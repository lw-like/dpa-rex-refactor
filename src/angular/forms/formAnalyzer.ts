import * as path from 'path';
import * as fs from 'fs';
import {
    Project, SyntaxKind, Node,
    ObjectLiteralExpression, ArrayLiteralExpression,
    PropertyAccessExpression, SourceFile, ClassDeclaration,
} from 'ts-morph';
import { FormDetection, FormNodeIR, ValidatorIR } from './formIR';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyses a single TypeScript component file and returns all detected
 * reactive form declarations as FormDetection objects.
 */
export function analyzeComponentFile(tsContent: string, tsFilePath: string): FormDetection[] {
    // Pre-screen: skip files that have no reactive form constructs
    if (!/\b(FormGroup|FormControl|FormBuilder)\b/.test(tsContent)) { return []; }

    const project = new Project({
        useInMemoryFileSystem: true,
        skipFileDependencyResolution: true,
        compilerOptions: { strict: false },
    });
    const sf = project.createSourceFile(tsFilePath, tsContent, { overwrite: true });
    return analyzeSourceFile(sf, tsFilePath);
}

// ─── Per-file analysis ────────────────────────────────────────────────────────

function analyzeSourceFile(sf: SourceFile, filePath: string): FormDetection[] {
    const results: FormDetection[] = [];
    const htmlPath = resolveHtmlCompanion(filePath, sf);

    for (const cls of sf.getClasses()) {
        const componentName = cls.getName() ?? 'UnknownComponent';
        const diagnostics: string[] = [];

        // 1. Class property declarations: loginForm = new FormGroup({...})
        //                              or loginForm = this.fb.group({...})
        for (const prop of cls.getProperties()) {
            const init = prop.getInitializer();
            if (!init) { continue; }
            const ir = tryExtractFormNode(init, diagnostics, cls);
            if (ir) {
                results.push({
                    componentName, filePath,
                    variableName: prop.getName(),
                    declarationLine: prop.getStartLineNumber(),
                    ir, diagnostics: [...diagnostics], htmlPath,
                });
                diagnostics.length = 0;
            }
        }

        // 2. Constructor-body assignments: this.loginForm = this.fb.group({...})
        for (const ctor of cls.getConstructors()) {
            for (const stmt of ctor.getBody()?.asKindOrThrow(SyntaxKind.Block).getStatements() ?? []) {
                const expr   = stmt.asKind(SyntaxKind.ExpressionStatement)?.getExpression();
                const binary = expr?.asKind(SyntaxKind.BinaryExpression);
                if (!binary) { continue; }
                if (!isThisPropAccess(binary.getLeft())) { continue; }
                const varName = (binary.getLeft() as PropertyAccessExpression).getName();
                const ir = tryExtractFormNode(binary.getRight(), diagnostics, cls);
                if (ir) {
                    results.push({
                        componentName, filePath, variableName: varName,
                        declarationLine: stmt.getStartLineNumber(),
                        ir, diagnostics: [...diagnostics], htmlPath,
                    });
                    diagnostics.length = 0;
                }
            }
        }

        // 3. ngOnInit / other method assignments: this.loginForm = ...
        for (const method of cls.getMethods()) {
            if (method.getName() === 'constructor') { continue; }
            for (const stmt of method.getBody()?.asKindOrThrow(SyntaxKind.Block).getStatements() ?? []) {
                const expr   = stmt.asKind(SyntaxKind.ExpressionStatement)?.getExpression();
                const binary = expr?.asKind(SyntaxKind.BinaryExpression);
                if (!binary) { continue; }
                if (!isThisPropAccess(binary.getLeft())) { continue; }
                const varName = (binary.getLeft() as PropertyAccessExpression).getName();
                const ir = tryExtractFormNode(binary.getRight(), diagnostics, cls);
                if (ir) {
                    results.push({
                        componentName, filePath, variableName: varName,
                        declarationLine: stmt.getStartLineNumber(),
                        ir, diagnostics: [...diagnostics], htmlPath,
                    });
                    diagnostics.length = 0;
                }
            }
        }

        // Post-scan: detect unsupported dynamic patterns across the whole class body
        const classText = cls.getText();
        const formsInClass = results.filter(r => r.componentName === componentName && r.filePath === filePath);
        if (/\.(addControl|removeControl)\s*\(/.test(classText)) {
            formsInClass.forEach(r => r.diagnostics.push(
                'Dynamic controls (addControl / removeControl) detected — structure cannot be migrated automatically',
            ));
        }
        if (/AsyncValidatorFn|asyncValidators\s*:/.test(classText)) {
            formsInClass.forEach(r => r.diagnostics.push(
                'Async validators detected — not supported in Signal Forms; migrate manually',
            ));
        }
        if (/\.(setValue|patchValue|reset)\s*\(/.test(classText)) {
            formsInClass.forEach(r => r.diagnostics.push(
                'setValue() / patchValue() / reset() call detected — replace with loginModel.set({...}) or loginForm.fieldName().value.set(...) in Signal Forms',
            ));
        }
    }

    return results;
}

// ─── Node extractors ──────────────────────────────────────────────────────────

function tryExtractFormNode(node: Node, diagnostics: string[], cls?: ClassDeclaration): FormNodeIR | null {
    // new FormGroup({...})
    const newExpr = node.asKind(SyntaxKind.NewExpression);
    if (newExpr) {
        const name = newExpr.getExpression().getText().trim();
        if (name === 'FormGroup' || name === 'UntypedFormGroup') {
            const obj = newExpr.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression);
            if (obj) { return extractGroup(obj, diagnostics, cls); }
        }
        if (name === 'FormControl' || name === 'UntypedFormControl') {
            return extractControl(newExpr.getArguments(), diagnostics);
        }
        if (name === 'FormArray' || name === 'UntypedFormArray') {
            return extractArray(newExpr.getArguments(), diagnostics, cls);
        }
    }

    // this.fb.group({...}) / this.formBuilder.group({...})
    const call = node.asKind(SyntaxKind.CallExpression);
    if (call) {
        const prop = call.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
        if (prop) {
            const method = prop.getName();
            if (method === 'group') {
                const obj = call.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression);
                if (obj) { return extractGroup(obj, diagnostics, cls); }
            }
            if (method === 'control') {
                return extractControl(call.getArguments(), diagnostics);
            }
            if (method === 'array') {
                return extractArray(call.getArguments(), diagnostics, cls);
            }
        }
        // this.methodName() — resolve method body within the same class
        if (cls) {
            const resolved = resolveThisMethodCall(call, cls, diagnostics);
            if (resolved) { return resolved; }
        }
    }

    return null;
}

function extractGroup(obj: ObjectLiteralExpression, diagnostics: string[], cls?: ClassDeclaration): FormNodeIR {
    const controls: Record<string, FormNodeIR> = {};
    for (const prop of obj.getProperties()) {
        const assignment = prop.asKind(SyntaxKind.PropertyAssignment);
        if (!assignment) {
            diagnostics.push(`Unsupported property shape in FormGroup: ${prop.getText().slice(0, 60)}`);
            continue;
        }
        const name = assignment.getName();
        const init = assignment.getInitializerOrThrow();

        // Nested group / control / array (including this.methodName() resolution)
        const childIR = tryExtractFormNode(init, diagnostics, cls);
        if (childIR) { controls[name] = childIR; continue; }

        // Array shorthand: [value] or [value, validators] or [value, [validators]]
        const arr = init.asKind(SyntaxKind.ArrayLiteralExpression);
        if (arr) { controls[name] = extractControlFromArray(arr, diagnostics); continue; }

        // Scalar value — simple control with no validators
        controls[name] = { type: 'control', initialValue: extractLiteral(init), validators: [] };
    }
    return { type: 'group', controls };
}

function extractControlFromArray(arr: ArrayLiteralExpression, diagnostics: string[]): FormNodeIR {
    const elements = arr.getElements();
    const initialValue = elements[0] ? extractLiteral(elements[0]) : null;
    const validators: ValidatorIR[] = [];
    if (elements[1]) {
        const vNode = elements[1];
        const vArr = vNode.asKind(SyntaxKind.ArrayLiteralExpression);
        if (vArr) {
            for (const v of vArr.getElements()) { validators.push(...extractValidators(v, diagnostics)); }
        } else {
            validators.push(...extractValidators(vNode, diagnostics));
        }
    }
    return { type: 'control', initialValue, validators };
}

/**
 * Extracts a FormArray / fb.array() into an array IR node.
 * args[0] = initial items array literal
 * args[1] = optional array-level validators
 */
function extractArray(args: Node[], diagnostics: string[], cls?: ClassDeclaration): FormNodeIR {
    const validators: ValidatorIR[] = [];

    // Extract array-level validators (second argument)
    if (args[1]) {
        const vNode = args[1];
        const vArr  = vNode.asKind(SyntaxKind.ArrayLiteralExpression);
        if (vArr) {
            for (const v of vArr.getElements()) { validators.push(...extractValidators(v, diagnostics)); }
        } else {
            validators.push(...extractValidators(vNode, diagnostics));
        }
    }

    // Extract initial items — resolves this.methodName() calls via the class body
    const initialItems: FormNodeIR[] = [];
    const itemsLit = args[0]?.asKind(SyntaxKind.ArrayLiteralExpression);
    if (itemsLit) {
        for (const el of itemsLit.getElements()) {
            const ir = tryExtractFormNode(el, diagnostics, cls);
            if (ir) {
                initialItems.push(ir);
            } else {
                diagnostics.push(
                    `FormArray item "${el.getText().slice(0, 60)}" could not be resolved — ` +
                    `provide the initial item shape manually in the model signal`,
                );
            }
        }
    }

    const itemSchema = initialItems[0];
    return { type: 'array', itemSchema, initialItems, validators };
}

function extractControl(args: Node[], diagnostics: string[]): FormNodeIR {
    const initialValue = args[0] ? extractLiteral(args[0]) : null;
    const validators: ValidatorIR[] = [];
    if (args[1]) {
        const v = args[1];
        // FormControl options object: { validators: [...], nonNullable: true }
        const optObj = v.asKind(SyntaxKind.ObjectLiteralExpression);
        if (optObj) {
            const vProp = optObj.getProperty('validators');
            const vAssign = vProp?.asKind(SyntaxKind.PropertyAssignment);
            const vInit = vAssign?.getInitializer();
            if (vInit) {
                const vArr = vInit.asKind(SyntaxKind.ArrayLiteralExpression);
                if (vArr) {
                    for (const x of vArr.getElements()) { validators.push(...extractValidators(x, diagnostics)); }
                } else {
                    validators.push(...extractValidators(vInit, diagnostics));
                }
            }
            if (optObj.getProperty('asyncValidators')) {
                diagnostics.push('asyncValidators in FormControl options — not supported in Signal Forms');
            }
        } else {
            const vArr = v.asKind(SyntaxKind.ArrayLiteralExpression);
            if (vArr) {
                for (const x of vArr.getElements()) { validators.push(...extractValidators(x, diagnostics)); }
            } else {
                validators.push(...extractValidators(v, diagnostics));
            }
        }
    }
    return { type: 'control', initialValue, validators };
}

/**
 * Resolves `this.methodName()` by finding the method in the class,
 * walking its statements for a `return` expression, and extracting
 * a FormNodeIR from that expression.
 */
function resolveThisMethodCall(
    call: import('ts-morph').CallExpression,
    cls: ClassDeclaration,
    diagnostics: string[],
): FormNodeIR | null {
    const expr = call.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
    if (!expr) { return null; }
    if (expr.getExpression().getKind() !== SyntaxKind.ThisKeyword) { return null; }

    const methodName = expr.getName();
    const method = cls.getMethod(methodName);
    if (!method) { return null; }

    const body = method.getBody()?.asKind(SyntaxKind.Block);
    if (!body) { return null; }

    for (const stmt of body.getStatements()) {
        const ret = stmt.asKind(SyntaxKind.ReturnStatement);
        if (!ret) { continue; }
        const returnExpr = ret.getExpression();
        if (!returnExpr) { continue; }
        // Recursively extract — passes cls so nested method calls are also resolved
        const ir = tryExtractFormNode(returnExpr, diagnostics, cls);
        if (ir) { return ir; }
    }

    return null;
}

function extractValidators(node: Node, diagnostics: string[]): ValidatorIR[] {
    const text = node.getText().trim();

    // Validators.required / Validators.email — property access without call
    const propAccess = node.asKind(SyntaxKind.PropertyAccessExpression);
    if (propAccess && propAccess.getExpression().getText() === 'Validators') {
        const name = propAccess.getName();
        if (name === 'required') { return [{ type: 'required' }]; }
        if (name === 'email')    { return [{ type: 'email' }]; }
        diagnostics.push(`Validators.${name} — no Signal Forms equivalent; marked as custom`);
        return [{ type: 'custom', originalCode: text }];
    }

    // Validators.min(n) / Validators.max(n) / etc. — call expression
    const call = node.asKind(SyntaxKind.CallExpression);
    if (call) {
        const callee = call.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
        if (callee && callee.getExpression().getText() === 'Validators') {
            const name = callee.getName();
            const arg0 = call.getArguments()[0];
            const argVal = arg0 ? extractLiteral(arg0) : undefined;
            switch (name) {
                case 'min':       return [{ type: 'min',       args: argVal !== undefined ? [argVal] : [] }];
                case 'max':       return [{ type: 'max',       args: argVal !== undefined ? [argVal] : [] }];
                case 'minLength': return [{ type: 'minLength', args: argVal !== undefined ? [argVal] : [] }];
                case 'maxLength': return [{ type: 'maxLength', args: argVal !== undefined ? [argVal] : [] }];
                case 'pattern':   return [{ type: 'pattern',   args: argVal !== undefined ? [argVal] : [] }];
                default:
                    diagnostics.push(`Validators.${name}(...) — no Signal Forms equivalent; marked as custom`);
                    return [{ type: 'custom', originalCode: text }];
            }
        }
        // Any other call = custom validator function
        diagnostics.push(`Custom validator: ${text.slice(0, 80)} — marked as TODO`);
        return [{ type: 'custom', originalCode: text }];
    }

    diagnostics.push(`Unknown validator shape: ${text.slice(0, 80)} — marked as TODO`);
    return [{ type: 'custom', originalCode: text }];
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function extractLiteral(node: Node): unknown {
    if (node.getKind() === SyntaxKind.StringLiteral)  { return (node as import('ts-morph').StringLiteral).getLiteralValue(); }
    if (node.getKind() === SyntaxKind.NumericLiteral) { return Number(node.getText()); }
    if (node.getKind() === SyntaxKind.TrueKeyword)    { return true; }
    if (node.getKind() === SyntaxKind.FalseKeyword)   { return false; }
    if (node.getKind() === SyntaxKind.NullKeyword)    { return null; }
    if (node.getKind() === SyntaxKind.UndefinedKeyword) { return undefined; }
    // Preserve as raw source for complex expressions
    return node.getText().trim();
}

function isThisPropAccess(node: Node): boolean {
    const pa = node.asKind(SyntaxKind.PropertyAccessExpression);
    return !!pa && pa.getExpression().getKind() === SyntaxKind.ThisKeyword;
}

/**
 * Resolves the companion .html file from either @Component({ templateUrl }) or
 * same-basename convention. Returns undefined if clearly not found.
 */
function resolveHtmlCompanion(filePath: string, sf: SourceFile): string | undefined {
    // Try templateUrl from @Component decorator
    for (const cls of sf.getClasses()) {
        for (const dec of cls.getDecorators()) {
            if (dec.getName() !== 'Component') { continue; }
            const obj = dec.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression);
            const tUrlProp = obj?.getProperty('templateUrl');
            const tUrlAssign = tUrlProp?.asKind(SyntaxKind.PropertyAssignment);
            const tUrlLit = tUrlAssign?.getInitializer()?.asKind(SyntaxKind.StringLiteral);
            if (tUrlLit) {
                return path.resolve(path.dirname(filePath), tUrlLit.getLiteralValue());
            }
            // Inline template — no HTML file
            if (obj?.getProperty('template')) { return undefined; }
        }
    }
    // Fallback: same-name .html
    const candidate = filePath.replace(/\.ts$/, '.html');
    return fs.existsSync(candidate) ? candidate : undefined;
}
