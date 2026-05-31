import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AuditFinding } from './auditTypes';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

// Signal/reactive field declarations in companion .ts file
const SIGNAL_FIELD_RE = /\b(\w+)\s*=\s*(?:signal|computed|input|viewChild|contentChild|model|toSignal)\s*[(<]/g;

// Safe built-in names that are always allowed in templates
const SAFE_BUILTINS = new Set([
    'Object', 'Array', 'Math', 'String', 'Number', 'JSON',
    'Date', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
]);

/**
 * Extract signal field names from the companion .ts file.
 * Returns empty set if the .ts does not exist.
 */
function extractSignalNames(tsPath: string): Set<string> {
    const names = new Set<string>();
    if (!fs.existsSync(tsPath)) { return names; }
    try {
        const content = fs.readFileSync(tsPath, 'utf8');
        SIGNAL_FIELD_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = SIGNAL_FIELD_RE.exec(content)) !== null) {
            names.add(m[1]);
        }
    } catch {
        // Silently ignore read errors
    }
    return names;
}

export async function scanTemplateFunctionCalls(
    diagnostics: vscode.DiagnosticCollection,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
): Promise<AuditFinding[]> {
    diagnostics.clear();

    const files = await vscode.workspace.findFiles('**/*.html', `{${EXCLUDE_GLOB}}`);
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

        // Pre-screen: must have interpolations or property bindings
        if (!text.includes('{{') && !text.includes('[')) { continue; }

        // Load signal names from companion .ts
        const tsPath = uri.fsPath.replace(/\.html$/, '.ts');
        const signalNames = extractSignalNames(tsPath);

        const lines = text.split('\n');
        const fileDiags: vscode.Diagnostic[] = [];

        // Interpolation regex: {{ ... name( ... ) ... }}
        const interpolationRe = /\{\{[^}]*\b(\w+)\s*\([^)]*\)[^}]*\}\}/g;
        // Property binding regex: [attr]="... name( ... )"
        const bindingRe = /\[[^\]]+\]="[^"]*\b(\w+)\s*\([^"]*\)"/g;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Skip event bindings: lines where binding opens with (
            // We do NOT skip the entire line — we just skip bindings that start with (
            // The per-regex checks below naturally skip `(click)="..."` patterns
            // because our bindingRe only matches `[...]="..."` not `(...)="..."`

            // Pass 1: Interpolations {{ fn() }}
            interpolationRe.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = interpolationRe.exec(line)) !== null) {
                const fnName = m[1];
                if (fnName.startsWith('$')) { continue; }
                if (SAFE_BUILTINS.has(fnName)) { continue; }
                if (signalNames.has(fnName)) { continue; }

                const col = m.index;
                const endCol = col + m[0].length;
                const msg = `Function call ${fnName}() in template re-executes on every change-detection cycle. Convert to a signal or computed() value.`;
                const range = new vscode.Range(i, col, i, endCol);
                const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
                diag.source = 'angular-perf';
                diag.code = 'B1';
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
                    code: 'B1',
                    originalText: null,
                    fixText: null,
                    fixDescription: `Convert ${fnName}() to a signal: ${fnName} = computed(() => /* your logic */); The template call ${fnName}() is then a safe signal read, not a recalculated function call.`,
                });
            }

            // Pass 2: Property bindings [attr]="fn()"
            bindingRe.lastIndex = 0;
            while ((m = bindingRe.exec(line)) !== null) {
                const fnName = m[1];
                if (fnName.startsWith('$')) { continue; }
                if (SAFE_BUILTINS.has(fnName)) { continue; }
                if (signalNames.has(fnName)) { continue; }

                const col = m.index;
                const endCol = col + m[0].length;
                const msg = `Function call ${fnName}() in template re-executes on every change-detection cycle. Convert to a signal or computed() value.`;
                const range = new vscode.Range(i, col, i, endCol);
                const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
                diag.source = 'angular-perf';
                diag.code = 'B1';
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
                    code: 'B1',
                    originalText: null,
                    fixText: null,
                    fixDescription: `Convert ${fnName}() to a signal: ${fnName} = computed(() => /* your logic */); The template call ${fnName}() is then a safe signal read, not a recalculated function call.`,
                });
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
