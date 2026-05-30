import * as vscode from 'vscode';
import * as path from 'path';
import { analyzeHtml } from './htmlAnalyzer';
import { scanClassUsage, ClassUsage, relativePath } from './cssScanner';
import { resolveCustomComponents, ResolvedComponent } from './componentResolver';
import { generateComponent, toPascalCase, toSelector, ComponentSpec, ComponentImport, TodoData } from './componentGenerator';
import { parseMixinsFile, MixinMap } from './mixinsScanner';
import { TodoReviewPanel } from '../ui/todoReviewPanel';

export const LAST_EXTRACTION_KEY = 'lastAngularExtraction';

export interface LastExtraction {
    componentName: string;
    selector: string;
    componentDir: string;
    parentFilePath: string;
    originalHtml: string;
    importStatement: string;
    timestamp: string;
}

export async function extractAngularComponent(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Select HTML to extract before running this command.');
        return;
    }

    const selectedHtml = editor.document.getText(editor.selection);
    const analysis = analyzeHtml(selectedHtml);

    // 1 — Ask for component name
    const nameInput = await vscode.window.showInputBox({
        title: 'Extract Angular Component — Name',
        prompt: 'Component name in PascalCase (e.g. UserCard)',
        placeHolder: 'UserCard',
        validateInput: v => /^[A-Z][a-zA-Z0-9]*$/.test(v.trim()) ? undefined : 'Use PascalCase, e.g. UserCard',
    });
    if (!nameInput) { return; }
    const componentName = toPascalCase(nameInput.trim());

    // 2 — Scan CSS usage and resolve child components in parallel (both need workspace search)
    let classUsages: ClassUsage[] = [];
    let resolution: Awaited<ReturnType<typeof resolveCustomComponents>> = { resolved: [], unresolved: [] };

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Analysing workspace…', cancellable: false },
        async (progress) => {
            [classUsages, resolution] = await Promise.all([
                scanClassUsage(analysis.classes, progress),
                resolveCustomComponents(analysis.customElements, progress),
            ]);
        },
    );

    // 3 — Show class usage stats and let user pick which to move
    const moveClasses = await pickClassesToMove(classUsages);
    if (moveClasses === undefined) { return; } // cancelled

    // 4 — Confirm detected inputs/outputs
    const confirmedInputs = await pickSignals(analysis.inputs, 'inputs');
    if (confirmedInputs === undefined) { return; }
    const confirmedOutputs = await pickSignals(analysis.outputs, 'outputs');
    if (confirmedOutputs === undefined) { return; }

    // 5 — Determine output directory, then confirm child component imports
    const sourceDir = path.dirname(editor.document.uri.fsPath);
    const componentDir = path.join(sourceDir, toKebabCase(componentName));

    const componentImports = await pickComponentImports(resolution, componentDir);
    if (componentImports === undefined) { return; } // cancelled

    // 5b — Load mixin map and settings
    const { mixinMap, mixinsImport, convertToMobileFirst } = await loadMixinSettings();

    const spec: ComponentSpec = {
        name: componentName,
        selector: toSelector(componentName),
        template: selectedHtml,
        inputs: confirmedInputs,
        outputs: confirmedOutputs,
        classUsages,
        moveClasses,
        componentImports,
        mixinMap,
        mixinsImport,
        convertToMobileFirst,
    };

    const files = generateComponent(spec);

    // 6 — Write new component files directly to disk so they are immediately
    // visible to findFiles (WorkspaceEdit.createFile+insert leaves buffers unsaved).
    const componentDirUri = vscode.Uri.file(componentDir);
    await vscode.workspace.fs.createDirectory(componentDirUri);

    const writeToDisk = async (name: string, content: string) => {
        await vscode.workspace.fs.writeFile(
            vscode.Uri.file(path.join(componentDir, name)),
            Buffer.from(content, 'utf8'),
        );
    };

    await writeToDisk(files.tsFileName, files.ts);
    await writeToDisk(files.htmlFileName, files.html);
    await writeToDisk(files.scssFileName, files.scss);
    if (files.todo.trim()) {
        await writeToDisk(files.todoFileName, files.todo);
    }

    // Modify the existing parent file via WorkspaceEdit (replace selection + import)
    const autoImport = vscode.workspace.getConfiguration('dpa-rex-refacror.angular').get<boolean>('autoImport', true);
    const edit = new vscode.WorkspaceEdit();
    const componentTag = `<${spec.selector} />`;
    edit.replace(editor.document.uri, editor.selection, componentTag);
    const importStatement = buildImportStatement(componentName, files.tsFileName, componentDir, editor.document);
    if (autoImport) {
        await insertImportInParent(edit, editor.document, componentName, files.tsFileName, componentDir);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
        vscode.window.showErrorMessage('Failed to update parent component. New files were created but parent was not modified.');
        return;
    }

    // Save extraction record for revert
    const extraction: LastExtraction = {
        componentName: `${componentName}Component`,
        selector: spec.selector,
        componentDir,
        parentFilePath: editor.document.uri.fsPath,
        originalHtml: selectedHtml,
        importStatement,
        timestamp: new Date().toISOString(),
    };
    await context.globalState.update(LAST_EXTRACTION_KEY, extraction);

    const tsUri = vscode.Uri.file(path.join(componentDir, files.tsFileName));
    const todoUri = vscode.Uri.file(path.join(componentDir, files.todoFileName));

    await vscode.window.showTextDocument(tsUri, { viewColumn: vscode.ViewColumn.One });

    if (files.todo.trim()) {
        const todoData = JSON.parse(files.todo) as TodoData;
        TodoReviewPanel.show(todoUri, todoData);
    }

    vscode.window.showInformationMessage(
        `Component ${componentName}Component created. Review the Styles Checklist panel to clean up origin files.`,
    );
}

function buildImportStatement(
    componentName: string,
    tsFileName: string,
    componentDir: string,
    doc: vscode.TextDocument,
): string {
    const sourceDir = path.dirname(doc.uri.fsPath);
    let importPath = path.relative(sourceDir, path.join(componentDir, tsFileName.replace('.ts', ''))).replace(/\\/g, '/');
    if (!importPath.startsWith('.')) { importPath = './' + importPath; }
    return `import { ${componentName}Component } from '${importPath}';`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function pickClassesToMove(usages: ClassUsage[]): Promise<string[] | undefined> {
    if (usages.length === 0) { return []; }

    const items: vscode.QuickPickItem[] = usages.map(u => ({
        label: `.${u.className}`,
        description: u.safeToMove
            ? `used in ${u.usageCount} file — safe to move`
            : `used in ${u.usageCount} files — keep global`,
        detail: u.definedIn.length
            ? `Defined in: ${u.definedIn.map(relativePath).join(', ')}`
            : 'Not found in any style file',
        picked: u.safeToMove,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: 'CSS Class Usage — select classes to move into component SCSS',
        canPickMany: true,
        placeHolder: 'Pre-selected: single-use classes (safe to scope). Uncheck to keep global.',
    });
    if (picked === undefined) { return undefined; }

    return picked.map(p => p.label.replace(/^\./, ''));
}

async function pickSignals(names: string[], kind: 'inputs' | 'outputs'): Promise<string[] | undefined> {
    if (names.length === 0) { return []; }

    const items: vscode.QuickPickItem[] = names.map(n => ({
        label: n,
        picked: true,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: `Detected ${kind} — confirm which to add as signal ${kind}`,
        canPickMany: true,
        placeHolder: `Uncheck any that are not actually ${kind}`,
    });

    return picked?.map(p => p.label);
}

/**
 * Adds the extracted component to the parent component's `imports: []` array
 * and prepends the TypeScript import statement.
 *
 * When the user selected HTML from a `.html` template file, the actual
 * Angular component class lives in the paired `.ts` file — we detect and
 * target that file automatically.
 *
 * Handles edge-cases in the imports array:
 *   imports: []            → imports: [UserCardComponent]
 *   imports: [A]           → imports: [A, UserCardComponent]
 *   imports: [A, B,]       → imports: [A, B, UserCardComponent]  (trailing comma)
 */
async function insertImportInParent(
    edit: vscode.WorkspaceEdit,
    sourceDoc: vscode.TextDocument,
    componentName: string,
    tsFileName: string,
    componentDir: string,
): Promise<void> {
    // If the user selected HTML from a template file, find the paired .ts file
    let targetUri = sourceDoc.uri;
    if (targetUri.fsPath.endsWith('.html')) {
        const tsPath = targetUri.fsPath.replace(/\.html$/, '.ts');
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(tsPath));
            targetUri = vscode.Uri.file(tsPath);
        } catch {
            return; // No paired .ts component — skip auto-import
        }
    }

    let doc: vscode.TextDocument;
    try {
        doc = await vscode.workspace.openTextDocument(targetUri);
    } catch { return; }

    const text = doc.getText();
    const importsMatch = /imports\s*:\s*\[([^\]]*)\]/s.exec(text);
    if (!importsMatch) { return; }

    const closePos = text.indexOf(importsMatch[0]) + importsMatch[0].lastIndexOf(']');

    // Determine the right separator based on what's already in the array
    const beforeClose = text.slice(0, closePos).trimEnd();
    const lastChar = beforeClose[beforeClose.length - 1];
    const arrayEntry = lastChar === '['  ? `${componentName}Component`    // empty array
                     : lastChar === ','  ? ` ${componentName}Component`   // trailing comma
                     :                    `, ${componentName}Component`;  // normal case

    const targetDir = path.dirname(targetUri.fsPath);
    let importPath = path.relative(targetDir, path.join(componentDir, tsFileName.replace('.ts', ''))).replace(/\\/g, '/');
    if (!importPath.startsWith('.')) { importPath = './' + importPath; }

    const importLine = `import { ${componentName}Component } from '${importPath}';\n`;

    edit.insert(targetUri, new vscode.Position(0, 0), importLine);
    edit.insert(targetUri, doc.positionAt(closePos), arrayEntry);
}

async function pickComponentImports(
    resolution: { resolved: ResolvedComponent[]; unresolved: string[] },
    componentDir: string,
): Promise<ComponentImport[] | undefined> {
    const { resolved, unresolved } = resolution;
    if (resolved.length === 0 && unresolved.length === 0) { return []; }

    type Item = vscode.QuickPickItem & { component?: ResolvedComponent };

    const items: Item[] = [
        ...resolved.map(c => ({
            label: c.className,
            description: c.selector,
            detail: `Found: ${relativePath(c.fsPath)}`,
            picked: true,
            component: c,
        })),
        ...unresolved.map(sel => ({
            label: sel,
            description: 'not found in workspace — likely 3rd-party (import manually)',
            picked: false,
        })),
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Child components — select which to import',
        canPickMany: true,
        placeHolder: 'Workspace components are pre-selected. 3rd-party components need manual import.',
    });
    if (picked === undefined) { return undefined; }

    return (picked as Item[])
        .filter(p => p.component)
        .map(p => {
            const fsPath = p.component!.fsPath.replace(/\.ts$/, '');
            let importPath = path.relative(componentDir, fsPath).replace(/\\/g, '/');
            if (!importPath.startsWith('.')) { importPath = './' + importPath; }
            return { className: p.component!.className, importPath };
        });
}

async function loadMixinSettings(): Promise<{ mixinMap?: MixinMap; mixinsImport?: string; convertToMobileFirst: boolean }> {
    const config = vscode.workspace.getConfiguration('dpa-rex-refacror.angular');
    const mixinsFileSetting = config.get<string>('mixinsFile', '').trim();
    const mixinsImport = config.get<string>('mixinsImport', '').trim() || undefined;
    const convertToMobileFirst = config.get<boolean>('convertToMobileFirst', true);

    if (!mixinsFileSetting) { return { mixinsImport, convertToMobileFirst }; }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { return { mixinsImport, convertToMobileFirst }; }

    const absPath = path.isAbsolute(mixinsFileSetting)
        ? mixinsFileSetting
        : path.join(folders[0].uri.fsPath, mixinsFileSetting);

    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
        const mixinMap = parseMixinsFile(Buffer.from(bytes).toString('utf8'));
        return { mixinMap, mixinsImport, convertToMobileFirst };
    } catch {
        vscode.window.showWarningMessage(
            `Angular: could not read mixins file "${mixinsFileSetting}" — @media queries will not be replaced with mixins.`,
        );
        return { mixinsImport, convertToMobileFirst };
    }
}

function toKebabCase(pascal: string): string {
    return pascal
        .replace(/([A-Z])/g, (_, c, i) => (i > 0 ? '-' : '') + c.toLowerCase())
        .replace(/^-/, '');
}
