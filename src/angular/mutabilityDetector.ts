/**
 * Shared mutability detection utility.
 *
 * Used by:
 *   - changeDetectionScanner (A1) — populates the `risks` badge
 *   - mutabilityScanner      (M1) — standalone audit finding per pattern
 */

export interface MutabilityIssue {
    lineIdx: number;    // 0-based absolute line index in the file
    col: number;        // 0-based column start
    endCol: number;     // 0-based column end
    message: string;
    severity: 'high' | 'medium';
}

// Infrastructure fields that should not be flagged as mutation targets.
const SKIP_FIELDS = new Set([
    'cdr', 'cd', 'changedetectorref',
    'router', 'route', 'activatedroute',
    'http', 'httpclient',
    'fb', 'formbuilder',
    'store', 'actions', 'effects',
    'renderer', 'renderer2',
    'sanitizer', 'injector', 'platform',
    'zone', 'ngzone',
    'el', 'elementref', 'viewcontainerref',
    'componentfactoryresolver', 'componentref',
    'logger', 'console',
]);

function skip(field: string): boolean {
    return SKIP_FIELDS.has(field.toLowerCase());
}

/** Collects names of @Input()-decorated and input() signal fields from the class body. */
export function collectInputFields(lines: string[], classStart: number, classEnd: number): Set<string> {
    const fields = new Set<string>();
    const decoratorRe   = /@Input\s*\([^)]*\)\s*(?:(?:public|protected|private|readonly)\s+)*(\w+)/;
    const signalInputRe = /\b(\w+)\s*=\s*input\s*[<(]/;

    for (let i = classStart; i <= classEnd; i++) {
        const d = decoratorRe.exec(lines[i]);
        if (d) { fields.add(d[1]); }
        const s = signalInputRe.exec(lines[i]);
        if (s) { fields.add(s[1]); }
    }
    return fields;
}

/**
 * Finds the class body range (0-based inclusive line indices) for the first
 * `class` declaration found within 10 lines after `afterLine`.
 */
export function findClassBodyRange(
    lines: string[],
    afterLine: number,
): { start: number; end: number } | null {
    for (let i = afterLine + 1; i < Math.min(afterLine + 10, lines.length); i++) {
        if (!/\bclass\b/.test(lines[i])) { continue; }
        let braceStart = -1;
        for (let j = i; j < Math.min(i + 3, lines.length); j++) {
            if (lines[j].includes('{')) { braceStart = j; break; }
        }
        if (braceStart < 0) { return null; }
        let depth = 0;
        for (let k = braceStart; k < lines.length; k++) {
            depth += (lines[k].match(/\{/g) ?? []).length;
            depth -= (lines[k].match(/\}/g) ?? []).length;
            if (depth <= 0) { return { start: braceStart, end: k }; }
        }
    }
    return null;
}

/**
 * Extracts all class body ranges from file lines.
 * Shared by mutabilityScanner and unmanagedSubscriptionScanner.
 */
export function extractClassBodies(
    lines: string[],
): Array<{ className: string; startLine: number; endLine: number }> {
    const CLASS_RE = /\bclass\s+(\w+)/;
    const results: Array<{ className: string; startLine: number; endLine: number }> = [];

    for (let i = 0; i < lines.length; i++) {
        const m = CLASS_RE.exec(lines[i]);
        if (!m) { continue; }
        const className = m[1];
        let depth = 0;
        let end = i;
        for (let j = i; j < lines.length; j++) {
            for (const ch of lines[j]) {
                if (ch === '{') { depth++; }
                else if (ch === '}') { depth--; }
            }
            if (depth <= 0 && j > i) { end = j; break; }
        }
        results.push({ className, startLine: i, endLine: end });
    }
    return results;
}

/**
 * Detects mutability issues within a class body.
 *
 * Patterns detected:
 *   1. Array mutator methods: push / pop / splice / sort / reverse / shift / unshift / fill
 *   2. Nested property assignment: this.obj.prop = ...
 *   3. Object.assign(this.field, ...) — mutates object in place
 *   4. ActivatedRoute .params/.queryParams/.data subscription
 *
 * For each issue the absolute line index and column are returned so callers
 * can point diagnostics at the exact source location.
 */
export function detectMutabilityIssues(
    lines: string[],
    classStart: number,
    classEnd: number,
    inputFields: Set<string> = new Set(),
): MutabilityIssue[] {
    const issues: MutabilityIssue[] = [];

    const ARRAY_MUTATORS = /\bthis\.(\w+)\.(push|pop|splice|sort|reverse|shift|unshift|fill|copyWithin)\s*\(/g;
    const NESTED_ASSIGN  = /\bthis\.(\w+)\.(\w+)\s*=(?![=>])/g;
    const OBJECT_ASSIGN  = /Object\.assign\s*\(\s*this\.(\w+)\b/g;
    const ROUTE_SUB      = /\bthis\.(?:\w+)\.(params|queryParams|data)\b/g;

    for (let i = classStart; i <= classEnd; i++) {
        const line = lines[i];
        if (!line.trim() || /^\s*\/\//.test(line)) { continue; }

        // ── Pattern 1: array mutator methods ──────────────────────────────
        ARRAY_MUTATORS.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = ARRAY_MUTATORS.exec(line)) !== null) {
            const [, field, method] = m;
            if (skip(field)) { continue; }
            const isInput = inputFields.has(field);
            issues.push({
                lineIdx: i, col: m.index, endCol: m.index + m[0].length,
                message: isInput
                    ? `@Input '${field}'.${method}() mutates an input array — parent reference unchanged, view stays stale under OnPush`
                    : `this.${field}.${method}() mutates array in place — use spread ([...this.${field}, item]) or assign a new array`,
                severity: isInput ? 'high' : 'medium',
            });
        }

        // ── Pattern 2: nested property assignment ──────────────────────────
        NESTED_ASSIGN.lastIndex = 0;
        while ((m = NESTED_ASSIGN.exec(line)) !== null) {
            const [, field, prop] = m;
            if (skip(field)) { continue; }
            const isInput = inputFields.has(field);
            issues.push({
                lineIdx: i, col: m.index, endCol: m.index + m[0].length,
                message: isInput
                    ? `@Input '${field}' object mutated (this.${field}.${prop} = ...) — parent reference unchanged, view stays stale under OnPush`
                    : `this.${field}.${prop} = ... mutates object in place — use { ...this.${field}, ${prop}: value } to produce a new reference`,
                severity: isInput ? 'high' : 'medium',
            });
        }

        // ── Pattern 3: Object.assign(this.field, ...) ─────────────────────
        OBJECT_ASSIGN.lastIndex = 0;
        while ((m = OBJECT_ASSIGN.exec(line)) !== null) {
            const [, field] = m;
            if (skip(field)) { continue; }
            const isInput = inputFields.has(field);
            issues.push({
                lineIdx: i, col: m.index, endCol: m.index + m[0].length,
                message: `Object.assign(this.${field}, ...) mutates ${isInput ? 'an @Input' : 'the'} object in place — use { ...this.${field}, ...changes } to create a new reference`,
                severity: isInput ? 'high' : 'medium',
            });
        }

        // ── Pattern 4: ActivatedRoute param subscriptions ─────────────────
        ROUTE_SUB.lastIndex = 0;
        while ((m = ROUTE_SUB.exec(line)) !== null) {
            const [, paramName] = m;
            issues.push({
                lineIdx: i, col: m.index, endCol: m.index + m[0].length,
                message: `ActivatedRoute.${paramName} subscription — add markForCheck() or use async pipe; re-navigation will show stale data under OnPush`,
                severity: 'high',
            });
        }
    }

    return issues;
}
