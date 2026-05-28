import * as vscode from 'vscode';
import { PatternStore } from '../patternStore';
import { buildHtml, MessageHandler, WebviewMessage } from './webviewCore';

export class ReplaceView implements vscode.WebviewViewProvider {
    static readonly viewId = 'dpa-rex-refacror.sidebar';

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly store: PatternStore,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        webviewView.webview.html = buildHtml(webviewView.webview, this.extensionUri);

        const handler = new MessageHandler(
            this.store,
            msg => webviewView.webview.postMessage(msg),
        );

        webviewView.webview.onDidReceiveMessage(
            (msg: WebviewMessage) => handler.handle(msg),
        );

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { handler.pushHistory(); }
        });

        setTimeout(() => handler.pushHistory(), 300);
    }
}
