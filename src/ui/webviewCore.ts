import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PatternStore, HistoryEntry, AppliedChange, PipelineStep, SavedPattern } from '../patternStore';
import {
    previewReplace, applyReplace, applySelected, revertChanges,
    previewPipeline, applyPipeline,
    Scope, MatchEntry, EngineOptions,
} from '../replaceEngine';
import { extractPatterns } from '../patternExtractor';
import { TodoData } from '../angular/componentGenerator';
import { TodoReviewPanel } from './todoReviewPanel';
import { LAST_EXTRACTION_KEY, LastExtraction } from '../angular/extractCommand';
import { AuditFinding } from '../angular/auditTypes';
import { AuditScope } from '../angular/auditScope';
import { scanChangeDetection } from '../angular/changeDetectionScanner';
import { scanShareReplayLeak } from '../angular/rxjsLeakScanner';
import { scanListTracking } from '../angular/listTrackingScanner';
import { scanHeavyImports } from '../angular/heavyImportScanner';
import { scanNestedSwitchMap } from '../angular/nestedSwitchMapScanner';
import { scanTemplateFunctionCalls } from '../angular/templateFunctionCallScanner';
import { scanHttpInEffect } from '../angular/httpInEffectScanner';
import { scanUnmanagedSubscriptions } from '../angular/unmanagedSubscriptionScanner';
import { scanUnmanagedTimers } from '../angular/unmanagedTimerScanner';
import { scanUnoptimizedImages } from '../angular/unoptimizedImageScanner';
import { scanManualChangeDetection } from '../angular/manualChangeDetectionScanner';
import { scanRepeatedTemplateExpressions } from '../angular/repeatedExpressionScanner';
import { scanLargeRenderedLists } from '../angular/largeListScanner';
import { scanUnsafeToSignal } from '../angular/unsafeToSignalScanner';
import { scanNestedSubscriptions } from '../angular/nestedSubscriptionScanner';
import { scanEagerRoutes } from '../angular/eagerRouteScanner';

export interface WebviewMessage {
    type: string;
    fsPath?: string;
    value?: boolean;
    name?: string;
    command?: string;
    commands?: string[];
    steps?: PipelineStep[];
    // Single-step compat (step 0 values, sent alongside steps[]):
    pattern?: string;
    flags?: string;
    replacement?: string;
    scope?: string;
    glob?: string;
    fileTypes?: string;
    excludePattern?: string;
    contextLines?: number;
    matches?: MatchEntry[];
    index?: number;
    uri?: string;
    line?: number;
    column?: number;
    uriList?: string[];
    // Audit fix fields
    startLine?: number;
    startCol?: number;
    endLine?: number;
    endCol?: number;
    fixText?: string;
    findingIndex?: number;
    // Audit scope (distinct from replace-engine scope which is a string)
    auditScopeData?: { type: 'workspace' | 'folder' | 'files'; uriString?: string; uriStrings?: string[] };
}

export class MessageHandler {
    private cancelToken: { cancelled: boolean } | null = null;
    private decorationType: vscode.TextEditorDecorationType | null = null;

    constructor(
        private store: PatternStore,
        private readonly post: (msg: object) => void,
        private readonly context: vscode.ExtensionContext,
        private readonly diagnostics: vscode.DiagnosticCollection,
    ) {}

    dispose(): void {
        this.clearDecorations();
    }

    private clearDecorations(): void {
        if (this.decorationType) { this.decorationType.dispose(); this.decorationType = null; }
    }

    private applyDecorations(matches: MatchEntry[]): void {
        this.clearDecorations();
        if (!matches.length) { return; }
        const byUri = new Map<string, vscode.Range[]>();
        for (const m of matches.slice(0, 1000)) {
            const lines = m.matchText.split('\n');
            const endLine = m.line - 1 + lines.length - 1;
            const endCol  = lines.length === 1 ? m.column - 1 + lines[0].length : lines[lines.length - 1].length;
            const ranges = byUri.get(m.uri) ?? [];
            ranges.push(new vscode.Range(new vscode.Position(m.line - 1, m.column - 1), new vscode.Position(endLine, endCol)));
            byUri.set(m.uri, ranges);
        }
        this.decorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
            border: '1px solid',
            borderColor: new vscode.ThemeColor('editor.findMatchHighlightBorder'),
        });
        const dt = this.decorationType;
        for (const editor of vscode.window.visibleTextEditors) {
            const ranges = byUri.get(editor.document.uri.toString());
            if (ranges) { editor.setDecorations(dt, ranges); }
        }
    }

    pushHistory(): void {
        this.post({ type: 'history', entries: this.store.getHistory() });
    }

    pushPendingPattern(): void {
        const pending = this.store.consumePendingPattern();
        if (pending) { this.post({ type: 'loadPatternResult', pattern: pending }); }
    }

    switchToPlanner(text: string): void {
        // Normalize CRLF so the string matches what the browser produces
        // from innerHTML (which strips \r), keeping textOffset indices consistent.
        const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const suggestions = normalized ? extractPatterns(normalized) : [];
        this.post({ type: 'switchTab', tab: 'planner' });
        this.post({ type: 'sampleResult', text: normalized, suggestions });
    }

    async handle(msg: WebviewMessage): Promise<void> {
        switch (msg.type) {
            case 'loadPatterns':
                this.pushHistory();
                break;

            case 'savePattern': {
                const name = await vscode.window.showInputBox({
                    prompt: 'Save pattern as…',
                    placeHolder: 'Pattern name',
                    validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
                });
                if (!name?.trim()) { break; }
                const steps = this.resolveSteps(msg);
                this.store.save({
                    name: name.trim(),
                    steps,
                    scope: msg.scope ?? 'workspaceFolder',
                    glob: msg.glob,
                    fileTypes: msg.fileTypes,
                    excludePattern: msg.excludePattern,
                });
                vscode.window.showInformationMessage(`Pattern "${name.trim()}" saved.`);
                break;
            }

            case 'loadPattern': {
                const patterns = this.store.getAll();
                if (!patterns.length) {
                    vscode.window.showInformationMessage('No saved patterns yet.');
                    break;
                }
                const picked = await vscode.window.showQuickPick(
                    patterns.map(p => ({
                        label: p.name,
                        description: p.steps.length > 1
                            ? `${p.steps.length} steps`
                            : `/${p.steps[0]?.pattern ?? ''}/ → ${p.steps[0]?.replacement ?? ''}`,
                        pattern: p,
                    })),
                    { placeHolder: 'Select a pattern to load' }
                );
                if (picked) {
                    this.post({ type: 'loadPatternResult', pattern: picked.pattern });
                }
                break;
            }

            case 'deletePattern': {
                const patterns = this.store.getAll();
                if (!patterns.length) {
                    vscode.window.showInformationMessage('No saved patterns yet.');
                    break;
                }
                const picked = await vscode.window.showQuickPick(
                    patterns.map(p => ({
                        label: p.name,
                        description: p.steps.length > 1
                            ? `${p.steps.length} steps`
                            : `/${p.steps[0]?.pattern ?? ''}/ → ${p.steps[0]?.replacement ?? ''}`,
                    })),
                    { placeHolder: 'Select a pattern to delete' }
                );
                if (picked) {
                    this.store.delete(picked.label);
                    vscode.window.showInformationMessage(`Pattern "${picked.label}" deleted.`);
                }
                break;
            }

            case 'cancelPreview':
                if (this.cancelToken) { this.cancelToken.cancelled = true; }
                break;

            case 'clearDecorations':
                this.clearDecorations();
                break;

            case 'applyDecorations':
                if (msg.matches) { this.applyDecorations(msg.matches); }
                break;

            case 'preview': {
                this.clearDecorations();
                if (this.cancelToken) { this.cancelToken.cancelled = true; }
                const token = { cancelled: false };
                this.cancelToken = token;
                try {
                    const steps = this.resolveSteps(msg);
                    this.validateSteps(steps, msg);
                    const opts = await this.buildEngineOpts(msg);
                    if (opts === null) { this.cancelToken = null; break; }
                    opts.cancelToken = token;
                    opts.onProgress = (current, total) => {
                        this.post({ type: 'searchProgress', current, total });
                    };
                    if (steps.length > 1) {
                        const result = await previewPipeline(steps, msg.scope as Scope, msg.glob ?? '', msg.contextLines ?? 3, opts);
                        this.post({ type: 'pipelinePreviewResult', ...result });
                    } else {
                        const s = steps[0];
                        const result = await previewReplace(s.pattern, s.flags, s.replacement, msg.scope as Scope, msg.glob ?? '', msg.contextLines ?? 2, opts);
                        this.post({ type: 'previewResult', ...result });
                        this.applyDecorations(result.matches);
                    }
                } catch (e: unknown) {
                    if (e instanceof Error && e.message === '__SEARCH_CANCELLED__') {
                        this.post({ type: 'searchCancelled' });
                    } else {
                        this.postError(e instanceof Error ? e.message : String(e));
                    }
                } finally {
                    if (this.cancelToken === token) { this.cancelToken = null; }
                }
                break;
            }

            case 'applySelected': {
                this.clearDecorations();
                try {
                    if (!msg.matches?.length) { this.postError('No matches selected.'); return; }
                    const result = await applySelected(msg.matches);
                    this.post({ type: 'applyResult', ...result });
                    vscode.window.showInformationMessage(
                        `Replaced ${result.replacements} selected occurrence(s) in ${result.filesModified} file(s).`
                    );
                    if (result.replacements > 0) {
                        this.recordHistory(msg, result.replacements, result.filesModified, result.files, result.changes);
                    }
                } catch (e: unknown) { this.postError(e instanceof Error ? e.message : String(e)); }
                break;
            }

            case 'apply': {
                this.clearDecorations();
                try {
                    const steps = this.resolveSteps(msg);
                    this.validateSteps(steps, msg);
                    const opts = await this.buildEngineOpts(msg);
                    if (opts === null) { break; }
                    let result;
                    if (steps.length > 1) {
                        result = await applyPipeline(steps, msg.scope as Scope, msg.glob ?? '', opts);
                        this.post({ type: 'applyResult', ...result });
                        vscode.window.showInformationMessage(
                            `Pipeline applied: ${result.replacements} replacement(s) across ${result.filesModified} file(s).`
                        );
                    } else {
                        const s = steps[0];
                        result = await applyReplace(s.pattern, s.flags, s.replacement, msg.scope as Scope, msg.glob ?? '', opts);
                        this.post({ type: 'applyResult', ...result });
                        vscode.window.showInformationMessage(
                            `Replaced ${result.replacements} occurrence(s) across ${result.filesModified} file(s).`
                        );
                    }
                    if (result.replacements > 0) {
                        this.recordHistory(msg, result.replacements, result.filesModified, result.files, result.changes);
                    }
                } catch (e: unknown) { this.postError(e instanceof Error ? e.message : String(e)); }
                break;
            }

            case 'reanalyze': {
                const editor = vscode.window.activeTextEditor;
                const text = (editor && !editor.selection.isEmpty)
                    ? editor.document.getText(editor.selection) : '';
                this.switchToPlanner(text);
                break;
            }

            case 'clearHistory':
                this.store.clearHistory();
                this.pushHistory();
                break;

            case 'revertHistory': {
                if (msg.index === undefined) { break; }
                const history = this.store.getHistory();
                const entry = history[msg.index];
                if (!entry?.changes?.length) { break; }
                try {
                    const { reverted, skipped } = await revertChanges(entry.changes);
                    this.store.removeHistoryEntry(msg.index);
                    this.pushHistory();
                    if (skipped > 0) {
                        vscode.window.showWarningMessage(`Reverted ${reverted} change(s). ${skipped} could not be reverted (file changed).`);
                    } else {
                        vscode.window.showInformationMessage(`Reverted ${reverted} change(s).`);
                    }
                } catch (e: unknown) { this.postError(e instanceof Error ? e.message : String(e)); }
                break;
            }

            case 'openFile': {
                if (!msg.uri) { break; }
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(msg.uri));
                    const editor = await vscode.window.showTextDocument(doc);
                    if (msg.line) {
                        const pos = new vscode.Position(msg.line - 1, (msg.column ?? 1) - 1);
                        editor.selection = new vscode.Selection(pos, pos);
                        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    }
                } catch { /* file may have been deleted */ }
                break;
            }

            case 'liveMatchCount': {
                const editor = vscode.window.activeTextEditor;
                if (!editor || !msg.pattern) { this.post({ type: 'liveMatchCountResult', count: 0, fileName: '' }); break; }
                try {
                    // Cap at 200 k chars — a catastrophically backtracking pattern on a
                    // large file would otherwise freeze the extension host indefinitely.
                    const text = editor.document.getText().slice(0, 200_000);
                    const flags = (msg.flags ?? 'gi').includes('g') ? (msg.flags ?? 'gi') : (msg.flags ?? 'gi') + 'g';
                    const count = (text.match(new RegExp(msg.pattern, flags)) ?? []).length;
                    this.post({ type: 'liveMatchCountResult', count, fileName: vscode.workspace.asRelativePath(editor.document.uri) });
                } catch {
                    this.post({ type: 'liveMatchCountResult', count: -1, fileName: '' });
                }
                break;
            }

            case 'savePlannerPattern': {
                if (!msg.pattern?.trim()) { this.postError('Pattern is required.'); break; }
                const name = await vscode.window.showInputBox({
                    prompt: 'Save planner pattern as…',
                    placeHolder: 'Pattern name',
                    validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
                });
                if (!name?.trim()) { break; }
                this.store.save({
                    name: name.trim(),
                    steps: [{ pattern: msg.pattern, flags: msg.flags ?? 'gi', replacement: msg.replacement ?? '' }],
                    scope: 'workspaceFolder',
                } as SavedPattern);
                vscode.window.showInformationMessage(`Pattern "${name.trim()}" saved.`);
                break;
            }

            case 'exportPatterns': {
                const patterns = this.store.getAll();
                if (!patterns.length) { vscode.window.showInformationMessage('No saved patterns to export.'); break; }
                const saveUri = await vscode.window.showSaveDialog({
                    filters: { 'JSON': ['json'] },
                    defaultUri: vscode.Uri.file('rex-patterns.json'),
                    saveLabel: 'Export',
                });
                if (!saveUri) { break; }
                await vscode.workspace.fs.writeFile(saveUri, Buffer.from(JSON.stringify(patterns, null, 2), 'utf8'));
                vscode.window.showInformationMessage(`Exported ${patterns.length} pattern(s).`);
                break;
            }

            case 'importPatterns': {
                const openUris = await vscode.window.showOpenDialog({ filters: { 'JSON': ['json'] }, canSelectMany: false, openLabel: 'Import' });
                if (!openUris?.length) { break; }
                try {
                    const bytes = await vscode.workspace.fs.readFile(openUris[0]);
                    const data = JSON.parse(Buffer.from(bytes).toString('utf8'));
                    if (!Array.isArray(data)) { throw new Error('Expected a JSON array'); }
                    let count = 0;
                    for (const item of data) {
                        if (typeof item.name === 'string' && item.name.trim()) {
                            // Validate step structure before saving — prevents runtime crashes
                            // from importing malformed JSON with non-string pattern/flags fields.
                            const steps: unknown[] = Array.isArray(item.steps) ? item.steps : [];
                            const stepsValid = steps.every(
                                (s) => s !== null && typeof s === 'object' &&
                                        typeof (s as Record<string, unknown>).pattern === 'string' &&
                                        typeof (s as Record<string, unknown>).flags === 'string' &&
                                        typeof (s as Record<string, unknown>).replacement === 'string'
                            );
                            if (steps.length > 0 && !stepsValid) { continue; }
                            this.store.save(item as SavedPattern);
                            count++;
                        }
                    }
                    vscode.window.showInformationMessage(`Imported ${count} pattern(s).`);
                    this.post({ type: 'importDone' });
                } catch (e: unknown) {
                    this.postError(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                break;
            }

            case 'loadConfig': {
                const cfg = vscode.workspace.getConfiguration('dpa-rex-refacror.angular');
                const lastExtraction = this.context.globalState.get<LastExtraction>(LAST_EXTRACTION_KEY) ?? null;
                this.post({
                    type: 'configData',
                    settings: {
                        autoImport: cfg.get<boolean>('autoImport', true),
                        convertToMobileFirst: cfg.get<boolean>('convertToMobileFirst', true),
                        mixinsFile: cfg.get<string>('mixinsFile', ''),
                        mixinsImport: cfg.get<string>('mixinsImport', ''),
                    },
                    lastExtraction,
                });
                break;
            }

            case 'setAutoImport': {
                await vscode.workspace.getConfiguration('dpa-rex-refacror.angular')
                    .update('autoImport', msg.value, vscode.ConfigurationTarget.Workspace);
                break;
            }

            case 'setConvertToMobileFirst': {
                await vscode.workspace.getConfiguration('dpa-rex-refacror.angular')
                    .update('convertToMobileFirst', msg.value, vscode.ConfigurationTarget.Workspace);
                break;
            }

            case 'revertLastExtraction': {
                const extraction = this.context.globalState.get<LastExtraction>(LAST_EXTRACTION_KEY);
                if (!extraction) { this.postError('No extraction to revert.'); break; }

                const confirm = await vscode.window.showWarningMessage(
                    `Revert ${extraction.componentName}? This will delete the component files and restore the parent file.`,
                    { modal: true }, 'Revert',
                );
                if (confirm !== 'Revert') { break; }

                try {
                    // Delete component directory
                    await vscode.workspace.fs.delete(
                        vscode.Uri.file(extraction.componentDir),
                        { recursive: true, useTrash: true },
                    );
                } catch (e) {
                    this.postError(`Could not delete component files: ${e instanceof Error ? e.message : String(e)}`);
                    break;
                }

                // Step 1: restore original HTML in the template file (the file user edited)
                try {
                    const parentUri = vscode.Uri.file(extraction.parentFilePath);
                    const parentDoc = await vscode.workspace.openTextDocument(parentUri);
                    let parentText = parentDoc.getText();

                    const selectorRe = new RegExp(`<${escapeForRegex(extraction.selector)}\\s*\\/?>`, 'g');
                    parentText = parentText.replace(selectorRe, extraction.originalHtml);

                    // If the parent is a .ts file with an inline template, also strip the import here
                    if (!extraction.parentFilePath.endsWith('.html')) {
                        parentText = removeImportFromTs(parentText, extraction.importStatement, extraction.componentName);
                    }

                    const parentEdit = new vscode.WorkspaceEdit();
                    parentEdit.replace(parentUri,
                        new vscode.Range(parentDoc.positionAt(0), parentDoc.positionAt(parentDoc.getText().length)),
                        parentText,
                    );
                    await vscode.workspace.applyEdit(parentEdit);
                } catch {
                    vscode.window.showWarningMessage('Component files deleted but template file could not be auto-restored — please undo manually.');
                }

                // Step 2: remove import statement + imports[] entry from the .ts component file
                // (when editing a .html template the import goes into the paired .ts, not the .html)
                if (extraction.parentFilePath.endsWith('.html')) {
                    const tsFsPath = extraction.parentFilePath.replace(/\.html$/, '.ts');
                    try {
                        await vscode.workspace.fs.stat(vscode.Uri.file(tsFsPath));
                        const tsUri = vscode.Uri.file(tsFsPath);
                        const tsDoc = await vscode.workspace.openTextDocument(tsUri);
                        const cleaned = removeImportFromTs(tsDoc.getText(), extraction.importStatement, extraction.componentName);
                        const tsEdit = new vscode.WorkspaceEdit();
                        tsEdit.replace(tsUri,
                            new vscode.Range(tsDoc.positionAt(0), tsDoc.positionAt(tsDoc.getText().length)),
                            cleaned,
                        );
                        await vscode.workspace.applyEdit(tsEdit);
                    } catch {
                        vscode.window.showWarningMessage('Import not removed from paired .ts file — please remove it manually.');
                    }
                }

                await this.context.globalState.update(LAST_EXTRACTION_KEY, undefined);
                this.post({ type: 'configData', settings: null, lastExtraction: null });
                vscode.window.showInformationMessage(`Reverted: ${extraction.componentName} deleted.`);
                break;
            }

            case 'selectAuditFolder': {
                const picked = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: 'Audit this folder',
                });
                if (picked?.length) {
                    this.post({
                        type: 'auditScopeSelected',
                        scopeType: 'folder',
                        uriString: picked[0].toString(),
                        label: vscode.workspace.asRelativePath(picked[0]) || picked[0].fsPath,
                    });
                }
                break;
            }

            case 'selectAuditFiles': {
                const picked = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: true,
                    filters: { 'TypeScript & HTML': ['ts', 'html'] },
                    openLabel: 'Audit these files',
                });
                if (picked?.length) {
                    const label = picked.length === 1
                        ? vscode.workspace.asRelativePath(picked[0])
                        : `${picked.length} files`;
                    this.post({
                        type: 'auditScopeSelected',
                        scopeType: 'files',
                        uriStrings: picked.map(u => u.toString()),
                        label,
                    });
                }
                break;
            }

            case 'runAudit': {
                if (!msg.command) { break; }
                const auditCmd = msg.command;
                const auditScope = this.parseScope(msg);
                this.post({ type: 'auditScanStart', command: auditCmd });
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Angular Audit: Scanning…',
                        cancellable: true,
                    },
                    async (_progress, token) => {
                        const findings = await this.runScanByCommand(auditCmd, token, this.diagnostics, auditScope);
                        this.post({ type: 'auditResult', command: auditCmd, findings });
                    }
                );
                break;
            }

            case 'runAuditAll': {
                const allScope = this.parseScope(msg);
                // Clear the Problems panel once before all scans.  Without this, each
                // scanner's internal diagnostics.clear() wipes the previous scanners'
                // results, leaving only the last scanner visible in the Problems panel.
                this.diagnostics.clear();
                // A proxy that swallows per-scanner clear() calls — each individual
                // scanner still calls clear() at the top of its function, but during
                // Run All we want all results to accumulate.
                const accumDiags = new Proxy(this.diagnostics, {
                    get(target, prop) {
                        if (prop === 'clear') { return () => { /* no-op during Run All */ }; }
                        const v = (target as unknown as Record<string, unknown>)[prop as string];
                        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
                    },
                }) as vscode.DiagnosticCollection;
                const cmds = msg.commands ?? [];
                for (const cmd of cmds) {
                    this.post({ type: 'auditScanStart', command: cmd });
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: 'Angular Audit: Scanning…',
                            cancellable: true,
                        },
                        async (_progress, token) => {
                            const findings = await this.runScanByCommand(cmd, token, accumDiags, allScope);
                            this.post({ type: 'auditResult', command: cmd, findings });
                        }
                    );
                }
                break;
            }

            case 'applyAuditFix': {
                if (!msg.uri || msg.startLine === undefined || msg.startCol === undefined ||
                    msg.endLine === undefined || msg.endCol === undefined || !msg.fixText) {
                    break;
                }
                try {
                    const uri = vscode.Uri.parse(msg.uri);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const range = new vscode.Range(
                        msg.startLine - 1, msg.startCol,
                        msg.endLine - 1, msg.endCol,
                    );
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(uri, range, msg.fixText);
                    const success = await vscode.workspace.applyEdit(edit);
                    if (success) {
                        this.post({ type: 'auditFixApplied', uri: msg.uri, findingIndex: msg.findingIndex });
                    } else {
                        this.postError('Could not apply fix — the file may have changed.');
                    }
                } catch (e: unknown) {
                    this.postError(`Apply fix failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                break;
            }

            case 'loadAngularTodos': {
                const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**}';
                const todoFiles = await vscode.workspace.findFiles('**/*.todo.json', EXCLUDE);
                const items: {
                    component: string; scssFile: string; fsPath: string;
                    done: number; total: number; originFiles: string[];
                }[] = [];
                for (const uri of todoFiles) {
                    try {
                        const bytes = await vscode.workspace.fs.readFile(uri);
                        const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as TodoData;
                        const allItems = data.groups.flatMap(g => g.items);
                        items.push({
                            component: data.component,
                            scssFile: data.scssFile,
                            fsPath: uri.fsPath,
                            done: allItems.filter(i => i.checked).length,
                            total: allItems.length,
                            originFiles: data.groups.map(g => g.originFile),
                        });
                    } catch { /* skip malformed files */ }
                }
                this.post({ type: 'angularTodosResult', items });
                break;
            }

            case 'openTodoReview': {
                if (!msg.fsPath) { break; }
                try {
                    const uri = vscode.Uri.file(msg.fsPath);
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as TodoData;
                    TodoReviewPanel.show(uri, data);
                } catch (e: unknown) {
                    this.postError(`Could not open todo: ${e instanceof Error ? e.message : String(e)}`);
                }
                break;
            }

            case 'openHistoryFiles': {
                if (!msg.uriList?.length) { break; }
                if (msg.uriList.length === 1) {
                    try {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(msg.uriList[0]));
                        await vscode.window.showTextDocument(doc);
                    } catch { /* deleted */ }
                } else {
                    const items = msg.uriList.map(u => ({
                        label: vscode.workspace.asRelativePath(vscode.Uri.parse(u)),
                        uri: u,
                    }));
                    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Open file…' });
                    if (pick) {
                        try {
                            const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(pick.uri));
                            await vscode.window.showTextDocument(doc);
                        } catch { /* deleted */ }
                    }
                }
                break;
            }
        }
    }

    private parseScope(msg: WebviewMessage): AuditScope {
        const s = msg.auditScopeData;
        if (!s || s.type === 'workspace') { return { type: 'workspace' }; }
        if (s.type === 'folder' && s.uriString) {
            return { type: 'folder', folderUri: vscode.Uri.parse(s.uriString) };
        }
        if (s.type === 'files' && s.uriStrings?.length) {
            return { type: 'files', fileUris: s.uriStrings.map(u => vscode.Uri.parse(u)) };
        }
        return { type: 'workspace' };
    }

    private async runScanByCommand(
        command: string,
        token: vscode.CancellationToken,
        diags: vscode.DiagnosticCollection = this.diagnostics,
        scope: AuditScope = { type: 'workspace' },
    ): Promise<AuditFinding[]> {
        // Silent progress reporter — the withProgress notification handles user feedback
        const silentProgress = { report: () => { /* no-op */ } };
        switch (command) {
            case 'dpa-rex-refacror.detectDefaultChangeDetection':
                return scanChangeDetection(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectShareReplayLeak':
                return scanShareReplayLeak(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectListTracking':
                return scanListTracking(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectHeavyImports':
                return scanHeavyImports(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectNestedSwitchMap':
                return scanNestedSwitchMap(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectTemplateFunctionCalls':
                return scanTemplateFunctionCalls(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectHttpInEffect':
                return scanHttpInEffect(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectUnmanagedSubscriptions':
                return scanUnmanagedSubscriptions(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectUnmanagedTimersAndListeners':
                return scanUnmanagedTimers(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectUnoptimizedImages':
                return scanUnoptimizedImages(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectManualChangeDetection':
                return scanManualChangeDetection(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectRepeatedExpressions':
                return scanRepeatedTemplateExpressions(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectLargeRenderedLists':
                return scanLargeRenderedLists(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectUnsafeToSignal':
                return scanUnsafeToSignal(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectNestedSubscriptions':
                return scanNestedSubscriptions(diags, silentProgress, token, scope);
            case 'dpa-rex-refacror.detectEagerlyLoadedRoutes':
                return scanEagerRoutes(diags, silentProgress, token, scope);
            default:
                return [];
        }
    }

    private resolveSteps(msg: WebviewMessage): PipelineStep[] {
        if (msg.steps && msg.steps.length > 0) { return msg.steps; }
        return [{ pattern: msg.pattern ?? '', flags: msg.flags ?? 'gi', replacement: msg.replacement ?? '' }];
    }

    private recordHistory(msg: WebviewMessage, replacements: number, filesModified: number, files: string[], changes: AppliedChange[]): void {
        const steps = this.resolveSteps(msg);
        const entry: HistoryEntry = {
            steps,
            pattern:        steps[0]?.pattern ?? '',
            flags:          steps[0]?.flags ?? 'gi',
            replacement:    steps[0]?.replacement ?? '',
            scope:          msg.scope ?? 'workspaceFolder',
            glob:           msg.glob,
            fileTypes:      msg.fileTypes,
            excludePattern: msg.excludePattern,
            replacements,
            filesModified,
            files,
            changes,
            timestamp:      new Date().toISOString(),
        };
        this.store.addHistory(entry);
        this.pushHistory();
    }

    private async buildEngineOpts(msg: WebviewMessage): Promise<EngineOptions | null> {
        const opts: EngineOptions = { fileTypes: msg.fileTypes, excludePattern: msg.excludePattern };
        if (msg.scope === 'selection') {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selection.isEmpty) {
                this.postError('No text selected. Make a selection in the editor first.');
                return null;
            }
            // Compute offsets into the CRLF-normalized text that readFileText produces.
            // editor.document.offsetAt() counts \r\n as 2, but readFileText normalizes
            // \r\n to \n, so we count each line ending as 1 to stay consistent.
            const normalizePos = (pos: vscode.Position): number => {
                let offset = pos.character;
                for (let i = 0; i < pos.line; i++) {
                    offset += editor.document.lineAt(i).text.length + 1;
                }
                return offset;
            };
            const sel = editor.selection;
            opts.selectionRange = {
                startOffset: normalizePos(sel.start),
                endOffset:   normalizePos(sel.end),
            };
        }
        return opts;
    }

    private validateSteps(steps: PipelineStep[], msg: WebviewMessage): void {
        if (steps.length === 0) { throw new Error('Pattern is required.'); }
        for (const s of steps) {
            if (!s.pattern) { throw new Error(steps.length > 1 ? 'All steps require a pattern.' : 'Pattern is required.'); }
            new RegExp(s.pattern, s.flags ?? '');
        }
    }

    private postError(message: string): void {
        this.post({ type: 'error', message });
    }
}

function escapeForRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes the TypeScript import statement line and the component class name
 * from the `imports: []` array in a component file's text.
 *
 * Handles all separator cases in the array:
 *   [A, Comp]        → [A]
 *   [Comp, A]        → [A]
 *   [Comp]           → []
 *   trailing commas  → cleaned up
 */
function removeImportFromTs(text: string, importStatement: string, componentName: string): string {
    // Remove the import statement line (try with and without trailing newline)
    text = text
        .replace(importStatement + '\n', '')
        .replace('\n' + importStatement, '')
        .replace(importStatement, '');

    // Remove the class name from the imports array — handle all separator variants
    const esc = escapeForRegex(componentName);
    text = text
        .replace(new RegExp(`,\\s*${esc}`, 'g'), '')   // ", Comp"  — preceded by comma
        .replace(new RegExp(`${esc}\\s*,\\s*`, 'g'), '') // "Comp, "  — followed by comma
        .replace(new RegExp(esc, 'g'), '');              // "Comp"    — alone in array

    return text;
}

export function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const htmlPath = path.join(extensionUri.fsPath, 'src', 'ui', 'replacePanel', 'replacePanel.html');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui', 'replacePanel', 'replacePanel.css'));
    const jsUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui', 'replacePanel', 'replacePanel.js'));
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource}`,
        `script-src ${webview.cspSource}`,
    ].join('; ');
    return fs.readFileSync(htmlPath, 'utf8')
        .replace('{{csp}}', csp)
        .replace('{{cssUri}}', cssUri.toString())
        .replace('{{jsUri}}', jsUri.toString());
}
