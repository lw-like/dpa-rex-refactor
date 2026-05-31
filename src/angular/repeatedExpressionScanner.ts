import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';
import { AuditScope, findAuditFiles } from './auditScope';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

// Minimum expression length to consider
const MIN_EXPR_LENGTH = 8;
// Minimum occurrences to flag
const MIN_OCCURRENCES = 3;

// Bare identifier: no dot, no parens, no pipe
const BARE_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// Single signal call: word followed by ()
const SINGLE_SIGNAL_CALL_RE = /^\w+\(\)$/;

function normalizeExpr(expr: string): string {
    return expr.trim().replace(/\s+/g, ' ');
}

/**
 * Derive a short variable name from an expression for use in @let suggestions.
 * Takes the last dot-delimited segment, strips () and pipe characters.
 */
function deriveName(expr: string): string {
    const segments = expr.split('.');
    const last = segments[segments.length - 1] ?? expr;
    return last.replace(/\(.*$/, '').replace(/\s*\|.*$/, '').trim() || 'value';
}

/**
 * Collect all @let RHS expressions from the template to build a skip set.
 */
function collectLetExpressions(text: string): Set<string> {
    const skip = new Set<string>();
    const letRe = /@let\s+\w+\s*=\s*([^;]+);/g;
    let m: RegExpExecArray | null;
    while ((m = letRe.exec(text)) !== null) {
        skip.add(normalizeExpr(m[1]));
    }
    return skip;
}

/**
 * Collect expressions from the template, returning { expr, firstLine } entries.
 * firstLine is 0-based.
 */
function collectExpressions(text: string, lines: string[]): Map<string, { count: number; firstLine: number; firstCol: number }> {
    const freq = new Map<string, { count: number; firstLine: number; firstCol: number }>();

    const addExpr = (raw: string, offset: number) => {
        const expr = normalizeExpr(raw);
        if (!expr || expr.length < MIN_EXPR_LENGTH) { return; }
        if (BARE_IDENTIFIER_RE.test(expr)) { return; }
        if (SINGLE_SIGNAL_CALL_RE.test(expr)) { return; }

        if (!freq.has(expr)) {
            // Compute line/col from offset
            let runningLen = 0;
            let firstLine = 0;
            let firstCol = 0;
            for (let i = 0; i < lines.length; i++) {
                const lineLen = lines[i].length + 1;
                if (runningLen + lineLen > offset) {
                    firstLine = i;
                    firstCol = offset - runningLen;
                    break;
                }
                runningLen += lineLen;
            }
            freq.set(expr, { count: 1, firstLine, firstCol });
        } else {
            const entry = freq.get(expr)!;
            entry.count++;
        }
    };

    // Interpolation: {{ expr }}
    const interpRe = /\{\{([^}]+)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = interpRe.exec(text)) !== null) {
        addExpr(m[1], m.index + 2);
    }

    // Property binding: [prop]="expr"
    const propBindRe = /\[[^\]]+\]="([^"]+)"/g;
    while ((m = propBindRe.exec(text)) !== null) {
        // Skip event bindings like (click)="..." — these have () not []
        addExpr(m[1], m.index);
    }

    // @if(expr)
    const ifRe = /@if\s*\(([^)]+)\)/g;
    while ((m = ifRe.exec(text)) !== null) {
        addExpr(m[1], m.index);
    }

    // @for(item of expr; ...)
    const forRe = /@for\s*\(\s*\w+\s+of\s+([^;)]+)[;)]/g;
    while ((m = forRe.exec(text)) !== null) {
        addExpr(m[1], m.index);
    }

    return freq;
}

async function getAngularMajorVersion(workspaceRoot: string): Promise<number | null> {
    try {
        const pkgUri = vscode.Uri.file(path.join(workspaceRoot, 'node_modules', '@angular', 'core', 'package.json'));
        const bytes = await vscode.workspace.fs.readFile(pkgUri);
        const pkg = JSON.parse(Buffer.from(bytes).toString('utf8')) as { version?: string };
        if (!pkg.version) { return null; }
        const major = parseInt(pkg.version.split('.')[0], 10);
        return isNaN(major) ? null : major;
    } catch {
        return null;
    }
}

export async function scanRepeatedTemplateExpressions(
    diagnostics: vscode.DiagnosticCollection,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
    scope?: AuditScope,
): Promise<AuditFinding[]> {
    diagnostics.clear();

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath ?? '';

    let atLetAvailable = true;
    const angularMajor = await getAngularMajorVersion(workspaceRoot);
    if (angularMajor !== null && angularMajor < 18) {
        atLetAvailable = false;
    }

    const files = await findAuditFiles('html', scope);
    const total = files.length;
    let scanned = 0;
    let flagged = 0;
    const findings: AuditFinding[] = [];

    const outputChannel = vscode.window.createOutputChannel('Angular Performance Audit');

    if (!atLetAvailable && angularMajor !== null) {
        outputChannel.appendLine(`[B2] @let requires Angular 18+. Detected Angular ${angularMajor}. Findings are still emitted but @let is not available in this version.`);
    }

    for (const uri of files) {
        if (token.isCancellationRequested) { break; }

        progress.report({ increment: (1 / total) * 100, message: path.basename(uri.fsPath) });
        scanned++;

        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        // Pre-screen: must contain {{ or [
        if (!text.includes('{{') && !text.includes('[')) { continue; }

        const lines = text.split('\n');
        const letSkipSet = collectLetExpressions(text);
        const freqMap = collectExpressions(text, lines);
        const fileDiags: vscode.Diagnostic[] = [];

        for (const [expr, { count, firstLine, firstCol }] of freqMap) {
            if (count < MIN_OCCURRENCES) { continue; }
            if (letSkipSet.has(expr)) { continue; }

            const derivedName = deriveName(expr);
            const msg = `Expression "${expr}" appears ${count}× in template; extract with @let to avoid repeated evaluation`;
            const lineText = lines[firstLine] ?? '';
            const endCol = Math.min(firstCol + expr.length, lineText.length);

            const range = new vscode.Range(firstLine, firstCol, firstLine, endCol);
            const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Information);
            diag.source = 'angular-perf';
            diag.code = 'B2';
            fileDiags.push(diag);
            flagged++;

            findings.push({
                uri: uri.toString(),
                file: vscode.workspace.asRelativePath(uri),
                line: firstLine + 1,
                col: 0,
                endLine: firstLine + 1,
                endCol: 0,   // zero-width range = insert before the line
                message: msg,
                code: 'B2',
                // Empty string (not null) = zero-width insert. Only when @let is available (Angular 18+).
                originalText: atLetAvailable ? '' : null,
                fixText:      atLetAvailable ? `@let ${derivedName} = ${expr};\n` : null,
                fixDescription: `@let ${derivedName} = ${expr}; — inserted before first use. ` +
                    `Then replace all ${count} occurrences of '${expr}' in this template with '${derivedName}'.`,
            });
        }

        if (fileDiags.length > 0) {
            diagnostics.set(uri, fileDiags);
        }
    }

    outputChannel.appendLine(`[B2] Repeated Template Expression Scan — ${new Date().toLocaleTimeString()}`);
    outputChannel.appendLine(`Scanned ${scanned} HTML files. Found ${flagged} repeated expression(s).`);
    outputChannel.show(true);

    vscode.window.showInformationMessage(
        `Angular Audit [B2]: Found ${flagged} repeated expression(s) across ${scanned} HTML files.`
    );

    return findings;
}

export function registerRepeatedExpressionCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectRepeatedExpressions', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for repeated template expressions…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanRepeatedTemplateExpressions(diagnostics, progress, token);
            }
        );
    });
}
