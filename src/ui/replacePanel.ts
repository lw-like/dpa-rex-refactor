import * as vscode from 'vscode';
import { PatternStore } from '../patternStore';
import { buildHtml, MessageHandler, WebviewMessage } from './webviewCore';

export class ReplacePanel {
    static currentPanel: ReplacePanel | undefined;
    private static readonly viewType = 'dpa-rex-refacror.panel';

    private readonly panel: vscode.WebviewPanel;
    private readonly handler: MessageHandler;
    private readonly disposables: vscode.Disposable[] = [];

    static createOrShow(
        extensionUri: vscode.Uri,
        store: PatternStore,
        context: vscode.ExtensionContext,
        diagnostics: vscode.DiagnosticCollection,
    ): void {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        if (ReplacePanel.currentPanel) {
            ReplacePanel.currentPanel.panel.reveal(column);
            ReplacePanel.currentPanel.handler.pushHistory();
            ReplacePanel.currentPanel.handler.pushPendingPattern();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ReplacePanel.viewType,
            'DPA-REX-Refacror',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );

        ReplacePanel.currentPanel = new ReplacePanel(panel, store, extensionUri, context, diagnostics);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        store: PatternStore,
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
        diagnostics: vscode.DiagnosticCollection,
    ) {
        this.panel = panel;
        this.handler = new MessageHandler(
            store,
            msg => this.panel.webview.postMessage(msg),
            context,
            diagnostics,
        );
        this.panel.webview.html = buildHtml(panel.webview, extensionUri);

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            (msg: WebviewMessage) => this.handler.handle(msg),
            null,
            this.disposables
        );

        setTimeout(() => { this.handler.pushHistory(); this.handler.pushPendingPattern(); }, 300);
    }

    dispose(): void {
        ReplacePanel.currentPanel = undefined;
        this.panel.dispose();
        this.disposables.forEach(d => d.dispose());
        this.disposables.length = 0;
    }
}
