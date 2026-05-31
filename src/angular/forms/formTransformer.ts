import { FormDetection, FormNodeIR, ValidatorIR } from './formIR';

export interface TransformResult {
    /** The full generated TypeScript block (model + form declarations) */
    tsBlock: string;
    /** Interface definition for the model type */
    interfaceBlock: string;
    /** Named exports to add from @angular/core */
    coreImports: string[];
    /** Named exports to add from @angular/forms/signals */
    signalFormsImports: string[];
    /** Names to remove from @angular/forms import */
    formsImportsToRemove: string[];
}

// ─── Public entry ─────────────────────────────────────────────────────────────

export function transformToSignalForm(detection: FormDetection): TransformResult {
    const { variableName, ir } = detection;
    const typeName  = toTypeName(variableName);
    const modelVar  = toModelName(variableName);

    // --- Model signal ---
    const modelObj    = buildObjectLiteral(ir, 0);
    const modelDecl   = `${modelVar} = signal<${typeName}>(${modelObj});`;

    // --- Signal form ---
    const validatorLines = collectValidatorStatements(ir, 'schemaPath', []);
    const formDecl = validatorLines.length > 0
        ? `${variableName} = form(this.${modelVar}, (schemaPath) => {\n${validatorLines.map(l => '  ' + l).join('\n')}\n});`
        : `${variableName} = form(this.${modelVar});`;

    // --- Interface ---
    const interfaceBlock = buildInterface(typeName, ir);

    // --- Imports ---
    const usedValidators = collectUsedValidatorNames(ir);
    const signalFormsImports = ['form', 'FormField', ...usedValidators];
    if (needsApplyEach(ir)) { signalFormsImports.push('applyEach'); }
    const coreImports = ['signal'];
    const formsImportsToRemove = [
        'FormBuilder', 'FormGroup', 'UntypedFormGroup',
        'FormControl', 'UntypedFormControl',
        'FormArray', 'UntypedFormArray',
        'Validators', 'AbstractControl',
        'ReactiveFormsModule',
    ];

    const tsBlock = [
        `// Signal model — replace the old ${variableName}: FormGroup declaration`,
        modelDecl,
        '',
        `// Signal form — replace this.fb.group({...}) / new FormGroup({...})`,
        formDecl,
    ].join('\n');

    return { tsBlock, interfaceBlock, coreImports, signalFormsImports, formsImportsToRemove };
}

// ─── Interface builder ────────────────────────────────────────────────────────

/**
 * Generates ALL interface declarations needed for the form model:
 * one named interface per nested group, sub-interfaces declared before the
 * parent so the file is valid top-to-bottom.
 *
 * Example output for a form with an `address` FormGroup:
 *   interface AddressData { street: string; city: string; ... }
 *   interface LoginData   { email: string; address: AddressData; ... }
 */
function buildInterface(typeName: string, ir: FormNodeIR): string {
    const parts: string[] = [];
    collectInterfaces(typeName, ir, parts);
    return parts.join('\n\n');
}

/** Recursive DFS — sub-interfaces and array item interfaces emitted before parent. */
function collectInterfaces(typeName: string, ir: FormNodeIR, out: string[]): void {
    if (ir.type !== 'group' || !ir.controls) {
        out.push(`// TODO: define ${typeName} interface manually`);
        return;
    }
    // Recurse depth-first: generate sub-interfaces before the parent uses them
    for (const [key, child] of Object.entries(ir.controls)) {
        if (child.type === 'group') {
            collectInterfaces(fieldToInterfaceName(key), child, out);
        } else if (child.type === 'array' && child.itemSchema?.type === 'group') {
            collectInterfaces(fieldToItemTypeName(key), child.itemSchema, out);
        }
    }
    // Build parent interface — nested groups and arrays use their named types
    const fields = Object.entries(ir.controls).map(([key, child]) => {
        const tsType = child.type === 'group'
            ? fieldToInterfaceName(key)
            : child.type === 'array' && child.itemSchema?.type === 'group'
                ? `${fieldToItemTypeName(key)}[]`
                : inferTsType(child);
        return `  ${key}: ${tsType};`;
    });
    out.push(`interface ${typeName} {\n${fields.join('\n')}\n}`);
}

/** address → AddressData */
function fieldToInterfaceName(fieldName: string): string {
    return fieldName.charAt(0).toUpperCase() + fieldName.slice(1) + 'Data';
}

/** phones → PhoneItem (array item interface name) */
function fieldToItemTypeName(fieldName: string): string {
    // Strip trailing 's' for simple plurals: phones → Phone, orders → Order
    const singular = fieldName.endsWith('s') && fieldName.length > 2
        ? fieldName.slice(0, -1)
        : fieldName;
    return singular.charAt(0).toUpperCase() + singular.slice(1) + 'Item';
}

function inferTsType(node: FormNodeIR): string {
    if (node.type === 'array') {
        // itemSchema without a group shape — fall back to unknown[]
        return 'unknown[]';
    }
    const v = node.initialValue;
    if (v === null || v === undefined) { return 'string | null'; }
    if (typeof v === 'boolean') { return 'boolean'; }
    if (typeof v === 'number')  { return 'number'; }
    if (typeof v === 'string')  { return 'string'; }
    return `any /* was: ${String(v)} */`;
}

// ─── Object literal builder ───────────────────────────────────────────────────

function buildObjectLiteral(ir: FormNodeIR, depth: number): string {
    if (ir.type === 'array') { return buildArrayLiteral(ir, depth); }
    if (ir.type !== 'group' || !ir.controls) { return 'null'; }
    const indent  = '  '.repeat(depth + 1);
    const closing = '  '.repeat(depth);
    const entries = Object.entries(ir.controls).map(([key, child]) => {
        const value = child.type === 'group'
            ? buildObjectLiteral(child, depth + 1)
            : child.type === 'array'
                ? buildArrayLiteral(child, depth + 1)
                : renderValue(child.initialValue);
        return `${indent}${key}: ${value},`;
    });
    return `{\n${entries.join('\n')}\n${closing}}`;
}

function buildArrayLiteral(ir: FormNodeIR, depth: number): string {
    if (!ir.initialItems || ir.initialItems.length === 0) {
        // No known items — emit an empty array with a comment
        return `[] /* TODO: add initial ${ir.itemSchema ? 'item' : 'items'} */`;
    }
    const indent  = '  '.repeat(depth + 1);
    const closing = '  '.repeat(depth);
    const items = ir.initialItems.map(item => `${indent}${buildObjectLiteral(item, depth + 1)},`);
    return `[\n${items.join('\n')}\n${closing}]`;
}

function renderValue(v: unknown): string {
    if (v === null || v === undefined) { return 'null'; }
    if (typeof v === 'string')  { return JSON.stringify(v); }
    if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
    // Raw source expression — preserve as-is
    return `${String(v)} as any /* verify type */`;
}

// ─── Validator statement builder ──────────────────────────────────────────────

function collectValidatorStatements(
    ir: FormNodeIR,
    schemaVar: string,
    segments: string[],
): string[] {
    if (ir.type !== 'group' || !ir.controls) { return []; }
    const stmts: string[] = [];
    for (const [key, child] of Object.entries(ir.controls)) {
        const path = [...segments, key];
        const expr = path.reduce((acc, seg) => `${acc}.${seg}`, schemaVar);
        if (child.type === 'group') {
            stmts.push(...collectValidatorStatements(child, schemaVar, path));
        } else if (child.type === 'array') {
            // Array-level validators target the array field itself
            for (const v of child.validators ?? []) {
                stmts.push(renderValidator(v, expr));
            }
            // Item-level validators — applyEach pattern, never use index notation
            if (child.itemSchema) {
                const itemStmts = collectGroupValidatorsFlat(child.itemSchema, 'item');
                if (itemStmts.length > 0) {
                    stmts.push(`applyEach(${expr}, (item) => {`);
                    stmts.push(...itemStmts.map(s => `  ${s}`));
                    stmts.push(`});`);
                }
            }
        } else if (child.validators?.length) {
            for (const v of child.validators) {
                stmts.push(renderValidator(v, expr));
            }
        }
    }
    return stmts;
}

/**
 * Collects validator statements for a group IR using a plain base expression
 * (no segment-join, so callers control bracket vs dot notation).
 * Used inside applyEach callbacks where `baseExpr` is the lambda parameter name.
 * Nested arrays inside items also use applyEach — never [index] notation.
 */
function collectGroupValidatorsFlat(ir: FormNodeIR, baseExpr: string): string[] {
    if (ir.type !== 'group' || !ir.controls) { return []; }
    const stmts: string[] = [];
    for (const [key, child] of Object.entries(ir.controls)) {
        const expr = `${baseExpr}.${key}`;
        if (child.type === 'group') {
            stmts.push(...collectGroupValidatorsFlat(child, expr));
        } else if (child.type === 'array') {
            for (const v of child.validators ?? []) { stmts.push(renderValidator(v, expr)); }
            if (child.itemSchema) {
                const nested = collectGroupValidatorsFlat(child.itemSchema, 'nestedItem');
                if (nested.length > 0) {
                    stmts.push(`applyEach(${expr}, (nestedItem) => {`);
                    stmts.push(...nested.map(s => `  ${s}`));
                    stmts.push(`});`);
                }
            }
        } else {
            for (const v of child.validators ?? []) { stmts.push(renderValidator(v, expr)); }
        }
    }
    return stmts;
}

/** Returns true if any array field in the IR has item-level validators. */
function needsApplyEach(ir: FormNodeIR): boolean {
    if (ir.type === 'array' && ir.itemSchema) {
        return collectGroupValidatorsFlat(ir.itemSchema, 'item').length > 0;
    }
    if (ir.type === 'group' && ir.controls) {
        return Object.values(ir.controls).some(needsApplyEach);
    }
    return false;
}

function renderValidator(v: ValidatorIR, pathExpr: string): string {
    switch (v.type) {
        case 'required':   return `required(${pathExpr});`;
        case 'email':      return `email(${pathExpr});`;
        case 'min':        return `min(${pathExpr}, ${v.args?.[0] ?? 0});`;
        case 'max':        return `max(${pathExpr}, ${v.args?.[0] ?? 0});`;
        case 'minLength':  return `minLength(${pathExpr}, ${v.args?.[0] ?? 0});`;
        case 'maxLength':  return `maxLength(${pathExpr}, ${v.args?.[0] ?? 0});`;
        case 'pattern': {
            const raw = String(v.args?.[0] ?? '');
            // Regex literal (/pattern/) — output as-is; string pattern — wrap in quotes
            const patArg = raw.startsWith('/') ? raw : JSON.stringify(raw);
            return `pattern(${pathExpr}, ${patArg});`;
        }
        case 'custom':
            return `// TODO: Manual migration required — custom validator: ${v.originalCode ?? '?'}`;
        default:
            return `// TODO: Unknown validator`;
    }
}

function collectUsedValidatorNames(ir: FormNodeIR): string[] {
    const used = new Set<string>();
    function walk(node: FormNodeIR): void {
        for (const v of node.validators ?? []) {
            if (v.type !== 'custom') { used.add(v.type); }
        }
        for (const child of Object.values(node.controls ?? {})) { walk(child); }
        if (node.itemSchema) { walk(node.itemSchema); }
    }
    walk(ir);
    return Array.from(used);
}

// ─── Name helpers ─────────────────────────────────────────────────────────────

/** loginForm → LoginData */
function toTypeName(varName: string): string {
    const base = varName.replace(/Form$/i, '');
    return base.charAt(0).toUpperCase() + base.slice(1) + 'Data';
}

/** loginForm → loginModel, form → model (always lowercase first char) */
export function toModelName(varName: string): string {
    const result = varName.replace(/Form$/i, 'Model');
    return result.charAt(0).toLowerCase() + result.slice(1);
}
