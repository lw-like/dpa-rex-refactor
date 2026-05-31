import * as vscode from 'vscode';
import * as path from 'path';
import { analyzeComponentFile } from './formAnalyzer';
import { transformToSignalForm, TransformResult, toModelName } from './formTransformer';
import { transformHtml } from './htmlFormTransformer';
import { FormDetection, FormsAnalysisResult, FormsPreviewResult } from './formIR';

// ─── Resolve active component ─────────────────────────────────────────────────

export function resolveActiveComponentTs(): { tsPath: string } | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return null; }
    const p = editor.document.uri.fsPath;
    if (p.endsWith('.ts'))   { return { tsPath: p }; }
    if (p.endsWith('.html')) { return { tsPath: p.replace(/\.html$/, '.ts') }; }
    return null;
}

// ─── Analyse ──────────────────────────────────────────────────────────────────

export async function runFormsAnalysis(post: (msg: object) => void): Promise<void> {
    const active = resolveActiveComponentTs();
    if (!active) {
        post({
            type: 'formsAnalysisResult', detections: [], componentName: '', tsPath: '',
            error: 'No Angular component file is open. Open a .ts or .html file first.',
        });
        return;
    }
    const { tsPath } = active;
    try {
        const bytes     = await vscode.workspace.fs.readFile(vscode.Uri.file(tsPath));
        const tsContent = Buffer.from(bytes).toString('utf8');
        const detections = analyzeComponentFile(tsContent, tsPath);
        const componentName = detections[0]?.componentName
            ?? path.basename(tsPath, '.ts').replace(/\.component$/, '').replace(/[-_](.)/g, (_, c: string) => c.toUpperCase());
        const result: FormsAnalysisResult = { detections, componentName, tsPath, htmlPath: detections[0]?.htmlPath };
        post({ type: 'formsAnalysisResult', ...result });
    } catch (e: unknown) {
        post({ type: 'formsAnalysisResult', detections: [], componentName: '', tsPath,
            error: e instanceof Error ? e.message : String(e) });
    }
}

// ─── Preview ──────────────────────────────────────────────────────────────────

export async function buildFormsPreview(detection: FormDetection, post: (msg: object) => void): Promise<void> {
    try {
        const tsResult  = transformToSignalForm(detection);
        const modelName = toModelName(detection.variableName);

        // Scan the source file for old API usages that need replacing
        let apiDiags: string[] = [];
        try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(detection.filePath));
            const src   = Buffer.from(bytes).toString('utf8');
            apiDiags = replaceOldApiUsages(src, detection.variableName, modelName).diagnostics;
        } catch { /* best-effort */ }

        const tsPreview = [
            tsResult.interfaceBlock,
            '',
            tsResult.tsBlock,
            '',
            '// ── Imports ────────────────────────────────────────────────',
            `// Add to @angular/core:          ${tsResult.coreImports.join(', ')}`,
            `// Add to @angular/forms/signals: ${tsResult.signalFormsImports.join(', ')}`,
            `// Remove from @angular/forms:    ${tsResult.formsImportsToRemove.join(', ')}`,
            '// ── @Component decorator ────────────────────────────────────',
            '// Remove from imports[]:         ReactiveFormsModule',
            '// Add to imports[]:              FormField',
            '// ── Class fields ────────────────────────────────────────────',
            '// Auto-removed:  inject(FormBuilder) field declaration',
            '// Manual check:  constructor-injected FormBuilder parameter (remove if present)',
            '// ── API usages (auto-replaced) ──────────────────────────────',
            `// .get('x')/.controls.x → this.${detection.variableName}.x()`,
            `// .getRawValue()/.value → this.${modelName}()`,
            `// .setValue(v)          → this.${modelName}.set(v)`,
            `// .reset()              → this.${modelName}.set(/* initial value */)`,
        ].join('\n');

        let htmlPreview = '';
        const htmlDiags: string[] = [];
        if (detection.htmlPath) {
            try {
                const b = await vscode.workspace.fs.readFile(vscode.Uri.file(detection.htmlPath));
                const html = Buffer.from(b).toString('utf8');
                const r = transformHtml(html, detection.variableName, /formGroupName/.test(html));
                htmlPreview = r.output;
                htmlDiags.push(...r.diagnostics);
            } catch {
                htmlDiags.push('Could not read HTML template — HTML migration skipped');
            }
        }

        const preview: FormsPreviewResult = {
            variableName: detection.variableName,
            tsPreview,
            htmlPreview,
            htmlPath: detection.htmlPath,
            diagnostics: [...detection.diagnostics, ...htmlDiags, ...apiDiags],
        };
        post({ type: 'formsPreviewResult', preview });
    } catch (e: unknown) {
        post({ type: 'formsPreviewError', error: e instanceof Error ? e.message : String(e) });
    }
}

// ─── Apply migration ──────────────────────────────────────────────────────────

export async function applyFormsMigration(detection: FormDetection, post: (msg: object) => void): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
        `Apply Signal Forms migration to "${detection.variableName}" in ${detection.componentName}? This modifies source files.`,
        { modal: true }, 'Apply',
    );
    if (confirmed !== 'Apply') { return; }

    try {
        const tsResult  = transformToSignalForm(detection);
        const tsUri     = vscode.Uri.file(detection.filePath);
        const tsDoc     = await vscode.workspace.openTextDocument(tsUri);
        const origText  = tsDoc.getText();

        // Apply ALL TypeScript changes in memory via sorted string-splice operations.
        // This avoids VS Code rejecting a WorkspaceEdit with overlapping ranges.
        const newTsText = applyTsInMemory(origText, detection, tsResult);

        const edit = new vscode.WorkspaceEdit();
        // Single full-document replace — no range conflicts possible
        edit.replace(tsUri,
            new vscode.Range(tsDoc.positionAt(0), tsDoc.positionAt(origText.length)),
            newTsText,
        );

        // HTML file (separate document — no overlap risk)
        if (detection.htmlPath) {
            try {
                const htmlUri = vscode.Uri.file(detection.htmlPath);
                const htmlDoc = await vscode.workspace.openTextDocument(htmlUri);
                const htmlText = htmlDoc.getText();
                const { output } = transformHtml(htmlText, detection.variableName, /formGroupName/.test(htmlText));
                edit.replace(htmlUri,
                    new vscode.Range(htmlDoc.positionAt(0), htmlDoc.positionAt(htmlText.length)),
                    output,
                );
            } catch {
                vscode.window.showWarningMessage(
                    'Signal Forms: TS migrated. HTML template could not be auto-updated — migrate manually.',
                );
            }
        }

        const success = await vscode.workspace.applyEdit(edit);
        if (success) {
            post({ type: 'formsApplyResult', variableName: detection.variableName });
            vscode.window.showInformationMessage(
                `Signal Forms: "${detection.variableName}" migrated in ${detection.componentName}. Review TODOs in the output.`,
            );
        } else {
            post({ type: 'formsApplyError', error: 'WorkspaceEdit was rejected — the file may have changed since the preview was generated. Re-analyze and try again.' });
        }
    } catch (e: unknown) {
        post({ type: 'formsApplyError', error: e instanceof Error ? e.message : String(e) });
    }
}

// ─── In-memory TS transformation ─────────────────────────────────────────────

/**
 * Applies all Signal Forms migration transformations to `text` in a single pass.
 *
 * Each transformation is expressed as { start, end, newText }.
 * Ops are sorted descending by start offset so earlier positions are never
 * invalidated by later replacements.
 */
function applyTsInMemory(text: string, detection: FormDetection, result: TransformResult): string {
    const ops: Array<{ start: number; end: number; newText: string }> = [];

    // 1. Replace the form declaration (class property or this.varName = ... assignment)
    const [declStart, declEnd] = findDeclarationRange(text, detection.variableName);
    if (declStart !== -1) {
        ops.push({ start: declStart, end: declEnd, newText: result.tsBlock });
    }

    // 2. Insert the interface type definition before @Component decorator / export class
    const classMatch = /\n(@Component\b|export\s+class\b)/.exec(text);
    if (classMatch) {
        const pos = classMatch.index + 1;
        ops.push({ start: pos, end: pos, newText: result.interfaceBlock + '\n\n' });
    }

    // 3. Rewrite the @angular/forms import (remove Reactive Forms specifiers)
    const formsImport = /import\s*\{([^}]+)\}\s*from\s*['"]@angular\/forms['"]/m.exec(text);
    if (formsImport) {
        const kept = formsImport[1].split(',').map(s => s.trim()).filter(s => s && !result.formsImportsToRemove.includes(s));
        if (kept.length === 0) {
            // Remove entire import line (include trailing newline)
            const lineEnd = text.indexOf('\n', formsImport.index);
            ops.push({ start: formsImport.index, end: lineEnd >= 0 ? lineEnd + 1 : formsImport.index + formsImport[0].length, newText: '' });
        } else {
            ops.push({
                start: formsImport.index,
                end: formsImport.index + formsImport[0].length,
                newText: `import { ${kept.join(', ')} } from '@angular/forms'`,
            });
        }
    }

    // 4. Insert @angular/forms/signals import (after @angular/core import for clean ordering)
    if (!text.includes('@angular/forms/signals') && result.signalFormsImports.length > 0) {
        const coreImpEnd = findLineEnd(text, /@angular\/core/);
        const insertAt   = coreImpEnd !== -1 ? coreImpEnd : findLastImportEnd(text);
        ops.push({
            start: insertAt, end: insertAt,
            newText: `import { ${result.signalFormsImports.join(', ')} } from '@angular/forms/signals';\n`,
        });
    }

    // 5. Merge coreImports into the existing @angular/core import statement.
    //    Parse specifiers into an array, add missing ones, rewrite the whole statement —
    //    same pattern as step 3 so no stray commas from multiline originals.
    if (result.coreImports.length > 0) {
        const coreMatch = /import\s*\{([^}]+)\}\s*from\s*['"]@angular\/core['"]/m.exec(text);
        if (coreMatch) {
            const existing = coreMatch[1].split(',').map(s => s.trim()).filter(s => s.length > 0);
            const toAdd    = result.coreImports.filter(imp => !existing.includes(imp));
            if (toAdd.length > 0) {
                ops.push({
                    start: coreMatch.index,
                    end: coreMatch.index + coreMatch[0].length,
                    newText: `import { ${[...existing, ...toAdd].join(', ')} } from '@angular/core'`,
                });
            }
        } else {
            ops.push({ start: 0, end: 0, newText: `import { ${result.coreImports.join(', ')} } from '@angular/core';\n` });
        }
    }

    // 6+7. Rewrite @Component({ imports: [...] }) in one pass:
    //      remove ReactiveFormsModule, add FormField — single op avoids stray commas
    const compImportsMatch = /\bimports\s*:\s*\[([^\]]*)\]/.exec(text);
    if (compImportsMatch) {
        const arrayOpenPos = compImportsMatch.index + compImportsMatch[0].indexOf('[');
        const contentStart = arrayOpenPos + 1;
        const contentEnd   = contentStart + compImportsMatch[1].length;
        const elements = compImportsMatch[1]
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0 && s !== 'ReactiveFormsModule');
        if (!elements.includes('FormField')) {
            elements.push('FormField');
        }
        ops.push({ start: contentStart, end: contentEnd, newText: elements.join(', ') });
    }

    // 8. Remove FormBuilder inject() field declaration
    //    Matches: private (readonly) anyName = inject(FormBuilder);
    const fbInjectRe = /\n[ \t]*(?:(?:private|protected|public)[ \t]+)?(?:readonly[ \t]+)?\w+\s*=\s*inject\s*\(\s*FormBuilder\s*\)\s*;/;
    const fbInjectMatch = fbInjectRe.exec(text);
    if (fbInjectMatch) {
        ops.push({ start: fbInjectMatch.index, end: fbInjectMatch.index + fbInjectMatch[0].length, newText: '' });
    }

    // Apply ops from bottom to top — earlier offsets are never shifted
    ops.sort((a, b) => b.start - a.start);

    let out = text;
    for (const op of ops) {
        out = out.slice(0, op.start) + op.newText + out.slice(op.end);
    }

    // 9. Replace old FormGroup API usages with Signal Forms equivalents
    const { text: replaced } = replaceOldApiUsages(out, detection.variableName, toModelName(detection.variableName));
    return replaced;
}

// ─── Old Reactive Forms API → Signal Forms replacements ───────────────────────

/**
 * Scans `text` for old FormGroup API calls on `this.varName` and replaces them
 * with Signal Forms equivalents. Also returns diagnostics for patterns that
 * require manual migration.
 */
export function replaceOldApiUsages(
    text: string,
    varName: string,
    modelName: string,
): { text: string; diagnostics: string[] } {
    const v   = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const diags: string[] = [];

    // .get('field') / .get("field") → .field()
    text = text.replace(
        new RegExp(`\\bthis\\.${v}\\.get\\s*\\(\\s*['"]([\\w]+)['"]\\s*\\)`, 'g'),
        (_, field) => `this.${varName}.${field}()`,
    );

    // .controls.field → .field()
    text = text.replace(
        new RegExp(`\\bthis\\.${v}\\.controls\\.([\\w]+)`, 'g'),
        (_, field) => `this.${varName}.${field}()`,
    );

    // .controls['field'] / .controls["field"] → .field()
    text = text.replace(
        new RegExp(`\\bthis\\.${v}\\.controls\\s*\\[\\s*['"]([\\w]+)['"]\\s*\\]`, 'g'),
        (_, field) => `this.${varName}.${field}()`,
    );

    // .getRawValue() → this.modelName()
    text = text.replace(
        new RegExp(`\\bthis\\.${v}\\.getRawValue\\s*\\(\\s*\\)`, 'g'),
        `this.${modelName}()`,
    );

    // .value (property access, not part of .setValue) → this.modelName()
    text = text.replace(
        new RegExp(`\\bthis\\.${v}\\.value\\b`, 'g'),
        `this.${modelName}()`,
    );

    // .setValue( → this.modelName.set(
    text = text.replace(
        new RegExp(`\\bthis\\.${v}\\.setValue\\s*\\(`, 'g'),
        `this.${modelName}.set(`,
    );

    // .reset() (no args) → this.modelName.set(/* TODO: initial value */)
    text = text.replace(
        new RegExp(`\\bthis\\.${v}\\.reset\\s*\\(\\s*\\)`, 'g'),
        `this.${modelName}.set(/* TODO: provide initial value */)`,
    );

    // .valid / .invalid — form is a signal, invalid is also a signal: this.form().invalid()
    text = text.replace(
        new RegExp(`\\bthis\\.${v}\\.valid\\b(?!\\s*\\()`, 'g'),
        `this.${varName}().valid()`,
    );
    text = text.replace(
        new RegExp(`\\bthis\\.${v}\\.invalid\\b(?!\\s*\\()`, 'g'),
        `this.${varName}().invalid()`,
    );

    // Patterns that cannot be auto-replaced — surface as diagnostics
    if (new RegExp(`\\bthis\\.${v}\\.patchValue\\s*\\(`).test(text)) {
        diags.push(`patchValue() → this.${modelName}.update(v => ({ ...v, ...changes }))`);
    }
    if (new RegExp(`\\bthis\\.${v}\\.markAllAsTouched\\s*\\(`).test(text)) {
        diags.push(`markAllAsTouched() — verify Signal Forms equivalent; behaviour may differ`);
    }
    if (new RegExp(`\\bthis\\.${v}\\.markAsTouched\\s*\\(`).test(text)) {
        diags.push(`markAsTouched() — verify Signal Forms equivalent`);
    }
    if (new RegExp(`\\bthis\\.${v}\\.(disable|enable)\\s*\\(`).test(text)) {
        diags.push(`disable() / enable() — verify Signal Forms equivalent`);
    }
    if (new RegExp(`\\bthis\\.${v}\\.valueChanges\\b`).test(text)) {
        diags.push(`valueChanges — replace with effect(() => { const v = this.${modelName}(); ... })`);
    }
    if (new RegExp(`\\bthis\\.${v}\\.statusChanges\\b`).test(text)) {
        diags.push(`statusChanges — use effect() with validity signals in Signal Forms`);
    }

    // FormArray dynamic operations — must use immutable model.update()
    if (/\.push\s*\(/.test(text)) {
        diags.push(
            `FormArray .push() detected — replace with immutable model update:\n` +
            `  this.${modelName}.update(v => ({ ...v, arrayField: [...v.arrayField, newItem] }))`,
        );
    }
    if (/\.removeAt\s*\(/.test(text)) {
        diags.push(
            `FormArray .removeAt() detected — replace with:\n` +
            `  this.${modelName}.update(v => ({ ...v, arrayField: v.arrayField.filter((_, i) => i !== index) }))`,
        );
    }
    if (/\.clear\s*\(\s*\)/.test(text)) {
        diags.push(
            `FormArray .clear() detected — replace with:\n` +
            `  this.${modelName}.update(v => ({ ...v, arrayField: [] }))`,
        );
    }
    if (/\.setControl\s*\(/.test(text)) {
        diags.push(
            `FormArray .setControl() detected — replace with:\n` +
            `  this.${modelName}.update(v => ({ ...v, arrayField: v.arrayField.map((item, i) => i === index ? newItem : item) }))`,
        );
    }
    if (/\.insert\s*\(|\.at\s*\(|\.controls\s*\[/.test(text)) {
        diags.push(`FormArray .insert() / .at() / .controls[] — migrate manually using this.${modelName}.update(...)`);
    }

    // Insert inline TODO comments before FormArray mutation calls in method bodies.
    // The original call is preserved — the comment shows the immutable Signal Forms equivalent.
    text = insertArrayMutationComments(text, modelName);

    // Convert FormArray/FormGroup getters that simply expose a form field to computed signals.
    // Pattern: get phones(): FormArray { return this.formVar.phones() as FormArray; }
    //       →  readonly phones = computed(() => this.formVar.phones());
    let getterConverted = false;
    text = text.replace(
        new RegExp(
            // indent  get  name  ()  optional-type-annotation  {  return this.VAR.name()  optional-cast  ;  }
            `([ \\t]*)get\\s+(\\w+)\\s*\\(\\s*\\)\\s*(?::\\s*[\\w<>\\[\\], |]+)?\\s*\\{` +
            `\\s*[\\n\\r\\s]*return\\s+this\\.${v}\\.\\2\\s*\\(\\s*\\)\\s*(?:as\\s+[\\w<>\\[\\], |]+)?\\s*;` +
            `\\s*[\\n\\r\\s]*\\}`,
            'g',
        ),
        (_, indent, name) => {
            getterConverted = true;
            return `${indent}readonly ${name} = computed(() => this.${varName}.${name}());`;
        },
    );

    if (getterConverted) {
        text = addSpecifierToCoreImport(text, 'computed');
        diags.push(`Getter(s) converted to computed signals — usages of this.fieldName are now signals, call them as this.fieldName() to read the value`);
    }

    return { text, diagnostics: diags };
}

// ─── Array mutation comment inserter ─────────────────────────────────────────

/**
 * Finds lines inside method bodies that call FormArray mutation operations
 * (push, removeAt, clear, splice) on any `this.field` and inserts a
 * TODO comment immediately above showing the immutable Signal Forms equivalent.
 * The original call is kept so the developer sees both side by side.
 */
function insertArrayMutationComments(text: string, modelName: string): string {
    // .push(item) → spread into new array
    text = text.replace(
        /^([ \t]*)(this\.(\w+)\.push\s*\()/gm,
        (_, indent, call, field) =>
            `${indent}// TODO Signal Forms: this.${modelName}.update(v => ({ ...v, ${field}: [...v.${field}, newItem] }));\n` +
            `${indent}${call}`,
    );

    // .removeAt(index) → filter out by index
    text = text.replace(
        /^([ \t]*)(this\.(\w+)\.removeAt\s*\(([^)]*)\))/gm,
        (_, indent, call, field, indexArg) => {
            const idx = indexArg.trim() || 'index';
            return (
                `${indent}// TODO Signal Forms: this.${modelName}.update(v => ({ ...v, ${field}: v.${field}.filter((_, i) => i !== ${idx}) }));\n` +
                `${indent}${call}`
            );
        },
    );

    // .clear() → replace with empty array
    text = text.replace(
        /^([ \t]*)(this\.(\w+)\.clear\s*\(\s*\))/gm,
        (_, indent, call, field) =>
            `${indent}// TODO Signal Forms: this.${modelName}.update(v => ({ ...v, ${field}: [] }));\n` +
            `${indent}${call}`,
    );

    // .splice(start, deleteCount) → slice-based removal
    text = text.replace(
        /^([ \t]*)(this\.(\w+)\.splice\s*\(([^)]*)\))/gm,
        (_, indent, call, field, args) => {
            const parts = args.split(',').map((s: string) => s.trim());
            const start = parts[0] || 'start';
            const count = parts[1] || '1';
            return (
                `${indent}// TODO Signal Forms: this.${modelName}.update(v => ({ ...v, ${field}: [...v.${field}.slice(0, ${start}), ...v.${field}.slice(${start} + ${count})] }));\n` +
                `${indent}${call}`
            );
        },
    );

    return text;
}

// ─── Import helpers ───────────────────────────────────────────────────────────

/** Adds a named specifier to the existing @angular/core import using the array approach. */
function addSpecifierToCoreImport(text: string, specifier: string): string {
    const coreMatch = /import\s*\{([^}]+)\}\s*from\s*['"]@angular\/core['"]/m.exec(text);
    if (!coreMatch) { return text; }
    const existing = coreMatch[1].split(',').map(s => s.trim()).filter(s => s.length > 0);
    if (existing.includes(specifier)) { return text; }
    const merged = [...existing, specifier];
    return (
        text.slice(0, coreMatch.index) +
        `import { ${merged.join(', ')} } from '@angular/core'` +
        text.slice(coreMatch.index + coreMatch[0].length)
    );
}

// ─── Declaration range finder ─────────────────────────────────────────────────

function findDeclarationRange(text: string, varName: string): [number, number] {
    const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
        // Class property (with optional access modifiers and optional type annotation)
        new RegExp(`(?:^|\\n)([ \\t]*(?:(?:private|protected|public|readonly|override)\\s+)*${esc}\\s*(?::[^=;\\n]+)?\\s*=\\s*)`),
        // this.varName = ... (constructor / ngOnInit / method body)
        new RegExp(`(?:^|\\n)([ \\t]*this\\.${esc}\\s*=\\s*)`),
    ];

    for (const re of patterns) {
        const match = re.exec(text);
        if (!match) { continue; }

        const startOffset = match.index + (text[match.index] === '\n' ? 1 : 0);
        let depth = 0;
        let i = match.index + match[0].length;
        let end = i;
        while (i < text.length) {
            const ch = text[i];
            if ('({['.includes(ch))  { depth++; }
            else if (')}]'.includes(ch)) { depth--; }
            else if (ch === ';' && depth === 0) { end = i + 1; break; }
            else if (ch === '\n' && depth === 0) { end = i; break; }
            i++;
        }
        if (end === i) { end = i; }
        if (end > startOffset + 1) { return [startOffset, end]; }
    }

    return [-1, -1];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the position just after the line that contains `pattern`, or -1. */
function findLineEnd(text: string, pattern: RegExp): number {
    const m = pattern.exec(text);
    if (!m) { return -1; }
    const nl = text.indexOf('\n', m.index);
    return nl >= 0 ? nl + 1 : text.length;
}

/** Returns the position just after the last `import …` line. */
function findLastImportEnd(text: string): number {
    const re = /^import\s.+$/gm;
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) { last = m; }
    return last ? last.index + last[0].length + 1 : 0;
}
