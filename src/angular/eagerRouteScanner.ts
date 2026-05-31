import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';
import { AuditScope, findAuditFiles } from './auditScope';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

// Matches a `component:` property inside a route object literal
const COMPONENT_PROP_RE = /\bcomponent\s*:/;

// Context signals that confirm we are inside a route configuration
const ROUTE_CONTEXT_RE = /Routes|RouterModule\.forRoot|RouterModule\.forChild|provideRouter|Route\[\]|const\s+\w*[Rr]outes|path\s*:/;

export async function scanEagerRoutes(
    diagnostics: vscode.DiagnosticCollection,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
    scope?: AuditScope,
): Promise<AuditFinding[]> {
    diagnostics.clear();

    const files = await findAuditFiles('ts', scope);
    const total = files.length;
    let scanned = 0;
    const findings: AuditFinding[] = [];
    const fileDiagMap = new Map<string, vscode.Diagnostic[]>();

    for (const uri of files) {
        if (token.isCancellationRequested) { break; }

        progress.report({ increment: (1 / total) * 100, message: path.basename(uri.fsPath) });
        scanned++;

        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        // Pre-screen: route config files must have `path:` and `component:`
        if (!text.includes('path:') || !text.includes('component:')) { continue; }

        const lines = text.split('\n');
        const fileDiags: vscode.Diagnostic[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!COMPONENT_PROP_RE.test(line)) { continue; }

            // Scan up to 5 lines above and below to detect lazy alternatives or
            // route-skipping properties within the same route object block
            const windowStart = Math.max(0, i - 5);
            const windowEnd   = Math.min(lines.length - 1, i + 5);
            let hasLazyAlternative = false;

            for (let w = windowStart; w <= windowEnd; w++) {
                if (w === i) { continue; }
                const wl = lines[w];
                if (/\bloadComponent\s*:/.test(wl) ||
                    /\bloadChildren\s*:/.test(wl)  ||
                    /\bredirectTo\s*:/.test(wl)) {
                    hasLazyAlternative = true;
                    break;
                }
            }

            if (hasLazyAlternative) { continue; }

            // Confirm we are inside a route config — check 10 lines above for
            // route-context signals to suppress false positives from @Component
            // decorators and other Angular constructs that also use `component:`
            const contextStart = Math.max(0, i - 10);
            let isRouteContext = false;

            for (let c = contextStart; c <= i; c++) {
                if (ROUTE_CONTEXT_RE.test(lines[c])) {
                    isRouteContext = true;
                    break;
                }
            }

            if (!isRouteContext) { continue; }

            // Extract the component name so we can generate a template auto-fix.
            const componentMatch = /\bcomponent\s*:\s*(\w+)/.exec(line);
            const componentName  = componentMatch?.[1] ?? null;

            // Narrow the finding range (and fix range) to the `component: Name` token.
            const fixCol    = componentMatch ? componentMatch.index : 0;
            const fixEndCol = componentMatch ? componentMatch.index + componentMatch[0].length : line.length;

            const autoFixOrig = componentMatch ? componentMatch[0] : null;
            const autoFixText = componentName
                ? `loadComponent: () => import('./PATH-TO-COMPONENT').then(m => m.${componentName})`
                : null;

            const message =
                'Route uses component: (eager load) — this component is bundled into the main chunk ' +
                'and loaded on startup regardless of whether the route is visited';

            const range = new vscode.Range(i, fixCol, i, fixEndCol);
            const diag = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
            diag.source = 'angular-perf';
            diag.code = 'H2';
            fileDiags.push(diag);

            findings.push({
                uri: uri.toString(),
                file: vscode.workspace.asRelativePath(uri),
                line: i + 1,
                col: fixCol,
                endLine: i + 1,
                endCol: fixEndCol,
                message,
                code: 'H2',
                originalText: autoFixOrig,
                fixText: autoFixText,
                fixDescription: componentName
                    ? `After applying fix, replace './PATH-TO-COMPONENT' with the actual relative import path to ${componentName}. The class name is already filled in.`
                    : "Replace with: loadComponent: () => import('./your.component').then(m => m.YourComponent) to lazy-load this route on first navigation.",
            });
        }

        if (fileDiags.length > 0) {
            fileDiagMap.set(uri.toString(), fileDiags);
            diagnostics.set(uri, fileDiags);
        }
    }

    const outputChannel = vscode.window.createOutputChannel('Angular Performance Audit');
    outputChannel.appendLine(`[H2] Eagerly Loaded Routes Scan — ${new Date().toLocaleTimeString()}`);
    outputChannel.appendLine(`Scanned ${scanned} TypeScript files. Found ${findings.length} eager route(s).`);
    outputChannel.appendLine('');

    if (findings.length > 0) {
        for (const f of findings) {
            outputChannel.appendLine(`  ${f.file}:${f.line}`);
        }
        outputChannel.appendLine('');
    }

    outputChannel.show(true);

    vscode.window.showInformationMessage(
        `Angular Audit [H2]: Found ${findings.length} eagerly loaded route(s) across ${scanned} files. See Output panel for details.`,
    );

    return findings;
}

export function registerEagerRouteCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectEagerlyLoadedRoutes', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for eagerly loaded routes…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanEagerRoutes(diagnostics, progress, token);
            },
        );
    });
}
