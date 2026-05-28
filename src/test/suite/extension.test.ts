import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Running extension tests.');

    test('Command dpa-rex-refacror.openPanel is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('dpa-rex-refacror.openPanel'),
            'dpa-rex-refacror.openPanel command must be registered'
        );
    });

    test('Extension activates without error', async () => {
        const ext = vscode.extensions.getExtension('dpa-rex-refacror.dpa-rex-refacror');
        assert.ok(ext, 'Extension should be present');
        await ext?.activate();
        assert.ok(ext?.isActive, 'Extension should be active after activate()');
    });
});
