export interface PatternSuggestion {
    id: string;
    label: string;
    description: string;
    pattern: string;
    flags: string;
    replacement: string;
    matchCount: number;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countMatches(text: string, pattern: string, flags: string): number {
    try {
        const gFlags = flags.includes('g') ? flags : flags + 'g';
        return (text.match(new RegExp(pattern, gFlags)) ?? []).length;
    } catch { return 0; }
}

function isLikelyHtml(text: string): boolean {
    return /<[a-zA-Z][\w-]*[\s/>]/.test(text) || text.includes('</');
}

// ─── Marker-based HTML normalization ─────────────────────────────────────────
//
// We normalize an HTML fragment by replacing variable parts with control-char
// markers so we can check if multiple elements share identical structure.
//
//   \x01  →  attribute value: ="anything"  becomes  =\x01
//   \x02  →  text content:    >text<        becomes  >\x02<
//   \x03  →  whitespace gap:  >   \n  <     becomes  >\x03<

const MARK_AV = '\x01'; // attribute value (the ="..." part)
const MARK_TV = '\x02'; // text content between tags
const MARK_WS = '\x03'; // whitespace-only gap between tags

function normalizeHtmlBlock(block: string): string {
    return block
        .replace(/>\s+</g, `>${MARK_WS}<`)                            // whitespace between tags
        .replace(/=(?:"[^"]*"|'[^']*')/g, `=${MARK_AV}`)             // attr values (either quote style)
        .replace(/>([^<\x01\x02\x03][^<]*)</g, `>${MARK_TV}<`)       // non-whitespace text content
        .replace(/[ \t]+/g, ' ')                                       // collapse inline spaces
        .trim();
}

// Build a regex pattern from a normalized template string.
// Literal segments are escapeRegex'd; markers become capture groups.
function templateToPattern(template: string): string {
    let result = '';
    let rest = template;

    while (rest.length > 0) {
        // Find the earliest marker
        const avIdx = rest.indexOf(MARK_AV);
        const tvIdx = rest.indexOf(MARK_TV);
        const wsIdx = rest.indexOf(MARK_WS);

        let minIdx = -1;
        let marker = '';
        let groupPat = '';

        if (avIdx >= 0 && (minIdx < 0 || avIdx < minIdx)) { minIdx = avIdx; marker = MARK_AV; groupPat = '"([^"]*)"'; }
        if (tvIdx >= 0 && (minIdx < 0 || tvIdx < minIdx)) { minIdx = tvIdx; marker = MARK_TV; groupPat = '([^<]*)'; }
        if (wsIdx >= 0 && (minIdx < 0 || wsIdx < minIdx)) { minIdx = wsIdx; marker = MARK_WS; groupPat = '\\s*'; }

        if (minIdx < 0) {
            result += escapeRegex(rest);
            break;
        }

        result += escapeRegex(rest.slice(0, minIdx));
        result += groupPat;
        rest = rest.slice(minIdx + marker.length);
    }

    return result;
}

// ─── HTML: repeating block detection (primary HTML analysis) ─────────────────
//
// Finds tags that appear 2+ times as complete elements (<tag>…</tag>),
// normalizes each occurrence, and if they share the same structure generates
// a capture pattern with groups for the variable parts.

function findRepeatingHtmlBlocks(text: string): PatternSuggestion[] {
    // Step 1: Find which tags have matching open + close pairs
    const closingTags = new Set<string>();
    let m: RegExpExecArray | null;
    const closingRe = /<\/([a-zA-Z][\w-]*)\s*>/g;
    while ((m = closingRe.exec(text)) !== null) { closingTags.add(m[1].toLowerCase()); }

    // Step 2: Count how many times each paired tag opens
    const openCounts = new Map<string, number>();
    const openRe = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?\s*>/g;
    while ((m = openRe.exec(text)) !== null) {
        const tag = m[1].toLowerCase();
        if (closingTags.has(tag)) { openCounts.set(tag, (openCounts.get(tag) ?? 0) + 1); }
    }

    const results: PatternSuggestion[] = [];

    for (const [tag, openCount] of openCounts) {
        if (openCount < 2) { continue; }

        // Step 3: Extract all <tag…>…</tag> blocks (lazy match, handles multi-line)
        const blockRe = new RegExp(`<${escapeRegex(tag)}(\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegex(tag)}>`, 'gi');
        const instances: string[] = [];
        while ((m = blockRe.exec(text)) !== null) { instances.push(m[0]); }
        if (instances.length < 2) { continue; }

        // Step 4: Normalize and require identical structure
        const normalized = instances.map(normalizeHtmlBlock);
        if (!normalized.every(n => n === normalized[0])) { continue; }

        // Step 5: Build pattern from the template
        const pattern = templateToPattern(normalized[0]);
        const matchCount = countMatches(text, pattern, 'gis');
        if (matchCount < 2) { continue; }

        results.push({
            id: `block-${tag}`,
            label: `<${tag}> element structure`,
            description: `Matches all ${instances.length} <${tag}> elements — variable attribute values and text content become capture groups`,
            pattern,
            flags: 'gis',
            replacement: '',
            matchCount,
        });
    }

    // Prefer tags that appear most (usually the innermost repeating element)
    return results.sort((a, b) => b.matchCount - a.matchCount);
}

// ─── HTML: void / self-closing tag patterns ───────────────────────────────────

const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr']);

function suggestVoidTagPatterns(text: string): PatternSuggestion[] {
    const tagCounts = new Map<string, string[]>();
    const re = /<([a-zA-Z][\w-]*)(\s[^>]*)?\s*\/?>/g;
    let m: RegExpExecArray | null;

    while ((m = re.exec(text)) !== null) {
        const tag = m[1].toLowerCase();
        if (!VOID_TAGS.has(tag)) { continue; }
        if (!tagCounts.has(tag)) { tagCounts.set(tag, []); }
        tagCounts.get(tag)!.push(m[0]);
    }

    const results: PatternSuggestion[] = [];

    for (const [tag, instances] of tagCounts) {
        if (instances.length < 2) { continue; }

        // Normalize each instance
        const normalized = instances.map(s =>
            s.replace(/=(?:"[^"]*"|'[^']*')/g, `=${MARK_AV}`).replace(/\s+/g, ' ').trim()
        );
        if (!normalized.every(n => n === normalized[0])) { continue; }

        const pattern = templateToPattern(normalized[0]);
        const matchCount = countMatches(text, pattern, 'gi');
        if (matchCount < 2) { continue; }

        results.push({
            id: `void-${tag}`,
            label: `<${tag}> element`,
            description: `Matches all ${instances.length} <${tag}> elements — attribute values become capture groups`,
            pattern,
            flags: 'gi',
            replacement: '',
            matchCount,
        });
    }

    return results;
}

// ─── HTML: attribute value patterns ──────────────────────────────────────────

function suggestAttrPatterns(text: string): PatternSuggestion[] {
    const attrRe = /\b([\w][\w-]*)=(?:"([^"]*)"|'([^']*)')/g;
    const attrMap = new Map<string, Set<string>>();
    let m: RegExpExecArray | null;

    while ((m = attrRe.exec(text)) !== null) {
        const name = m[1].toLowerCase();
        const val = m[2] ?? m[3] ?? '';
        if (!attrMap.has(name)) { attrMap.set(name, new Set()); }
        attrMap.get(name)!.add(val);
    }

    const results: PatternSuggestion[] = [];
    for (const [attr, values] of attrMap) {
        const count = countMatches(text, `${attr}="([^"]*)"`, 'g');
        if (count === 0) { continue; }
        const desc = values.size > 1
            ? `Captures ${attr} value — ${values.size} different values in sample`
            : `Captures the ${attr} attribute value`;
        results.push({
            id: `attr-${attr}`,
            label: `${attr}="…"`,
            description: desc,
            pattern: `${attr}="([^"]*)"`,
            flags: 'g',
            replacement: `${attr}="$1"`,
            matchCount: count,
        });
    }
    return results.sort((a, b) => b.matchCount - a.matchCount);
}

// ─── HTML: <tag>content</tag> patterns ───────────────────────────────────────

function suggestTagContentPatterns(text: string): PatternSuggestion[] {
    const tagRe = /<([a-zA-Z][\w-]*)([^>]*)>([^<]*)<\/\1>/g;
    type Info = { attrSets: Set<string>; contents: Set<string> };
    const tagMap = new Map<string, Info>();
    let m: RegExpExecArray | null;

    while ((m = tagRe.exec(text)) !== null) {
        const tag = m[1].toLowerCase();
        if (!tagMap.has(tag)) { tagMap.set(tag, { attrSets: new Set(), contents: new Set() }); }
        tagMap.get(tag)!.attrSets.add(m[2].trim());
        tagMap.get(tag)!.contents.add(m[3]);
    }

    const results: PatternSuggestion[] = [];
    for (const [tag, { attrSets, contents }] of tagMap) {
        if (attrSets.size > 1 && contents.size > 1) {
            const pattern = `<${tag}([^>]*)>([^<]*)<\\/${tag}>`;
            const count = countMatches(text, pattern, 'gi');
            if (count >= 1) { results.push({ id: `tagcont-${tag}`, label: `<${tag}> content`, description: `Matches <${tag}> elements — captures attributes and text content`, pattern, flags: 'gi', replacement: `<${tag}$1>$2</${tag}>`, matchCount: count }); }
        } else if (contents.size > 1) {
            const fixedAttrs = [...attrSets][0];
            const attrPart = fixedAttrs ? ' ' + escapeRegex(fixedAttrs) : '';
            const pattern = `<${tag}${attrPart}>([^<]*)<\\/${tag}>`;
            const count = countMatches(text, pattern, 'gi');
            if (count >= 1) { results.push({ id: `tagtext-${tag}`, label: `<${tag}> text`, description: `Matches <${tag}> with varying text content`, pattern, flags: 'gi', replacement: `<${tag}${fixedAttrs ? ' ' + fixedAttrs : ''}>$1</${tag}>`, matchCount: count }); }
        } else if (attrSets.size > 1) {
            const content = escapeRegex([...contents][0]);
            const pattern = `<${tag}([^>]*)>${content}<\\/${tag}>`;
            const count = countMatches(text, pattern, 'gi');
            if (count >= 1) { results.push({ id: `tagattr-${tag}`, label: `<${tag}> attrs`, description: `Matches <${tag}> with varying attributes`, pattern, flags: 'gi', replacement: `<${tag}$1>${[...contents][0]}</${tag}>`, matchCount: count }); }
        }
    }
    return results;
}

// ─── HTML: class attribute patterns ──────────────────────────────────────────

function suggestClassPatterns(text: string): PatternSuggestion[] {
    const classRe = /class=(?:"([^"]*)"|'([^']*)')/g;
    const allLists: string[][] = [];
    let m: RegExpExecArray | null;

    while ((m = classRe.exec(text)) !== null) {
        const val = (m[1] ?? m[2] ?? '').trim();
        if (val) { allLists.push(val.split(/\s+/)); }
    }
    if (!allLists.length) { return []; }

    const results: PatternSuggestion[] = [];

    if (allLists.length > 1) {
        const common = allLists[0].filter(c => allLists.every(l => l.includes(c)));
        if (common.length > 0 && allLists.some(l => l.length > common.length)) {
            const pattern = `class="([^"]*\\b${common.map(escapeRegex).join('\\s+')}\\b[^"]*)"`;
            const count = countMatches(text, pattern, 'g');
            if (count > 0) { results.push({ id: 'class-base', label: `class with "${common.join(' ')}"`, description: `Elements sharing the base class — modifier classes captured`, pattern, flags: 'g', replacement: 'class="$1"', matchCount: count }); }
        }
    }

    const genericCount = countMatches(text, 'class="([^"]*)"', 'g');
    if (genericCount >= 1) { results.push({ id: 'class-any', label: 'class="…"', description: 'Captures the full class attribute value', pattern: 'class="([^"]*)"', flags: 'g', replacement: 'class="$1"', matchCount: genericCount }); }

    return results;
}

// ─── HTML: data-* attribute patterns ─────────────────────────────────────────

function suggestDataAttrPatterns(text: string): PatternSuggestion[] {
    const re = /\bdata-([\w-]+)=(?:"[^"]*"|'[^']*')/g;
    const counts = new Map<string, number>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) { const n = m[1]; counts.set(n, (counts.get(n) ?? 0) + 1); }
    return [...counts.entries()].map(([name, count]) => ({
        id: `data-${name}`, label: `data-${name}="…"`,
        description: `Captures data-${name} attribute values`,
        pattern: `data-${name}="([^"]*)"`, flags: 'g',
        replacement: `data-${name}="$1"`, matchCount: count,
    })).sort((a, b) => b.matchCount - a.matchCount);
}

// ─── HTML: style attribute patterns ──────────────────────────────────────────

function suggestStylePatterns(text: string): PatternSuggestion[] {
    const results: PatternSuggestion[] = [];
    const styleCount = countMatches(text, 'style="([^"]*)"', 'g');
    if (styleCount >= 1) { results.push({ id: 'style-attr', label: 'style="…"', description: 'Captures the full inline style value', pattern: 'style="([^"]*)"', flags: 'g', replacement: 'style="$1"', matchCount: styleCount }); }

    const propRe = /style="[^"]*\b([\w-]+)\s*:/g;
    const propCounts = new Map<string, number>();
    let m: RegExpExecArray | null;
    while ((m = propRe.exec(text)) !== null) { const p = m[1]; propCounts.set(p, (propCounts.get(p) ?? 0) + 1); }
    for (const [prop, count] of propCounts) {
        if (count >= 2) { results.push({ id: `style-${prop}`, label: `style: ${prop}`, description: `Captures ${prop} CSS property values`, pattern: `\\b${escapeRegex(prop)}\\s*:\\s*([^;"}]+)`, flags: 'g', replacement: `${prop}: $1`, matchCount: count }); }
    }
    return results;
}

// ─── HTML: link attribute patterns ───────────────────────────────────────────

function suggestLinkPatterns(text: string): PatternSuggestion[] {
    return ['href', 'src', 'action', 'formaction'].flatMap(attr => {
        const count = countMatches(text, `${attr}="([^"]*)"`, 'g');
        return count >= 1 ? [{ id: `link-${attr}`, label: `${attr}="…" (URL)`, description: `Captures ${attr} URL values`, pattern: `${attr}="([^"]*)"`, flags: 'g', replacement: `${attr}="$1"`, matchCount: count }] : [];
    });
}

// ─── HTML: template / framework expression patterns ───────────────────────────

const TEMPLATE_PATTERNS: Array<{ id: string; label: string; description: string; pattern: string; flags: string }> = [
    { id: 'mustache',    label: '{{…}} Mustache / Handlebars',     description: 'Matches {{expression}} — Handlebars, Hugo, Jekyll, Vue text interpolation', pattern: '\\{\\{([^}]+)\\}\\}',               flags: 'g'  },
    { id: 'jsx-expr',    label: '{…} JSX expression',              description: 'Matches {expression} — React/JSX embedded JavaScript',                       pattern: '\\{([^{}\\n]+)\\}',                flags: 'g'  },
    { id: 'ejs-out',     label: '<%= … %> EJS/ERB output',         description: 'Matches <%= expr %> output tags',                                             pattern: '<%=\\s*([\\s\\S]+?)\\s*%>',         flags: 'g'  },
    { id: 'ejs-exec',    label: '<% … %> EJS script',              description: 'Matches <% code %> execution tags',                                           pattern: '<%(?!=)\\s*([\\s\\S]+?)\\s*%>',    flags: 'g'  },
    { id: 'angular-prop',label: '[prop] Angular binding',          description: 'Matches [property]="expr" — Angular property binding',                        pattern: '\\[([\\w.]+)\\]="([^"]*)"',        flags: 'g'  },
    { id: 'angular-ev',  label: '(event) Angular binding',         description: 'Matches (event)="handler" — Angular event binding',                           pattern: '\\(([\\w.]+)\\)="([^"]*)"',        flags: 'g'  },
    { id: 'ng-for',      label: '*ngFor directive',                description: 'Matches Angular *ngFor="let x of list"',                                     pattern: '\\*ngFor="let\\s+(\\w+)\\s+of\\s+([^"]+)"', flags: 'g' },
    { id: 'ng-if',       label: '*ngIf directive',                 description: 'Matches Angular *ngIf="condition"',                                           pattern: '\\*ngIf="([^"]*)"',                flags: 'g'  },
    { id: 'vue-bind',    label: ':attr Vue binding',               description: 'Matches Vue.js :attribute="expr" shorthand',                                  pattern: ':([ \\w-]+)="([^"]*)"',            flags: 'g'  },
    { id: 'vue-on',      label: '@event Vue binding',              description: 'Matches Vue.js @event="handler" shorthand',                                   pattern: '@([\\w.]+)="([^"]*)"',             flags: 'g'  },
    { id: 'vue-dir',     label: 'v-directive Vue',                 description: 'Matches v-if, v-for, v-model, v-show, etc.',                                  pattern: 'v-([\\w:-]+)(?:="([^"]*)")?',      flags: 'g'  },
    { id: 'jinja',       label: '{{ … }} Jinja2 / Twig',           description: 'Matches {{ variable }} — Jinja2, Twig, Nunjucks',                             pattern: '\\{\\{\\s*([^}]+?)\\s*\\}\\}',    flags: 'g'  },
    { id: 'jinja-tag',   label: '{% … %} Jinja2 tag',             description: 'Matches {% block %}, {% for %}, {% if %} — Jinja2/Twig',                     pattern: '\\{%[-–]?\\s*([\\s\\S]+?)\\s*[-–]?%\\}', flags: 'g' },
    { id: 'php-echo',    label: '<?= … ?> PHP echo',              description: 'Matches PHP short echo output tags',                                          pattern: '<\\?=\\s*([^?]+?)\\s*\\?>',        flags: 'g'  },
];

function suggestTemplatePatterns(text: string): PatternSuggestion[] {
    const seen = new Set<string>();
    return TEMPLATE_PATTERNS.filter(t => {
        if (seen.has(t.pattern)) { return false; }
        const count = countMatches(text, t.pattern, t.flags);
        if (count === 0) { return false; }
        seen.add(t.pattern);
        return true;
    }).map(t => ({ ...t, replacement: '', matchCount: countMatches(text, t.pattern, t.flags) }));
}

// ─── Generic: named library patterns ─────────────────────────────────────────

interface LibEntry { id: string; label: string; description: string; pattern: string; flags: string; replacement: string; }

const LIBRARY: LibEntry[] = [
    { id: 'email',    label: 'Email address',         description: 'Matches email addresses',                    pattern: '[\\w.+-]+@[\\w-]+\\.[a-z]{2,}',                                       flags: 'gi',  replacement: '' },
    { id: 'url',      label: 'URL (http/https)',       description: 'Matches http and https URLs',                pattern: 'https?://[^\\s<>"\']+',                                               flags: 'gi',  replacement: '' },
    { id: 'ipv4',     label: 'IPv4 address',           description: 'Matches IPv4 addresses',                    pattern: '\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\b', flags: 'g', replacement: '' },
    { id: 'uuid',     label: 'UUID',                   description: 'Matches UUIDs',                             pattern: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',      flags: 'gi',  replacement: '' },
    { id: 'isodate',  label: 'ISO date (YYYY-MM-DD)',  description: 'Matches YYYY-MM-DD dates',                  pattern: '\\b(\\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])\\b',             flags: 'g',   replacement: '$1-$2-$3' },
    { id: 'hexcolor', label: 'CSS hex color',          description: 'Matches #rgb / #rrggbb / #rrggbbaa colors', pattern: '#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\\b',                       flags: 'gi',  replacement: '' },
    { id: 'version',  label: 'Version (semver)',       description: 'Matches semver-style version strings',      pattern: '\\bv?(\\d+)\\.(\\d+)(?:\\.(\\d+))?(?:[.-][\\w.]+)?\\b',             flags: 'g',   replacement: '' },
    { id: 'integer',  label: 'Integer',                description: 'Matches integer numbers',                   pattern: '-?\\b\\d+\\b',                                                        flags: 'g',   replacement: '' },
    { id: 'camel',    label: 'camelCase identifier',   description: 'Matches camelCase names',                   pattern: '\\b[a-z]+(?:[A-Z][a-z]+)+\\b',                                        flags: 'g',   replacement: '' },
    { id: 'scream',   label: 'SCREAMING_SNAKE',        description: 'Matches UPPER_CASE_CONSTANTS',              pattern: '\\b[A-Z][A-Z0-9_]{2,}\\b',                                           flags: 'g',   replacement: '' },
    { id: 'jsimport', label: 'JS/TS import',           description: 'Matches ES import statements',              pattern: '^import\\s+(.+?)\\s+from\\s+[\'"](.+?)[\'"]',                        flags: 'gm',  replacement: '' },
];

// ─── Generic: non-HTML line structure ────────────────────────────────────────

type TokenType = 'word' | 'number' | 'whitespace' | 'punct';
interface Token { text: string; type: TokenType; }

function tokenize(line: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < line.length) {
        if (/\s/.test(line[i])) { let j = i; while (j < line.length && /\s/.test(line[j])) { j++; } tokens.push({ text: line.slice(i, j), type: 'whitespace' }); i = j; }
        else if (/\d/.test(line[i])) { let j = i; while (j < line.length && /[\d.]/.test(line[j])) { j++; } tokens.push({ text: line.slice(i, j), type: 'number' }); i = j; }
        else if (/[a-zA-Z_$]/.test(line[i])) { let j = i; while (j < line.length && /[\w$]/.test(line[j])) { j++; } tokens.push({ text: line.slice(i, j), type: 'word' }); i = j; }
        else { tokens.push({ text: line[i], type: 'punct' }); i++; }
    }
    return tokens;
}

function colPattern(col: Token[]): string {
    if (col[0].type === 'whitespace') { return '\\s+'; }
    if (col.every(t => t.text === col[0].text && t.type === col[0].type)) { return escapeRegex(col[0].text); }
    const types = new Set(col.map(t => t.type));
    if (types.size === 1 && col[0].type === 'word')   { return '(\\w+)'; }
    if (types.size === 1 && col[0].type === 'number') { return '(\\d+(?:\\.\\d+)?)'; }
    return '(.+?)';
}

function analyzeLineStructure(text: string): PatternSuggestion | null {
    const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0);
    if (lines.length < 2) { return null; }
    const tok = lines.map(tokenize);
    if (new Set(tok.map(t => t.length)).size !== 1) { return null; }
    const pattern = '^' + Array.from({ length: tok[0].length }, (_, i) => colPattern(tok.map(t => t[i]))).join('') + '$';
    const count = countMatches(text, pattern, 'gm');
    if (count < lines.length) { return null; }
    return { id: 'line-structure', label: 'Line structure', description: `Matches all ${lines.length} lines — variable parts become capture groups`, pattern, flags: 'gm', replacement: '', matchCount: count };
}

// ─── Literal fallback ─────────────────────────────────────────────────────────

function buildLiteralSuggestion(text: string): PatternSuggestion | null {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) { return null; }
    const pattern = lines.length === 1 ? escapeRegex(lines[0]) : lines.map(escapeRegex).join('|');
    const flags = lines.length > 1 ? 'gm' : 'g';
    return { id: 'literal', label: lines.length > 1 ? 'Literal alternation' : 'Exact literal', description: lines.length > 1 ? 'Matches any of the selected lines exactly' : 'Matches this text verbatim', pattern, flags, replacement: '', matchCount: countMatches(text, pattern, flags) };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function extractPatterns(text: string): PatternSuggestion[] {
    const seen = new Set<string>();
    const push = (sugs: PatternSuggestion[], acc: PatternSuggestion[]) => {
        for (const s of sugs) { if (!seen.has(s.id) && s.matchCount > 0) { seen.add(s.id); acc.push(s); } }
    };

    const results: PatternSuggestion[] = [];
    const html = isLikelyHtml(text);

    if (html) {
        // DOM block detection — the primary HTML analysis
        push(findRepeatingHtmlBlocks(text), results);
        push(suggestVoidTagPatterns(text), results);
        // Framework template expressions (very specific, low false-positive)
        push(suggestTemplatePatterns(text), results);
        // Attribute-level patterns
        push(suggestAttrPatterns(text), results);
        push(suggestLinkPatterns(text), results);
        push(suggestClassPatterns(text), results);
        push(suggestDataAttrPatterns(text), results);
        push(suggestStylePatterns(text), results);
        // Single-line tag content
        push(suggestTagContentPatterns(text), results);
    }

    // Generic library patterns
    const libHits: PatternSuggestion[] = [];
    for (const e of LIBRARY) {
        const count = countMatches(text, e.pattern, e.flags);
        if (count > 0) { libHits.push({ ...e, matchCount: count }); }
    }
    libHits.sort((a, b) => b.matchCount - a.matchCount);
    push(libHits, results);

    // Non-HTML line structure
    if (!html) {
        const ls = analyzeLineStructure(text);
        if (ls && !seen.has(ls.id)) { seen.add(ls.id); results.push(ls); }
    }

    // Literal (always last)
    const lit = buildLiteralSuggestion(text);
    if (lit && !seen.has(lit.id)) { results.push(lit); }

    return results;
}
