export interface MixinInfo {
    name: string;
    direction: 'min-width' | 'max-width';
    px: number;
}

/**
 * Map key: "min-width:768" or "max-width:768"
 * Value: the mixin that wraps that exact media query
 */
export type MixinMap = Map<string, MixinInfo>;

/**
 * Parses a SCSS file and builds a MixinMap.
 *
 * Algorithm:
 * 1. Extract all `$var: NNNpx` variable declarations and build a value table.
 * 2. For each `@mixin name { @media(direction: $var|NNNpx) { @content; } }` block,
 *    resolve the pixel value via the variable table and store the mapping.
 *
 * Example input:
 *   $media-md: 768px;
 *   @mixin md { @media(min-width:$media-md) { @content; } }
 *
 * Produces: Map { "min-width:768" => { name: "md", direction: "min-width", px: 768 } }
 */
export function parseMixinsFile(content: string): MixinMap {
    const map: MixinMap = new Map();

    // Step 1 — resolve SCSS px variables
    const vars = new Map<string, number>();
    for (const m of content.matchAll(/\$([a-zA-Z_-]+)\s*:\s*(\d+)px\s*;/g)) {
        vars.set(m[1], parseInt(m[2]));
    }

    // Step 2 — find @mixin blocks and extract their @media rule
    const mixinRe = /@mixin\s+([\w-]+)\s*(?:\([^)]*\))?\s*\{/g;

    for (const startMatch of content.matchAll(mixinRe)) {
        const mixinName = startMatch[1];
        const body = extractBlock(content, startMatch.index! + startMatch[0].length);
        if (!body) { continue; }

        const mediaRe = /@media\s*\(\s*(min-width|max-width)\s*:\s*(\$[\w-]+|\d+px)\s*\)/i;
        const mediaMatch = mediaRe.exec(body);
        if (!mediaMatch) { continue; }

        const direction = mediaMatch[1].toLowerCase() as 'min-width' | 'max-width';
        const rawValue  = mediaMatch[2].trim();

        const px = rawValue.startsWith('$')
            ? (vars.get(rawValue.slice(1)) ?? 0)
            : parseInt(rawValue);

        if (!px) { continue; }

        const key = `${direction}:${px}`;
        if (!map.has(key)) {
            map.set(key, { name: mixinName, direction, px });
        }
    }

    return map;
}

/**
 * Given a raw `@media (...)` string from parsed SCSS, returns the mixin name
 * to use instead — or undefined if no matching mixin exists.
 *
 * Handles whitespace variations: "@media (max-width: 768px)" and "@media(min-width:768px)"
 * both normalize to the same lookup key.
 */
export function resolveMixin(mediaContext: string, mixinMap: MixinMap): string | undefined {
    const m = /^@media\s*\(\s*(min-width|max-width)\s*:\s*(\d+)px\s*\)$/i.exec(mediaContext.trim());
    if (!m) { return undefined; }
    return mixinMap.get(`${m[1].toLowerCase()}:${m[2]}`)?.name;
}

/** Extracts the content of a `{ ... }` block starting right after the opening brace. */
function extractBlock(content: string, startIdx: number): string | undefined {
    let depth = 1;
    let i = startIdx;
    while (i < content.length && depth > 0) {
        if (content[i] === '{') { depth++; }
        else if (content[i] === '}') { depth--; }
        i++;
    }
    return depth === 0 ? content.slice(startIdx, i - 1) : undefined;
}
