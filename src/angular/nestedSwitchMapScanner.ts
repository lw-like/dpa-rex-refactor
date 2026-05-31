import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';
const LOOKAHEAD_LINES = 40;

interface ChainFinding {
    outerLine: number;
    depth: number;
    uri: vscode.Uri;
}

function indentOf(line: string): number {
    let i = 0;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) { i++; }
    return i;
}

function detectSwitchMapChains(lines: string[]): ChainFinding[] {
    const findings: ChainFinding[] = [];
    const switchMapPattern = /switchMap\s*\(/;
    const visited = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
        if (!switchMapPattern.test(lines[i])) { continue; }
        if (visited.has(i)) { continue; }

        const outerIndent = indentOf(lines[i]);
        let depth = 1;
        const chainLines = [i];

        const limit = Math.min(i + LOOKAHEAD_LINES, lines.length);
        for (let j = i + 1; j < limit; j++) {
            if (!switchMapPattern.test(lines[j])) { continue; }
            const innerIndent = indentOf(lines[j]);
            if (innerIndent >= outerIndent) {
                depth++;
                chainLines.push(j);
                visited.add(j);
            }
        }

        if (depth >= 2) {
            findings.push({ outerLine: i, depth, uri: vscode.Uri.file('') });
            for (const l of chainLines.slice(1)) { visited.add(l); }
        }
    }

    return findings;
}

export async function scanNestedSwitchMap(
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
    outputChannel.appendLine(`[E1] Nested switchMap Scan — ${new Date().toLocaleTimeString()}`);

    for (const uri of files) {
        if (token.isCancellationRequested) { break; }

        progress.report({ increment: (1 / total) * 100, message: path.basename(uri.fsPath) });
        scanned++;

        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        if (!text.includes('switchMap')) { continue; }

        const lines = text.split('\n');
        const rawFindings = detectSwitchMapChains(lines);

        if (rawFindings.length === 0) { continue; }

        const fileDiags: vscode.Diagnostic[] = [];

        for (const f of rawFindings) {
            const lineIdx = f.outerLine;
            const lineText = lines[lineIdx] ?? '';
            const col = lineText.indexOf('switchMap');
            const range = new vscode.Range(lineIdx, col, lineIdx, col + 'switchMap'.length);
            const msg = `Nested switchMap chains (depth ${f.depth}) reduce readability and make error handling brittle. Consider flattening with forkJoin or separate streams.`;
            const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
            diag.source = 'angular-perf';
            diag.code = 'E1';
            fileDiags.push(diag);
            flagged++;

            outputChannel.appendLine(`  ${uri.fsPath}:${lineIdx + 1} — depth ${f.depth} switchMap chain`);

            findings.push({
                uri: uri.toString(),
                file: vscode.workspace.asRelativePath(uri),
                line: lineIdx + 1,
                col,
                endLine: lineIdx + 1,
                endCol: col + 'switchMap'.length,
                message: msg,
                code: 'E1',
                originalText: null,
                fixText: null,
                fixDescription:
                    `Depth-${f.depth} nested switchMap. If inner requests are independent, use forkJoin:\n` +
                    `  // Before: outer$.pipe(switchMap(a => inner$(a).pipe(switchMap(b => final$(b)))))\n` +
                    `  // After:  outer$.pipe(switchMap(a => forkJoin({ b: inner$(a), c: other$(a) })))\n` +
                    `Use combineLatest for ongoing streams, concatMap to preserve order, mergeMap for parallel execution.`,
            });
        }

        diagnostics.set(uri, fileDiags);
    }

    outputChannel.appendLine('');
    outputChannel.appendLine(`Scanned ${scanned} TypeScript files. Found ${flagged} nested switchMap chain(s).`);
    outputChannel.show(true);

    vscode.window.showInformationMessage(
        `Angular Audit [E1]: Found ${flagged} nested switchMap chain(s) across ${scanned} files.`
    );

    return findings;
}

export function registerNestedSwitchMapCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectNestedSwitchMap', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for nested switchMap chains…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanNestedSwitchMap(diagnostics, progress, token);
            }
        );
    });
}
