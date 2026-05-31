import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

export async function isZonelessApp(): Promise<boolean> {
    const configFiles = await vscode.workspace.findFiles(
        '{**/app.config.ts,**/main.ts}',
        `{${EXCLUDE_GLOB}}`
    );
    for (const uri of configFiles) {
        const doc = await vscode.workspace.openTextDocument(uri);
        if (/provideZonelessChangeDetection|provideExperimentalZonelessChangeDetection/.test(doc.getText())) {
            return true;
        }
    }
    return false;
}

export async function scanChangeDetection(
    diagnostics: vscode.DiagnosticCollection,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
): Promise<AuditFinding[]> {
    diagnostics.clear();

    const zoneless = await isZonelessApp();
    if (zoneless) {
        vscode.window.showInformationMessage(
            'Angular Audit: provideZonelessChangeDetection detected — Default CD strategy is not a performance issue in this app.'
        );
        return [];
    }

    const files = await vscode.workspace.findFiles('**/*.ts', `{${EXCLUDE_GLOB}}`);
    const total = files.length;
    let scanned = 0;
    let flagged = 0;
    const fileDiagMap = new Map<string, vscode.Diagnostic[]>();
    const findings: AuditFinding[] = [];

    for (const uri of files) {
        if (token.isCancellationRequested) { break; }

        progress.report({ increment: (1 / total) * 100, message: path.basename(uri.fsPath) });
        scanned++;

        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        if (!/\@Component\s*\(/.test(text)) { continue; }

        const lines = text.split('\n');
        const fileDiags: vscode.Diagnostic[] = [];

        let inComponent = false;
        let braceDepth = 0;
        let decoratorStartLine = -1;
        let hasChangeDetection = false;
        let hasExplicitDefault = false;
        let explicitDefaultLine = -1;

        const flush = () => {
            if (decoratorStartLine < 0) { return; }
            if (hasExplicitDefault) {
                const lineIdx = explicitDefaultLine;
                const lineText = lines[lineIdx] ?? '';
                const range = new vscode.Range(lineIdx, 0, lineIdx, lineText.length);
                const diag = new vscode.Diagnostic(
                    range,
                    'Component uses ChangeDetectionStrategy.Default. Consider OnPush for better performance.',
                    vscode.DiagnosticSeverity.Warning
                );
                diag.source = 'angular-perf';
                diag.code = 'A1';
                fileDiags.push(diag);
                flagged++;

                // auto-fix: replace .Default with .OnPush on that line
                findings.push({
                    uri: uri.toString(),
                    file: vscode.workspace.asRelativePath(uri),
                    line: lineIdx + 1,
                    col: 0,
                    endLine: lineIdx + 1,
                    endCol: lineText.length,
                    message: 'Component uses ChangeDetectionStrategy.Default. Consider OnPush for better performance.',
                    code: 'A1',
                    originalText: lineText,
                    fixText: lineText.replace('ChangeDetectionStrategy.Default', 'ChangeDetectionStrategy.OnPush'),
                    fixDescription: 'Replace ChangeDetectionStrategy.Default with ChangeDetectionStrategy.OnPush',
                });
            } else if (!hasChangeDetection) {
                const lineIdx = decoratorStartLine;
                const lineText = lines[lineIdx] ?? '';
                const range = new vscode.Range(lineIdx, 0, lineIdx, lineText.length);
                const diag = new vscode.Diagnostic(
                    range,
                    'Component has no changeDetection property — Default strategy is applied implicitly. Add ChangeDetectionStrategy.OnPush.',
                    vscode.DiagnosticSeverity.Warning
                );
                diag.source = 'angular-perf';
                diag.code = 'A1';
                fileDiags.push(diag);
                flagged++;

                // no auto-fix — adding a property requires understanding decorator structure
                findings.push({
                    uri: uri.toString(),
                    file: vscode.workspace.asRelativePath(uri),
                    line: lineIdx + 1,
                    col: 0,
                    endLine: lineIdx + 1,
                    endCol: lineText.length,
                    message: 'Component has no changeDetection property — Default strategy is applied implicitly. Add ChangeDetectionStrategy.OnPush.',
                    code: 'A1',
                    originalText: null,
                    fixText: null,
                    fixDescription: 'Add changeDetection: ChangeDetectionStrategy.OnPush to the @Component decorator',
                });
            }
            inComponent = false;
            braceDepth = 0;
            decoratorStartLine = -1;
            hasChangeDetection = false;
            hasExplicitDefault = false;
            explicitDefaultLine = -1;
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (!inComponent) {
                if (/\@Component\s*\(/.test(line)) {
                    inComponent = true;
                    decoratorStartLine = i;
                    braceDepth = 0;
                    hasChangeDetection = false;
                    hasExplicitDefault = false;
                }
            }

            if (inComponent) {
                braceDepth += (line.match(/\{/g) ?? []).length;
                braceDepth -= (line.match(/\}/g) ?? []).length;

                if (/changeDetection\s*:/.test(line)) {
                    hasChangeDetection = true;
                    if (/ChangeDetectionStrategy\.Default/.test(line)) {
                        hasExplicitDefault = true;
                        explicitDefaultLine = i;
                    }
                }

                if (braceDepth <= 0 && decoratorStartLine >= 0) {
                    flush();
                }
            }
        }

        if (fileDiags.length > 0) {
            fileDiagMap.set(uri.toString(), fileDiags);
            diagnostics.set(uri, fileDiags);
        }
    }

    const outputChannel = vscode.window.createOutputChannel('Angular Performance Audit');
    outputChannel.appendLine(`[A1] Change Detection Scan — ${new Date().toLocaleTimeString()}`);
    outputChannel.appendLine(`Scanned ${scanned} TypeScript files.`);
    outputChannel.appendLine(`Found ${flagged} component(s) using Default (or implicit Default) CD strategy.`);
    outputChannel.appendLine('');
    for (const [uriStr, diags] of fileDiagMap) {
        const fsPath = vscode.Uri.parse(uriStr).fsPath;
        for (const d of diags) {
            outputChannel.appendLine(`  ${fsPath}:${d.range.start.line + 1} — ${d.message}`);
        }
    }
    outputChannel.show(true);

    vscode.window.showInformationMessage(
        `Angular Audit [A1]: Found ${flagged} Default CD component(s) across ${scanned} files.`
    );

    return findings;
}

export function registerChangeDetectionCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectDefaultChangeDetection', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning change detection strategies…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanChangeDetection(diagnostics, progress, token);
            }
        );
    });
}
