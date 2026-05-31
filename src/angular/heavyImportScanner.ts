import * as vscode from 'vscode';
import * as path from 'path';
import { AuditFinding } from './auditTypes';
import { AuditScope, findAuditFiles } from './auditScope';

const EXCLUDE_GLOB = '**/node_modules/**,**/dist/**,**/out/**';

interface HeavyLib {
    pattern: RegExp;
    name: string;
    weight: string;
    alt: string;
}

const HEAVY_LIBS: HeavyLib[] = [
    { pattern: /from ['"]moment['"]/, name: 'moment', weight: '~300 KB', alt: 'date-fns or Day.js' },
    { pattern: /from ['"]lodash['"]/, name: 'lodash (full)', weight: '~70 KB', alt: "lodash-es or individual 'lodash/method' imports" },
    { pattern: /from ['"]chart\.js['"]/, name: 'chart.js', weight: '~200 KB', alt: 'lazy-load via dynamic import()' },
    { pattern: /from ['"]monaco-editor['"]/, name: 'monaco-editor', weight: '~2 MB', alt: 'load via CDN or dynamic import()' },
    { pattern: /from ['"]firebase['"](?!\/)/, name: 'firebase (full SDK)', weight: '~400 KB', alt: "individual 'firebase/app', 'firebase/auth' imports" },
    { pattern: /from ['"]rxjs['"](?!\/)/, name: 'rxjs (full barrel)', weight: '~40 KB extra', alt: "named imports from 'rxjs' (already tree-shakeable in RxJS 7+; only star imports pull the whole barrel)" },
];

const H1_FIX_DESCRIPTIONS: Record<string, string> = {
    'moment':
        "Replace moment (~300 KB) with date-fns:\n" +
        "  npm install date-fns\n" +
        "  // Before: import moment from 'moment'; moment(date).format('YYYY-MM-DD')\n" +
        "  // After:  import { format } from 'date-fns'; format(date, 'yyyy-MM-dd')\n" +
        "  Or Day.js (moment-compatible API): npm install dayjs; import dayjs from 'dayjs'",
    'lodash (full)':
        "Replace lodash barrel (~70 KB) with tree-shakeable lodash-es:\n" +
        "  npm install lodash-es @types/lodash-es\n" +
        "  // Before: import _ from 'lodash'; _.cloneDeep(obj)\n" +
        "  // After:  import { cloneDeep } from 'lodash-es'; cloneDeep(obj)",
    'chart.js':
        "Lazy-load chart.js to keep it out of the main bundle:\n" +
        "  async showChart() {\n" +
        "    const { Chart, registerables } = await import('chart.js');\n" +
        "    Chart.register(...registerables);\n" +
        "    new Chart(canvas, config);\n" +
        "  }",
    'monaco-editor':
        "Load monaco-editor dynamically to avoid ~2 MB in the main bundle:\n" +
        "  async openEditor() {\n" +
        "    const monaco = await import('monaco-editor');\n" +
        "    monaco.editor.create(container, { value: '', language: 'typescript' });\n" +
        "  }",
    'firebase (full SDK)':
        "Replace the full firebase barrel (~400 KB) with modular sub-package imports:\n" +
        "  // Before: import firebase from 'firebase'\n" +
        "  // After:  import { initializeApp } from 'firebase/app'\n" +
        "  //         import { getAuth } from 'firebase/auth'\n" +
        "  //         import { getFirestore, doc, getDoc } from 'firebase/firestore'\n" +
        "  Only the sub-packages you import are bundled.",
    'rxjs (full barrel)':
        "In RxJS 7+, named imports from 'rxjs' are already tree-shakeable — no change needed.\n" +
        "Flag only if you see import * as Rx from 'rxjs' (star import), which pulls the whole barrel:\n" +
        "  // Before: import * as Rx from 'rxjs'\n" +
        "  // After:  import { Observable, Subject, BehaviorSubject } from 'rxjs'",
};

interface InternalFinding {
    lib: HeavyLib;
    file: string;
    line: number;
    col: number;
    uri: vscode.Uri;
}

export async function scanHeavyImports(
    diagnostics: vscode.DiagnosticCollection,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
    scope?: AuditScope,
): Promise<AuditFinding[]> {
    diagnostics.clear();

    const files = await findAuditFiles('ts', scope);
    const total = files.length;
    let scanned = 0;
    const internalFindings: InternalFinding[] = [];
    const fileDiagMap = new Map<string, vscode.Diagnostic[]>();
    const findings: AuditFinding[] = [];

    for (const uri of files) {
        if (token.isCancellationRequested) { break; }

        progress.report({ increment: (1 / total) * 100, message: path.basename(uri.fsPath) });
        scanned++;

        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        if (!text.includes('from \'') && !text.includes('from "')) { continue; }

        const lines = text.split('\n');
        const fileDiags: vscode.Diagnostic[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.includes('from ')) { continue; }

            for (const lib of HEAVY_LIBS) {
                lib.pattern.lastIndex = 0;
                if (lib.pattern.test(line)) {
                    lib.pattern.lastIndex = 0;
                    const col = line.indexOf('from ');
                    const range = new vscode.Range(i, col, i, line.length);
                    const message = `Heavy import: '${lib.name}' adds ${lib.weight} to your bundle. Consider: ${lib.alt}.`;
                    const diag = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
                    diag.source = 'angular-perf';
                    diag.code = 'H1';
                    fileDiags.push(diag);
                    internalFindings.push({ lib, file: uri.fsPath, line: i + 1, col, uri });

                    findings.push({
                        uri: uri.toString(),
                        file: vscode.workspace.asRelativePath(uri),
                        line: i + 1,
                        col,
                        endLine: i + 1,
                        endCol: line.length,
                        message,
                        code: 'H1',
                        originalText: null,
                        fixText: null,
                        fixDescription: H1_FIX_DESCRIPTIONS[lib.name] ?? `Replace ${lib.name} with ${lib.alt} (lighter alternative)`,
                    });
                }
                lib.pattern.lastIndex = 0;
            }
        }

        if (fileDiags.length > 0) {
            fileDiagMap.set(uri.toString(), fileDiags);
            diagnostics.set(uri, fileDiags);
        }
    }

    const outputChannel = vscode.window.createOutputChannel('Angular Performance Audit');
    outputChannel.appendLine(`[H1] Heavy Library Import Scan — ${new Date().toLocaleTimeString()}`);
    outputChannel.appendLine(`Scanned ${scanned} TypeScript files. Found ${internalFindings.length} heavy import(s).`);
    outputChannel.appendLine('');

    const byLib = new Map<string, InternalFinding[]>();
    for (const f of internalFindings) {
        const key = f.lib.name;
        if (!byLib.has(key)) { byLib.set(key, []); }
        byLib.get(key)!.push(f);
    }

    for (const [libName, libFindings] of byLib) {
        const first = libFindings[0];
        outputChannel.appendLine(`${libName} (${first.lib.weight}) — ${libFindings.length} occurrence(s)`);
        outputChannel.appendLine(`  Alternative: ${first.lib.alt}`);
        for (const f of libFindings) {
            outputChannel.appendLine(`    ${f.file}:${f.line}`);
        }
        outputChannel.appendLine('');
    }

    outputChannel.show(true);

    vscode.window.showInformationMessage(
        `Angular Audit [H1]: Found ${internalFindings.length} heavy import(s) across ${scanned} files. See Output panel for details.`
    );

    return findings;
}

export function registerHeavyImportCommand(
    context: vscode.ExtensionContext,
    diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
    return vscode.commands.registerCommand('dpa-rex-refacror.detectHeavyImports', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Angular Audit: Scanning for heavy library imports…',
                cancellable: true,
            },
            async (progress, token) => {
                await scanHeavyImports(diagnostics, progress, token);
            }
        );
    });
}
