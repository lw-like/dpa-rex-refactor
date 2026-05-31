import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';
import { AuditScope, findAuditFiles } from './auditScope';
import { collectInputFields, detectMutabilityIssues, findClassBodyRange } from './mutabilityDetector';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

/** Derives the risks[] for an A1 finding using the shared mutability detector. */
function computeOnPushRisks(lines: string[], decoratorEndLine: number): string[] {
    const range = findClassBodyRange(lines, decoratorEndLine);
    if (!range) { return []; }
    const inputFields = collectInputFields(lines, range.start, range.end);
    const issues = detectMutabilityIssues(lines, range.start, range.end, inputFields);

    // Deduplicate by message prefix so the badge stays concise.
    const seen = new Set<string>();
    const risks: string[] = [];
    for (const issue of issues) {
        if (!seen.has(issue.message)) { seen.add(issue.message); risks.push(issue.message); }
    }

    // Additional class-level signals that are not line-specific (kept from original analysis)
    const classBody = lines.slice(range.start, range.end + 1).join('\n');
    if (/\bsetTimeout\b|\bsetInterval\b/.test(classBody)) {
        risks.push('setTimeout / setInterval callbacks need markForCheck() or NgZone.run() under OnPush');
    }
    if (/detectChanges\(\)|markForCheck\(\)/.test(classBody)) {
        risks.push('detectChanges() / markForCheck() already present — verify these still trigger correctly');
    }
    if (/ChangeDetectorRef/.test(classBody) && !/markForCheck\(\)/.test(classBody)) {
        risks.push('ChangeDetectorRef injected but markForCheck() not called — may produce stale views');
    }
    if (/\bnew EventEmitter/.test(classBody) && !/\@Output[\s\S]{0,80}EventEmitter/.test(classBody)) {
        risks.push('EventEmitter without @Output — if used as a state stream, OnPush will not react to it');
    }
    return risks;
}

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
    scope?: AuditScope,
): Promise<AuditFinding[]> {
    diagnostics.clear();

    const zoneless = await isZonelessApp();
    if (zoneless) {
        vscode.window.showInformationMessage(
            'Angular Audit: provideZonelessChangeDetection detected — Default CD strategy is not a performance issue in this app.'
        );
        return [];
    }

    const files = await findAuditFiles('ts', scope);
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

        const flush = (decoratorEndLine: number) => {
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
                const risks1 = computeOnPushRisks(lines, decoratorEndLine);
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
                    risks: risks1,
                });
            } else if (!hasChangeDetection) {
                const diagMsg = 'Component has no changeDetection property — Default strategy is applied implicitly. Add ChangeDetectionStrategy.OnPush.';

                // Diagnostic points at the @Component({ line
                const diagLineIdx = decoratorStartLine;
                const diagLineText = lines[diagLineIdx] ?? '';
                const range = new vscode.Range(diagLineIdx, 0, diagLineIdx, diagLineText.length);
                const diag = new vscode.Diagnostic(range, diagMsg, vscode.DiagnosticSeverity.Warning);
                diag.source = 'angular-perf';
                diag.code = 'A1';
                fileDiags.push(diag);
                flagged++;

                // Find the line containing the opening `{` of the decorator object
                let braceLineIdx = decoratorStartLine;
                for (let k = decoratorStartLine; k < Math.min(decoratorStartLine + 5, lines.length); k++) {
                    if (lines[k].includes('{')) { braceLineIdx = k; break; }
                }
                const braceLine  = lines[braceLineIdx] ?? '';
                const braceCol   = braceLine.indexOf('{');
                const afterBrace = braceLine.slice(braceCol + 1).trim();

                let fixLineIdx: number;
                let origText: string;
                let fixedText: string;

                // Preferred: insert changeDetection AFTER the selector property so
                // selector stays first, which is the Angular convention.
                let selectorLineIdx = -1;
                for (let k = braceLineIdx + 1; k < Math.min(braceLineIdx + 30, lines.length); k++) {
                    if (/\bselector\s*:/.test(lines[k])) { selectorLineIdx = k; break; }
                    if (/^\s*[})]/.test(lines[k])) { break; }
                }

                if (selectorLineIdx >= 0) {
                    const selLine = lines[selectorLineIdx];
                    const indent  = selLine.match(/^(\s*)/)?.[1] ?? '  ';
                    fixLineIdx = selectorLineIdx;
                    origText   = selLine;
                    fixedText  = `${selLine}\n${indent}changeDetection: ChangeDetectionStrategy.OnPush,`;
                } else if (afterBrace === '') {
                    // No selector — insert as first property (Shape 1 fallback).
                    fixLineIdx     = braceLineIdx + 1;
                    const nextLine = lines[fixLineIdx] ?? '';
                    const indent   = nextLine.match(/^(\s*)/)?.[1] ?? '  ';
                    origText  = nextLine;
                    fixedText = `${indent}changeDetection: ChangeDetectionStrategy.OnPush,\n${nextLine}`;
                } else {
                    // Shape 2: `@Component({ selector: '...', ...` all on one line.
                    fixLineIdx = braceLineIdx;
                    origText   = braceLine;
                    fixedText  = braceLine.slice(0, braceCol + 1) +
                                 ' changeDetection: ChangeDetectionStrategy.OnPush,' +
                                 braceLine.slice(braceCol + 1);
                }

                const risks2 = computeOnPushRisks(lines, decoratorEndLine);
                findings.push({
                    uri: uri.toString(),
                    file: vscode.workspace.asRelativePath(uri),
                    line: fixLineIdx + 1,
                    col: 0,
                    endLine: fixLineIdx + 1,
                    endCol: origText.length,
                    message: diagMsg,
                    code: 'A1',
                    originalText: origText,
                    fixText: fixedText,
                    fixDescription: "Inserts changeDetection: ChangeDetectionStrategy.OnPush as the first @Component property. If ChangeDetectionStrategy is not yet imported from '@angular/core', it is added automatically.",
                    risks: risks2,
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
                    flush(i);
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
