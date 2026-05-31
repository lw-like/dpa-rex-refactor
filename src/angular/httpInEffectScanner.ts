import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';
import { AuditScope, findAuditFiles } from './auditScope';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

// Matches effect( followed by an arrow function or named function
const EFFECT_OPEN_RE = /\beffect\s*\(\s*(?:\(\s*\)\s*=>|function\s*\()/;

// HttpClient via class field: this.http.get(, this.http.post(, etc.
const HTTP_CLIENT_CALL_RE = /this\.http\.\w+\s*\(/;

// Generic HTTP verb calls
const HTTP_VERB_RE = /\.get\s*\(|\.post\s*\(|\.put\s*\(|\.delete\s*\(|\.patch\s*\(/;

export async function scanHttpInEffect(
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

        // Pre-screen: must contain both 'effect' and 'http' (case-insensitive)
        if (!/effect/i.test(text) || !/http/i.test(text)) { continue; }

        const lines = text.split('\n');
        const fileDiags: vscode.Diagnostic[] = [];

        for (let i = 0; i < lines.length; i++) {
            if (!EFFECT_OPEN_RE.test(lines[i])) { continue; }

            // Track braces from this line to find the effect body
            // The first `{` after the effect( opens the body at depth 1
            let depth = 0;
            let bodyStarted = false;
            const bodyLines: Array<{ lineIdx: number; text: string }> = [];

            for (let j = i; j < lines.length; j++) {
                const ln = lines[j];

                for (const ch of ln) {
                    if (ch === '{') {
                        depth++;
                        if (!bodyStarted) { bodyStarted = true; }
                    } else if (ch === '}') {
                        depth--;
                    }
                }

                if (bodyStarted && j > i) {
                    bodyLines.push({ lineIdx: j, text: ln });
                } else if (bodyStarted && j === i) {
                    // The opening line itself — only add the part after the first `{`
                    const bracePos = ln.indexOf('{');
                    if (bracePos !== -1) {
                        bodyLines.push({ lineIdx: j, text: ln.slice(bracePos + 1) });
                    }
                }

                // Body closed
                if (bodyStarted && depth <= 0) { break; }
            }

            // Scan body lines for HTTP calls
            for (let bi = 0; bi < bodyLines.length; bi++) {
                const { lineIdx, text: bodyLine } = bodyLines[bi];

                const isHttpClientCall = HTTP_CLIENT_CALL_RE.test(bodyLine);

                // For generic verb calls, require 'http' context in same or preceding 3 body lines
                let isVerbCallWithHttpContext = false;
                if (!isHttpClientCall && HTTP_VERB_RE.test(bodyLine)) {
                    const contextStart = Math.max(0, bi - 3);
                    const contextText = bodyLines.slice(contextStart, bi + 1).map(b => b.text).join('\n');
                    isVerbCallWithHttpContext = /http/i.test(contextText);
                }

                if (isHttpClientCall || isVerbCallWithHttpContext) {
                    const col = 0;
                    const endCol = bodyLine.length;
                    const msg = 'HTTP call inside effect() re-fires on every signal change. Use resource() (Angular 19+) or toSignal(toObservable(sig).pipe(switchMap(...))) for Angular 17–18.';
                    const range = new vscode.Range(lineIdx, col, lineIdx, endCol);
                    const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
                    diag.source = 'angular-perf';
                    diag.code = 'D1';
                    fileDiags.push(diag);
                    flagged++;

                    findings.push({
                        uri: uri.toString(),
                        file: vscode.workspace.asRelativePath(uri),
                        line: lineIdx + 1,
                        col,
                        endLine: lineIdx + 1,
                        endCol,
                        message: msg,
                        code: 'D1',
                        originalText: null,
                        fixText: null,
                        fixDescription: 'Replace effect(() => { this.http.get(...).subscribe(...) }) with: private data = resource({ request: () => this.mySignal(), loader: ({ request }) => fetch(...) }); — Angular 19+. For Angular 17–18 use toSignal(toObservable(this.mySignal()).pipe(switchMap(val => this.http.get(val)))).',
                    });
                }
            }
        }

        if (fileDiags.length > 0) {
            diagnostics.set(uri, fileDiags);
        }
    }

    vscode.window.showInformationMessage(
        `Angular Audit [D1]: Found ${flagged} HTTP call(s) inside effect() across ${scanned} TypeScript files.`
    );

    return findings;
}

export function registerHttpInEffectCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectHttpInEffect', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for HTTP calls inside effect()…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanHttpInEffect(diagnostics, progress, token);
            }
        );
    });
}
