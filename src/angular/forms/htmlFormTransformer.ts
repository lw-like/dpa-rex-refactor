/**
 * Transforms an Angular Reactive Forms HTML template to Signal Forms.
 *
 * Transformations:
 *   [formGroup]="myForm"          → removed
 *   (ngSubmit)="handler()"        → (submit)="handler(); false"
 *   (ngSubmit)="handler($event)"  → (submit)="handler($event)"  + diagnostic
 *   formGroupName="address"       → removed; child formControlName gets full path
 *   formControlName="email"       → [formField]="myForm.email"
 *   formControlName inside group  → [formField]="myForm.address.email"  (full path)
 *   [formControlName]="expr"      → [formField]="myForm.group.[expr]"  + diagnostic
 *   .hasError() / .errors[]       → diagnostic
 *
 * Steps 2–4 use a depth-tracking tokenizer so that formControlName attributes
 * inside a <div formGroupName="address"> receive the full path automatically.
 */
export function transformHtml(
    html: string,
    variableName: string,
    _hasNestedGroups: boolean,
): { output: string; diagnostics: string[] } {
    const diagnostics: string[] = [];
    let out = html;

    // 1. Transform <form> elements that have [formGroup]:
    //    - Remove [formGroup]="..."
    //    - Convert (ngSubmit) → (submit) with appropriate default-prevention
    out = out.replace(
        /(<form\b[^>]*>)/gs,
        (formTag) => {
            if (!/\[formGroup\]/.test(formTag)) { return formTag; }

            let tag = formTag;
            tag = tag.replace(/\s*\[formGroup\]="[^"]*"/, '');

            if (/\(ngSubmit\)/.test(tag)) {
                tag = tag.replace(/\(ngSubmit\)="([^"]*)"/g, (_, handler) => {
                    const usesEvent = /\$event\b/.test(handler);
                    if (usesEvent) {
                        diagnostics.push(
                            `(ngSubmit) → (submit): ensure handler calls event.preventDefault() — ` +
                            `${handler.replace(/\(.*/, '')}(event: SubmitEvent) { event.preventDefault(); ... }`,
                        );
                        return `(submit)="${handler}"`;
                    }
                    diagnostics.push(
                        `(ngSubmit) → (submit)="${handler}; false" — "; false" prevents default form submission.`,
                    );
                    return `(submit)="${handler}; false"`;
                });
            } else if (!/\(submit\)/.test(tag)) {
                tag = tag.replace(/>$/, ' (submit)="onSubmit(); false">');
                diagnostics.push('No submit handler found — add onSubmit() { /* logic */ } to your component.');
            }

            return tag;
        },
    );

    // 2. Convert @for loops over FormArray.controls to Signal Forms equivalent.
    //    Must run BEFORE the tag tokenizer so loop variable is known for step 3.
    const loopVarByArray: Map<string, string> = new Map(); // arrayName → loopVar
    out = out.replace(
        /@for\s*\(\s*(\w+)\s+of\s+(\w+)\.controls\s*;[^)]*\)/g,
        (_, loopVar: string, arrayName: string) => {
            loopVarByArray.set(arrayName, loopVar);
            return `@for (${loopVar} of ${variableName}.${arrayName}; track ${loopVar})`;
        },
    );
    // Also handle: *ngFor="let item of phones.controls"
    out = out.replace(
        /\*ngFor="let\s+(\w+)\s+of\s+(\w+)\.controls[^"]*"/g,
        (_, loopVar: string, arrayName: string) => {
            loopVarByArray.set(arrayName, loopVar);
            return `@for (${loopVar} of ${variableName}.${arrayName}; track ${loopVar})`;
        },
    );

    // 3–5. Context-aware replacement of formGroupName / formControlName.
    //      Tokenizer tracks depth, group names, and array loop variables.
    const ctxResult = transformWithGroupContext(out, variableName, loopVarByArray);
    out = ctxResult.output;
    diagnostics.push(...ctxResult.diagnostics);

    // 5. Detect template validation patterns that need manual update
    if (/\.hasError\s*\(/.test(out)) {
        diagnostics.push(
            `form.get(...).hasError(...) detected — replace with ${variableName}.fieldName().errors() in Signal Forms`,
        );
    }
    if (/\.controls\s*[\[.]/.test(out)) {
        diagnostics.push(
            `form.controls[...] access detected — replace with ${variableName}.fieldName() in Signal Forms`,
        );
    }
    if (/\.get\s*\(/.test(out)) {
        diagnostics.push(
            `form.get('fieldName') detected — replace with ${variableName}.fieldName() in Signal Forms`,
        );
    }

    // 6. Replace .valid / .invalid on the form variable
    //    In Signal Forms: form is a signal and invalid/valid are signals on it
    out = out.replace(
        new RegExp(`\\b${escapeRe(variableName)}\\.invalid\\b`, 'g'),
        `${variableName}().invalid()`,
    );
    out = out.replace(
        new RegExp(`\\b${escapeRe(variableName)}\\.valid\\b`, 'g'),
        `${variableName}().valid()`,
    );

    return { output: out, diagnostics };
}

// ─── Context-aware group/control transformer ──────────────────────────────────

/**
 * Single-pass HTML tokenizer tracking formGroupName nesting and FormArray
 * loop context. Builds full [formField] paths automatically.
 *
 * Handles:
 *   formArrayName="phones"          → removed (loop was already converted in step 2)
 *   formGroupName="address"         → removed; pushed onto group path stack
 *   [formGroupName]="$index"        → removed (index wrapper inside @for loop)
 *   formControlName="street"        → [formField]="form.address.street"   (group context)
 *   formControlName="number"        → [field]="phone.number"              (array loop context)
 *   [formControlName]="expr"        → [formField]="form.prefix.[expr]"
 */
function transformWithGroupContext(
    html: string,
    variableName: string,
    loopVarByArray: Map<string, string>,
): { output: string; diagnostics: string[] } {
    const diagnostics: string[] = [];
    const groupStack: string[] = [];        // active named group path segments
    const groupOpenedAtDepth: number[] = [];
    const arrayLoopVarStack: string[] = []; // active loop variable when inside formArrayName element
    const arrayOpenedAtDepth: number[] = [];
    let depth = 0;

    const parts: string[] = [];
    const tagRe = /<[^>]+>/g;
    let last = 0;
    let m: RegExpExecArray | null;

    while ((m = tagRe.exec(html)) !== null) {
        if (m.index > last) { parts.push(html.slice(last, m.index)); }
        last = m.index + m[0].length;

        let tag = m[0];
        const isClosing  = tag.startsWith('</');
        const isVoid     = /^<(input|br|hr|img|link|meta|area|base|col|embed|param|source|track|wbr)\b/i.test(tag);
        const isSelfClosing = tag.endsWith('/>') || isVoid;

        if (isClosing) {
            depth--;
            while (groupOpenedAtDepth.length > 0 && groupOpenedAtDepth[groupOpenedAtDepth.length - 1] === depth) {
                groupOpenedAtDepth.pop();
                groupStack.pop();
            }
            while (arrayOpenedAtDepth.length > 0 && arrayOpenedAtDepth[arrayOpenedAtDepth.length - 1] === depth) {
                arrayOpenedAtDepth.pop();
                arrayLoopVarStack.pop();
            }
            parts.push(tag);
            continue;
        }

        // ── formArrayName — remove attr, push loop variable context ──────────
        const arrayNameMatch = /\s*formArrayName="([^"]*)"/.exec(tag);
        if (arrayNameMatch) {
            tag = tag.replace(/\s*formArrayName="[^"]*"/, '');
            const loopVar = loopVarByArray.get(arrayNameMatch[1]);
            if (loopVar && !isSelfClosing) {
                arrayLoopVarStack.push(loopVar);
                arrayOpenedAtDepth.push(depth);
            }
        }

        // ── formGroupName / [formGroupName]="$index" ─────────────────────────
        const groupMatch = /\s*\[?formGroupName\]?="([^"]*)"/.exec(tag);
        if (groupMatch) {
            tag = tag.replace(/\s*\[?formGroupName\]?="[^"]*"/, '');
            // Only push named groups onto the path — not $index (inside @for loops)
            if (!isSelfClosing && /^\w+$/.test(groupMatch[1])) {
                groupStack.push(groupMatch[1]);
                groupOpenedAtDepth.push(depth);
            }
            // [formGroupName]="$index" is simply removed (wrapper div inside @for)
        }

        // ── formControlName ──────────────────────────────────────────────────
        const controlMatch = /\bformControlName="([^"]*)"/.exec(tag);
        if (controlMatch) {
            const field = controlMatch[1];
            const insideArray = arrayLoopVarStack.length > 0;

            if (insideArray) {
                // Inside a FormArray loop: [field]="loopVar.fieldName"
                const loopVar = arrayLoopVarStack[arrayLoopVarStack.length - 1];
                tag = tag.replace(
                    /\bformControlName="[^"]*"/,
                    `[field]="${loopVar}.${field}"`,
                );
            } else {
                // Inside a FormGroup: [formField]="form.group.fieldName"
                const fullPath = [...groupStack, field].join('.');
                tag = tag.replace(
                    /\bformControlName="[^"]*"/,
                    `[formField]="${variableName}.${fullPath}"`,
                );
            }
        }

        // ── [formControlName]="expr" ─────────────────────────────────────────
        const dynMatch = /\[formControlName\]="([^"]*)"/.exec(tag);
        if (dynMatch) {
            const expr = dynMatch[1];
            const groupPrefix = groupStack.length > 0 ? groupStack.join('.') + '.' : '';
            tag = tag.replace(
                /\[formControlName\]="[^"]*"/,
                `[formField]="${variableName}.${groupPrefix}[${expr}]"`,
            );
            diagnostics.push(`Dynamic [formControlName]="${expr}" converted — verify at runtime`);
        }

        if (!isSelfClosing) { depth++; }
        parts.push(tag);
    }

    if (last < html.length) { parts.push(html.slice(last)); }
    return { output: parts.join(''), diagnostics };
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
