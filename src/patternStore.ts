import * as vscode from 'vscode';

export interface PipelineStep {
    pattern: string;
    flags: string;
    replacement: string;
}

export interface SavedPattern {
    name: string;
    steps: PipelineStep[];
    scope: string;
    glob?: string;
    fileTypes?: string;
    excludePattern?: string;
}

export interface AppliedChange {
    uri: string;
    offset: number;
    originalText: string;
    replacedText: string;
}

export interface HistoryEntry {
    steps: PipelineStep[];
    // Kept for display in history card:
    pattern: string;
    flags: string;
    replacement: string;
    scope: string;
    glob?: string;
    fileTypes?: string;
    excludePattern?: string;
    replacements: number;
    filesModified: number;
    files: string[];
    changes: AppliedChange[];
    timestamp: string;
}

const STORAGE_KEY  = 'dpa-rex-refacror.savedPatterns';
const HISTORY_KEY  = 'dpa-rex-refacror.history';
const MAX_HISTORY  = 50;

// In-memory only — cleared when the pattern is consumed
let _pendingPattern: SavedPattern | null = null;

function migratePattern(r: any): SavedPattern {
    if (Array.isArray(r.steps)) { return r as SavedPattern; }
    return {
        name: r.name,
        steps: [{ pattern: r.pattern || '', flags: r.flags || 'gi', replacement: r.replacement || '' }],
        scope: r.scope || 'workspaceFolder',
        glob: r.glob,
        fileTypes: r.fileTypes,
        excludePattern: r.excludePattern,
    };
}

export class PatternStore {
    constructor(private readonly context: vscode.ExtensionContext) {}

    getAll(): SavedPattern[] {
        return this.context.globalState.get<any[]>(STORAGE_KEY, []).map(migratePattern);
    }

    save(pattern: SavedPattern): void {
        const patterns = this.getAll();
        const idx = patterns.findIndex(p => p.name === pattern.name);
        if (idx >= 0) { patterns[idx] = pattern; } else { patterns.push(pattern); }
        this.context.globalState.update(STORAGE_KEY, patterns);
    }

    delete(name: string): void {
        this.context.globalState.update(STORAGE_KEY, this.getAll().filter(p => p.name !== name));
    }

    getHistory(): HistoryEntry[] {
        return this.context.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
    }

    addHistory(entry: HistoryEntry): void {
        const history = this.getHistory();
        history.unshift(entry);
        if (history.length > MAX_HISTORY) { history.length = MAX_HISTORY; }
        this.context.globalState.update(HISTORY_KEY, history);
    }

    removeHistoryEntry(index: number): void {
        const history = this.getHistory();
        history.splice(index, 1);
        this.context.globalState.update(HISTORY_KEY, history);
    }

    clearHistory(): void {
        this.context.globalState.update(HISTORY_KEY, []);
    }

    setPendingPattern(p: SavedPattern): void { _pendingPattern = p; }
    consumePendingPattern(): SavedPattern | null {
        const p = _pendingPattern;
        _pendingPattern = null;
        return p;
    }
}
