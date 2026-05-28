import * as vscode from 'vscode';
import { ReplacePanel } from './ui/replacePanel';
import { ReplaceView } from './ui/replaceView';
import { PatternStore } from './patternStore';

let store: PatternStore;

export function activate(context: vscode.ExtensionContext): void {
    store = new PatternStore(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('dpa-rex-refacror.openPanel', () => {
            ReplacePanel.createOrShow(context.extensionUri, store);
        }),
        vscode.window.registerWebviewViewProvider(
            ReplaceView.viewId,
            new ReplaceView(context.extensionUri, store),
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );
}

export function deactivate(): void {}
