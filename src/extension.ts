import * as vscode from 'vscode';
import { ReplacePanel } from './ui/replacePanel';
import { ReplaceView } from './ui/replaceView';
import { PatternStore } from './patternStore';
import { extractAngularComponent } from './angular/extractCommand';

let store: PatternStore;
let replaceView: ReplaceView;

export function activate(context: vscode.ExtensionContext): void {
    store = new PatternStore(context);
    replaceView = new ReplaceView(context.extensionUri, store, context);

    context.subscriptions.push(
        vscode.commands.registerCommand('dpa-rex-refacror.openPanel', () => {
            ReplacePanel.createOrShow(context.extensionUri, store, context);
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
        vscode.commands.registerCommand('dpa-rex-refacror.extractAngularComponent', () => extractAngularComponent(context)),
    );
}

export function deactivate(): void {}
