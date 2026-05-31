import * as vscode from 'vscode';
import { PatternStore } from '../patternStore';
import { buildHtml, MessageHandler, WebviewMessage } from './webviewCore';

export class ReplaceView implements vscode.WebviewViewProvider {
    static readonly viewId = 'dpa-rex-refacror.sidebar';

    private webviewView: vscode.WebviewView | undefined;
    private handler: MessageHandler | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly store: PatternStore,
        private readonly extContext: vscode.ExtensionContext,
        private readonly diagnostics: vscode.DiagnosticCollection,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.webviewView = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        webviewView.webview.html = buildHtml(webviewView.webview, this.extensionUri);

        this.handler = new MessageHandler(
            this.store,
            msg => webviewView.webview.postMessage(msg),
            this.extContext,
            this.diagnostics,
        );

        webviewView.webview.onDidReceiveMessage(
            (msg: WebviewMessage) => this.handler!.handle(msg),
        );

        const pushEditorContext = () => {
            if (!webviewView.visible) { return; }
            const editor = vscode.window.activeTextEditor;
            webviewView.webview.postMessage({
                type: 'editorContext',
                uri: editor?.document.uri.toString() ?? '',
            });
        };

        // Push whenever the active editor changes
        this.extContext.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => pushEditorContext()),
        );

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.handler!.pushHistory();
                this.handler!.pushPendingPattern();
                pushEditorContext();
            }
        });

        setTimeout(() => {
            this.handler!.pushHistory();
            this.handler!.pushPendingPattern();
            pushEditorContext();
        }, 300);
    }

    analyzeSelection(text: string): void {
        if (!this.webviewView || !this.handler) { return; }
        this.webviewView.show(true);
        this.handler.switchToPlanner(text);
    }
}
