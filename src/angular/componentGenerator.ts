import { ClassUsage, relativePath } from './cssScanner';
import { MixinMap, resolveMixin } from './mixinsScanner';

export interface ComponentImport {
    className: string;
    importPath: string;     // relative path for the import statement (no .ts extension)
}

export interface ComponentSpec {
    name: string;           // PascalCase, e.g. "UserCard"
    selector: string;       // kebab-case, e.g. "app-user-card"
    template: string;       // raw HTML
    inputs: string[];
    outputs: string[];
    classUsages: ClassUsage[];
    moveClasses: string[];  // class names the user confirmed to move into component SCSS
    componentImports: ComponentImport[];
    mixinMap?: MixinMap;    // when set, @media blocks are replaced with @include calls
    mixinsImport?: string;  // import statement prepended to the generated SCSS
}

export interface GeneratedFiles {
    ts: string;
    html: string;
    scss: string;
    todo: string;
    tsFileName: string;
    htmlFileName: string;
    scssFileName: string;
    todoFileName: string;
}

export function generateComponent(spec: ComponentSpec): GeneratedFiles {
    const base = toFileName(spec.name);
    const tsFileName = `${base}.component.ts`;
    const htmlFileName = `${base}.component.html`;
    const scssFileName = `${base}.component.scss`;
    const todoFileName = `${base}.todo.json`;

    return {
        ts: buildTs(spec, htmlFileName, scssFileName),
        html: spec.template.trim(),
        scss: buildScss(spec),
        todo: buildTodo(spec, scssFileName),
        tsFileName,
        htmlFileName,
        scssFileName,
        todoFileName,
    };
}

function buildTs(spec: ComponentSpec, htmlFileName: string, scssFileName: string): string {
    const coreSymbols: string[] = ['Component', 'ChangeDetectionStrategy'];
    if (spec.inputs.length) { coreSymbols.push('input'); }
    if (spec.outputs.length) { coreSymbols.push('output'); }

    const importLines: string[] = [
        `import { ${coreSymbols.join(', ')} } from '@angular/core';`,
        ...spec.componentImports.map(ci => `import { ${ci.className} } from '${ci.importPath}';`),
    ];

    const inputLines = spec.inputs.map(i => `  ${i} = input<unknown>();`);
    const outputLines = spec.outputs.map(o => `  ${o} = output<void>();`);
    const memberLines = [...inputLines, ...outputLines];

    const importsArray = spec.componentImports.length
        ? [`  imports: [${spec.componentImports.map(ci => ci.className).join(', ')}],`]
        : [];

    return [
        ...importLines,
        '',
        '@Component({',
        `  selector: '${spec.selector}',`,
        `  templateUrl: './${htmlFileName}',`,
        `  styleUrl: './${scssFileName}',`,
        '  changeDetection: ChangeDetectionStrategy.OnPush,',
        ...importsArray,
        '})',
        `export class ${spec.name}Component {`,
        ...(memberLines.length ? memberLines : ['  // TODO: add inputs and outputs']),
        '}',
    ].join('\n');
}

function buildScss(spec: ComponentSpec): string {
    const moveSet = new Set(spec.moveClasses);
    const lines: string[] = [];

    // Prepend import statement if a mixins file is configured
    if (spec.mixinsImport?.trim()) {
        const imp = spec.mixinsImport.trim().replace(/;+$/, '');
        lines.push(`${imp};`);
        lines.push('');
    }

    const movedUsages = spec.classUsages.filter(u => moveSet.has(u.className));
    const keptUsages = spec.classUsages.filter(u => !moveSet.has(u.className) && u.definedIn.length > 0);

    if (movedUsages.length) {
        lines.push('// Component styles — moved from global (single-use classes)');
        lines.push('');
        lines.push(...renderMovedClasses(movedUsages, spec.mixinMap));
    }

    if (keptUsages.length) {
        lines.push('// Classes used in multiple places — kept in global styles');
        for (const u of keptUsages) {
            const files = u.usedIn.map(relativePath).join(', ');
            lines.push(`// .${u.className} — used in: ${files}`);
        }
        lines.push('');
    }

    if (lines.length === 0) {
        lines.push('// Component styles');
    }

    return lines.join('\n');
}

/**
 * Renders the SCSS for classes that are being moved into the component.
 *
 * Classes that share the same BEM root selector (selectorChain[0]) are grouped
 * under one block using `&` concatenation — matching the original source structure.
 *
 * Example with two BEM children of `.cl-header`:
 *
 *   // Originally in: src/styles.scss
 *   .cl-header {
 *       &--right {
 *           justify-content: flex-end;
 *       }
 *       &__left-section {
 *           flex: 1;
 *       }
 *   }
 */
/** Renders `@media` or `@include mixin` depending on whether a matching mixin is found. */
function mediaOrMixin(mediaContext: string, mixinMap?: MixinMap): string {
    if (mixinMap) {
        const name = resolveMixin(mediaContext, mixinMap);
        if (name) { return `@include ${name}`; }
    }
    return mediaContext;
}

function renderMovedClasses(usages: ClassUsage[], mixinMap?: MixinMap): string[] {
    const lines: string[] = [];

    // Separate classes we have source info for from those we don't
    const withInfo = usages.filter(u => u.nodeInfo);
    const withoutInfo = usages.filter(u => !u.nodeInfo);

    // Group by the top-level (root) selector so BEM siblings collapse into one block
    const groups = new Map<string, ClassUsage[]>();
    for (const u of withInfo) {
        const rootSel = u.nodeInfo!.selectorChain[0] ?? `.${u.className}`;
        const existing = groups.get(rootSel) ?? [];
        existing.push(u);
        groups.set(rootSel, existing);
    }

    for (const [rootSel, group] of groups) {
        const src = relativePath(group[0].nodeInfo!.fsPath);
        lines.push(`// Originally in: ${src}`);

        const allTopLevel = group.every(u => u.nodeInfo!.selectorChain.length === 1);

        if (allTopLevel) {
            // Not BEM — emit base block then each @media variant as a separate block
            for (const u of group) {
                const defs     = u.nodeInfo!.allDefinitions;
                const baseDef  = defs.find(d => !d.mediaContext);
                const mediaDefs = defs.filter(d => d.mediaContext);

                if (baseDef) {
                    lines.push(originComment(u.nodeInfo!.selectorChain));
                    lines.push(`${rootSel} {`);
                    lines.push(...dedentContent(baseDef.rawContent, '    '));
                    lines.push('}');
                    lines.push('');
                }

                for (const mDef of mediaDefs) {
                    lines.push(originComment(u.nodeInfo!.selectorChain, mDef.mediaContext));
                    lines.push(`${mediaOrMixin(mDef.mediaContext!, mixinMap)} {`);
                    lines.push(`    ${rootSel} {`);
                    lines.push(...dedentContent(mDef.rawContent, '        '));
                    lines.push('    }');
                    lines.push('}');
                    lines.push('');
                }
            }
        } else {
            // BEM — wrap all children under the root selector block
            lines.push(`${rootSel} {`);
            for (const u of group) {
                const chain = u.nodeInfo!.selectorChain;
                const defs  = u.nodeInfo!.allDefinitions;
                const baseDef   = defs.find(d => !d.mediaContext);
                const mediaDefs = defs.filter(d =>  d.mediaContext);

                if (chain.length === 1) {
                    // Root class: emit only its direct properties (strip nested blocks to
                    // avoid duplicating BEM children rendered individually below).
                    if (baseDef) {
                        const props = extractDirectProperties(baseDef.rawContent);
                        if (props.trim()) {
                            lines.push(`    ${originComment(chain)}`);
                            lines.push(...dedentContent(props, '    '));
                        }
                    }
                    for (const mDef of mediaDefs) {
                        const props = extractDirectProperties(mDef.rawContent);
                        if (props.trim()) {
                            lines.push('');
                            lines.push(`    ${originComment(chain, mDef.mediaContext)}`);
                            lines.push(`    ${mediaOrMixin(mDef.mediaContext!, mixinMap)} {`);
                            lines.push(...dedentContent(props, '        '));
                            lines.push('    }');
                        }
                    }
                } else {
                    // BEM child — base style + nested @media variants inside the selector
                    const leafSel = chain[chain.length - 1];
                    lines.push(`    ${originComment(chain)}`);
                    lines.push(`    ${leafSel} {`);
                    if (baseDef) {
                        lines.push(...dedentContent(baseDef.rawContent, '        '));
                    }
                    for (const mDef of mediaDefs) {
                        lines.push('');
                        lines.push(`        ${originComment(chain, mDef.mediaContext)}`);
                        lines.push(`        ${mediaOrMixin(mDef.mediaContext!, mixinMap)} {`);
                        lines.push(...dedentContent(mDef.rawContent, '            '));
                        lines.push('        }');
                    }
                    lines.push('    }');
                    lines.push('');
                }
            }
            lines.push('}');
            lines.push('');
        }
    }

    // Classes without source info — placeholder only
    for (const u of withoutInfo) {
        const src = u.definedIn.map(relativePath).join(', ');
        if (src) { lines.push(`// Originally in: ${src}`); }
        lines.push(`.${u.className} {`);
        lines.push('    // TODO: copy rules from the source file');
        lines.push('}');
        lines.push('');
    }

    return lines;
}

// ─── Todo JSON types (exported so the panel can import them) ────────────────

export interface TodoItem {
    className: string;
    selectorChain: string[];
    isRoot: boolean;
    mediaContext?: string;   // undefined = base definition; "@media ..." = media variant
    content: string;         // SCSS snippet with origin comment at top — one definition only
    checked: boolean;
}

export interface TodoGroup {
    originFile: string;     // relative path — shown in the UI
    originFsPath: string;   // absolute path — used to open the file
    items: TodoItem[];
}

export interface TodoData {
    component: string;      // e.g. "UserCardComponent"
    scssFile: string;       // e.g. "user-card.component.scss"
    createdAt: string;
    groups: TodoGroup[];
}

function buildTodo(spec: ComponentSpec, scssFileName: string): string {
    const moveSet = new Set(spec.moveClasses);
    const movedWithInfo = spec.classUsages.filter(u => moveSet.has(u.className) && u.nodeInfo);

    const byFile = new Map<string, ClassUsage[]>();
    for (const u of movedWithInfo) {
        const fp = u.nodeInfo!.fsPath;
        const bucket = byFile.get(fp) ?? [];
        bucket.push(u);
        byFile.set(fp, bucket);
    }

    const groups: TodoGroup[] = [];

    for (const [fsPath, usages] of byFile) {
        const items: TodoItem[] = [];

        for (const u of usages) {
            const chain  = u.nodeInfo!.selectorChain;
            const isRoot = chain.length === 1;

            // One TodoItem per definition (base + each @media variant separately)
            for (const def of u.nodeInfo!.allDefinitions) {
                const comment = originComment(chain, def.mediaContext);
                let content: string;

                if (isRoot) {
                    const props = extractDirectProperties(def.rawContent);
                    if (!props.trim()) { continue; }
                    if (def.mediaContext) {
                        content = [comment, `${def.mediaContext} {`, ...dedentContent(props, '    '), '}'].join('\n');
                    } else {
                        content = [comment, ...dedentContent(props, '')].join('\n');
                    }
                } else {
                    const leafSel = chain[chain.length - 1];
                    if (def.mediaContext) {
                        content = [
                            comment,
                            `${def.mediaContext} {`,
                            `    ${chain[0]} {`,
                            `        ${leafSel} {`,
                            ...dedentContent(def.rawContent, '            '),
                            '        }',
                            '    }',
                            '}',
                        ].join('\n');
                    } else {
                        content = [comment, `${leafSel} {`, ...dedentContent(def.rawContent, '    '), '}'].join('\n');
                    }
                }

                items.push({
                    className: u.className,
                    selectorChain: chain,
                    isRoot,
                    mediaContext: def.mediaContext,
                    content,
                    checked: false,
                });
            }
        }

        if (items.length) {
            groups.push({ originFile: relativePath(fsPath), originFsPath: fsPath, items });
        }
    }

    const data: TodoData = {
        component: `${spec.name}Component`,
        scssFile: scssFileName,
        createdAt: new Date().toISOString(),
        groups,
    };

    return JSON.stringify(data, null, 2);
}

/**
 * Returns only the CSS property declarations that are direct children of a block,
 * stripping both nested rule-sets AND the selector text that precedes them.
 *
 * At depth 0 we accumulate text in `pending`. When we hit `{`, the pending text
 * was a nested selector — discard it. When we hit `;`, the pending text was a
 * property declaration — keep it. Anything at depth > 0 is inside a nested block
 * and is ignored entirely.
 *
 * Used when a root BEM class (e.g. `.cl-header`) is in the same move-group as
 * its children so we emit only `display: flex` and not the `&--right { }` etc.
 * blocks which the children render individually.
 */
function extractDirectProperties(rawContent: string): string {
    const cleaned = rawContent
        .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
        .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));

    let depth = 0;
    let pending = '';
    let result = '';

    for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (ch === '{') {
            depth++;
            if (depth === 1) {
                // pending holds a nested selector name — discard it
                pending = '';
            }
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                pending = ''; // reset after exiting a nested block
            }
        } else if (depth === 0) {
            if (ch === ';') {
                result += pending + rawContent[i]; // complete property declaration
                pending = '';
            } else {
                pending += rawContent[i];
            }
        }
        // depth > 0 — inside a nested block, skip everything
    }

    return result;
}

/**
 * Strips the minimum common leading whitespace from rawContent lines and
 * re-indents them with `indent`. Leading and trailing empty lines are removed.
 */
function dedentContent(raw: string, indent: string): string[] {
    const rawLines = raw.split('\n');
    const nonEmpty = rawLines.filter(l => l.trim());
    if (!nonEmpty.length) { return []; }

    const minIndent = Math.min(...nonEmpty.map(l => l.match(/^(\s*)/)?.[1].length ?? 0));

    const result = rawLines.map(l => l.trim() ? indent + l.slice(minIndent) : '');

    // Trim leading and trailing blank lines
    while (result.length && !result[0].trim()) { result.shift(); }
    while (result.length && !result[result.length - 1].trim()) { result.pop(); }

    return result;
}

/** Builds a one-line origin comment, e.g. "// .cl-header > &--right" or "// @media (...) > .cl-header > &--right" */
function originComment(chain: string[], mediaContext?: string): string {
    const selPart = chain.join(' > ');
    return mediaContext ? `// ${mediaContext} > ${selPart}` : `// ${selPart}`;
}

function toFileName(pascalName: string): string {
    return pascalName
        .replace(/([A-Z])/g, (_, c, i) => (i > 0 ? '-' : '') + c.toLowerCase())
        .replace(/^-/, '');
}

export function toSelector(pascalName: string): string {
    return 'app-' + toFileName(pascalName);
}

export function toPascalCase(raw: string): string {
    return raw
        .replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase())
        .replace(/^(.)/, c => c.toUpperCase());
}
