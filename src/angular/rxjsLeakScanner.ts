import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

const SHARE_REPLAY_NUMERIC = /shareReplay\s*\(\s*\d+\s*\)/g;
const SHARE_REPLAY_OBJECT = /shareReplay\s*\(\s*\{[^}]*\}/g;
const SHARE_REPLAY_BARE = /shareReplay\s*\(\s*\)/g;

const WARNING_MESSAGE =
    'shareReplay() without refCount: true holds a permanent subscription. Use shareReplay({ bufferSize: 1, refCount: true }).';

const FIX_TEXT = 'shareReplay({ bufferSize: 1, refCount: true })';
const FIX_DESC = 'Replace with shareReplay({ bufferSize: 1, refCount: true })';

/**
 * Extracts the full shareReplay(...) call text from a line starting at the
 * position of 'shareReplay'. Returns null if not found.
 */
function extractShareReplayCall(line: string, startIdx: number): string | null {
    // Find the opening paren
    const parenIdx = line.indexOf('(', startIdx);
    if (parenIdx < 0) { return null; }
    let depth = 0;
    for (let i = parenIdx; i < line.length; i++) {
        if (line[i] === '(') { depth++; }
        else if (line[i] === ')') {
            depth--;
            if (depth === 0) {
                return line.slice(startIdx, i + 1);
            }
        }
    }
    return null;
}

export async function scanShareReplayLeak(
    diagnostics: vscode.DiagnosticCollection,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
): Promise<AuditFinding[]> {
    diagnostics.clear();

    const files = await vscode.workspace.findFiles('**/*.ts', `{${EXCLUDE_GLOB}}`);
    const total = files.length;
    let scanned = 0;
    let flagged = 0;
    const findings: AuditFinding[] = [];
    const outputChannel = vscode.window.createOutputChannel('Angular Performance Audit');

    outputChannel.appendLine(`[E2] shareReplay() Leak Scan — ${new Date().toLocaleTimeString()}`);

    for (const uri of files) {
        if (token.isCancellationRequested) { break; }

        progress.report({ increment: (1 / total) * 100, message: path.basename(uri.fsPath) });
        scanned++;

        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        if (!text.includes('shareReplay')) { continue; }

        const fileDiags: vscode.Diagnostic[] = [];
        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.includes('shareReplay')) { continue; }

            let matched = false;

            SHARE_REPLAY_NUMERIC.lastIndex = 0;
            if (SHARE_REPLAY_NUMERIC.test(line)) { matched = true; }
            SHARE_REPLAY_NUMERIC.lastIndex = 0;

            if (!matched) {
                SHARE_REPLAY_BARE.lastIndex = 0;
                if (SHARE_REPLAY_BARE.test(line)) { matched = true; }
                SHARE_REPLAY_BARE.lastIndex = 0;
            }

            if (!matched) {
                SHARE_REPLAY_OBJECT.lastIndex = 0;
                if (SHARE_REPLAY_OBJECT.test(line)) {
                    SHARE_REPLAY_OBJECT.lastIndex = 0;
                    const objectBlock = lines.slice(i, Math.min(i + 6, lines.length)).join(' ');
                    const objectMatch = /shareReplay\s*\(\s*\{([^}]*)\}/.exec(objectBlock);
                    if (objectMatch && !/refCount\s*:\s*true/.test(objectMatch[1])) {
                        matched = true;
                    }
                }
                SHARE_REPLAY_OBJECT.lastIndex = 0;
            }

            if (matched) {
                const col = line.indexOf('shareReplay');
                const range = new vscode.Range(i, col, i, col + 'shareReplay'.length);
                const diag = new vscode.Diagnostic(range, WARNING_MESSAGE, vscode.DiagnosticSeverity.Warning);
                diag.source = 'angular-perf';
                diag.code = 'E2';
                fileDiags.push(diag);
                flagged++;
                outputChannel.appendLine(`  ${uri.fsPath}:${i + 1} — ${WARNING_MESSAGE}`);

                // Extract the full call text for the diff
                const callText = extractShareReplayCall(line, col);
                findings.push({
                    uri: uri.toString(),
                    file: vscode.workspace.asRelativePath(uri),
                    line: i + 1,
                    col,
                    endLine: i + 1,
                    endCol: callText ? col + callText.length : col + 'shareReplay'.length,
                    message: WARNING_MESSAGE,
                    code: 'E2',
                    originalText: callText ?? null,
                    fixText: FIX_TEXT,
                    fixDescription: FIX_DESC,
                });
            }
        }

        if (fileDiags.length > 0) {
            diagnostics.set(uri, fileDiags);
        }
    }

    outputChannel.appendLine('');
    outputChannel.appendLine(`Scanned ${scanned} TypeScript files. Found ${flagged} shareReplay() leak pattern(s).`);
    outputChannel.show(true);

    vscode.window.showInformationMessage(
        `Angular Audit [E2]: Found ${flagged} shareReplay() leak pattern(s) across ${scanned} files.`
    );

    return findings;
}

export function registerShareReplayLeakCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectShareReplayLeak', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for shareReplay() memory leaks…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanShareReplayLeak(diagnostics, progress, token);
            }
        );
    });
}
