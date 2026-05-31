import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';
import { AuditScope, findAuditFiles } from './auditScope';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

/**
 * Join lines from the img tag opening up to the closing `>`, limited to
 * lookAhead lines past the opening line.
 */
function resolveTagText(lines: string[], startIdx: number, lookAhead: number): string {
    const parts: string[] = [];
    for (let i = startIdx; i < lines.length && i <= startIdx + lookAhead; i++) {
        parts.push(lines[i]);
        if (lines[i].includes('>')) { break; }
    }
    return parts.join(' ');
}

export async function scanUnoptimizedImages(
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

        // Pre-screen: skip files without any <img
        if (!text.includes('<img')) { continue; }

        const lines = text.split('\n');
        const fileDiags: vscode.Diagnostic[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Detect <img opening tags on this line
            if (!/\<img\b/i.test(line)) { continue; }

            // Resolve the full tag text (multi-line support, up to 10 lines ahead)
            const tagText = resolveTagText(lines, i, 10);

            // Must have src= or [src]= to be considered
            const hasSrc = /\bsrc\s*=/.test(tagText) || /\[src\]\s*=/.test(tagText);
            if (!hasSrc) { continue; }

            // Suppress if already using NgOptimizedImage
            const hasNgSrc = /\bngSrc\s*=/.test(tagText) || /\[ngSrc\]\s*=/.test(tagText);
            if (hasNgSrc) { continue; }

            // Suppress base64 inline data URIs
            const dataUriMatch = /\bsrc\s*=\s*["']data:/.test(tagText) || /\[src\]\s*=\s*["']data:/.test(tagText);
            if (dataUriMatch) { continue; }

            const col = line.indexOf('<img');
            if (col === -1) { continue; }

            // Auto-fix: replace src= with ngSrc= when the attribute is on the same
            // line as <img (multi-line tags are left as suggestion-only).
            const srcMatch = /(\[?)src(\]?)\s*=/.exec(line);
            let findingCol    = col;
            let findingEndCol = col + 4;
            let autoFixOrig: string | null = null;
            let autoFixText: string | null = null;

            if (srcMatch) {
                const srcToken = srcMatch[0];  // "src=", "[src]=", "src =", etc.
                findingCol    = srcMatch.index;
                findingEndCol = findingCol + srcToken.length;
                autoFixOrig   = srcToken;
                autoFixText   = srcToken.replace(/\bsrc\b/, 'ngSrc');
            }

            const range = new vscode.Range(i, findingCol, i, findingEndCol);
            const msg = '<img> uses src= without NgOptimizedImage — missing automatic lazy loading, responsive srcset, and LCP priority hints.';
            const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
            diag.source = 'angular-perf';
            diag.code = 'I1';
            fileDiags.push(diag);
            flagged++;

            findings.push({
                uri: uri.toString(),
                file: vscode.workspace.asRelativePath(uri),
                line: i + 1,
                col: findingCol,
                endLine: i + 1,
                endCol: findingEndCol,
                message: msg,
                code: 'I1',
                originalText: autoFixOrig,
                fixText: autoFixText,
                fixDescription: autoFixOrig
                    ? "After applying fix: (1) add NgOptimizedImage to @Component imports (from '@angular/common'); (2) add width and height attributes to the <img> tag; (3) for above-the-fold images add the priority attribute."
                    : "Replace src=\"...\" with ngSrc=\"...\" and add NgOptimizedImage to @Component imports (from '@angular/common'). Add width and height attributes.",
            });
        }

        if (fileDiags.length > 0) {
            diagnostics.set(uri, fileDiags);
        }
    }

    vscode.window.showInformationMessage(
        `Angular Audit [I1]: Found ${flagged} unoptimized image(s) across ${scanned} HTML files.`
    );

    return findings;
}

export function registerUnoptimizedImageCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectUnoptimizedImages', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for unoptimized images…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanUnoptimizedImages(diagnostics, progress, token);
            }
        );
    });
}
