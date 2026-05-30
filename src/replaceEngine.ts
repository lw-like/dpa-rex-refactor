import * as vscode from 'vscode';
import { AppliedChange, PipelineStep } from './patternStore';

export type { PipelineStep };

export type Scope = 'currentFile' | 'openFiles' | 'workspaceFolder' | 'glob' | 'selection';

export interface ContextLine {
    lineNumber: number;
    text: string;
}

export interface MatchEntry {
    file: string;
    uri: string;
    offset: number;
    line: number;
    column: number;
    matchText: string;
    replacedText: string;
    groups: (string | undefined)[];
    contextBefore: ContextLine[];
    contextLine: ContextLine & { matchStart: number; matchEnd: number };
    contextAfter: ContextLine[];
}

export interface PreviewResult {
    matches: MatchEntry[];
    totalFiles: number;
    totalMatches: number;
}

export interface ApplyResult {
    filesModified: number;
    replacements: number;
    files: string[];
    changes: AppliedChange[];
}

export interface EngineOptions {
    fileTypes?: string;
    excludePattern?: string;
    selectionRange?: { startOffset: number; endOffset: number };
    cancelToken?: { cancelled: boolean };
    onProgress?: (current: number, total: number) => void;
}

// ─── Pipeline result types ────────────────────────────────────────────────────

export interface DiffLine {
    type: 'ctx' | 'del' | 'add';
    text: string;
    lineNum: number;
}

export interface DiffHunk {
    oldStart: number;
    newStart: number;
    lines: DiffLine[];
}

export interface FileDiff {
    file: string;
    uri: string;
    hunks: DiffHunk[];
    stepCounts: number[];
}

export interface PipelinePreviewResult {
    totalFiles: number;
    fileDiffs: FileDiff[];
}

// ─── Constants & utilities ────────────────────────────────────────────────────

const MAX_REVERT_CHANGES = 500;
const BATCH_SIZE = 50;
const decoder = new TextDecoder();

const CANCEL_MSG = '__SEARCH_CANCELLED__';
function yieldToEventLoop(): Promise<void> {
    return new Promise<void>(resolve => setImmediate(resolve));
}
function checkCancelled(token: { cancelled: boolean } | undefined): void {
    if (token?.cancelled) { throw new Error(CANCEL_MSG); }
}

async function readFileText(uri: vscode.Uri): Promise<string | null> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = decoder.decode(bytes).replace(/\r\n/g, '\n');
    return text.includes('\0') ? null : text;
}

function buildLineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') { starts.push(i + 1); }
    }
    return starts;
}

function offsetToPosition(starts: number[], offset: number): vscode.Position {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
    }
    return new vscode.Position(lo, offset - starts[lo]);
}

function getLine(text: string, starts: number[], line: number): string {
    const start = starts[line];
    const end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
    return text.slice(start, end);
}

const BUILTIN_EXCLUDES = [
    '**/node_modules/**', '**/.git/**', '**/.svn/**', '**/.hg/**',
    '**/dist/**', '**/out/**', '**/build/**', '**/bin/**', '**/obj/**',
    '**/.next/**', '**/.nuxt/**', '**/.output/**', '**/.angular/**',
    '**/coverage/**', '**/.nyc_output/**', '**/.cache/**', '**/.parcel-cache/**',
    '**/vendor/**', '**/__pycache__/**', '**/.pytest_cache/**',
    '**/target/**', '**/.gradle/**', '**/.idea/**',
    '**/*.min.js', '**/*.min.css',
];

function buildExcludeGlob(customPatterns: string[]): string {
    const patterns = [...BUILTIN_EXCLUDES];
    for (const extra of customPatterns) {
        const trimmed = extra.trim();
        if (trimmed && !BUILTIN_EXCLUDES.includes(trimmed)) { patterns.push(trimmed); }
    }
    return '{' + patterns.join(',') + '}';
}

async function resolveFiles(scope: Scope, globPattern: string, opts: EngineOptions = {}): Promise<vscode.Uri[]> {
    const settingExclude = vscode.workspace.getConfiguration('dpa-rex-refacror').get<string>('excludePattern', '');
    const excludeGlob = buildExcludeGlob([settingExclude, opts.excludePattern ?? ''].filter(s => s.trim() !== ''));

    let uris: vscode.Uri[];
    switch (scope) {
        case 'currentFile':
        case 'selection': {
            const editor = vscode.window.activeTextEditor;
            uris = editor ? [editor.document.uri] : [];
            break;
        }
        case 'openFiles':
            uris = vscode.workspace.textDocuments
                .filter(d => !d.isUntitled && d.uri.scheme === 'file')
                .map(d => d.uri);
            break;
        case 'workspaceFolder': {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders?.length) { uris = []; break; }
            uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folders[0], '**/*'), excludeGlob);
            break;
        }
        case 'glob':
            uris = globPattern ? await vscode.workspace.findFiles(globPattern, excludeGlob) : [];
            break;
        default:
            uris = [];
    }

    if (opts.fileTypes) {
        const exts = opts.fileTypes.split(',').map(e => e.trim().replace(/^\./, '')).filter(Boolean);
        if (exts.length > 0) { uris = uris.filter(u => exts.some(e => u.fsPath.endsWith('.' + e))); }
    }
    return uris;
}

function buildRegex(pattern: string, flags: string): RegExp {
    const globalFlags = flags.includes('g') ? flags : flags + 'g';
    return new RegExp(pattern, globalFlags);
}

function expandReplacement(match: RegExpExecArray, template: string): string {
    let result = '';
    let blockMode: 'none' | 'upper' | 'lower' = 'none';
    let nextChar: 'upper' | 'lower' | null = null;
    let i = 0;

    function applyCase(s: string): string {
        let out = '';
        for (const ch of s) {
            if (nextChar === 'upper')       { out += ch.toUpperCase(); nextChar = null; }
            else if (nextChar === 'lower')  { out += ch.toLowerCase(); nextChar = null; }
            else if (blockMode === 'upper') { out += ch.toUpperCase(); }
            else if (blockMode === 'lower') { out += ch.toLowerCase(); }
            else                            { out += ch; }
        }
        return out;
    }

    while (i < template.length) {
        const ch = template[i];
        if (ch === '\\' && i + 1 < template.length) {
            const mod = template[i + 1];
            switch (mod) {
                case 'u': nextChar = 'upper';  i += 2; continue;
                case 'l': nextChar = 'lower';  i += 2; continue;
                case 'U': blockMode = 'upper'; i += 2; continue;
                case 'L': blockMode = 'lower'; i += 2; continue;
                case 'E': blockMode = 'none'; nextChar = null; i += 2; continue;
                case 'n': result += applyCase('\n'); i += 2; continue;
                case 't': result += applyCase('\t'); i += 2; continue;
                default:  result += applyCase(mod);  i += 2; continue;
            }
        }
        if (ch === '$' && i + 1 < template.length) {
            const next = template[i + 1];
            if (next === '$') { result += applyCase('$'); i += 2; continue; }
            if (next === '&') { result += applyCase(match[0]); i += 2; continue; }
            let j = i + 1, numStr = '';
            while (j < template.length && template[j] >= '0' && template[j] <= '9') { numStr += template[j++]; }
            if (numStr.length > 0) {
                const groupNum = parseInt(numStr, 10);
                result += applyCase(groupNum < match.length ? (match[groupNum] ?? '') : '');
                i = j; continue;
            }
        }
        result += applyCase(ch);
        i++;
    }
    return result;
}

function computeReplacement(match: RegExpExecArray, replacement: string): string {
    return expandReplacement(match, replacement);
}

// ─── Single-step preview & apply ─────────────────────────────────────────────

export async function previewReplace(
    pattern: string, flags: string, replacement: string,
    scope: Scope, globPattern: string, contextLines = 2,
    opts: EngineOptions = {}
): Promise<PreviewResult> {
    const files = await resolveFiles(scope, globPattern, opts);
    const baseRegex = buildRegex(pattern, flags);
    const matches: MatchEntry[] = [];
    const seenFiles = new Set<string>();

    for (let b = 0; b < files.length; b += BATCH_SIZE) {
        // Yield to the event loop so pending IPC messages (e.g. cancelPreview) are
        // processed before we check the flag — microtask continuations alone are not
        // enough because IPC callbacks are macrotasks.
        await yieldToEventLoop();
        checkCancelled(opts.cancelToken);

        const texts = await Promise.all(files.slice(b, b + BATCH_SIZE).map(async uri => {
            try { return { uri, text: await readFileText(uri) }; } catch { return null; }
        }));

        for (const item of texts) {
            checkCancelled(opts.cancelToken); // check between every file in the batch
            if (!item?.text) { continue; }
            const { uri, text } = item;
            const starts = buildLineStarts(text);
            const lineCount = starts.length;
            const regex = new RegExp(baseRegex.source, baseRegex.flags);
            regex.lastIndex = 0;

            const sr = opts.selectionRange;
            const searchFrom = sr ? sr.startOffset : 0;
            const searchTo   = sr ? sr.endOffset   : text.length;
            const searchText = sr ? text.slice(searchFrom, searchTo) : text;

            let m: RegExpExecArray | null;
            let foundInFile = false;
            while ((m = regex.exec(searchText)) !== null) {
                const realOffset = m.index + searchFrom;
                const pos = offsetToPosition(starts, realOffset);
                const lineNum = pos.line;
                const startCtx = Math.max(0, lineNum - contextLines);
                const endCtx   = Math.min(lineCount - 1, lineNum + contextLines);
                const contextBefore: ContextLine[] = [];
                for (let l = startCtx; l < lineNum; l++) {
                    contextBefore.push({ lineNumber: l + 1, text: getLine(text, starts, l) });
                }
                const contextAfter: ContextLine[] = [];
                for (let l = lineNum + 1; l <= endCtx; l++) {
                    contextAfter.push({ lineNumber: l + 1, text: getLine(text, starts, l) });
                }
                const currentLine = getLine(text, starts, lineNum);
                matches.push({
                    file: vscode.workspace.asRelativePath(uri),
                    uri: uri.toString(),
                    offset: realOffset,
                    line: lineNum + 1,
                    column: pos.character + 1,
                    matchText: m[0],
                    replacedText: computeReplacement(m, replacement),
                    groups: Array.from({ length: m.length - 1 }, (_, i) => m![i + 1]),
                    contextBefore,
                    contextLine: {
                        lineNumber: lineNum + 1, text: currentLine,
                        matchStart: pos.character,
                        matchEnd: Math.min(pos.character + m[0].length, currentLine.length),
                    },
                    contextAfter,
                });
                foundInFile = true;
                if (!flags.includes('g')) { break; }
            }
            if (foundInFile) { seenFiles.add(uri.toString()); }
        }
        opts.onProgress?.(Math.min(b + BATCH_SIZE, files.length), files.length);
    }
    return { matches, totalFiles: seenFiles.size, totalMatches: matches.length };
}

export async function applyReplace(
    pattern: string, flags: string, replacement: string,
    scope: Scope, globPattern: string,
    opts: EngineOptions = {}
): Promise<ApplyResult> {
    const files = await resolveFiles(scope, globPattern, opts);
    const edit = new vscode.WorkspaceEdit();
    let totalReplacements = 0, filesModified = 0;
    const modifiedFiles: string[] = [];
    const allChanges: AppliedChange[] = [];

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'DPA-REX-Refacror', cancellable: false },
        async (progress) => {
            const baseRegex = buildRegex(pattern, flags);
            for (let b = 0; b < files.length; b += BATCH_SIZE) {
                const batch = files.slice(b, b + BATCH_SIZE);
                progress.report({ increment: 100 * batch.length / files.length, message: `${b + batch.length}/${files.length} files` });
                const texts = await Promise.all(batch.map(async uri => {
                    try { return { uri, text: await readFileText(uri) }; } catch { return null; }
                }));
                for (const item of texts) {
                    if (!item?.text) { continue; }
                    const { uri, text } = item;
                    const starts = buildLineStarts(text);
                    const regex = new RegExp(baseRegex.source, baseRegex.flags);
                    regex.lastIndex = 0;

                    const sr = opts.selectionRange;
                    const searchFrom = sr ? sr.startOffset : 0;
                    const searchTo   = sr ? sr.endOffset   : text.length;
                    const searchText = sr ? text.slice(searchFrom, searchTo) : text;

                    let m: RegExpExecArray | null;
                    let fileHits = 0;
                    while ((m = regex.exec(searchText)) !== null) {
                        const realOffset = m.index + searchFrom;
                        const start = offsetToPosition(starts, realOffset);
                        const end   = offsetToPosition(starts, realOffset + m[0].length);
                        const replaced = computeReplacement(m, replacement);
                        edit.replace(uri, new vscode.Range(start, end), replaced);
                        allChanges.push({ uri: uri.toString(), offset: realOffset, originalText: m[0], replacedText: replaced });
                        fileHits++;
                        if (!flags.includes('g')) { break; }
                    }
                    if (fileHits > 0) { totalReplacements += fileHits; filesModified++; modifiedFiles.push(uri.toString()); }
                }
            }
        }
    );

    await vscode.workspace.applyEdit(edit);
    await Promise.all(modifiedFiles.map(u => vscode.workspace.save(vscode.Uri.parse(u))));
    const changes = allChanges.length <= MAX_REVERT_CHANGES ? allChanges : [];
    return { filesModified, replacements: totalReplacements, files: modifiedFiles, changes };
}

export async function applySelected(matches: MatchEntry[]): Promise<ApplyResult> {
    const byUri = new Map<string, MatchEntry[]>();
    for (const m of matches) {
        const list = byUri.get(m.uri) ?? [];
        list.push(m);
        byUri.set(m.uri, list);
    }

    const edit = new vscode.WorkspaceEdit();
    let totalReplacements = 0, filesModified = 0;
    const modifiedFiles: string[] = [];
    const allChanges: AppliedChange[] = [];

    for (const [uriStr, fileMatches] of byUri) {
        const uri = vscode.Uri.parse(uriStr);
        let text: string | null;
        try { text = await readFileText(uri); } catch { continue; }
        if (!text) { continue; }

        const starts = buildLineStarts(text);
        let fileHits = 0;
        for (const m of fileMatches) {
            if (text.slice(m.offset, m.offset + m.matchText.length) === m.matchText) {
                const start = offsetToPosition(starts, m.offset);
                const end   = offsetToPosition(starts, m.offset + m.matchText.length);
                edit.replace(uri, new vscode.Range(start, end), m.replacedText);
                allChanges.push({ uri: uriStr, offset: m.offset, originalText: m.matchText, replacedText: m.replacedText });
                fileHits++;
            }
        }
        if (fileHits > 0) { totalReplacements += fileHits; filesModified++; modifiedFiles.push(uriStr); }
    }

    await vscode.workspace.applyEdit(edit);
    await Promise.all(modifiedFiles.map(u => vscode.workspace.save(vscode.Uri.parse(u))));
    const changes = allChanges.length <= MAX_REVERT_CHANGES ? allChanges : [];
    return { filesModified, replacements: totalReplacements, files: modifiedFiles, changes };
}

export async function revertChanges(changes: AppliedChange[]): Promise<{ reverted: number; skipped: number }> {
    const byUri = new Map<string, AppliedChange[]>();
    for (const c of changes) {
        const list = byUri.get(c.uri) ?? [];
        list.push(c);
        byUri.set(c.uri, list);
    }

    const edit = new vscode.WorkspaceEdit();
    let reverted = 0, skipped = 0;

    for (const [uriStr, fileChanges] of byUri) {
        const uri = vscode.Uri.parse(uriStr);
        let text: string | null;
        try { text = await readFileText(uri); } catch { skipped += fileChanges.length; continue; }
        if (!text) { skipped += fileChanges.length; continue; }

        const starts = buildLineStarts(text);
        const sorted = [...fileChanges].sort((a, b) => b.offset - a.offset);
        for (const c of sorted) {
            if (text.slice(c.offset, c.offset + c.replacedText.length) === c.replacedText) {
                const start = offsetToPosition(starts, c.offset);
                const end   = offsetToPosition(starts, c.offset + c.replacedText.length);
                edit.replace(uri, new vscode.Range(start, end), c.originalText);
                reverted++;
            } else { skipped++; }
        }
    }

    await vscode.workspace.applyEdit(edit);
    await Promise.all([...byUri.keys()].map(u => vscode.workspace.save(vscode.Uri.parse(u))));
    return { reverted, skipped };
}

// ─── Pipeline helpers ─────────────────────────────────────────────────────────

function applyPipelineToText(steps: PipelineStep[], text: string): { finalText: string; stepCounts: number[] } {
    const stepCounts: number[] = [];
    let current = text;
    for (const step of steps) {
        if (!step.pattern) { stepCounts.push(0); continue; }
        let count = 0;
        try {
            const regex = buildRegex(step.pattern, step.flags);
            let result = '', lastIndex = 0;
            let m: RegExpExecArray | null;
            regex.lastIndex = 0;
            while ((m = regex.exec(current)) !== null) {
                result += current.slice(lastIndex, m.index);
                result += computeReplacement(m, step.replacement);
                lastIndex = m.index + m[0].length;
                count++;
                if (!step.flags.includes('g')) { break; }
                if (m[0].length === 0) {
                    if (lastIndex >= current.length) { break; }
                    result += current[lastIndex++];
                }
            }
            result += current.slice(lastIndex);
            current = result;
        } catch { /* skip invalid pattern */ }
        stepCounts.push(count);
    }
    return { finalText: current, stepCounts };
}

// Diff for same line counts: O(n) scan
function sameCountDiff(old: string[], nw: string[], ctx: number): DiffHunk[] {
    const changedIdx: number[] = [];
    for (let i = 0; i < old.length; i++) {
        if (old[i] !== nw[i]) { changedIdx.push(i); }
    }
    if (!changedIdx.length) { return []; }

    const regions: [number, number][] = [];
    let gFrom = changedIdx[0], gTo = changedIdx[0];
    for (let k = 1; k < changedIdx.length; k++) {
        if (changedIdx[k] - gTo <= 2 * ctx) { gTo = changedIdx[k]; }
        else { regions.push([gFrom, gTo]); gFrom = changedIdx[k]; gTo = changedIdx[k]; }
    }
    regions.push([gFrom, gTo]);

    return regions.map(([from, to]) => {
        const start = Math.max(0, from - ctx);
        const end   = Math.min(old.length - 1, to + ctx);
        const lines: DiffLine[] = [];
        for (let l = start; l <= end; l++) {
            if (old[l] === nw[l]) {
                lines.push({ type: 'ctx', text: old[l], lineNum: l + 1 });
            } else {
                lines.push({ type: 'del', text: old[l], lineNum: l + 1 });
                lines.push({ type: 'add', text: nw[l], lineNum: l + 1 });
            }
        }
        return { oldStart: start + 1, newStart: start + 1, lines };
    });
}

// Diff for different line counts: LCS-based, O(m*n)
function lcsDiff(old: string[], nw: string[], ctx: number): DiffHunk[] {
    const m = old.length, n = nw.length;
    const dp = new Uint16Array((m + 1) * (n + 1));
    const W = n + 1;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i * W + j] = old[i - 1] === nw[j - 1]
                ? dp[(i - 1) * W + (j - 1)] + 1
                : Math.max(dp[(i - 1) * W + j], dp[i * W + (j - 1)]);
        }
    }

    // Backtrack to edit ops
    type Op = { type: 'eq' | 'del' | 'add'; oi: number; ni: number };
    const ops: Op[] = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && old[i - 1] === nw[j - 1]) {
            ops.push({ type: 'eq', oi: i - 1, ni: j - 1 }); i--; j--;
        } else if (j > 0 && (i === 0 || dp[i * W + (j - 1)] >= dp[(i - 1) * W + j])) {
            ops.push({ type: 'add', oi: -1, ni: j - 1 }); j--;
        } else {
            ops.push({ type: 'del', oi: i - 1, ni: -1 }); i--;
        }
    }
    ops.reverse();

    // Precompute old/new line numbers per op position
    const oldLineOf = new Int32Array(ops.length);
    const newLineOf = new Int32Array(ops.length);
    let ol = 1, nl = 1;
    for (let k = 0; k < ops.length; k++) {
        oldLineOf[k] = ol; newLineOf[k] = nl;
        if (ops[k].type !== 'add') { ol++; }
        if (ops[k].type !== 'del') { nl++; }
    }

    // Group changed ops into regions, add context
    const changedOps = ops.map((_, k) => k).filter(k => ops[k].type !== 'eq');
    if (!changedOps.length) { return []; }

    const regions: [number, number][] = [];
    let gFrom = changedOps[0], gTo = changedOps[0];
    for (let k = 1; k < changedOps.length; k++) {
        if (changedOps[k] - gTo <= 2 * ctx) { gTo = changedOps[k]; }
        else { regions.push([gFrom, gTo]); gFrom = changedOps[k]; gTo = changedOps[k]; }
    }
    regions.push([gFrom, gTo]);

    return regions.map(([from, to]) => {
        const start = Math.max(0, from - ctx);
        const end   = Math.min(ops.length - 1, to + ctx);
        const lines: DiffLine[] = [];
        for (let k = start; k <= end; k++) {
            const op = ops[k];
            if (op.type === 'eq')  { lines.push({ type: 'ctx', text: old[op.oi], lineNum: oldLineOf[k] }); }
            else if (op.type === 'del') { lines.push({ type: 'del', text: old[op.oi], lineNum: oldLineOf[k] }); }
            else                        { lines.push({ type: 'add', text: nw[op.ni],  lineNum: newLineOf[k] }); }
        }
        return { oldStart: oldLineOf[start], newStart: newLineOf[start], lines };
    });
}

function computeLineDiff(oldLines: string[], newLines: string[], ctx = 3): DiffHunk[] {
    if (oldLines.length === newLines.length) {
        return sameCountDiff(oldLines, newLines, ctx);
    }
    const MAX_LCS = 2000;
    if (oldLines.length <= MAX_LCS && newLines.length <= MAX_LCS) {
        return lcsDiff(oldLines, newLines, ctx);
    }
    return [{ oldStart: 1, newStart: 1, lines: [{ type: 'ctx', text: `(file too large to diff — ${oldLines.length} → ${newLines.length} lines)`, lineNum: 1 }] }];
}

// ─── Pipeline preview & apply ─────────────────────────────────────────────────

export async function previewPipeline(
    steps: PipelineStep[], scope: Scope, globPattern: string,
    contextLines = 3, opts: EngineOptions = {}
): Promise<PipelinePreviewResult> {
    const files = await resolveFiles(scope, globPattern, opts);
    const fileDiffs: FileDiff[] = [];

    for (let b = 0; b < files.length; b += BATCH_SIZE) {
        await yieldToEventLoop();
        checkCancelled(opts.cancelToken);

        const texts = await Promise.all(files.slice(b, b + BATCH_SIZE).map(async uri => {
            try { return { uri, text: await readFileText(uri) }; } catch { return null; }
        }));
        for (const item of texts) {
            checkCancelled(opts.cancelToken);
            if (!item?.text) { continue; }
            const { uri, text } = item;
            const { finalText, stepCounts } = applyPipelineToText(steps, text);
            if (finalText === text) { continue; }
            const oldLines = text.split('\n');
            const newLines = finalText.split('\n');
            fileDiffs.push({
                file: vscode.workspace.asRelativePath(uri),
                uri: uri.toString(),
                hunks: computeLineDiff(oldLines, newLines, contextLines),
                stepCounts,
            });
        }
        opts.onProgress?.(Math.min(b + BATCH_SIZE, files.length), files.length);
    }

    return { totalFiles: fileDiffs.length, fileDiffs };
}

export async function applyPipeline(
    steps: PipelineStep[], scope: Scope, globPattern: string,
    opts: EngineOptions = {}
): Promise<ApplyResult> {
    const files = await resolveFiles(scope, globPattern, opts);
    const edit = new vscode.WorkspaceEdit();
    let totalReplacements = 0, filesModified = 0;
    const modifiedFiles: string[] = [];
    const allChanges: AppliedChange[] = [];

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'DPA-REX-Refacror (pipeline)', cancellable: false },
        async (progress) => {
            for (let b = 0; b < files.length; b += BATCH_SIZE) {
                const batch = files.slice(b, b + BATCH_SIZE);
                progress.report({ increment: 100 * batch.length / files.length, message: `${b + batch.length}/${files.length} files` });
                const texts = await Promise.all(batch.map(async uri => {
                    try { return { uri, text: await readFileText(uri) }; } catch { return null; }
                }));
                for (const item of texts) {
                    if (!item?.text) { continue; }
                    const { uri, text } = item;
                    const { finalText, stepCounts } = applyPipelineToText(steps, text);
                    if (finalText === text) { continue; }
                    const starts = buildLineStarts(text);
                    const lastLine = starts.length - 1;
                    const lastChar = text.length - starts[lastLine];
                    edit.replace(uri, new vscode.Range(0, 0, lastLine, lastChar), finalText);
                    totalReplacements += stepCounts.reduce((a, c) => a + c, 0);
                    filesModified++;
                    modifiedFiles.push(uri.toString());
                    allChanges.push({ uri: uri.toString(), offset: 0, originalText: text, replacedText: finalText });
                }
            }
        }
    );

    await vscode.workspace.applyEdit(edit);
    await Promise.all(modifiedFiles.map(u => vscode.workspace.save(vscode.Uri.parse(u))));
    const changes = allChanges.length <= MAX_REVERT_CHANGES ? allChanges : [];
    return { filesModified, replacements: totalReplacements, files: modifiedFiles, changes };
}
