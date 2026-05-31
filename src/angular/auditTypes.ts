export interface AuditFinding {
    uri: string;                  // vscode URI string for navigation/apply
    file: string;                 // workspace-relative display path
    line: number;                 // 1-based
    col: number;                  // 0-based column start
    endLine: number;              // 1-based
    endCol: number;               // 0-based column end
    message: string;              // human-readable problem description
    code: string;                 // A1 | E1 | E2 | C1 | H1
    originalText: string | null;  // line text to replace (null = no auto-fix)
    fixText: string | null;       // replacement text (null = no auto-fix)
    fixDescription: string;       // always present — describes the fix or suggestion
    risks?: string[];             // A1 only — absent = not checked, [] = safe, [...] = risks found
}
