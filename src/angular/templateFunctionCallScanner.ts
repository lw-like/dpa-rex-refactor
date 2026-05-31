import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AuditFinding } from './auditTypes';
import { AuditScope, findAuditFiles } from './auditScope';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

/**
 * Detects signal/reactive field declarations in a .ts file.
 *
 * Covers all Angular signal-like APIs:
 *   signal(), computed(), linkedSignal()   — writable/derived signals
 *   input(), input.required()              — signal inputs
 *   viewChild(), viewChild.required()      — signal queries
 *   contentChild(), contentChild.required()
 *   model(), model.required()             — two-way signal binding
 *   toSignal()                             — RxJS → signal bridge
 *   resource()                             — async resource (Angular 19+)
 *   form()                                 — Signal Forms FieldTree (@angular/forms/signals)
 */
const SIGNAL_FIELD_RE = /\b(\w+)\s*=\s*(?:signal|computed|linkedSignal|resource|toSignal|form|input(?:\.required)?|viewChild(?:\.required)?|contentChild(?:\.required)?|model(?:\.required)?)\s*[(<]/g;

// Safe built-in names that are always allowed in templates
const SAFE_BUILTINS = new Set([
    'Object', 'Array', 'Math', 'String', 'Number', 'JSON',
    'Date', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
]);

/**
 * Returns true when `fnName(...)` in `matchedText` is a chained call on a
 * signal field rather than a standalone component method.
 *
 * Handles all Signal Forms access patterns:
 *   loginForm.email()           — fnName = 'email', receiver = 'loginForm' (signal)
 *   loginForm.email().value()   — fnName = 'value', chain contains 'loginForm' (signal)
 *   loginForm.email().touched() — same
 *
 * Also handles plain signal field chains: mySignal().someMethod()
 */
function isChainedOnSignalField(matchedText: string, fnName: string, signalNames: Set<string>): boolean {
    if (signalNames.size === 0) { return false; }

    // Find the last occurrence of fnName( in the matched text
    const callToken = fnName + '(';
    const fnPos = matchedText.lastIndexOf(callToken);
    if (fnPos <= 0) { return false; }

    // Must have a '.' immediately before fnName — otherwise it's a standalone call
    if (matchedText[fnPos - 1] !== '.') { return false; }

    // Extract everything before the dot
    const beforeDot = matchedText.slice(0, fnPos - 1);

    // Direct receiver: signalField.fnName() — check if last word before '.' is a signal
    const directReceiver = /\b(\w+)$/.exec(beforeDot);
    if (directReceiver && signalNames.has(directReceiver[1])) { return true; }

    // Deep chain: signalField.something().fnName() — any signal field appears in the chain
    for (const name of signalNames) {
        if (beforeDot.includes(name)) { return true; }
    }

    return false;
}

/** Extracts all signal-like field names from TypeScript source text. */
function extractSignalNamesFromContent(content: string): Set<string> {
    const names = new Set<string>();
    SIGNAL_FIELD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SIGNAL_FIELD_RE.exec(content)) !== null) {
        names.add(m[1]);
    }
    return names;
}

/**
 * Finds a method definition for `fnName` in the TypeScript source and generates
 * the `readonly fnName = computed(...)` replacement.
 *
 * Returns null when:
 *   - The method is not found (not defined in this file)
 *   - The method body spans multiple statements (safe to leave as guidance-only)
 *
 * The returned range spans the ENTIRE method (multi-line) so the WorkspaceEdit
 * replaces everything from the first character of the declaration to the closing `}`.
 */
function findMethodAndGenerateFix(
    tsContent: string,
    tsLines: string[],
    fnName: string,
): {
    startLine: number;  // 0-based
    endLine: number;    // 0-based
    endCol: number;
    originalText: string;
    fixText: string;
} | null {
    const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Match method declarations: optional access modifiers + fnName + (<generics>)? + (
    // Anchored to line start (multiline flag). Does NOT match `this.fnName(`.
    const methodRe = new RegExp(
        `^([ \\t]*)(?:(?:public|private|protected|override|static|abstract)\\s+)*` +
        `(?:async\\s+)?${escaped}\\s*(?:<[^>]*>)?\\s*\\(`,
        'gm',
    );

    let match: RegExpExecArray | null;
    while ((match = methodRe.exec(tsContent)) !== null) {
        const indent = match[1];

        // Skip if the character immediately before is '.' — call, not declaration
        if (match.index > 0 && tsContent[match.index - 1] === '.') { continue; }

        // Scan forward past the parameter list to find the opening brace
        let parenDepth = 0;
        let braceStart = -1;
        for (let i = match.index + match[0].length - 1; i < tsContent.length; i++) {
            const ch = tsContent[i];
            if (ch === '(') { parenDepth++; }
            else if (ch === ')') { parenDepth--; }
            else if (ch === '{' && parenDepth === 0) { braceStart = i; break; }
            else if ((ch === ';' || ch === ',') && parenDepth === 0) { break; } // abstract/interface
        }
        if (braceStart < 0) { continue; } // abstract or interface method — no body

        // Find matching closing brace via depth tracking
        let depth = 0;
        let braceEnd = -1;
        for (let i = braceStart; i < tsContent.length; i++) {
            if (tsContent[i] === '{') { depth++; }
            else if (tsContent[i] === '}') { depth--; if (depth === 0) { braceEnd = i; break; } }
        }
        if (braceEnd < 0) { continue; }

        // Determine line numbers (0-based)
        const startLine = (tsContent.slice(0, match.index).match(/\n/g) ?? []).length;
        const endLine   = (tsContent.slice(0, braceEnd + 1).match(/\n/g) ?? []).length;
        const endCol    = (tsLines[endLine] ?? '').length;

        const originalText = tsLines.slice(startLine, endLine + 1).join('\n');

        // Extract body text (inside braces)
        const bodyRaw     = tsContent.slice(braceStart + 1, braceEnd);
        const bodyTrimmed = bodyRaw.trim();

        // Simplify single-expression returns: { return expr; } → () => expr
        const singleReturn = /^return\s+([\s\S]+?);?\s*$/.exec(bodyTrimmed);
        let computedBody: string;
        if (singleReturn) {
            computedBody = `() => ${singleReturn[1]}`;
        } else {
            // Multi-statement body — wrap as block arrow function
            computedBody = `() => {${bodyRaw.endsWith('\n') ? bodyRaw : bodyRaw + '\n'}${indent}}`;
        }

        const fixText = `${indent}readonly ${fnName} = computed(${computedBody});`;

        return { startLine, endLine, endCol, originalText, fixText };
    }
    return null;
}

export async function scanTemplateFunctionCalls(
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

        const doc  = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        if (!text.includes('{{') && !text.includes('[')) { continue; }

        // Read companion .ts file once — used for both signal detection and method extraction
        const tsPath = uri.fsPath.replace(/\.html$/, '.ts');
        let tsContent = '';
        let tsLines:   string[] = [];
        if (fs.existsSync(tsPath)) {
            try {
                tsContent = fs.readFileSync(tsPath, 'utf8');
                tsLines   = tsContent.split('\n');
            } catch { /* ignore unreadable files */ }
        }

        const signalNames = extractSignalNamesFromContent(tsContent);

        const lines    = text.split('\n');
        const fileDiags: vscode.Diagnostic[] = [];

        // Interpolation: {{ ... fnName() ... }}
        const interpolationRe = /\{\{[^}]*\b(\w+)\s*\([^)]*\)[^}]*\}\}/g;
        // Property binding: [attr]="... fnName() ..."
        const bindingRe = /\[[^\]]+\]="[^"]*\b(\w+)\s*\([^"]*\)"/g;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Pass 1: Interpolations
            interpolationRe.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = interpolationRe.exec(line)) !== null) {
                const fnName = m[1];
                if (fnName.startsWith('$')) { continue; }
                if (SAFE_BUILTINS.has(fnName)) { continue; }
                if (signalNames.has(fnName)) { continue; } // direct signal field read
                // Signal Forms / chained signal access: loginForm.email(), loginForm.email().value()
                if (isChainedOnSignalField(m[0], fnName, signalNames)) { continue; }

                emitFinding(uri, tsPath, tsContent, tsLines, i, m.index, m.index + m[0].length, fnName, fileDiags, findings);
                flagged++;
            }

            // Pass 2: Property bindings
            bindingRe.lastIndex = 0;
            while ((m = bindingRe.exec(line)) !== null) {
                const fnName = m[1];
                if (fnName.startsWith('$')) { continue; }
                if (SAFE_BUILTINS.has(fnName)) { continue; }
                if (signalNames.has(fnName)) { continue; }
                if (isChainedOnSignalField(m[0], fnName, signalNames)) { continue; }

                emitFinding(uri, tsPath, tsContent, tsLines, i, m.index, m.index + m[0].length, fnName, fileDiags, findings);
                flagged++;
            }
        }

        if (fileDiags.length > 0) {
            diagnostics.set(uri, fileDiags);
        }
    }

    vscode.window.showInformationMessage(
        `Angular Audit [B1]: Found ${flagged} template function call(s) across ${scanned} HTML files.`
    );

    return findings;
}

/**
 * Emits one diagnostic (on the HTML line) and one AuditFinding.
 *
 * When the method body can be extracted from the companion .ts file the
 * finding points at the .ts method location so "Apply Fix" edits the right
 * file. Otherwise it falls back to pointing at the HTML template line with
 * guidance-only (null/null).
 */
function emitFinding(
    htmlUri: vscode.Uri,
    tsPath:  string,
    tsContent: string,
    tsLines:   string[],
    lineIdx:  number,
    col:      number,
    endCol:   number,
    fnName:   string,
    fileDiags: vscode.Diagnostic[],
    findings:  AuditFinding[],
): void {
    const msg = `Function call ${fnName}() in template re-executes on every change-detection cycle. Convert to computed() in the .ts file.`;

    // Diagnostic always points at the HTML template line (Problems panel / squiggle)
    const diag = new vscode.Diagnostic(
        new vscode.Range(lineIdx, col, lineIdx, endCol),
        msg,
        vscode.DiagnosticSeverity.Warning,
    );
    diag.source = 'angular-perf';
    diag.code   = 'B1';
    fileDiags.push(diag);

    // Try to locate and extract the method from the .ts file for auto-fix
    const fix = tsContent ? findMethodAndGenerateFix(tsContent, tsLines, fnName) : null;

    if (fix) {
        // Finding points at the .ts method — "Apply Fix" edits the right file
        const tsUri  = vscode.Uri.file(tsPath);
        const tsFile = vscode.workspace.asRelativePath(tsUri);
        findings.push({
            uri:          tsUri.toString(),
            file:         tsFile,
            line:         fix.startLine + 1,
            col:          0,
            endLine:      fix.endLine + 1,
            endCol:       fix.endCol,
            message:      msg,
            code:         'B1',
            originalText: fix.originalText,
            fixText:      fix.fixText,
            fixDescription:
                `Converts ${fnName}() to a computed() signal. ` +
                `The template {{ ${fnName}() }} is unchanged — () reads the signal value. ` +
                `After applying: add computed to the @angular/core import if missing, ` +
                `and ensure all property reads inside computed use signal syntax (e.g. this.items() not this.items).`,
        });
    } else {
        // Fallback: point at the HTML line, guidance only
        findings.push({
            uri:          htmlUri.toString(),
            file:         vscode.workspace.asRelativePath(htmlUri),
            line:         lineIdx + 1,
            col,
            endLine:      lineIdx + 1,
            endCol,
            message:      msg,
            code:         'B1',
            originalText: null,
            fixText:      null,
            fixDescription:
                `In the .ts file convert ${fnName}() to: ` +
                `readonly ${fnName} = computed(() => /* existing method body */); ` +
                `The template {{ ${fnName}() }} stays unchanged — computed() is a signal and () reads its cached value. ` +
                `Add computed to the @angular/core import.`,
        });
    }
}

export function registerTemplateFunctionCallCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectTemplateFunctionCalls', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for template function calls…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanTemplateFunctionCalls(diagnostics, progress, token);
            }
        );
    });
}
