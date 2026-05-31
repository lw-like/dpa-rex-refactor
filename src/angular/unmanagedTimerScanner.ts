import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';
import { AuditScope, findAuditFiles } from './auditScope';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

// Matches `class Foo` (start of a class declaration)
const CLASS_START_RE = /\bclass\s+(\w+)/;

/**
 * Extract all class body ranges from the file lines.
 * Each entry is { className, startLine, endLine } (0-based, inclusive).
 */
function extractClassBodies(lines: string[]): Array<{ className: string; startLine: number; endLine: number }> {
    const results: Array<{ className: string; startLine: number; endLine: number }> = [];

    for (let i = 0; i < lines.length; i++) {
        const m = CLASS_START_RE.exec(lines[i]);
        if (!m) { continue; }

        const className = m[1];
        let depth = 0;
        let classEndLine = i;

        for (let j = i; j < lines.length; j++) {
            const ln = lines[j];
            for (const ch of ln) {
                if (ch === '{') { depth++; }
                else if (ch === '}') { depth--; }
            }
            if (depth <= 0 && j > i) {
                classEndLine = j;
                break;
            }
        }

        results.push({ className, startLine: i, endLine: classEndLine });
    }

    return results;
}

/**
 * Returns true if the call-site line index is within `windowSize` lines of
 * a matching pattern in the class body lines.
 */
function isNearPattern(
    lines: string[],
    callLineIdx: number,
    classStartLine: number,
    classEndLine: number,
    pattern: RegExp,
    windowSize: number,
): boolean {
    const from = Math.max(classStartLine, callLineIdx - windowSize);
    const to = Math.min(classEndLine, callLineIdx + windowSize);
    for (let i = from; i <= to; i++) {
        if (pattern.test(lines[i])) { return true; }
    }
    return false;
}

export async function scanUnmanagedTimers(
    diagnostics: vscode.DiagnosticCollection,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
    scope?: AuditScope,
): Promise<AuditFinding[]> {
    diagnostics.clear();

    const files = await findAuditFiles('ts', scope);
    const total = files.length;
    let scanned = 0;
    let flagged = 0;
    const findings: AuditFinding[] = [];

    for (const uri of files) {
        if (token.isCancellationRequested) { break; }

        progress.report({ increment: (1 / total) * 100, message: path.basename(uri.fsPath) });
        scanned++;

        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        // Pre-screen: must mention setInterval or addEventListener
        if (!/setInterval|addEventListener/.test(text)) { continue; }

        const lines = text.split('\n');
        const fileDiags: vscode.Diagnostic[] = [];
        const classBodies = extractClassBodies(lines);

        for (const { className, startLine, endLine } of classBodies) {
            const bodyText = lines.slice(startLine, endLine + 1).join('\n');

            // ── setInterval checks ──────────────────────────────────────────
            const hasClearInterval = /clearInterval/.test(bodyText);

            if (!hasClearInterval) {
                const setIntervalRe = /\bsetInterval\s*\(/g;
                for (let i = startLine; i <= endLine; i++) {
                    setIntervalRe.lastIndex = 0;
                    if (!setIntervalRe.test(lines[i])) { continue; }

                    // Guard: skip if within 20 lines of ngOnDestroy or DestroyRef
                    const nearDestroy = isNearPattern(lines, i, startLine, endLine, /ngOnDestroy\s*\(|DestroyRef/, 20);
                    if (nearDestroy) { continue; }

                    const col = lines[i].indexOf('setInterval');
                    const endCol = col + 'setInterval'.length;
                    const msg = `setInterval() in ${className} has no clearInterval() — interval continues running after the component/service is destroyed.`;
                    const range = new vscode.Range(i, col, i, endCol);
                    const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
                    diag.source = 'angular-perf';
                    diag.code = 'F2';
                    fileDiags.push(diag);
                    flagged++;

                    findings.push({
                        uri: uri.toString(),
                        file: vscode.workspace.asRelativePath(uri),
                        line: i + 1,
                        col,
                        endLine: i + 1,
                        endCol,
                        message: msg,
                        code: 'F2',
                        originalText: null,
                        fixText: null,
                        fixDescription: 'Store the interval ID: private intervalId = setInterval(...). Call clearInterval(this.intervalId) in ngOnDestroy, or inject DestroyRef and call this.destroyRef.onDestroy(() => clearInterval(this.intervalId)).',
                    });
                }
            }

            // ── window/document.addEventListener checks ────────────────────
            const hasRemoveEventListener = /removeEventListener/.test(bodyText);
            const hasDestroyRef = /DestroyRef/.test(bodyText);

            if (!hasRemoveEventListener && !hasDestroyRef) {
                const addListenerRe = /\b(?:window|document)\.addEventListener\s*\(/g;
                for (let i = startLine; i <= endLine; i++) {
                    addListenerRe.lastIndex = 0;
                    const lm = addListenerRe.exec(lines[i]);
                    if (!lm) { continue; }

                    // Guard: skip if within ngOnDestroy block (20 lines above)
                    const nearNgOnDestroy = isNearPattern(lines, i, startLine, endLine, /ngOnDestroy\s*\(/, 20);
                    if (nearNgOnDestroy) { continue; }

                    const col = lm.index;
                    const matchedWord = lm[0].startsWith('window') ? 'window.addEventListener' : 'document.addEventListener';
                    const endCol = col + matchedWord.length;
                    const msg = `window.addEventListener() in ${className} has no removeEventListener() — the listener accumulates on repeated component instantiation.`;
                    const range = new vscode.Range(i, col, i, endCol);
                    const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
                    diag.source = 'angular-perf';
                    diag.code = 'F2';
                    fileDiags.push(diag);
                    flagged++;

                    findings.push({
                        uri: uri.toString(),
                        file: vscode.workspace.asRelativePath(uri),
                        line: i + 1,
                        col,
                        endLine: i + 1,
                        endCol,
                        message: msg,
                        code: 'F2',
                        originalText: null,
                        fixText: null,
                        fixDescription: 'Store the handler as a class field (arrow function) and call window.removeEventListener(event, this.handler) in ngOnDestroy, or use DestroyRef.onDestroy(() => window.removeEventListener(...)).',
                    });
                }
            }
        }

        if (fileDiags.length > 0) {
            diagnostics.set(uri, fileDiags);
        }
    }

    vscode.window.showInformationMessage(
        `Angular Audit [F2]: Found ${flagged} unmanaged timer/listener(s) across ${scanned} TypeScript files.`
    );

    return findings;
}

export function registerUnmanagedTimerCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectUnmanagedTimersAndListeners', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for unmanaged timers and event listeners…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanUnmanagedTimers(diagnostics, progress, token);
            }
        );
    });
}
