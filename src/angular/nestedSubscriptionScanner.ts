import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

/**
 * Using paren-depth tracking, find the matching closing ')' for the opening '('
 * at `openParenPos` in `text`. Returns the index of the closing ')' or -1 if not found.
 */
function findMatchingParen(text: string, openParenPos: number): number {
    let depth = 0;
    for (let i = openParenPos; i < text.length; i++) {
        if (text[i] === '(') { depth++; }
        else if (text[i] === ')') {
            depth--;
            if (depth === 0) { return i; }
        }
    }
    return -1;
}

/**
 * Given a text offset, return the 1-based line number.
 */
function offsetToLine(text: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === '\n') { line++; }
    }
    return line;
}

export async function scanNestedSubscriptions(
    diagnostics: vscode.DiagnosticCollection,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
): Promise<AuditFinding[]> {
    diagnostics.clear();

    const files = await vscode.workspace.findFiles('**/*.ts', `{${EXCLUDE_GLOB}}`);
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

        // Pre-screen: must contain both .subscribe and import from 'rxjs'
        if (!text.includes('.subscribe') || !/from\s+['"]rxjs['"]/.test(text)) { continue; }

        const lines = text.split('\n');
        const fileDiags: vscode.Diagnostic[] = [];

        // Track inner subscribe positions already reported to avoid double-reporting
        const visitedInnerOffsets = new Set<number>();

        // Find all outer .subscribe( positions
        const outerSubscribeRe = /\.subscribe\s*\(/g;
        let outerMatch: RegExpExecArray | null;

        while ((outerMatch = outerSubscribeRe.exec(text)) !== null) {
            const outerSubscribePos = outerMatch.index;

            // Skip if this was already flagged as an inner subscribe
            if (visitedInnerOffsets.has(outerSubscribePos)) { continue; }

            // The opening '(' is at outerMatch.index + outerMatch[0].length - 1
            const openParenPos = outerSubscribePos + outerMatch[0].length - 1;
            const closeParenPos = findMatchingParen(text, openParenPos);
            if (closeParenPos < 0) { continue; }

            // Extract the callback body text (between opening and closing parens)
            const callbackBody = text.slice(openParenPos + 1, closeParenPos);
            const outerLine = offsetToLine(text, outerSubscribePos);

            // Search for nested .subscribe( in the callback body
            const innerSubscribeRe = /\.subscribe\s*\(/g;
            let innerMatch: RegExpExecArray | null;

            while ((innerMatch = innerSubscribeRe.exec(callbackBody)) !== null) {
                const innerAbsolutePos = openParenPos + 1 + innerMatch.index;
                visitedInnerOffsets.add(innerAbsolutePos);

                const innerLine = offsetToLine(text, innerAbsolutePos);

                // Check for triple nesting inside the inner subscribe
                const innerOpenParenPos = innerAbsolutePos + innerMatch[0].length - 1;
                const innerCloseParenPos = findMatchingParen(text, innerOpenParenPos);
                let isTripleNested = false;
                if (innerCloseParenPos >= 0) {
                    const innerBody = text.slice(innerOpenParenPos + 1, innerCloseParenPos);
                    isTripleNested = /\.subscribe\s*\(/.test(innerBody);
                }

                const severity = isTripleNested
                    ? vscode.DiagnosticSeverity.Error
                    : vscode.DiagnosticSeverity.Warning;

                const msg = isTripleNested
                    ? `Triple-nested .subscribe() — severe subscription leak pattern`
                    : `Nested .subscribe() at line ${innerLine} inside outer subscribe at line ${outerLine} — inner subscription is unmanaged and leaks`;

                // Find line/col in lines array (0-based)
                const innerLineIdx = innerLine - 1;
                const lineText = lines[innerLineIdx] ?? '';
                const col = lineText.indexOf('.subscribe');
                const colStart = col < 0 ? 0 : col;
                const endCol = colStart + '.subscribe('.length;

                const range = new vscode.Range(innerLineIdx, colStart, innerLineIdx, endCol);
                const diag = new vscode.Diagnostic(range, msg, severity);
                diag.source = 'angular-perf';
                diag.code = 'E3';
                fileDiags.push(diag);
                flagged++;

                findings.push({
                    uri: uri.toString(),
                    file: vscode.workspace.asRelativePath(uri),
                    line: innerLine,
                    col: colStart,
                    endLine: innerLine,
                    endCol,
                    message: msg,
                    code: 'E3',
                    originalText: null,
                    fixText: null,
                    fixDescription:
                        'Replace nested .subscribe() with a higher-order operator:\n' +
                        '  // Before: outer$.subscribe(val => { inner$(val).subscribe(r => use(r)); });\n' +
                        '  // After:  outer$.pipe(switchMap(val => inner$(val))).subscribe(r => use(r));\n' +
                        'switchMap cancels the previous inner when outer emits. Use mergeMap for parallel, concatMap for queued, exhaustMap to ignore while busy.',
                });
            }
        }

        if (fileDiags.length > 0) {
            diagnostics.set(uri, fileDiags);
        }
    }

    vscode.window.showInformationMessage(
        `Angular Audit [E3]: Found ${flagged} nested subscription(s) across ${scanned} files.`
    );

    return findings;
}

export function registerNestedSubscriptionCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectNestedSubscriptions', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for nested subscriptions…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanNestedSubscriptions(diagnostics, progress, token);
            }
        );
    });
}
