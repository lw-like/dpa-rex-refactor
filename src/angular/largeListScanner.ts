import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';
import { AuditScope, findAuditFiles } from './auditScope';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

// Number of top-level commas to consider a "large" array
const LARGE_ARRAY_COMMA_THRESHOLD = 50;
// Max lines to scan after the opening bracket
const MAX_SCAN_LINES = 50;

/**
 * Count commas at brace depth 1 (top-level of the array literal)
 * scanning up to MAX_SCAN_LINES lines after the bracket line.
 */
function countTopLevelCommas(lines: string[], startLine: number, startCol: number): number {
    let depth = 0;
    let commas = 0;

    for (let li = startLine; li < Math.min(lines.length, startLine + MAX_SCAN_LINES); li++) {
        const lineStart = li === startLine ? startCol : 0;
        const text = lines[li].slice(lineStart);
        for (const ch of text) {
            if (ch === '[') { depth++; }
            else if (ch === ']') {
                depth--;
                if (depth <= 0) { return commas; }
            } else if (ch === ',' && depth === 1) {
                commas++;
            }
        }
    }

    return commas;
}

/**
 * Extract property names typed as T[] or Array<T> from a TS class body.
 */
function extractArrayPropertyNames(text: string): string[] {
    const names: string[] = [];
    // Matches: (optional modifiers) propertyName: Type[] or Array<T> or signal/computed<T[]>
    const re = /(?:private|public|protected|readonly|\s)+(\w+)\s*(?::\s*(?:\w+\s*\[\]|Array\s*<[^>]+>)|(?:!:\s*(?:\w+\s*\[\]|Array\s*<[^>]+>))|=\s*(?:signal|computed)\s*<[^>]*\[\])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        if (m[1]) { names.push(m[1]); }
    }
    return names;
}

export async function scanLargeRenderedLists(
    diagnostics: vscode.DiagnosticCollection,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
    scope?: AuditScope,
): Promise<AuditFinding[]> {
    diagnostics.clear();

    const tsFiles = await findAuditFiles('ts', scope);
    const htmlFiles = await findAuditFiles('html', scope);
    const total = tsFiles.length + htmlFiles.length;
    let scanned = 0;
    let flagged = 0;
    const findings: AuditFinding[] = [];
    const fileDiagMap = new Map<string, vscode.Diagnostic[]>();

    const addDiag = (uri: vscode.Uri, range: vscode.Range, msg: string, severity: vscode.DiagnosticSeverity) => {
        const diag = new vscode.Diagnostic(range, msg, severity);
        diag.source = 'angular-perf';
        diag.code = 'C2';
        const existing = fileDiagMap.get(uri.toString()) ?? [];
        existing.push(diag);
        fileDiagMap.set(uri.toString(), existing);
    };

    // ── Vector 1: Large inline array literals in TS ──────────────────────────
    for (const uri of tsFiles) {
        if (token.isCancellationRequested) { break; }

        progress.report({ increment: (1 / total) * 100, message: path.basename(uri.fsPath) });
        scanned++;

        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        // Pre-screen: file contains "= ["
        if (!text.includes('= [')) { continue; }

        const lines = text.split('\n');

        // Match array assignments: (private|public|protected|readonly) propName... = [
        const arrayAssignRe = /(?:private|public|protected|readonly)\s+\w+[^=\n]*=\s*\[/g;
        let m: RegExpExecArray | null;
        while ((m = arrayAssignRe.exec(text)) !== null) {
            // Find which line/col the '[' sits at
            const bracketAbsPos = m.index + m[0].length - 1; // position of '['
            let runningLen = 0;
            let bracketLine = 0;
            let bracketCol = 0;
            for (let i = 0; i < lines.length; i++) {
                const lineLen = lines[i].length + 1;
                if (runningLen + lineLen > bracketAbsPos) {
                    bracketLine = i;
                    bracketCol = bracketAbsPos - runningLen;
                    break;
                }
                runningLen += lineLen;
            }

            const commaCount = countTopLevelCommas(lines, bracketLine, bracketCol);
            if (commaCount > LARGE_ARRAY_COMMA_THRESHOLD) {
                const lineText = lines[bracketLine] ?? '';
                const assignStart = lineText.search(/(?:private|public|protected|readonly)/);
                const col = assignStart < 0 ? 0 : assignStart;
                const range = new vscode.Range(bracketLine, col, bracketLine, lineText.length);
                const msg = `Large inline array (${commaCount}+ items) iterated in template — consider virtual scrolling for lists over 50 items`;
                addDiag(uri, range, msg, vscode.DiagnosticSeverity.Warning);
                flagged++;

                findings.push({
                    uri: uri.toString(),
                    file: vscode.workspace.asRelativePath(uri),
                    line: bracketLine + 1,
                    col,
                    endLine: bracketLine + 1,
                    endCol: lineText.length,
                    message: msg,
                    code: 'C2',
                    originalText: null,
                    fixText: null,
                    fixDescription: 'Use <cdk-virtual-scroll-viewport itemSize="48"> with *cdkVirtualFor from @angular/cdk/scrolling to render only visible items',
                });
            }
        }
    }

    // ── Vector 2: T[] properties iterated without cdk-virtual-scroll ────────
    for (const uri of tsFiles) {
        if (token.isCancellationRequested) { break; }

        progress.report({ increment: (1 / total) * 100, message: path.basename(uri.fsPath) });
        scanned++;

        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        // Pre-screen: must be a component file
        if (!/@Component/.test(text)) { continue; }

        const propNames = extractArrayPropertyNames(text);
        if (propNames.length === 0) { continue; }

        // Find the paired .html template (same base name, same directory)
        const tsBase = uri.fsPath.replace(/\.ts$/, '');
        const htmlFsPath = tsBase + '.html';

        // Look for the html file in the already-fetched list
        const htmlUri = htmlFiles.find(h => h.fsPath === htmlFsPath);
        if (!htmlUri) { continue; }

        const htmlDoc = await vscode.workspace.openTextDocument(htmlUri);
        const htmlText = htmlDoc.getText();

        // Skip if already using virtual scroll
        if (htmlText.includes('cdk-virtual-scroll-viewport')) { continue; }
        // Skip if using *cdkVirtualFor (correct solution, not our pattern)
        if (htmlText.includes('cdkVirtualFor')) { continue; }

        const htmlLines = htmlText.split('\n');

        for (const propName of propNames) {
            // Check if this prop appears inside a *ngFor or @for block
            const loopRe = new RegExp(`(?:\\*ngFor|@for)[^>\\n]*\\b${propName}\\b`);
            if (!loopRe.test(htmlText)) { continue; }

            // Find first occurrence line in HTML
            for (let i = 0; i < htmlLines.length; i++) {
                if (/\*ngFor|@for/.test(htmlLines[i]) && new RegExp(`\\b${propName}\\b`).test(htmlLines[i])) {
                    const lineText = htmlLines[i];
                    const col = 0;
                    const range = new vscode.Range(i, col, i, lineText.length);
                    const msg = `Array property "${propName}" is iterated in template without cdk-virtual-scroll-viewport`;
                    addDiag(htmlUri, range, msg, vscode.DiagnosticSeverity.Warning);
                    flagged++;

                    findings.push({
                        uri: htmlUri.toString(),
                        file: vscode.workspace.asRelativePath(htmlUri),
                        line: i + 1,
                        col,
                        endLine: i + 1,
                        endCol: lineText.length,
                        message: msg,
                        code: 'C2',
                        originalText: null,
                        fixText: null,
                        fixDescription: 'Wrap the list in <cdk-virtual-scroll-viewport> and replace *ngFor/*@for with *cdkVirtualFor. Import ScrollingModule from @angular/cdk/scrolling.',
                    });
                    break;
                }
            }
        }
    }

    // Apply diagnostics
    for (const [uriStr, diags] of fileDiagMap) {
        diagnostics.set(vscode.Uri.parse(uriStr), diags);
    }

    vscode.window.showInformationMessage(
        `Angular Audit [C2]: Found ${flagged} large list issue(s) across ${scanned} files.`
    );

    return findings;
}

export function registerLargeListCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectLargeRenderedLists', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for large rendered lists…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanLargeRenderedLists(diagnostics, progress, token);
            }
        );
    });
}
