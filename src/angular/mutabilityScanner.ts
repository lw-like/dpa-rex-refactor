import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';
import { AuditScope, findAuditFiles } from './auditScope';
import {
    collectInputFields,
    detectMutabilityIssues,
    extractClassBodies,
} from './mutabilityDetector';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

export async function scanMutabilityIssues(
    diagnostics: vscode.DiagnosticCollection,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
    scope?: AuditScope,
): Promise<AuditFinding[]> {
    diagnostics.clear();

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

        const doc  = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        // Pre-screen: must reference mutation-related patterns to avoid reading every file in detail
        if (
            !text.includes('.push(') &&
            !text.includes('.splice(') &&
            !text.includes('.sort(') &&
            !text.includes('.reverse(') &&
            !text.includes('Object.assign(') &&
            !/this\.\w+\.\w+\s*=/.test(text)
        ) { continue; }

        const lines     = text.split('\n');
        const classes   = extractClassBodies(lines);
        const fileDiags: vscode.Diagnostic[] = [];

        for (const { className, startLine, endLine } of classes) {
            // Only flag classes that are Angular-decorated (component, directive, injectable)
            const contextStart = Math.max(0, startLine - 5);
            const decoratorContext = lines.slice(contextStart, startLine).join('\n');
            if (!/@Component|@Directive|@Injectable|@Pipe/.test(decoratorContext)) { continue; }

            const inputFields = collectInputFields(lines, startLine, endLine);
            const issues = detectMutabilityIssues(lines, startLine, endLine, inputFields);

            for (const issue of issues) {
                const lineText = lines[issue.lineIdx] ?? '';
                const severity = issue.severity === 'high'
                    ? vscode.DiagnosticSeverity.Warning
                    : vscode.DiagnosticSeverity.Information;

                const range = new vscode.Range(issue.lineIdx, issue.col, issue.lineIdx, issue.endCol);
                const diag  = new vscode.Diagnostic(range, issue.message, severity);
                diag.source = 'angular-perf';
                diag.code   = 'M1';
                fileDiags.push(diag);
                flagged++;

                findings.push({
                    uri:          uri.toString(),
                    file:         vscode.workspace.asRelativePath(uri),
                    line:         issue.lineIdx + 1,
                    col:          issue.col,
                    endLine:      issue.lineIdx + 1,
                    endCol:       issue.endCol,
                    message:      issue.message,
                    code:         'M1',
                    originalText: null,
                    fixText:      null,
                    fixDescription: buildFixDescription(issue.message, lineText),
                });
            }
        }

        if (fileDiags.length > 0) {
            diagnostics.set(uri, fileDiags);
        }
    }

    vscode.window.showInformationMessage(
        `Angular Audit [M1]: Found ${flagged} mutability issue(s) across ${scanned} TypeScript files.`
    );

    return findings;
}

function buildFixDescription(message: string, line: string): string {
    if (message.includes('.push(') || message.includes('.splice(') ||
        message.includes('.sort(')  || message.includes('.reverse(')) {
        return 'Replace in-place array mutation with an immutable operation: this.items = [...this.items, item] instead of push; this.items = [...this.items].sort(...) instead of sort.';
    }
    if (message.includes('Object.assign')) {
        return 'Replace Object.assign(this.obj, changes) with this.obj = { ...this.obj, ...changes } to produce a new reference.';
    }
    if (message.includes('.prop =') || message.includes('mutates object')) {
        return 'Produce a new object reference: this.obj = { ...this.obj, property: newValue } instead of this.obj.property = newValue.';
    }
    if (message.includes('ActivatedRoute')) {
        return 'Add markForCheck() inside the subscribe callback, or replace the subscription with an async pipe in the template.';
    }
    return 'Replace mutation with an immutable operation that produces a new object or array reference.';
}

export function registerMutabilityCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectMutabilityIssues', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for mutability issues…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanMutabilityIssues(diagnostics, progress, token);
            }
        );
    });
}
