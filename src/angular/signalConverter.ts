import * as vscode from 'vscode';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SignalConversionResult {
    varName: string;
    tsChanges: number;
    htmlChanges: number;
    diagnostics: string[];
}

export interface IOConversionResult {
    inputsConverted: string[];
    outputsConverted: string[];
    diagnostics: string[];
}

// ─── Convert primitive variable to signal ─────────────────────────────────────

interface PropertyDecl {
    indent: string;
    name: string;
    initialValue: string;
}

function parseDeclaration(line: string): PropertyDecl | null {
    // Matches: [modifiers] name[?!]: type = value; OR [modifiers] name = value;
    const m = /^([ \t]*)(?:(?:private|protected|public|readonly|override|static|abstract)\s+)*(\w+)\s*[!?]?\s*(?::\s*[^=;]+?)?\s*=\s*(.+?)\s*;?\s*$/.exec(line.trim() ? line : '');
    if (!m) { return null; }
    const value = m[3].trim().replace(/;$/, '').trim();
    return { indent: m[1], name: m[2], initialValue: value };
}

/**
 * Converts a selected primitive variable declaration to a signal and updates
 * all usages in the TypeScript file and (optionally) the companion HTML template.
 */
export async function runConvertToSignal(post: (msg: object) => void): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        post({ type: 'convertSignalError', error: 'No active editor.' });
        return;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection).trim();
    if (!selectedText) {
        post({ type: 'convertSignalError', error: 'Select a variable declaration first.' });
        return;
    }

    const decl = parseDeclaration(selectedText);
    if (!decl) {
        post({ type: 'convertSignalError', error: `Could not parse declaration: "${selectedText.slice(0, 60)}"` });
        return;
    }

    const tsUri  = editor.document.uri;
    const tsText = editor.document.getText();

    const { text: newTs, changes: tsChanges, diagnostics } = applySignalConversion(tsText, decl);

    const htmlUri  = resolveHtmlCompanion(tsUri.fsPath);
    let newHtml: string | undefined;
    let htmlChanges = 0;

    if (htmlUri) {
        try {
            const bytes = await vscode.workspace.fs.readFile(htmlUri);
            const html  = Buffer.from(bytes).toString('utf8');
            const r     = convertHtmlReads(html, decl.name);
            newHtml     = r.text;
            htmlChanges = r.changes;
        } catch { /* HTML missing — fine */ }
    }

    const edit = new vscode.WorkspaceEdit();
    const fullTs = new vscode.Range(tsDoc(tsUri, tsText).positionAt(0), tsDoc(tsUri, tsText).positionAt(tsText.length));

    // Apply via WorkspaceEdit to get undo support
    const tsDoc2 = await vscode.workspace.openTextDocument(tsUri);
    edit.replace(tsUri, new vscode.Range(tsDoc2.positionAt(0), tsDoc2.positionAt(tsText.length)), newTs);
    if (htmlUri && newHtml !== undefined) {
        const htmlDoc = await vscode.workspace.openTextDocument(htmlUri);
        const htmlOrig = htmlDoc.getText();
        edit.replace(htmlUri, new vscode.Range(htmlDoc.positionAt(0), htmlDoc.positionAt(htmlOrig.length)), newHtml);
    }

    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
        post({ type: 'convertSignalError', error: 'WorkspaceEdit was rejected.' });
        return;
    }

    const result: SignalConversionResult = { varName: decl.name, tsChanges, htmlChanges, diagnostics };
    post({ type: 'convertSignalResult', result });
}

function tsDoc(uri: vscode.Uri, text: string) {
    // Minimal shim so we can call positionAt without opening the document
    let line = 0; let col = 0;
    return {
        positionAt(offset: number) {
            let l = 0; let c = 0;
            for (let i = 0; i < offset && i < text.length; i++) {
                if (text[i] === '\n') { l++; c = 0; } else { c++; }
            }
            return new vscode.Position(l, c);
        },
    };
}

function applySignalConversion(text: string, decl: PropertyDecl): { text: string; changes: number; diagnostics: string[] } {
    const diags: string[] = [];
    const v = decl.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let changes = 0;

    const replace = (re: RegExp, fn: (m: string, ...args: string[]) => string) => {
        const before = text;
        text = text.replace(re, fn as any);
        if (text !== before) { changes++; }
    };

    // 1. Rewrite the declaration — strip modifiers, wrap in signal()
    replace(
        new RegExp(`^([ \\t]*)(?:(?:private|protected|public|readonly|override|static|abstract)\\s+)*${v}\\s*[!?]?\\s*(?::\\s*[^=;]+?)?\\s*=\\s*[^;]+;`, 'm'),
        (_, indent) => `${indent}${decl.name} = signal(${decl.initialValue});`,
    );

    // 2. Compound assignments: this.name += x → this.name.update(v => v + x)
    replace(
        new RegExp(`\\bthis\\.${v}\\s*\\+=\\s*([^;\\n]+)`, 'g'),
        (_, rhs) => `this.${decl.name}.update(v => v + ${rhs.trim()})`,
    );
    replace(
        new RegExp(`\\bthis\\.${v}\\s*-=\\s*([^;\\n]+)`, 'g'),
        (_, rhs) => `this.${decl.name}.update(v => v - ${rhs.trim()})`,
    );
    replace(
        new RegExp(`\\bthis\\.${v}\\s*\\*=\\s*([^;\\n]+)`, 'g'),
        (_, rhs) => `this.${decl.name}.update(v => v * ${rhs.trim()})`,
    );

    // 3. Increment / decrement
    replace(new RegExp(`\\bthis\\.${v}\\+\\+`, 'g'), () => `this.${decl.name}.update(v => v + 1)`);
    replace(new RegExp(`\\bthis\\.${v}--`, 'g'),    () => `this.${decl.name}.update(v => v - 1)`);
    replace(new RegExp(`\\+\\+this\\.${v}\\b`, 'g'), () => `this.${decl.name}.update(v => v + 1)`);
    replace(new RegExp(`--this\\.${v}\\b`, 'g'),     () => `this.${decl.name}.update(v => v - 1)`);

    // 4. Simple assignments: this.name = expr (not === / !==)
    replace(
        new RegExp(`\\bthis\\.${v}\\s*=(?!=)\\s*([^;\\n]+)`, 'g'),
        (_, rhs) => `this.${decl.name}.set(${rhs.trim()})`,
    );

    // 5. Plain reads: this.name not already followed by ( or .
    //    Also convert this.name.someMethod/prop → this.name().someMethod/prop
    replace(
        new RegExp(`\\bthis\\.${v}\\.`, 'g'),
        () => `this.${decl.name}().`,
    );
    replace(
        new RegExp(`\\bthis\\.${v}\\b(?!\\s*[.(])`, 'g'),
        () => `this.${decl.name}()`,
    );

    // 6. Add signal to @angular/core imports
    text = addSpecifierToCoreImport(text, 'signal');

    if (changes === 0) {
        diags.push('Declaration rewritten but no usages found to update — check manually.');
    }

    return { text, changes, diagnostics: diags };
}

function convertHtmlReads(html: string, varName: string): { text: string; changes: number } {
    const v = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let changes = 0;
    // Replace varName (not already followed by () ) inside Angular binding/interpolation contexts
    const result = html.replace(
        new RegExp(`\\b${v}\\b(?!\\s*\\()`, 'g'),
        (m) => { changes++; return `${varName}()`; },
    );
    return { text: result, changes };
}

// ─── Convert @Input / @Output to signal form ──────────────────────────────────

/**
 * Scans the active TypeScript file for @Input() and @Output() decorators and
 * converts them to the Angular 21+ signal API (input() / output()).
 */
export async function runConvertInputsOutputs(post: (msg: object) => void): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        post({ type: 'convertIOError', error: 'No active editor.' });
        return;
    }
    if (!editor.document.fileName.endsWith('.ts')) {
        post({ type: 'convertIOError', error: 'Open the component .ts file first.' });
        return;
    }

    const tsUri  = editor.document.uri;
    const tsText = editor.document.getText();

    const { text: newTs, result } = applyIOConversion(tsText);

    if (result.inputsConverted.length === 0 && result.outputsConverted.length === 0) {
        post({ type: 'convertIOResult', result: { ...result, message: 'No @Input() or @Output() decorators found.' } });
        return;
    }

    const htmlUri = resolveHtmlCompanion(tsUri.fsPath);
    let htmlEdit: { uri: vscode.Uri; original: string; newText: string } | undefined;

    if (htmlUri && result.inputsConverted.length > 0) {
        try {
            const b = await vscode.workspace.fs.readFile(htmlUri);
            const html = Buffer.from(b).toString('utf8');
            let newHtml = html;
            for (const name of result.inputsConverted) {
                newHtml = convertHtmlReads(newHtml, name).text;
            }
            if (newHtml !== html) {
                const htmlDoc = await vscode.workspace.openTextDocument(htmlUri);
                htmlEdit = { uri: htmlUri, original: htmlDoc.getText(), newText: newHtml };
            }
        } catch { /* no HTML */ }
    }

    const tsDoc = await vscode.workspace.openTextDocument(tsUri);
    const edit  = new vscode.WorkspaceEdit();
    edit.replace(tsUri, new vscode.Range(tsDoc.positionAt(0), tsDoc.positionAt(tsText.length)), newTs);
    if (htmlEdit) {
        const hDoc = await vscode.workspace.openTextDocument(htmlEdit.uri);
        edit.replace(htmlEdit.uri, new vscode.Range(hDoc.positionAt(0), hDoc.positionAt(htmlEdit.original.length)), htmlEdit.newText);
    }

    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
        post({ type: 'convertIOError', error: 'WorkspaceEdit was rejected.' });
        return;
    }

    post({ type: 'convertIOResult', result });
}

function applyIOConversion(text: string): { text: string; result: IOConversionResult } {
    const inputsConverted: string[] = [];
    const outputsConverted: string[] = [];
    const diagnostics: string[] = [];

    // ── @Input() ─────────────────────────────────────────────────────────────
    // Pattern A: @Input() name: Type = default;  →  name = input(default);
    // Pattern B: @Input() name!: Type;           →  name = input.required<Type>();
    // Pattern C: @Input({ required: true }) name!: Type;  →  name = input.required<Type>();

    text = text.replace(
        /@Input\s*\(([^)]*)\)\s*\n?([ \t]*)(\w+)\s*([!?])?\s*:\s*([^=;\n]+?)\s*(?:=\s*([^;\n]+?))?\s*;/g,
        (_, opts, indent, name, bang, type, defaultVal) => {
            inputsConverted.push(name);
            const t = type.trim();
            const isRequired = bang === '!' || /required\s*:\s*true/.test(opts);
            if (isRequired && !defaultVal) {
                return `${indent}${name} = input.required<${t}>();`;
            }
            const d = defaultVal?.trim();
            return d
                ? `${indent}${name} = input<${t}>(${d});`
                : `${indent}${name} = input<${t}>();`;
        },
    );

    // ── @Output() ─────────────────────────────────────────────────────────────
    // Pattern: @Output() name = new EventEmitter<T>();  →  name = output<T>();
    text = text.replace(
        /@Output\s*\([^)]*\)\s*\n?([ \t]*)(\w+)\s*(?::\s*EventEmitter<([^>]+)>)?\s*=\s*new\s+EventEmitter(?:<([^>]+)>)?\s*\(\s*\)\s*;/g,
        (_, indent, name, typeA, typeB) => {
            outputsConverted.push(name);
            const t = (typeA || typeB || '').trim();
            return t ? `${indent}${name} = output<${t}>();` : `${indent}${name} = output();`;
        },
    );

    // ── Update imports ─────────────────────────────────────────────────────────
    if (inputsConverted.length > 0) {
        text = addSpecifierToCoreImport(text, 'input');
        text = removeSpecifierFromCoreImport(text, 'Input');
    }
    if (outputsConverted.length > 0) {
        text = addSpecifierToCoreImport(text, 'output');
        text = removeSpecifierFromCoreImport(text, 'Output');
        // Remove EventEmitter import only if no remaining usages
        if (!/\bEventEmitter\b/.test(text.replace(/^import.+$/gm, ''))) {
            text = removeSpecifierFromCoreImport(text, 'EventEmitter');
        }
    }

    if (inputsConverted.length > 0) {
        diagnostics.push(`Converted inputs are now signals — update template reads: {{ name }} → {{ name() }}, [attr]="name" → [attr]="name()"`);
    }

    return { text, result: { inputsConverted, outputsConverted, diagnostics } };
}

// ─── Import helpers ───────────────────────────────────────────────────────────

function addSpecifierToCoreImport(text: string, specifier: string): string {
    const m = /import\s*\{([^}]+)\}\s*from\s*['"]@angular\/core['"]/m.exec(text);
    if (!m) { return text; }
    const existing = m[1].split(',').map(s => s.trim()).filter(Boolean);
    if (existing.includes(specifier)) { return text; }
    return text.slice(0, m.index) +
        `import { ${[...existing, specifier].join(', ')} } from '@angular/core'` +
        text.slice(m.index + m[0].length);
}

function removeSpecifierFromCoreImport(text: string, specifier: string): string {
    const m = /import\s*\{([^}]+)\}\s*from\s*['"]@angular\/core['"]/m.exec(text);
    if (!m) { return text; }
    const kept = m[1].split(',').map(s => s.trim()).filter(s => s && s !== specifier);
    if (kept.length === 0) {
        // Remove the whole import line
        const lineEnd = text.indexOf('\n', m.index);
        return text.slice(0, m.index) + text.slice(lineEnd >= 0 ? lineEnd + 1 : m.index + m[0].length);
    }
    return text.slice(0, m.index) +
        `import { ${kept.join(', ')} } from '@angular/core'` +
        text.slice(m.index + m[0].length);
}

// ─── Resolve HTML companion ───────────────────────────────────────────────────

function resolveHtmlCompanion(tsPath: string): vscode.Uri | undefined {
    const candidate = tsPath.replace(/\.ts$/, '.html');
    try {
        require('fs').accessSync(candidate);
        return vscode.Uri.file(candidate);
    } catch {
        return undefined;
    }
}
