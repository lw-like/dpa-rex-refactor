import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

const CLASS_START_RE = /\bclass\s+(\w+)/;

function extractClassBodies(lines: string[]): Array<{ className: string; startLine: number; endLine: number }> {
    const results: Array<{ className: string; startLine: number; endLine: number }> = [];

    for (let i = 0; i < lines.length; i++) {
        const m = CLASS_START_RE.exec(lines[i]);
        if (!m) { continue; }

        const className = m[1];
        let depth = 0;
        let classEndLine = i;

        for (let j = i; j < lines.length; j++) {
            const ln = lines[j];
            for (const ch of ln) {
                if (ch === '{') { depth++; }
                else if (ch === '}') { depth--; }
            }
            if (depth <= 0 && j > i) {
                classEndLine = j;
                break;
            }
        }

        results.push({ className, startLine: i, endLine: classEndLine });
    }

    return results;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns true if the .subscribe() on `lineIdx` is locally managed — either:
 *
 * a) The subscribe call is directly wrapped in an .add() call on the same line:
 *      this.subscription.add(this.obs$.subscribe(...))
 *
 * b) The result is assigned to a named variable that is later passed to:
 *    - any method on `this` (covers sanitize(), addSub(), collect(), etc.)
 *    - .add() or .push() (composite Subscription / array patterns)
 *
 *      const sub1 = this.obs$.subscribe(...);
 *      this.sanitize(sub1);          // ← detected
 *      this.subscription.add(sub1);  // ← detected
 *      this.subs.push(sub1);         // ← detected
 */
function isSubscribeManaged(lines: string[], lineIdx: number, classBodyText: string): boolean {
    const lineText = lines[lineIdx];

    // (a) Direct wrapper: .add( appears before .subscribe( on the same line
    const addIdx  = lineText.indexOf('.add(');
    const subIdx  = lineText.indexOf('.subscribe(');
    if (addIdx >= 0 && addIdx < subIdx) { return true; }

    // (b) Assignment + later cleanup
    const assignMatch = /(?:const|let|var)\s+(\w+)\s*=/.exec(lineText);
    if (!assignMatch) { return false; }
    const v = escapeRe(assignMatch[1]);

    return (
        // this.sanitize(sub1), this.addSub(sub1), this.cleanup(sub1), …
        new RegExp(`this\\.\\w+\\s*\\(\\s*${v}\\b`).test(classBodyText) ||
        // this.subscription.add(sub1), this.subs.add(sub1), …
        new RegExp(`\\.add\\s*\\(\\s*${v}\\b`).test(classBodyText) ||
        // this.subscriptions.push(sub1), this.subs.push(sub1), …
        new RegExp(`\\.push\\s*\\(\\s*${v}\\b`).test(classBodyText)
    );
}

export async function scanUnmanagedSubscriptions(
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

    for (const uri of files) {
        if (token.isCancellationRequested) { break; }

        progress.report({ increment: (1 / total) * 100, message: path.basename(uri.fsPath) });
        scanned++;

        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        if (!text.includes('.subscribe')) { continue; }
        if (uri.fsPath.endsWith('.spec.ts')) { continue; }

        const lines = text.split('\n');
        const fileDiags: vscode.Diagnostic[] = [];
        const classBodies = extractClassBodies(lines);

        for (const { className, startLine, endLine } of classBodies) {
            const bodyText = lines.slice(startLine, endLine + 1).join('\n');

            // ── class-level cleanup signals ──────────────────────────────────
            const hasTakeUntilDestroyed = /takeUntilDestroyed/.test(bodyText);
            const hasDestroyRef         = /DestroyRef/.test(bodyText);
            const hasUnsubscribe        = /\.unsubscribe\s*\(/.test(bodyText);
            const hasTakeUntilOnly      = /\btakeUntil\s*\(/.test(bodyText) && !hasTakeUntilDestroyed;

            // Composite Subscription pattern: this.subscription.add(…) / this.subs.add(…)
            // Paired with parent/local ngOnDestroy that calls subscription.unsubscribe().
            const hasCompositeAdd =
                /\bthis\.subscriptions?\s*\.add\s*\(/.test(bodyText) ||
                /\bthis\.subs?\s*\.add\s*\(/.test(bodyText);

            // If every subscribe in this class is globally covered, skip
            if (hasTakeUntilDestroyed || hasDestroyRef || hasUnsubscribe || hasCompositeAdd) { continue; }

            // ── per-subscribe-call check ─────────────────────────────────────
            for (let i = startLine; i <= endLine; i++) {
                if (!lines[i].includes('.subscribe(')) { continue; }

                // Check whether THIS specific subscribe is locally managed
                if (isSubscribeManaged(lines, i, bodyText)) { continue; }

                const col    = lines[i].indexOf('.subscribe(');
                const endCol = col + '.subscribe('.length;

                if (hasTakeUntilOnly) {
                    const msg = `${className} uses takeUntil() — consider migrating to takeUntilDestroyed() (Angular 16+) to eliminate the ngOnDestroy boilerplate.`;
                    const range = new vscode.Range(i, col, i, endCol);
                    const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Information);
                    diag.source = 'angular-perf';
                    diag.code = 'F1';
                    fileDiags.push(diag);
                    flagged++;

                    findings.push({
                        uri: uri.toString(),
                        file: vscode.workspace.asRelativePath(uri),
                        line: i + 1,
                        col,
                        endLine: i + 1,
                        endCol,
                        message: msg,
                        code: 'F1',
                        originalText: null,
                        fixText: null,
                        fixDescription: 'Replace the Subject + takeUntil(this.destroy$) + ngOnDestroy pattern with pipe(takeUntilDestroyed()). The DestroyRef is injected automatically.',
                    });
                } else {
                    // Auto-fix: insert .pipe(takeUntilDestroyed()) before .subscribe(
                    // when there is no existing .pipe( before it on the same line.
                    const beforeSub   = lines[i].slice(0, col);
                    const hasPipeBefore = /\.pipe\s*\(/.test(beforeSub);
                    const autoFixOrig = hasPipeBefore ? null : '.subscribe(';
                    const autoFixText = hasPipeBefore ? null : '.pipe(takeUntilDestroyed()).subscribe(';

                    const msg = `Subscription in ${className} has no cleanup — the observable may keep running after the component/service is destroyed.`;
                    const range = new vscode.Range(i, col, i, endCol);
                    const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
                    diag.source = 'angular-perf';
                    diag.code = 'F1';
                    fileDiags.push(diag);
                    flagged++;

                    findings.push({
                        uri: uri.toString(),
                        file: vscode.workspace.asRelativePath(uri),
                        line: i + 1,
                        col,
                        endLine: i + 1,
                        endCol,
                        message: msg,
                        code: 'F1',
                        originalText: autoFixOrig,
                        fixText: autoFixText,
                        fixDescription: autoFixOrig
                            ? "After applying fix, add: import { takeUntilDestroyed } from '@angular/core/rxjs-interop'; (Angular 16+). DestroyRef is injected automatically in any injection context."
                            : "Add takeUntilDestroyed() to the existing pipe: obs$.pipe(..., takeUntilDestroyed()).subscribe(...). Import from '@angular/core/rxjs-interop'. No ngOnDestroy needed.",
                    });
                }
            }
        }

        if (fileDiags.length > 0) {
            diagnostics.set(uri, fileDiags);
        }
    }

    vscode.window.showInformationMessage(
        `Angular Audit [F1]: Found ${flagged} unmanaged subscription(s) across ${scanned} TypeScript files.`
    );

    return findings;
}

export function registerUnmanagedSubscriptionCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectUnmanagedSubscriptions', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for unmanaged subscriptions…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanUnmanagedSubscriptions(diagnostics, progress, token);
            }
        );
    });
}
