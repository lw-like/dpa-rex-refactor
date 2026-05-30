import * as vscode from 'vscode';
import { TodoData, TodoItem } from '../angular/componentGenerator';

export class TodoReviewPanel {
    private static readonly panels = new Map<string, TodoReviewPanel>();
    private static readonly viewType = 'dpa-rex-refacror.todoReview';

    private readonly panel: vscode.WebviewPanel;
    private data: TodoData;
    private readonly todoUri: vscode.Uri;
    private readonly disposables: vscode.Disposable[] = [];

    static show(todoUri: vscode.Uri, data: TodoData): void {
        const key = todoUri.fsPath;
        const existing = TodoReviewPanel.panels.get(key);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.Beside);
            existing.sendData();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            TodoReviewPanel.viewType,
            `${data.component} — Styles Checklist`,
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        TodoReviewPanel.panels.set(key, new TodoReviewPanel(panel, todoUri, data, key));
    }

    private constructor(panel: vscode.WebviewPanel, todoUri: vscode.Uri, data: TodoData, key: string) {
        this.panel = panel;
        this.todoUri = todoUri;
        this.data = data;
        this.panel.webview.html = buildHtml();
        this.panel.onDidDispose(() => {
            TodoReviewPanel.panels.delete(key);
            this.disposables.forEach(d => d.dispose());
            this.disposables.length = 0;
        }, null, this.disposables);
        this.panel.webview.onDidReceiveMessage(msg => this.handle(msg), null, this.disposables);
    }

    private sendData(): void {
        this.panel.webview.postMessage({ type: 'init', data: this.data });
    }

    private async handle(msg: {
        type: string;
        groupIndex?: number;
        itemIndex?: number;
        checked?: boolean;
    }): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this.sendData();
                break;

            case 'toggle': {
                const item = this.data.groups[msg.groupIndex!]?.items[msg.itemIndex!];
                if (item) {
                    item.checked = msg.checked!;
                    await vscode.workspace.fs.writeFile(
                        this.todoUri,
                        Buffer.from(JSON.stringify(this.data, null, 2), 'utf8'),
                    );
                }
                break;
            }

            case 'openOnSelector': {
                const group = this.data.groups[msg.groupIndex!];
                const item = group?.items[msg.itemIndex!];
                if (!group || !item) { break; }
                try {
                    const uri = vscode.Uri.file(group.originFsPath);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                    const line = findSelectorLine(doc, item);
                    if (line >= 0) {
                        const pos = new vscode.Position(line, 0);
                        editor.selection = new vscode.Selection(pos, pos);
                        editor.revealRange(
                            new vscode.Range(pos, pos),
                            vscode.TextEditorRevealType.InCenter,
                        );
                    }
                } catch {
                    vscode.window.showErrorMessage(`Could not open: ${group.originFile}`);
                }
                break;
            }
        }
    }
}

/**
 * Finds the 0-based line number where the item's selector is defined.
 *
 * Strategy:
 * - Root class (.cl-header): search for the root selector followed by whitespace or {
 * - BEM child (&--right):    first find the parent block (.cl-header), then find the
 *                            leaf selector (&--right / &__element) after that point
 */
function findSelectorLine(doc: vscode.TextDocument, item: TodoItem): number {
    const text = doc.getText();
    const lines = text.split('\n');

    if (item.isRoot) {
        const rootSel = item.selectorChain[0]; // e.g. ".cl-header"
        return lines.findIndex(l => {
            const t = l.trim();
            return t.startsWith(rootSel) && /[\s{,]/.test(t.slice(rootSel.length) || ' ');
        });
    }

    // BEM child: locate parent block first, then find leaf selector after it
    const parentSel = item.selectorChain[0];      // e.g. ".cl-header"
    const leafSel   = item.selectorChain[item.selectorChain.length - 1]; // e.g. "&--right"

    const parentLine = lines.findIndex(l => {
        const t = l.trim();
        return t.startsWith(parentSel) && /[\s{,]/.test(t.slice(parentSel.length) || ' ');
    });

    const searchFrom = parentLine >= 0 ? parentLine + 1 : 0;

    const leafLine = lines.findIndex((l, i) => {
        if (i < searchFrom) { return false; }
        const t = l.trim();
        return t.startsWith(leafSel) && /[\s{,]/.test(t.slice(leafSel.length) || ' ');
    });

    return leafLine;
}

function buildHtml(): string {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px 20px;
    line-height: 1.5;
}
h1 { font-size: 1.1em; font-weight: 600; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.subtitle { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin: 6px 0 4px; }
.subtitle code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textBlockQuote-background); padding: 1px 4px; border-radius: 2px; }
.progress { font-size: 0.82em; color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
.group { margin-bottom: 16px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
.group-header {
    padding: 7px 12px;
    background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-inactiveSelectionBackground));
}
.origin { font-family: var(--vscode-editor-font-family); font-size: 0.82em; color: var(--vscode-descriptionForeground); }
.item { padding: 8px 12px; border-top: 1px solid var(--vscode-panel-border); }
.item.done { opacity: 0.42; }
.item-row { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; }
.item-row input[type=checkbox] { cursor: pointer; flex-shrink: 0; margin-top: 2px; }
.cls { font-family: var(--vscode-editor-font-family); font-weight: bold; font-size: 0.9em; }
.bem { font-family: var(--vscode-editor-font-family); font-size: 0.78em; color: var(--vscode-descriptionForeground); flex: 1; }
.goto-btn {
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font-size: 0.88em;
    padding: 0 2px;
    line-height: 1;
    opacity: 0.7;
}
.goto-btn:hover { opacity: 1; text-decoration: underline; }
pre {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.82em;
    background: var(--vscode-textBlockQuote-background);
    border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border));
    padding: 6px 10px;
    border-radius: 0 3px 3px 0;
    overflow-x: auto;
    white-space: pre;
    margin-left: 20px;
}
</style>
</head>
<body>
<div id="root"><p style="color:var(--vscode-descriptionForeground)">Loading…</p></div>
<script>
const vscode = acquireVsCodeApi();
let data = null;

function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function render() {
    if (!data) { return; }
    const allItems = data.groups.flatMap(g => g.items);
    const done = allItems.filter(i => i.checked).length;
    const total = allItems.length;

    document.getElementById('root').innerHTML =
        '<h1>' + esc(data.component) + '</h1>' +
        '<p class="subtitle">Verify each rule was copied into <code>' + esc(data.scssFile) + '</code>, delete it from the origin, then tick the box.</p>' +
        '<p class="progress" id="prog">' + done + ' / ' + total + ' done</p>' +
        data.groups.map((g, gi) =>
            '<div class="group">' +
            '<div class="group-header"><span class="origin">' + esc(g.originFile) + '</span></div>' +
            g.items.map((item, ii) =>
                '<div class="item' + (item.checked ? ' done' : '') + '" id="i' + gi + '-' + ii + '">' +
                '<div class="item-row">' +
                '<input type="checkbox" data-action="toggle" data-gi="' + gi + '" data-ii="' + ii + '"' + (item.checked ? ' checked' : '') + '>' +
                '<span class="cls">.' + esc(item.className) + '</span>' +
                (item.isRoot
                    ? '<span class="bem">(direct properties)</span>'
                    : '<span class="bem">&#8594; ' + esc(item.selectorChain.join(' > ')) + '</span>') +
                '<button class="goto-btn" data-action="goto" data-gi="' + gi + '" data-ii="' + ii + '" title="Go to selector in origin file">&#8599;</button>' +
                '</div>' +
                '<pre>' + esc(item.content) + '</pre>' +
                '</div>'
            ).join('') +
            '</div>'
        ).join('');
}

function updateProgress() {
    const allItems = data.groups.flatMap(g => g.items);
    const done = allItems.filter(i => i.checked).length;
    document.getElementById('prog').textContent = done + ' / ' + allItems.length + ' done';
}

document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) { return; }
    const gi = parseInt(el.dataset.gi);
    const ii = parseInt(el.dataset.ii);

    if (el.dataset.action === 'goto') {
        vscode.postMessage({ type: 'openOnSelector', groupIndex: gi, itemIndex: ii });
    }
    if (el.dataset.action === 'toggle') {
        const checked = el.checked;
        data.groups[gi].items[ii].checked = checked;
        const row = document.getElementById('i' + gi + '-' + ii);
        if (row) { row.className = 'item' + (checked ? ' done' : ''); }
        updateProgress();
        vscode.postMessage({ type: 'toggle', groupIndex: gi, itemIndex: ii, checked });
    }
});

window.addEventListener('message', e => {
    if (e.data.type === 'init') { data = e.data.data; render(); }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
