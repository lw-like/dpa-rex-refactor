import * as vscode from 'vscode';
import * as path from 'path';
import { analyzeHtml } from './htmlAnalyzer';
import { scanClassUsage, ClassUsage, relativePath } from './cssScanner';
import { resolveCustomComponents, ResolvedComponent } from './componentResolver';
import { generateComponent, toPascalCase, toSelector, ComponentSpec, ComponentImport, TodoData } from './componentGenerator';
import { TodoReviewPanel } from '../ui/todoReviewPanel';

export async function extractAngularComponent(): Promise<void> {
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

    const spec: ComponentSpec = {
        name: componentName,
        selector: toSelector(componentName),
        template: selectedHtml,
        inputs: confirmedInputs,
        outputs: confirmedOutputs,
        classUsages,
        moveClasses,
        componentImports,
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
    const edit = new vscode.WorkspaceEdit();
    const componentTag = `<${spec.selector} />`;
    edit.replace(editor.document.uri, editor.selection, componentTag);
    insertImportInParent(edit, editor.document, componentName, files.tsFileName, componentDir);

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
        vscode.window.showErrorMessage('Failed to update parent component. New files were created but parent was not modified.');
        return;
    }

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

function insertImportInParent(
    edit: vscode.WorkspaceEdit,
    doc: vscode.TextDocument,
    componentName: string,
    tsFileName: string,
    componentDir: string,
): void {
    const text = doc.getText();

    // Find imports: [ ... ] array in the parent component
    const importsMatch = /imports\s*:\s*\[([^\]]*)\]/s.exec(text);
    if (!importsMatch) { return; }

    const insertOffset = text.indexOf(importsMatch[0]) + importsMatch[0].lastIndexOf(']');
    const insertPos = doc.positionAt(insertOffset);

    const sourceDir = path.dirname(doc.uri.fsPath);
    let importPath = path.relative(sourceDir, path.join(componentDir, tsFileName.replace('.ts', ''))).replace(/\\/g, '/');
    if (!importPath.startsWith('.')) { importPath = './' + importPath; }

    const importStatement = `import { ${componentName}Component } from '${importPath}';\n`;
    const arrayEntry = `, ${componentName}Component`;

    // Prepend the import at top of file and add to imports array
    edit.insert(doc.uri, new vscode.Position(0, 0), importStatement);
    edit.insert(doc.uri, insertPos, arrayEntry);
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

function toKebabCase(pascal: string): string {
    return pascal
        .replace(/([A-Z])/g, (_, c, i) => (i > 0 ? '-' : '') + c.toLowerCase())
        .replace(/^-/, '');
}
