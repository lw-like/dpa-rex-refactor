import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';
import { AuditScope, findAuditFiles } from './auditScope';
import { isZonelessApp } from './changeDetectionScanner';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

/**
 * Extract all class body ranges from the file lines.
 * Returns { startLine, endLine } (0-based, inclusive).
 */
function extractClassBodies(lines: string[]): Array<{ startLine: number; endLine: number }> {
    const results: Array<{ startLine: number; endLine: number }> = [];

    for (let i = 0; i < lines.length; i++) {
        if (!/\bclass\s+\w+/.test(lines[i])) { continue; }

        let depth = 0;
        let classEndLine = i;
        let started = false;

        for (let j = i; j < lines.length; j++) {
            for (const ch of lines[j]) {
                if (ch === '{') { depth++; started = true; }
                else if (ch === '}') { depth--; }
            }
            if (started && depth <= 0) {
                classEndLine = j;
                break;
            }
        }

        results.push({ startLine: i, endLine: classEndLine });
    }

    return results;
}

export async function scanManualChangeDetection(
    diagnostics: vscode.DiagnosticCollection,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
    scope?: AuditScope,
): Promise<AuditFinding[]> {
    diagnostics.clear();

    const zoneless = await isZonelessApp();

    const files = await findAuditFiles('ts', scope);
    const tsFiles = files.filter(u => !u.fsPath.endsWith('.spec.ts'));
    const total = tsFiles.length;
    let scanned = 0;
    let flagged = 0;
    const findings: AuditFinding[] = [];

    for (const uri of tsFiles) {
        if (token.isCancellationRequested) { break; }

        progress.report({ increment: (1 / total) * 100, message: path.basename(uri.fsPath) });
        scanned++;

        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        // Pre-screen: skip if NONE of the three patterns present
        if (!text.includes('detectChanges') && !text.includes('tick') && !text.includes('markForCheck')) {
            continue;
        }

        const lines = text.split('\n');
        const fileDiags: vscode.Diagnostic[] = [];
        const classBodies = extractClassBodies(lines);
        const hasGlobalOnPush = /ChangeDetectionStrategy\.OnPush/.test(text);

        for (const { startLine, endLine } of classBodies) {
            const bodyText = lines.slice(startLine, endLine + 1).join('\n');

            const hasCdrInject = /inject\s*\(\s*ChangeDetectorRef\s*\)/.test(bodyText);
            const hasCdrType = /:\s*ChangeDetectorRef/.test(bodyText);
            const cdrConfirmed = hasCdrInject || hasCdrType;

            const hasAppRefInject = /inject\s*\(\s*ApplicationRef\s*\)/.test(bodyText);
            const hasAppRefType = /:\s*ApplicationRef/.test(bodyText);
            const appRefConfirmed = hasAppRefInject || hasAppRefType;

            // Pattern A — .detectChanges()
            if (cdrConfirmed) {
                const detectChangesRe = /\.detectChanges\s*\(\s*\)/g;
                let m: RegExpExecArray | null;
                while ((m = detectChangesRe.exec(bodyText)) !== null) {
                    // Find the absolute line index
                    const matchOffset = m.index;
                    let runningLen = 0;
                    let matchLine = startLine;
                    for (let i = startLine; i <= endLine; i++) {
                        const lineLen = lines[i].length + 1; // +1 for \n
                        if (runningLen + lineLen > matchOffset) {
                            matchLine = i;
                            break;
                        }
                        runningLen += lineLen;
                    }

                    // Skip calls within ngOnDestroy (check 20 lines above)
                    const contextStart = Math.max(startLine, matchLine - 20);
                    const contextAbove = lines.slice(contextStart, matchLine + 1).join('\n');
                    if (/ngOnDestroy/.test(contextAbove)) { continue; }

                    const lineText = lines[matchLine] ?? '';
                    const col = lineText.indexOf('.detectChanges');
                    const colStart = col < 0 ? 0 : col;
                    const endCol = colStart + '.detectChanges()'.length;

                    const msg = 'detectChanges() called manually — this bypasses Angular\'s reactive update model.';
                    const range = new vscode.Range(matchLine, colStart, matchLine, endCol);
                    const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
                    diag.source = 'angular-perf';
                    diag.code = 'A2';
                    fileDiags.push(diag);
                    flagged++;

                    findings.push({
                        uri: uri.toString(),
                        file: vscode.workspace.asRelativePath(uri),
                        line: matchLine + 1,
                        col: colStart,
                        endLine: matchLine + 1,
                        endCol,
                        message: msg,
                        code: 'A2',
                        originalText: null,
                        fixText: null,
                        fixDescription: 'Prefer signal()/computed() for reactive state, or markForCheck() on specific OnPush leaf components instead of detectChanges()',
                    });
                }
            }

            // Pattern B — ApplicationRef.tick()
            if (appRefConfirmed) {
                const tickRe = /\.tick\s*\(\s*\)/g;
                let m: RegExpExecArray | null;
                while ((m = tickRe.exec(bodyText)) !== null) {
                    const matchOffset = m.index;
                    let runningLen = 0;
                    let matchLine = startLine;
                    for (let i = startLine; i <= endLine; i++) {
                        const lineLen = lines[i].length + 1;
                        if (runningLen + lineLen > matchOffset) {
                            matchLine = i;
                            break;
                        }
                        runningLen += lineLen;
                    }

                    const lineText = lines[matchLine] ?? '';
                    const col = lineText.indexOf('.tick');
                    const colStart = col < 0 ? 0 : col;
                    const endCol = colStart + '.tick()'.length;

                    const severity = zoneless
                        ? vscode.DiagnosticSeverity.Information
                        : vscode.DiagnosticSeverity.Warning;

                    const msg = 'ApplicationRef.tick() forces a full application change detection cycle.';
                    const range = new vscode.Range(matchLine, colStart, matchLine, endCol);
                    const diag = new vscode.Diagnostic(range, msg, severity);
                    diag.source = 'angular-perf';
                    diag.code = 'A2';
                    fileDiags.push(diag);
                    flagged++;

                    findings.push({
                        uri: uri.toString(),
                        file: vscode.workspace.asRelativePath(uri),
                        line: matchLine + 1,
                        col: colStart,
                        endLine: matchLine + 1,
                        endCol,
                        message: msg,
                        code: 'A2',
                        originalText: null,
                        fixText: null,
                        fixDescription: 'ApplicationRef.tick() forces a full application check. Prefer signals and OnPush to make change detection fine-grained and automatic.',
                    });
                }
            }

            // Pattern C — .markForCheck() without OnPush in the file
            if (cdrConfirmed && !hasGlobalOnPush) {
                const markRe = /\.markForCheck\s*\(\s*\)/g;
                let m: RegExpExecArray | null;
                while ((m = markRe.exec(bodyText)) !== null) {
                    const matchOffset = m.index;
                    let runningLen = 0;
                    let matchLine = startLine;
                    for (let i = startLine; i <= endLine; i++) {
                        const lineLen = lines[i].length + 1;
                        if (runningLen + lineLen > matchOffset) {
                            matchLine = i;
                            break;
                        }
                        runningLen += lineLen;
                    }

                    const lineText = lines[matchLine] ?? '';
                    const col = lineText.indexOf('.markForCheck');
                    const colStart = col < 0 ? 0 : col;
                    const endCol = colStart + '.markForCheck()'.length;

                    const msg = 'markForCheck() has no effect without OnPush; add changeDetection: ChangeDetectionStrategy.OnPush to the @Component decorator.';
                    const range = new vscode.Range(matchLine, colStart, matchLine, endCol);
                    const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Information);
                    diag.source = 'angular-perf';
                    diag.code = 'A2';
                    fileDiags.push(diag);
                    flagged++;

                    findings.push({
                        uri: uri.toString(),
                        file: vscode.workspace.asRelativePath(uri),
                        line: matchLine + 1,
                        col: colStart,
                        endLine: matchLine + 1,
                        endCol,
                        message: msg,
                        code: 'A2',
                        originalText: null,
                        fixText: null,
                        fixDescription: 'Add changeDetection: ChangeDetectionStrategy.OnPush to the @Component decorator. With OnPush, markForCheck() notifies Angular to check this component on the next cycle.',
                    });
                }
            }
        }

        if (fileDiags.length > 0) {
            diagnostics.set(uri, fileDiags);
        }
    }

    const outputChannel = vscode.window.createOutputChannel('Angular Performance Audit');
    outputChannel.appendLine(`[A2] Manual Change Detection Scan — ${new Date().toLocaleTimeString()}`);
    outputChannel.appendLine(`Scanned ${scanned} TypeScript files. Zoneless: ${zoneless}.`);
    outputChannel.appendLine(`Found ${flagged} manual change detection trigger(s).`);
    outputChannel.show(true);

    vscode.window.showInformationMessage(
        `Angular Audit [A2]: Found ${flagged} manual CD trigger(s) across ${scanned} files.`
    );

    return findings;
}

export function registerManualChangeDetectionCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectManualChangeDetection', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for manual CD triggers…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanManualChangeDetection(diagnostics, progress, token);
            }
        );
    });
}
