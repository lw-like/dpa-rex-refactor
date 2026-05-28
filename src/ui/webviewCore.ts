import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PatternStore, HistoryEntry, AppliedChange, PipelineStep } from '../patternStore';
import {
    previewReplace, applyReplace, applySelected, revertChanges,
    previewPipeline, applyPipeline,
    Scope, MatchEntry, EngineOptions,
} from '../replaceEngine';

export interface WebviewMessage {
    type: string;
    name?: string;
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
}

export class MessageHandler {
    constructor(
        private store: PatternStore,
        private readonly post: (msg: object) => void,
    ) {}

    pushHistory(): void {
        this.post({ type: 'history', entries: this.store.getHistory() });
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

            case 'preview': {
                try {
                    const steps = this.resolveSteps(msg);
                    this.validateSteps(steps, msg);
                    const opts = await this.buildEngineOpts(msg);
                    if (opts === null) { break; }
                    if (steps.length > 1) {
                        const result = await previewPipeline(steps, msg.scope as Scope, msg.glob ?? '', msg.contextLines ?? 3, opts);
                        this.post({ type: 'pipelinePreviewResult', ...result });
                    } else {
                        const s = steps[0];
                        const result = await previewReplace(s.pattern, s.flags, s.replacement, msg.scope as Scope, msg.glob ?? '', msg.contextLines ?? 2, opts);
                        this.post({ type: 'previewResult', ...result });
                    }
                } catch (e: unknown) {
                    this.postError(e instanceof Error ? e.message : String(e));
                }
                break;
            }

            case 'applySelected': {
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
            opts.selectionRange = {
                startOffset: editor.document.offsetAt(editor.selection.start),
                endOffset:   editor.document.offsetAt(editor.selection.end),
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
