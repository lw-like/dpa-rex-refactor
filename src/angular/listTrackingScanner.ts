import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';
import { AuditScope, findAuditFiles } from './auditScope';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

const NG_FOR_WITHOUT_TRACK = /\*ngFor="([^"]*)"/g;
const AT_FOR_INDEX_TRACK = /@for\s*\(([^;]+);\s*track\s+\$index\b/g;

/**
 * Extracts the loop variable name from a @for expression.
 * e.g. "item of items()" → "item"
 */
function extractForItemVar(expr: string): string {
    const m = /^\s*(\w+)\s+of\s+/.exec(expr.trim());
    return m ? m[1] : 'item';
}

export async function scanListTracking(
    diagnostics: vscode.DiagnosticCollection,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
    scope?: AuditScope,
): Promise<AuditFinding[]> {
    diagnostics.clear();

    const files = await findAuditFiles('html', scope);
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

        if (!text.includes('ngFor') && !text.includes('@for')) { continue; }

        const fileDiags: vscode.Diagnostic[] = [];
        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Pass 1: *ngFor without trackBy
            NG_FOR_WITHOUT_TRACK.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = NG_FOR_WITHOUT_TRACK.exec(line)) !== null) {
                const attrValue = m[1];
                if (!attrValue.includes('trackBy')) {
                    const col = m.index;
                    const range = new vscode.Range(i, col, i, col + m[0].length);
                    const msg = '*ngFor without trackBy causes full list re-render on every change. Add trackBy: to a stable unique identifier.';
                    const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
                    diag.source = 'angular-perf';
                    diag.code = 'C1-ngFor';
                    fileDiags.push(diag);
                    flagged++;

                    findings.push({
                        uri: uri.toString(),
                        file: vscode.workspace.asRelativePath(uri),
                        line: i + 1,
                        col,
                        endLine: i + 1,
                        endCol: col + m[0].length,
                        message: msg,
                        code: 'C1',
                        originalText: null,
                        fixText: null,
                        fixDescription: 'Add trackBy: myTrackFn to *ngFor and implement trackById(index: number, item: T): any { return item.id; }',
                    });
                }
            }

            // Pass 2: @for with track $index
            AT_FOR_INDEX_TRACK.lastIndex = 0;
            while ((m = AT_FOR_INDEX_TRACK.exec(line)) !== null) {
                const itemVar = extractForItemVar(m[1]);
                const col = m.index;
                // Find the position of "track $index" within the match
                const trackIdx = m[0].lastIndexOf('track $index');
                const trackColStart = col + trackIdx;
                const trackColEnd = trackColStart + 'track $index'.length;
                const range = new vscode.Range(i, col, i, col + m[0].length);
                const msg = 'track $index is only safe for immutable append-only lists. Use a stable unique property (e.g. track item.id) for mutable or reorderable lists.';
                const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
                diag.source = 'angular-perf';
                diag.code = 'C1-index';
                fileDiags.push(diag);
                flagged++;

                findings.push({
                    uri: uri.toString(),
                    file: vscode.workspace.asRelativePath(uri),
                    line: i + 1,
                    col: trackColStart,
                    endLine: i + 1,
                    endCol: trackColEnd,
                    message: msg,
                    code: 'C1',
                    originalText: 'track $index',
                    fixText: `track ${itemVar}.id`,
                    fixDescription: `Replace track $index with track ${itemVar}.id`,
                });
            }
        }

        if (fileDiags.length > 0) {
            diagnostics.set(uri, fileDiags);
        }
    }

    vscode.window.showInformationMessage(
        `Angular Audit [C1]: Found ${flagged} list tracking issue(s) across ${scanned} HTML files.`
    );

    return findings;
}

export function registerListTrackingCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectListTracking', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning list tracking issues…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanListTracking(diagnostics, progress, token);
            }
        );
    });
}
