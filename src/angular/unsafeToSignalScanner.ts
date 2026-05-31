import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';
import { AuditScope, findAuditFiles } from './auditScope';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

/**
 * Extract all paren-depth-tracked argument text starting right after the opening '('
 * at `startIndex` in `text`. Returns the inner argument string, or null if malformed.
 */
function extractParenArgs(text: string, startIndex: number): string | null {
    let depth = 0;
    let start = -1;

    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') {
            depth++;
            if (depth === 1) { start = i + 1; }
        } else if (ch === ')') {
            depth--;
            if (depth === 0) {
                return start >= 0 ? text.slice(start, i) : null;
            }
        }
    }
    return null;
}

/**
 * Split argument string at top-level commas (depth 0 inside the args).
 * Handles nested parens, brackets, braces.
 */
function splitTopLevelArgs(argsText: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';

    for (const ch of argsText) {
        if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; }
        else if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; }
        else if (ch === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) { parts.push(current.trim()); }
    return parts;
}

/**
 * Scan import aliases for toSignal from '@angular/core/rxjs-interop'.
 * Returns a Set of all in-scope names that resolve to toSignal.
 */
function collectToSignalAliases(text: string): Set<string> {
    const aliases = new Set<string>(['toSignal']);

    const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]@angular\/core\/rxjs-interop['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(text)) !== null) {
        const specifiers = m[1];
        // Match: toSignal as foo
        const aliasRe = /\btoSignal\s+as\s+(\w+)/g;
        let am: RegExpExecArray | null;
        while ((am = aliasRe.exec(specifiers)) !== null) {
            aliases.add(am[1]);
        }
    }

    return aliases;
}

/**
 * Check up to 3 lines above and the current line for a typed Signal<T> (not Signal<T | undefined>).
 * Returns true if typed as non-nullable Signal<T>.
 */
function isTypedAsNonNullableSignal(lines: string[], lineIdx: number): boolean {
    const start = Math.max(0, lineIdx - 3);
    const context = lines.slice(start, lineIdx + 1).join('\n');
    // Signal<T> where T does not contain '| undefined' or 'undefined |'
    // We look for Signal< followed by something that does NOT include 'undefined'
    const signalTypeRe = /Signal\s*<([^>]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = signalTypeRe.exec(context)) !== null) {
        const typeParam = m[1];
        if (!typeParam.includes('undefined')) {
            return true;
        }
    }
    return false;
}

export async function scanUnsafeToSignal(
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

        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        // Pre-screen: skip files without toSignal
        if (!text.includes('toSignal')) { continue; }

        const lines = text.split('\n');
        const aliases = collectToSignalAliases(text);
        const fileDiags: vscode.Diagnostic[] = [];

        for (const alias of aliases) {
            // Find all call sites: alias followed by (
            const callRe = new RegExp(`\\b${alias}\\s*\\(`, 'g');
            let m: RegExpExecArray | null;

            while ((m = callRe.exec(text)) !== null) {
                // The ( is at m.index + m[0].length - 1
                const parenPos = m.index + m[0].length - 1;
                const argsText = extractParenArgs(text, parenPos);
                if (argsText === null) { continue; }

                const args = splitTopLevelArgs(argsText);

                // 2+ arguments → has options, skip
                if (args.length >= 2) { continue; }

                // Single argument — potentially unsafe
                const singleArg = args[0] ?? '';

                // Find the line index of this match
                let runningLen = 0;
                let matchLine = 0;
                for (let i = 0; i < lines.length; i++) {
                    const lineLen = lines[i].length + 1;
                    if (runningLen + lineLen > m.index) {
                        matchLine = i;
                        break;
                    }
                    runningLen += lineLen;
                }

                // Determine severity based on typing
                const typedNonNullable = isTypedAsNonNullableSignal(lines, matchLine);
                const severity = typedNonNullable
                    ? vscode.DiagnosticSeverity.Error
                    : vscode.DiagnosticSeverity.Warning;

                const msg = typedNonNullable
                    ? `toSignal() typed as Signal<T> but produces Signal<T | undefined> before first emission — this is a type safety bug`
                    : `toSignal() with no options produces Signal<T | undefined>; the signal is undefined before the first emission`;

                const lineText = lines[matchLine] ?? '';
                const colInLine = m.index - runningLen;
                const colStart = Math.max(0, colInLine);

                // The full matched substring: alias + ( + argsText + )
                const fullMatch = `${alias}(${argsText})`;
                const endCol = Math.min(colStart + fullMatch.length, lineText.length);

                const range = new vscode.Range(matchLine, colStart, matchLine, endCol);
                const diag = new vscode.Diagnostic(range, msg, severity);
                diag.source = 'angular-perf';
                diag.code = 'D2';
                fileDiags.push(diag);
                flagged++;

                // Auto-fix only when the full call is on one line and single arg has no deep nesting
                const callIsOnOneLine = !fullMatch.includes('\n');
                const argHasDeepNesting = (singleArg.match(/\(/g) ?? []).length > 1;
                const canAutoFix = callIsOnOneLine && !argHasDeepNesting;

                findings.push({
                    uri: uri.toString(),
                    file: vscode.workspace.asRelativePath(uri),
                    line: matchLine + 1,
                    col: colStart,
                    endLine: matchLine + 1,
                    endCol,
                    message: msg,
                    code: 'D2',
                    originalText: canAutoFix ? fullMatch : null,
                    fixText: canAutoFix ? `${alias}(${singleArg}, { initialValue: undefined })` : null,
                    fixDescription: 'Add { initialValue: <yourDefault> } to avoid undefined, or { requireSync: true } only if the source always emits synchronously (e.g. BehaviorSubject, of(value))',
                });
            }
        }

        if (fileDiags.length > 0) {
            diagnostics.set(uri, fileDiags);
        }
    }

    vscode.window.showInformationMessage(
        `Angular Audit [D2]: Found ${flagged} unsafe toSignal() call(s) across ${scanned} files.`
    );

    return findings;
}

export function registerUnsafeToSignalCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectUnsafeToSignal', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for unsafe toSignal() usage…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanUnsafeToSignal(diagnostics, progress, token);
            }
        );
    });
}
