import * as vscode from 'vscode';
import { ReplacePanel } from './ui/replacePanel';
import { ReplaceView } from './ui/replaceView';
import { PatternStore } from './patternStore';
import { extractAngularComponent } from './angular/extractCommand';
import { registerChangeDetectionCommand } from './angular/changeDetectionScanner';
import { registerShareReplayLeakCommand } from './angular/rxjsLeakScanner';
import { registerListTrackingCommand } from './angular/listTrackingScanner';
import { registerHeavyImportCommand } from './angular/heavyImportScanner';
import { registerNestedSwitchMapCommand } from './angular/nestedSwitchMapScanner';
import { registerTemplateFunctionCallCommand } from './angular/templateFunctionCallScanner';
import { registerHttpInEffectCommand } from './angular/httpInEffectScanner';
import { registerUnmanagedSubscriptionCommand } from './angular/unmanagedSubscriptionScanner';
import { registerUnmanagedTimerCommand } from './angular/unmanagedTimerScanner';
import { registerUnoptimizedImageCommand } from './angular/unoptimizedImageScanner';
import { registerManualChangeDetectionCommand } from './angular/manualChangeDetectionScanner';
import { registerRepeatedExpressionCommand } from './angular/repeatedExpressionScanner';
import { registerLargeListCommand } from './angular/largeListScanner';
import { registerUnsafeToSignalCommand } from './angular/unsafeToSignalScanner';
import { registerNestedSubscriptionCommand } from './angular/nestedSubscriptionScanner';
import { registerEagerRouteCommand } from './angular/eagerRouteScanner';
import { registerMutabilityCommand } from './angular/mutabilityScanner';

let store: PatternStore;
let replaceView: ReplaceView;

export function activate(context: vscode.ExtensionContext): void {
    store = new PatternStore(context);

    // Single shared diagnostics collection for all Angular audit scanners
    const diagnostics = vscode.languages.createDiagnosticCollection('angular-perf');
    context.subscriptions.push(diagnostics);

    replaceView = new ReplaceView(context.extensionUri, store, context, diagnostics);

    context.subscriptions.push(
        vscode.commands.registerCommand('dpa-rex-refacror.openPanel', () => {
            ReplacePanel.createOrShow(context.extensionUri, store, context, diagnostics);
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
        registerChangeDetectionCommand(context, diagnostics),
        registerShareReplayLeakCommand(context, diagnostics),
        registerListTrackingCommand(context, diagnostics),
        registerHeavyImportCommand(context, diagnostics),
        registerNestedSwitchMapCommand(context, diagnostics),
        registerTemplateFunctionCallCommand(context, diagnostics),
        registerHttpInEffectCommand(context, diagnostics),
        registerUnmanagedSubscriptionCommand(context, diagnostics),
        registerUnmanagedTimerCommand(context, diagnostics),
        registerUnoptimizedImageCommand(context, diagnostics),
        registerManualChangeDetectionCommand(context, diagnostics),
        registerRepeatedExpressionCommand(context, diagnostics),
        registerLargeListCommand(context, diagnostics),
        registerUnsafeToSignalCommand(context, diagnostics),
        registerNestedSubscriptionCommand(context, diagnostics),
        registerEagerRouteCommand(context, diagnostics),
        registerMutabilityCommand(context, diagnostics),
    );
}

export function deactivate(): void {}
