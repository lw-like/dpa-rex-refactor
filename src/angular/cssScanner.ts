import * as vscode from 'vscode';
import * as path from 'path';

/** One occurrence of a class definition — base style or inside an @media block. */
export interface ScssDefinition {
    selectorChain: string[];    // BEM chain only (no @rules): [".cl-header", "&--right"]
    rawContent: string;          // original SCSS content inside the block
    mediaContext?: string;       // undefined = base style; "@media (...)" = media variant
}

export interface ScssNodeInfo {
    selectorChain: string[];    // from the primary (non-media) definition
    rawContent: string;          // from the primary definition
    fsPath: string;
    allDefinitions: ScssDefinition[];  // base + every @media variant, in source order
}

export interface ClassUsage {
    className: string;
    definedIn: string[];        // scss/css files where the class is declared
    nodeInfo?: ScssNodeInfo;    // populated when found
    usedIn: string[];           // html/ts template files where the class name appears
    usageCount: number;
    safeToMove: boolean;        // true when usageCount <= 1
}

const EXCLUDE_PATTERN = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/coverage/**,**/.angular/**}';

export async function scanClassUsage(
    classes: string[],
    progress?: vscode.Progress<{ message?: string }>,
): Promise<ClassUsage[]> {
    if (classes.length === 0) { return []; }

    progress?.report({ message: 'Finding workspace files…' });

    const [templateFiles, styleFiles] = await Promise.all([
        vscode.workspace.findFiles('**/*.{html,htm}', EXCLUDE_PATTERN),
        vscode.workspace.findFiles('**/*.{css,scss,sass,less}', EXCLUDE_PATTERN),
    ]);

    progress?.report({ message: `Scanning ${templateFiles.length} templates and ${styleFiles.length} style files…` });

    const styleIndex = new Map<string, Map<string, ScssNodeInfo>>();
    await Promise.all(styleFiles.map(async (uri) => {
        const text = await readFile(uri);
        styleIndex.set(uri.fsPath, extractScssNodeInfos(text, uri.fsPath));
    }));

    const results: ClassUsage[] = [];

    for (const className of classes) {
        const usageRe = new RegExp(`(?<![a-zA-Z0-9_-])${escapeRegex(className)}(?![a-zA-Z0-9_-])`);

        const definedIn: string[] = [];
        let nodeInfo: ScssNodeInfo | undefined;

        for (const [fsPath, nodeMap] of styleIndex) {
            const info = nodeMap.get(className);
            if (info) {
                definedIn.push(fsPath);
                if (!nodeInfo) { nodeInfo = info; }
            }
        }

        const usedIn: string[] = [];
        await Promise.all(templateFiles.map(async (uri) => {
            const text = await readFile(uri);
            if (usageRe.test(text)) { usedIn.push(uri.fsPath); }
        }));

        results.push({ className, definedIn, nodeInfo, usedIn, usageCount: usedIn.length, safeToMove: usedIn.length <= 1 });
    }

    return results;
}

/**
 * Parses a CSS/SCSS file and returns a map of className → ScssNodeInfo.
 *
 * Key behaviours:
 * - BEM `&` concatenation: `.block { &--mod { } }` → "block--mod"
 * - @rules are TRANSPARENT to `&` resolution: `@media` does not become the new
 *   parent selector, so `&` inside a media block still refers to the enclosing
 *   CSS selector.
 * - ALL definitions for a class are collected (base + every @media variant).
 *   The primary `selectorChain`/`rawContent` comes from the first non-media
 *   definition; media variants are stored in `allDefinitions`.
 *
 * Comments are replaced with equal-length spaces so rawContent slices from the
 * original `scss` string stay position-accurate.
 */
export function extractScssNodeInfos(scss: string, fsPath: string): Map<string, ScssNodeInfo> {
    const cleaned = scss
        .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
        .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));

    interface StackFrame {
        rawSelector: string;
        resolvedClasses: string[];
        contentStart: number;
        isAtRule: boolean;  // true for @media, @supports, @keyframes, …
    }

    const frameStack: StackFrame[] = [];
    // selectorStack tracks CSS selectors only — @rules don't push new selectors.
    const selectorStack: string[][] = [['']];

    // Collect all ScssDefinition objects per class name before building ScssNodeInfo.
    const allDefs = new Map<string, ScssDefinition[]>();

    let pending = '';

    for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];

        if (ch === '{') {
            const rawSel = pending.trim();
            pending = '';

            const isAtRule = rawSel.startsWith('@');
            const parents = selectorStack[selectorStack.length - 1];

            let active: string[];
            let resolvedClasses: string[] = [];

            if (isAtRule) {
                // @media / @supports / @keyframes etc. are transparent to & resolution.
                // Keep the same CSS selector context so nested & still works correctly.
                active = parents;
            } else {
                active = resolveSelectors(rawSel, parents);
                const effective = active.length ? active : parents;
                for (const sel of effective) {
                    for (const m of sel.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
                        resolvedClasses.push(m[1]);
                    }
                }
            }

            frameStack.push({ rawSelector: rawSel, resolvedClasses, contentStart: i + 1, isAtRule });
            // @rules: push same parent selectors (transparent); CSS rules: push resolved
            selectorStack.push(isAtRule ? parents : (active.length ? active : parents));

        } else if (ch === '}') {
            const frame = frameStack.pop();
            selectorStack.pop();
            pending = '';

            if (frame && frame.resolvedClasses.length > 0) {
                const rawContent = scss.slice(frame.contentStart, i);

                // BEM chain: ancestor frames that are NOT @rules, plus this frame
                const bemChain = [
                    ...frameStack.filter(f => !f.isAtRule && f.rawSelector).map(f => f.rawSelector),
                    frame.rawSelector,
                ].filter(Boolean);

                // @media context: find the innermost @media ancestor
                const mediaFrame = [...frameStack].reverse()
                    .find(f => f.rawSelector.trimStart().startsWith('@media'));
                const mediaContext = mediaFrame?.rawSelector;

                for (const className of frame.resolvedClasses) {
                    const def: ScssDefinition = { selectorChain: bemChain, rawContent, mediaContext };
                    const existing = allDefs.get(className) ?? [];
                    existing.push(def);
                    allDefs.set(className, existing);
                }
            }

        } else if (ch === ';') {
            pending = '';
        } else {
            pending += ch;
        }
    }

    // Build ScssNodeInfo: primary = first non-media definition (or first overall)
    const infos = new Map<string, ScssNodeInfo>();
    for (const [className, defs] of allDefs) {
        const primary = defs.find(d => !d.mediaContext) ?? defs[0];
        infos.set(className, {
            selectorChain: primary.selectorChain,
            rawContent: primary.rawContent,
            fsPath,
            allDefinitions: defs,
        });
    }

    return infos;
}

/**
 * Convenience wrapper — returns just the set of class names defined in a file.
 */
export function extractScssClasses(scss: string): Set<string> {
    return new Set(extractScssNodeInfos(scss, '').keys());
}

function resolveSelectors(raw: string, parents: string[]): string[] {
    if (!raw) { return parents; }

    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    const resolved: string[] = [];

    for (const part of parts) {
        if (part.includes('&')) {
            for (const parent of parents) {
                resolved.push(part.replace(/&/g, parent));
            }
        } else {
            resolved.push(part);
        }
    }

    return resolved;
}

async function readFile(uri: vscode.Uri): Promise<string> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(bytes).toString('utf8');
    } catch {
        return '';
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function relativePath(fsPath: string): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { return fsPath; }
    const root = folders[0].uri.fsPath;
    return path.relative(root, fsPath);
}
