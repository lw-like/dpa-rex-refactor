import * as vscode from 'vscode';
import { ReplacePanel } from './ui/replacePanel';
import { ReplaceView } from './ui/replaceView';
import { PatternStore } from './patternStore';

let store: PatternStore;
let replaceView: ReplaceView;

export function activate(context: vscode.ExtensionContext): void {
    store = new PatternStore(context);
    replaceView = new ReplaceView(context.extensionUri, store);

    context.subscriptions.push(
        vscode.commands.registerCommand('dpa-rex-refacror.openPanel', () => {
            ReplacePanel.createOrShow(context.extensionUri, store);
        }),
        vscode.commands.registerCommand('dpa-rex-refacror.analyzeSelection', () => {
            const editor = vscode.window.activeTextEditor;
            const text = (editor && !editor.selection.isEmpty)
                ? editor.document.getText(editor.selection) : '';
            replaceView.analyzeSelection(text);
        }),
        vscode.window.registerWebviewViewProvider(
            ReplaceView.viewId,
            replaceView,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );
}

export function deactivate(): void {}
