import * as vscode from 'vscode';

export interface ResolvedComponent {
    selector: string;
    className: string;
    fsPath: string;
}

export interface ComponentResolution {
    resolved: ResolvedComponent[];
    unresolved: string[];   // selectors present in HTML but not found in workspace
}

const EXCLUDE_PATTERN = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/coverage/**}';

/**
 * Builds a workspace-wide index of selector → component class, then returns
 * which of the given selectors were found locally and which were not.
 * Unresolved selectors are likely third-party (e.g. mat-*, ng-*, etc.).
 */
export async function resolveCustomComponents(
    selectors: string[],
    progress?: vscode.Progress<{ message?: string }>,
): Promise<ComponentResolution> {
    if (selectors.length === 0) { return { resolved: [], unresolved: [] }; }

    progress?.report({ message: 'Indexing workspace components…' });

    const tsFiles = await vscode.workspace.findFiles('**/*.ts', EXCLUDE_PATTERN);

    // Map selector string → { className, fsPath }
    const index = new Map<string, { className: string; fsPath: string }>();

    await Promise.all(tsFiles.map(async (uri) => {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');

            if (!text.includes('@Component')) { return; }

            const selectorMatch = /selector\s*:\s*['"]([^'"]+)['"]/m.exec(text);
            if (!selectorMatch) { return; }

            const classMatch = /export\s+class\s+(\w+)/.exec(text);
            if (!classMatch) { return; }

            index.set(selectorMatch[1], { className: classMatch[1], fsPath: uri.fsPath });
        } catch {
            // ignore unreadable files
        }
    }));

    const resolved: ResolvedComponent[] = [];
    const unresolved: string[] = [];

    for (const selector of selectors) {
        const entry = index.get(selector);
        if (entry) {
            resolved.push({ selector, ...entry });
        } else {
            unresolved.push(selector);
        }
    }

    return { resolved, unresolved };
}
