import * as vscode from 'vscode';

const EXCLUDE = '{**/node_modules/**,**/dist/**,**/out/**}';

export interface AuditScope {
    type: 'workspace' | 'folder' | 'files';
    folderUri?: vscode.Uri;
    fileUris?: vscode.Uri[];
}

/**
 * Returns the files to scan for a given audit, respecting the active scope.
 *
 * - workspace: full `**‌/*.ext` glob across the workspace (existing behaviour)
 * - folder:    restricts glob to the chosen directory via RelativePattern
 * - files:     returns only the explicitly selected files matching the extension
 */
export async function findAuditFiles(
    extension: 'ts' | 'html',
    scope?: AuditScope,
): Promise<vscode.Uri[]> {
    if (scope?.type === 'files' && scope.fileUris?.length) {
        return scope.fileUris.filter(u => u.fsPath.endsWith('.' + extension));
    }
    const include: vscode.GlobPattern = scope?.type === 'folder' && scope.folderUri
        ? new vscode.RelativePattern(scope.folderUri, `**/*.${extension}`)
        : `**/*.${extension}`;
    return vscode.workspace.findFiles(include, EXCLUDE);
}
