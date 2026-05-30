import * as vscode from 'vscode';
import * as path from 'path';

export interface ScssNodeInfo {
    selectorChain: string[];  // raw selectors from root to leaf: [".cl-header", "&--right"]
    rawContent: string;        // original SCSS source inside the block (for copying verbatim)
    fsPath: string;
}

export interface ClassUsage {
    className: string;
    definedIn: string[];      // scss/css files where the class is declared
    nodeInfo?: ScssNodeInfo;  // populated when found; carries the BEM chain + raw content
    usedIn: string[];         // html/ts template files where the class name appears
    usageCount: number;
    safeToMove: boolean;      // true when usageCount <= 1
}

const EXCLUDE_PATTERN = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/coverage/**}';

export async function scanClassUsage(
    classes: string[],
    progress?: vscode.Progress<{ message?: string }>,
): Promise<ClassUsage[]> {
    if (classes.length === 0) { return []; }

    progress?.report({ message: 'Finding workspace files…' });

    const [templateFiles, styleFiles] = await Promise.all([
        vscode.workspace.findFiles('**/*.{html,htm}', EXCLUDE_PATTERN),
        vscode.workspace.findFiles('**/*.{css,scss,sass,less}', EXCLUDE_PATTERN),
    ]);

    progress?.report({ message: `Scanning ${templateFiles.length} templates and ${styleFiles.length} style files…` });

    // Build index: fsPath -> Map<className, ScssNodeInfo>
    // One pass per file, BEM resolution and content capture included.
    const styleIndex = new Map<string, Map<string, ScssNodeInfo>>();
    await Promise.all(styleFiles.map(async (uri) => {
        const text = await readFile(uri);
        styleIndex.set(uri.fsPath, extractScssNodeInfos(text, uri.fsPath));
    }));

    const results: ClassUsage[] = [];

    for (const className of classes) {
        const usageRe = new RegExp(`(?<![a-zA-Z0-9_-])${escapeRegex(className)}(?![a-zA-Z0-9_-])`);

        const definedIn: string[] = [];
        let nodeInfo: ScssNodeInfo | undefined;

        for (const [fsPath, nodeMap] of styleIndex) {
            const info = nodeMap.get(className);
            if (info) {
                definedIn.push(fsPath);
                if (!nodeInfo) { nodeInfo = info; } // first definition wins
            }
        }

        const usedIn: string[] = [];
        await Promise.all(templateFiles.map(async (uri) => {
            const text = await readFile(uri);
            if (usageRe.test(text)) { usedIn.push(uri.fsPath); }
        }));

        results.push({
            className,
            definedIn,
            nodeInfo,
            usedIn,
            usageCount: usedIn.length,
            safeToMove: usedIn.length <= 1,
        });
    }

    return results;
}

/**
 * Parses a CSS/SCSS file and returns a map of className → ScssNodeInfo.
 *
 * Handles BEM `&` concatenation at any nesting depth:
 *   .block { &--mod { color: red; } }  →  "block--mod" with selectorChain [".block", "&--mod"]
 *                                          and rawContent " color: red; "
 *
 * Comments are stripped for selector parsing but rawContent is taken from the
 * original source (same character positions since comments are replaced 1-for-1
 * with spaces).
 */
export function extractScssNodeInfos(scss: string, fsPath: string): Map<string, ScssNodeInfo> {
    const infos = new Map<string, ScssNodeInfo>();

    // Replace comments with spaces of equal length so brace positions stay aligned
    // between `cleaned` (used for parsing) and `scss` (used for rawContent slicing).
    const cleaned = scss
        .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
        .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));

    interface StackFrame {
        rawSelector: string;
        resolvedClasses: string[];
        contentStart: number;   // index in scss right after the opening {
    }

    const frameStack: StackFrame[] = [];
    const selectorStack: string[][] = [['']]; // resolved selectors at each depth level

    let pending = '';

    for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];

        if (ch === '{') {
            const rawSel = pending.trim();
            pending = '';

            const parents = selectorStack[selectorStack.length - 1];
            const resolved = resolveSelectors(rawSel, parents);
            const active = resolved.length ? resolved : parents;

            const resolvedClasses: string[] = [];
            for (const sel of active) {
                for (const m of sel.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
                    resolvedClasses.push(m[1]);
                }
            }

            frameStack.push({ rawSelector: rawSel, resolvedClasses, contentStart: i + 1 });
            selectorStack.push(active);

        } else if (ch === '}') {
            const frame = frameStack.pop();
            selectorStack.pop();
            pending = '';

            if (frame) {
                // Slice from original scss so variables, comments, etc. are preserved
                const rawContent = scss.slice(frame.contentStart, i);

                // Ancestor raw selectors + this frame's raw selector = the full chain
                const selectorChain = [
                    ...frameStack.map(f => f.rawSelector).filter(Boolean),
                    ...(frame.rawSelector ? [frame.rawSelector] : []),
                ];

                for (const className of frame.resolvedClasses) {
                    if (!infos.has(className)) { // first definition wins
                        infos.set(className, { selectorChain, rawContent, fsPath });
                    }
                }
            }

        } else if (ch === ';') {
            pending = ''; // end of property declaration

        } else {
            pending += ch;
        }
    }

    return infos;
}

/**
 * Convenience wrapper — returns just the set of class names defined in a file.
 * Useful for quick "is this class here?" checks without needing full node info.
 */
export function extractScssClasses(scss: string): Set<string> {
    return new Set(extractScssNodeInfos(scss, '').keys());
}

/**
 * Given a raw (possibly comma-separated) selector string and the parent
 * selector list from the enclosing block, produce all resolved selectors.
 *
 * `&--modifier` with parents [`.block`]    → [`.block--modifier`]
 * `.foo, .bar`  with parents [`''`]        → [`.foo`, `.bar`]
 * `& > span`    with parents [`.block`]    → [`.block > span`]
 */
function resolveSelectors(raw: string, parents: string[]): string[] {
    if (!raw) { return parents; }

    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    const resolved: string[] = [];

    for (const part of parts) {
        if (part.includes('&')) {
            for (const parent of parents) {
                resolved.push(part.replace(/&/g, parent));
            }
        } else {
            resolved.push(part);
        }
    }

    return resolved;
}

async function readFile(uri: vscode.Uri): Promise<string> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(bytes).toString('utf8');
    } catch {
        return '';
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function relativePath(fsPath: string): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { return fsPath; }
    const root = folders[0].uri.fsPath;
    return path.relative(root, fsPath);
}
