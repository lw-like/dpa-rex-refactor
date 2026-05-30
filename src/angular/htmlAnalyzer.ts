export interface HtmlAnalysis {
    classes: string[];
    inputs: string[];
    outputs: string[];
    pipes: string[];
    directives: string[];
    customElements: string[];   // hyphenated element selectors, e.g. "app-user-card", "mat-button"
}

const CLASS_ATTR_RE = /class(?:Name)?=["']([^"']+)["']/g;
const CLASS_BINDING_RE = /\[class\.([^\]]+)\]/g;
const NGCLASS_RE = /\[ngClass\]="([^"]+)"/g;

const INTERPOLATION_RE = /\{\{\s*(\w+)(?:\s*\|[^}]*)?\s*\}\}/g;
const PROP_BINDING_RE = /\[(?!class\.|style\.)([a-zA-Z][a-zA-Z0-9]*)(?:\.[a-zA-Z]+)?\]="([^"]+)"/g;
const EVENT_BINDING_RE = /\(([a-zA-Z][a-zA-Z0-9]*)\)="[^"]*"/g;
const PIPE_RE = /\|\s*([a-zA-Z][a-zA-Z0-9]*)/g;

// Matches any hyphenated element tag — the reliable signal for custom components.
// Native HTML elements never contain hyphens (custom elements spec).
const CUSTOM_ELEMENT_RE = /<([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)+)(?:\s|>|\/)/g;

const BUILTIN_PIPES = new Set(['async', 'json', 'date', 'number', 'currency', 'percent', 'uppercase', 'lowercase', 'titlecase', 'slice', 'keyvalue', 'i18nPlural', 'i18nSelect']);
const SKIP_DIRECTIVES = new Set(['if', 'else', 'for', 'switch', 'case', 'default', 'track']);
const SKIP_EVENTS = new Set(['click', 'change', 'input', 'submit', 'keydown', 'keyup', 'keypress', 'focus', 'blur', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'dblclick', 'contextmenu']);

export function analyzeHtml(html: string): HtmlAnalysis {
    const classes = new Set<string>();
    const inputs = new Set<string>();
    const outputs = new Set<string>();
    const pipes = new Set<string>();
    const directives = new Set<string>();
    const customElements = new Set<string>();

    // CSS classes from class="" attributes
    for (const m of html.matchAll(CLASS_ATTR_RE)) {
        m[1].split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
    }

    // [class.foo] bindings
    for (const m of html.matchAll(CLASS_BINDING_RE)) {
        classes.add(m[1]);
    }

    // [ngClass]="{ 'foo': ... }" — extract string keys
    for (const m of html.matchAll(NGCLASS_RE)) {
        for (const cm of m[1].matchAll(/'([^']+)'/g)) {
            cm[1].split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
        }
    }

    // {{ variable }} — candidate inputs
    for (const m of html.matchAll(INTERPOLATION_RE)) {
        inputs.add(m[1]);
    }

    // [prop]="expr" — extract simple identifier expressions as candidate inputs
    for (const m of html.matchAll(PROP_BINDING_RE)) {
        const prop = m[1];
        const expr = m[2].trim();
        // Only flag simple identifiers as inputs, not method calls or complex expressions
        if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(expr)) {
            inputs.add(expr);
        }
        // The bound property name may hint at a directive
        if (prop.startsWith('ng') && !SKIP_DIRECTIVES.has(prop)) {
            directives.add(prop);
        }
    }

    // (event)="..." — candidate outputs
    for (const m of html.matchAll(EVENT_BINDING_RE)) {
        if (!SKIP_EVENTS.has(m[1])) {
            outputs.add(m[1]);
        }
    }

    // Pipes
    for (const m of html.matchAll(PIPE_RE)) {
        if (!BUILTIN_PIPES.has(m[1])) {
            pipes.add(m[1]);
        }
    }

    // Custom component selectors (hyphenated element names)
    for (const m of html.matchAll(CUSTOM_ELEMENT_RE)) {
        customElements.add(m[1]);
    }

    return {
        classes: [...classes],
        inputs: [...inputs],
        outputs: [...outputs],
        pipes: [...pipes],
        directives: [...directives],
        customElements: [...customElements],
    };
}
