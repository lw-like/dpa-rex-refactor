const vscode = acquireVsCodeApi();

// ─── State ────────────────────────────────────────────────────────────────────

// Each step: { pattern: string, flags: Set<string>, replacement: string }
let steps = [{ pattern: '', flags: new Set(['g', 'i']), replacement: '' }];

let allMatches    = [];
let checkedSet    = new Set();
let lastPattern     = '';
let lastFlags       = '';
let lastReplacement = '';
let focusedMatch = null;
let focusedTr    = null;
let singleApplyPending = false;

const FLAG_TITLES = {
    g: 'Global (replace all occurrences)',
    i: 'Case-insensitive',
    m: 'Multiline (^ and $ match line boundaries)',
    s: 'Dot-all (. matches newlines)',
};

// ─── Element refs ─────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const scopeEl          = $('scope');
const globRowEl        = $('glob-row');
const globEl           = $('glob');
const filetypesRowEl   = $('filetypes-row');
const filetypesEl      = $('filetypes');
const excludeRowEl     = $('exclude-row');
const excludeEl        = $('exclude');
const errorEl          = $('error');
const applyOkEl        = $('apply-ok');
const resultsEl        = $('results');
const summaryEl        = $('summary');
const diffContainerEl  = $('diff-container');
const matchTableWrapEl = $('match-table-wrap');
const rowsEl           = $('rows');
const detailEl               = $('detail');
const detailHdrEl            = $('detail-hdr-text');
const btnApplySingleEl       = $('btn-apply-single');
const detailMatchEl          = $('detail-match');
const detailReplEl           = $('detail-repl');
const detailReplPatEl        = $('detail-repl-pattern');
const ctxViewEl              = $('ctx-view');
const ctxBlockEl             = $('ctx-block');
const replPatBlockEl         = $('repl-pattern-block');
const groupsLegendEl         = $('groups-legend');
const ctxLinesEl             = $('ctx-lines');
const loadingEl              = $('loading');
const btnPreviewEl           = $('btn-preview');
const selectAllEl            = $('select-all');
const btnReplSelEl           = $('btn-replace-sel');
const btnApplyPipelineEl     = $('btn-apply-pipeline');
const historyListEl          = $('history-list');
const btnClearHistoryEl      = $('btn-clear-history');

// ─── Compact layout ───────────────────────────────────────────────────────────

const _ro = new ResizeObserver(entries => {
    const w = entries[0]?.contentRect.width ?? document.body.offsetWidth;
    document.body.classList.toggle('compact', w < 360);
});
_ro.observe(document.body);

// ─── Collapsible cards ────────────────────────────────────────────────────────

document.querySelectorAll('[data-collapse-key]').forEach(card => {
    const key = 'rvsc.collapse.' + card.dataset.collapseKey;
    if (localStorage.getItem(key) === '1') { card.classList.add('collapsed'); }
    card.querySelector('.card-hdr').addEventListener('click', e => {
        if (e.target.closest('button') || e.target.tagName === 'INPUT') { return; }
        card.classList.toggle('collapsed');
        localStorage.setItem(key, card.classList.contains('collapsed') ? '1' : '0');
    });
});

// ─── Step management ──────────────────────────────────────────────────────────

function renderSteps() {
    const container = $('steps-container');
    const isMulti = steps.length > 1;

    container.innerHTML = steps.map((s, i) => `
        <div class="step${isMulti ? ' step-multi' : ''}" data-step="${i}">
            ${isMulti ? `
            <div class="step-hdr">
                <span class="step-num">Step ${i + 1}</span>
                <div class="step-ctrl">
                    ${i > 0 ? `<button class="step-up" title="Move up">&#8593;</button>` : ''}
                    ${i < steps.length - 1 ? `<button class="step-dn" title="Move down">&#8595;</button>` : ''}
                    <button class="step-del" title="Remove step">&#215;</button>
                </div>
            </div>` : ''}
            <div class="field">
                <label>Regex</label>
                <input type="text" class="step-pattern" placeholder="e.g. console\\.log\\((.*?)\\)" spellcheck="false" autocomplete="off"/>
                <div class="flags">
                    ${['g','i','m','s'].map(f =>
                        `<div class="flag${s.flags.has(f) ? ' on' : ''}" data-flag="${f}" title="${FLAG_TITLES[f]}">${f}</div>`
                    ).join('')}
                </div>
            </div>
            <div class="field">
                <label>Replacement</label>
                <input type="text" class="step-replacement" placeholder="e.g. logger.debug($1)" spellcheck="false" autocomplete="off"/>
            </div>
        </div>
    `).join('');

    // Set values and wire events (setting via .value avoids HTML-encoding issues)
    container.querySelectorAll('.step').forEach((el, i) => {
        const patEl  = el.querySelector('.step-pattern');
        const replEl = el.querySelector('.step-replacement');
        patEl.value  = steps[i].pattern;
        replEl.value = steps[i].replacement;

        patEl.addEventListener('input',  e => { steps[i].pattern     = e.target.value; });
        replEl.addEventListener('input', e => { steps[i].replacement = e.target.value; });

        el.querySelectorAll('.flag').forEach(f => {
            f.addEventListener('click', () => {
                const flag = f.dataset.flag;
                if (steps[i].flags.has(flag)) { steps[i].flags.delete(flag); f.classList.remove('on'); }
                else                          { steps[i].flags.add(flag);    f.classList.add('on'); }
            });
        });

        if (isMulti) {
            el.querySelector('.step-up')?.addEventListener('click', () => moveStep(i, -1));
            el.querySelector('.step-dn')?.addEventListener('click', () => moveStep(i, 1));
            el.querySelector('.step-del').addEventListener('click', () => removeStep(i));
        }
    });
}

function addStep() {
    steps.push({ pattern: '', flags: new Set(['g', 'i']), replacement: '' });
    renderSteps();
    $('steps-container').querySelector(`.step[data-step="${steps.length - 1}"] .step-pattern`)?.focus();
}

function removeStep(i) {
    if (steps.length <= 1) { return; }
    steps.splice(i, 1);
    renderSteps();
}

function moveStep(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) { return; }
    [steps[i], steps[j]] = [steps[j], steps[i]];
    renderSteps();
}

// Initial render
renderSteps();

// ─── Scope visibility ─────────────────────────────────────────────────────────

function updateScopeVisibility() {
    const s = scopeEl.value;
    globRowEl.classList.toggle('hidden', s !== 'glob');
    filetypesRowEl.classList.toggle('hidden', s === 'currentFile' || s === 'selection');
    excludeRowEl.classList.toggle('hidden', s !== 'workspaceFolder' && s !== 'glob');
}
scopeEl.addEventListener('change', updateScopeVisibility);
updateScopeVisibility();

// ─── Buttons ──────────────────────────────────────────────────────────────────

$('btn-preview').addEventListener('click', () => dispatch('preview'));
$('btn-apply').addEventListener('click',   () => dispatch('apply'));
$('btn-add-step').addEventListener('click', addStep);

$('btn-save-pattern').addEventListener('click', () => {
    vscode.postMessage({ type: 'savePattern', ...currentState() });
});
$('btn-load-pattern').addEventListener('click', () => {
    vscode.postMessage({ type: 'loadPattern' });
});
$('btn-delete-pattern').addEventListener('click', () => {
    vscode.postMessage({ type: 'deletePattern' });
});

btnReplSelEl.addEventListener('click', () => {
    const selected = Array.from(checkedSet).map(i => allMatches[i]);
    if (!selected.length) { return; }
    vscode.postMessage({ type: 'applySelected', matches: selected, ...currentState() });
});

btnApplyPipelineEl.addEventListener('click', () => dispatch('apply'));

// ─── State helpers ────────────────────────────────────────────────────────────

function currentState() {
    return {
        steps:          steps.map(s => ({ pattern: s.pattern, flags: [...s.flags].join(''), replacement: s.replacement })),
        // step-0 compat fields (used by applySelected and single-step):
        pattern:        steps[0]?.pattern ?? '',
        flags:          [...(steps[0]?.flags ?? new Set(['g','i']))].join(''),
        replacement:    steps[0]?.replacement ?? '',
        scope:          scopeEl.value,
        glob:           globEl.value,
        fileTypes:      filetypesEl.value,
        excludePattern: excludeEl.value,
        contextLines:   Number(ctxLinesEl.value),
    };
}

function isMultiStep() { return steps.length > 1; }

function dispatch(type) {
    clearStatus();
    const state = currentState();
    lastPattern     = state.pattern;
    lastFlags       = state.flags;
    lastReplacement = state.replacement;
    const multi = isMultiStep();

    if (type === 'preview') {
        resultsEl.classList.add('show');
        detailEl.classList.remove('show');
        rowsEl.innerHTML = '';
        summaryEl.textContent = '';
        diffContainerEl.innerHTML = '';
        allMatches = [];
        checkedSet.clear();
        selectAllEl.checked = false;
        selectAllEl.indeterminate = false;
        updateSelBtn();

        matchTableWrapEl.classList.toggle('hidden', multi);
        diffContainerEl.classList.toggle('hidden', !multi);
        btnApplyPipelineEl.classList.add('hidden');
        btnReplSelEl.classList.add('hidden');

        loadingEl.classList.remove('hidden');
        btnPreviewEl.disabled = true;
    }

    vscode.postMessage({ type, ...state });
}

function searchDone() {
    loadingEl.classList.add('hidden');
    btnPreviewEl.disabled = false;
}

function clearStatus() {
    errorEl.textContent = '';
    errorEl.classList.remove('show');
    applyOkEl.classList.remove('show');
}

function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add('show');
}

// ─── Selection helpers ────────────────────────────────────────────────────────

function updateSelBtn() {
    const n = checkedSet.size;
    btnReplSelEl.textContent = 'Replace selected (' + n + ')';
    btnReplSelEl.classList.toggle('hidden', n === 0);
    const total = allMatches.length;
    selectAllEl.indeterminate = n > 0 && n < total;
    selectAllEl.checked = total > 0 && n === total;
}

function setChecked(tr, idx, checked) {
    tr.classList.toggle('checked', checked);
    tr.querySelector('input[type="checkbox"]').checked = checked;
    if (checked) { checkedSet.add(idx); } else { checkedSet.delete(idx); }
}

selectAllEl.addEventListener('change', () => {
    const check = selectAllEl.checked;
    rowsEl.querySelectorAll('tr[data-idx]').forEach(tr => {
        setChecked(tr, Number(tr.dataset.idx), check);
    });
    updateSelBtn();
});

function removeMatchRow(tr) {
    const idx = Number(tr.dataset.idx);
    checkedSet.delete(idx);
    let prev = tr.previousElementSibling;
    while (prev && !prev.classList.contains('file-group')) { prev = prev.previousElementSibling; }
    const groupHdr = prev;
    tr.remove();
    if (groupHdr) {
        let sibling = groupHdr.nextElementSibling;
        let hasRows = false;
        while (sibling && !sibling.classList.contains('file-group')) {
            if (sibling.dataset.idx !== undefined) { hasRows = true; break; }
            sibling = sibling.nextElementSibling;
        }
        if (!hasRows) { groupHdr.remove(); }
    }
    updateSelBtn();
}

// ─── Single-step detail view ──────────────────────────────────────────────────

btnApplySingleEl.addEventListener('click', () => {
    if (!focusedMatch || !focusedTr) { return; }
    const m = focusedMatch, tr = focusedTr;
    focusedMatch = null; focusedTr = null;
    detailEl.classList.remove('show');
    removeMatchRow(tr);
    singleApplyPending = true;
    vscode.postMessage({ type: 'applySelected', matches: [m], ...currentState() });
});

function selectRow(tr, m) {
    const prev = rowsEl.querySelector('tr.focused');
    if (prev) { prev.classList.remove('focused'); }
    if (prev === tr) { focusedMatch = null; focusedTr = null; detailEl.classList.remove('show'); return; }
    tr.classList.add('focused');
    focusedMatch = m;
    focusedTr    = tr;

    detailHdrEl.textContent = m.file + '   line ' + m.line + ', col ' + m.column;

    const allCtx = [...(m.contextBefore || []), m.contextLine, ...(m.contextAfter || [])];
    if (allCtx.length > 0) {
        const pad = String(allCtx[allCtx.length - 1].lineNumber).length;
        ctxViewEl.innerHTML = allCtx.map(cl => {
            const isMatch = cl.lineNumber === m.line;
            const lnStr = String(cl.lineNumber).padStart(pad, ' ');
            let textHtml;
            if (isMatch && cl.matchStart !== undefined) {
                textHtml = esc(cl.text.slice(0, cl.matchStart)) +
                           '<mark class="ctx-hi">' + esc(cl.text.slice(cl.matchStart, cl.matchEnd)) + '</mark>' +
                           esc(cl.text.slice(cl.matchEnd));
            } else {
                textHtml = esc(cl.text);
            }
            return '<div class="ctx-line' + (isMatch ? ' ctx-match-line' : '') + '">' +
                   '<span class="ctx-ln' + (isMatch ? ' ctx-arr' : '') + '">' + (isMatch ? '&#8594;' : '') + lnStr + '</span>' +
                   '<span class="ctx-text">' + textHtml + '</span>' +
                   '</div>';
        }).join('');
        ctxBlockEl.style.display = '';
    } else {
        ctxBlockEl.style.display = 'none';
    }

    detailMatchEl.innerHTML = renderMatchGroups(m.matchText, lastPattern, lastFlags, m.groups || []);

    const replPat = lastReplacement;
    if (replPat && (m.groups || []).length > 0) {
        detailReplPatEl.innerHTML = renderReplPattern(replPat);
        replPatBlockEl.style.display = '';
    } else {
        replPatBlockEl.style.display = 'none';
    }
    detailReplEl.textContent = m.replacedText;

    const groups = m.groups || [];
    if (groups.length > 0) {
        groupsLegendEl.innerHTML = groups.map((val, i) =>
            '<span class="grp-badge">' +
            '<span class="grp-token g' + (i+1) + '">' + esc('$' + (i+1)) + '</span>' +
            '<span class="grp-val">' + esc(val === undefined ? '(no match)' : val) + '</span>' +
            '</span>'
        ).join('');
    } else {
        groupsLegendEl.innerHTML = '';
    }
    detailEl.classList.add('show');
}

function renderMatchGroups(matchText, pattern, flags, groups) {
    if (!groups.length || !pattern) { return esc(matchText); }
    try {
        const re = new RegExp(pattern, flags.replace(/[gd]/g, '') + 'd');
        const m = re.exec(matchText);
        if (!m || !m.indices) { return esc(matchText); }
        const ranges = m.indices.slice(1)
            .map((r, i) => r ? { start: r[0], end: r[1], g: i + 1 } : null)
            .filter(Boolean)
            .sort((a, b) => a.start - b.start);
        let html = '', pos = 0;
        for (const { start, end, g } of ranges) {
            if (start > pos) { html += esc(matchText.slice(pos, start)); }
            html += '<mark class="grp g' + g + '">' + esc(matchText.slice(start, end)) + '</mark>';
            pos = end;
        }
        if (pos < matchText.length) { html += esc(matchText.slice(pos)); }
        return html;
    } catch { return esc(matchText); }
}

function renderReplPattern(pattern) {
    let html = '', pos = 0;
    const re = /\\[uUlLE]|\$(\d+|\$|&)/g;
    let m;
    while ((m = re.exec(pattern)) !== null) {
        if (m.index > pos) { html += esc(pattern.slice(pos, m.index)); }
        if (m[0][0] === '\\') {
            html += '<mark class="grp case-mod">' + esc(m[0]) + '</mark>';
        } else {
            const n = parseInt(m[1], 10);
            const cls = !isNaN(n) ? ' g' + n : '';
            html += '<mark class="grp' + cls + '">' + esc(m[0]) + '</mark>';
        }
        pos = m.index + m[0].length;
    }
    html += esc(pattern.slice(pos));
    return html;
}

function esc(s) {
    return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Messages from extension ──────────────────────────────────────────────────

window.addEventListener('message', ({ data: msg }) => {
    switch (msg.type) {

        case 'loadPatternResult': {
            const p = msg.pattern;
            if (Array.isArray(p.steps) && p.steps.length > 0) {
                steps = p.steps.map(s => ({ pattern: s.pattern, flags: new Set(s.flags.split('')), replacement: s.replacement }));
            } else {
                steps = [{ pattern: p.pattern || '', flags: new Set((p.flags || 'gi').split('')), replacement: p.replacement || '' }];
            }
            scopeEl.value   = p.scope;
            globEl.value    = p.glob || '**/*.ts';
            filetypesEl.value   = p.fileTypes || '';
            excludeEl.value     = p.excludePattern || '';
            renderSteps();
            updateScopeVisibility();
            break;
        }

        case 'previewResult': {
            searchDone();
            clearStatus();
            resultsEl.classList.add('show');
            detailEl.classList.remove('show');
            allMatches = msg.matches;
            checkedSet.clear();
            selectAllEl.checked = false;
            selectAllEl.indeterminate = false;
            updateSelBtn();

            matchTableWrapEl.classList.remove('hidden');
            diffContainerEl.classList.add('hidden');
            btnApplyPipelineEl.classList.add('hidden');

            const { matches, totalFiles, totalMatches } = msg;
            summaryEl.textContent = totalMatches + ' match' + (totalMatches !== 1 ? 'es' : '') +
                                    ' across ' + totalFiles + ' file' + (totalFiles !== 1 ? 's' : '') + '.';
            rowsEl.innerHTML = '';
            if (matches.length === 0) {
                const tr = document.createElement('tr');
                tr.innerHTML = '<td colspan="3" style="color:var(--vscode-descriptionForeground);font-style:italic">No matches found.</td>';
                rowsEl.appendChild(tr);
                break;
            }

            const shown = matches.slice(0, 500);
            const fileGroups = new Map();
            shown.forEach((m, i) => {
                if (!fileGroups.has(m.file)) { fileGroups.set(m.file, []); }
                fileGroups.get(m.file).push({ m, i });
            });

            for (const [file, entries] of fileGroups) {
                const matchTrs = [];
                const groupTr = document.createElement('tr');
                groupTr.className = 'file-group';
                groupTr.innerHTML = '<td colspan="3">' +
                    '<span class="grp-toggle">&#9660;</span>' + esc(file) +
                    '<span class="grp-count">' + entries.length + ' match' + (entries.length !== 1 ? 'es' : '') + '</span>' +
                    '</td>';
                rowsEl.appendChild(groupTr);

                let open = true;
                groupTr.addEventListener('click', () => {
                    open = !open;
                    groupTr.querySelector('.grp-toggle').innerHTML = open ? '&#9660;' : '&#9654;';
                    matchTrs.forEach(r => { r.style.display = open ? '' : 'none'; });
                });

                entries.forEach(({ m, i }) => {
                    const tr = document.createElement('tr');
                    tr.dataset.idx = String(i);
                    tr.innerHTML =
                        '<td class="cb-cell"><input type="checkbox"/></td>' +
                        '<td style="width:56px">' + m.line + ':' + m.column + '</td>' +
                        '<td><button class="open-match-btn" title="Open file at this line">&#8599;</button>' +
                        '<span class="old">' + esc(m.matchText) + '</span>' +
                        '<span class="arr">&#8594;</span>' +
                        '<span class="new">' + esc(m.replacedText) + '</span></td>';
                    const cb = tr.querySelector('input[type="checkbox"]');
                    cb.addEventListener('click', (e) => {
                        e.stopPropagation();
                        setChecked(tr, i, cb.checked);
                        updateSelBtn();
                    });
                    tr.querySelector('.open-match-btn').addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'openFile', uri: m.uri, line: m.line, column: m.column });
                    });
                    tr.addEventListener('click', () => selectRow(tr, m));
                    rowsEl.appendChild(tr);
                    matchTrs.push(tr);
                });
            }

            if (matches.length > 500) {
                const tr = document.createElement('tr');
                tr.innerHTML = '<td colspan="3" style="color:var(--vscode-descriptionForeground);font-style:italic">' +
                               '&#8230; ' + (matches.length - 500) + ' more not shown</td>';
                rowsEl.appendChild(tr);
            }
            break;
        }

        case 'pipelinePreviewResult': {
            searchDone();
            clearStatus();
            resultsEl.classList.add('show');

            matchTableWrapEl.classList.add('hidden');
            diffContainerEl.classList.remove('hidden');

            const { totalFiles, fileDiffs } = msg;

            if (totalFiles === 0) {
                summaryEl.textContent = 'No files would change.';
                diffContainerEl.innerHTML = '';
                btnApplyPipelineEl.classList.add('hidden');
                break;
            }

            // Compute per-step totals
            const nSteps = fileDiffs[0]?.stepCounts?.length ?? 0;
            const stepTotals = Array.from({ length: nSteps }, (_, s) =>
                fileDiffs.reduce((sum, f) => sum + (f.stepCounts[s] || 0), 0)
            );
            const stepSummary = stepTotals.map((c, i) => `step ${i + 1}: ${c}`).join(', ');
            summaryEl.textContent = `${totalFiles} file${totalFiles !== 1 ? 's' : ''} will change — ${stepSummary}`;
            btnApplyPipelineEl.classList.remove('hidden');

            diffContainerEl.innerHTML = fileDiffs.map(fd => {
                const total = fd.stepCounts.reduce((a, b) => a + b, 0);
                const detail = fd.stepCounts.map((c, i) => `step ${i + 1}: ${c}`).join(', ');
                const hunksHtml = fd.hunks.map(hunk =>
                    '<div class="diff-hunk">' +
                    hunk.lines.map(l =>
                        `<div class="diff-line diff-${l.type}">` +
                        `<span class="diff-ln">${l.lineNum}</span>` +
                        `<span class="diff-pfx">${l.type === 'del' ? '-' : l.type === 'add' ? '+' : ' '}</span>` +
                        `<span class="diff-text">${esc(l.text)}</span>` +
                        '</div>'
                    ).join('') +
                    '</div>'
                ).join('<div class="diff-sep">&#8230;</div>');

                return `<div class="diff-file">` +
                    `<div class="diff-file-hdr">` +
                    `<span class="grp-toggle">&#9660;</span>` +
                    esc(fd.file) +
                    `<span class="grp-count">${total} replacement${total !== 1 ? 's' : ''} (${esc(detail)})</span>` +
                    `</div>` +
                    `<div class="diff-body">${hunksHtml}</div>` +
                    `</div>`;
            }).join('');

            // Wire collapsible file blocks
            diffContainerEl.querySelectorAll('.diff-file-hdr').forEach(hdr => {
                const body = hdr.nextElementSibling;
                let open = true;
                hdr.addEventListener('click', () => {
                    open = !open;
                    hdr.querySelector('.grp-toggle').innerHTML = open ? '&#9660;' : '&#9654;';
                    body.style.display = open ? '' : 'none';
                });
            });
            break;
        }

        case 'applyResult': {
            if (singleApplyPending) { singleApplyPending = false; break; }
            clearStatus();
            resultsEl.classList.remove('show');
            const { replacements, filesModified } = msg;
            applyOkEl.textContent = 'Done — ' + replacements + ' replacement' + (replacements !== 1 ? 's' : '') +
                                    ' in ' + filesModified + ' file' + (filesModified !== 1 ? 's' : '') + '.';
            applyOkEl.classList.add('show');
            break;
        }

        case 'error':
            searchDone();
            showError(msg.message);
            break;

        case 'history':
            renderHistory(msg.entries);
            break;
    }
});

// ─── History ──────────────────────────────────────────────────────────────────

function timeAgo(iso) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) { return 'just now'; }
    const m = Math.floor(s / 60);
    if (m < 60) { return m + 'm ago'; }
    const h = Math.floor(m / 60);
    if (h < 24) { return h + 'h ago'; }
    return Math.floor(h / 24) + 'd ago';
}

function renderHistory(entries) {
    btnClearHistoryEl.classList.toggle('hidden', entries.length === 0);
    if (entries.length === 0) {
        historyListEl.innerHTML = '<p class="hist-empty">No history yet.</p>';
        return;
    }

    historyListEl.innerHTML = entries.map((e, i) => {
        const isMulti = Array.isArray(e.steps) && e.steps.length > 1;
        const patternHtml = isMulti
            ? `<span class="hist-pipeline-badge">${e.steps.length} steps</span>`
            : `<span class="old hist-code">${esc(e.pattern)}</span>` +
              `<span class="arr">&#8594;</span>` +
              `<span class="new hist-code">${esc(e.replacement || '(empty)')}</span>`;
        return `<div class="hist-entry">` +
            `<div class="hist-meta">` +
            `<span class="hist-time">${timeAgo(e.timestamp)}</span>` +
            `<span class="hist-stat">${e.replacements} replacement${e.replacements !== 1 ? 's' : ''} in ${e.filesModified} file${e.filesModified !== 1 ? 's' : ''}</span>` +
            `</div>` +
            `<div class="hist-pattern">${patternHtml}</div>` +
            `<div class="hist-sub">` +
            `<span class="hist-scope">${esc(e.scope)}${e.glob ? ': ' + esc(e.glob) : ''}</span>` +
            `<span class="hist-flags">${esc(e.flags)}</span>` +
            `</div>` +
            `<div class="hist-actions">` +
            `<button class="sec hist-load-btn" data-idx="${i}">Load</button>` +
            (e.files && e.files.length > 0
                ? `<button class="sec hist-open-btn" data-idx="${i}">Open file${e.files.length > 1 ? 's…' : ''}</button>`
                : '') +
            (e.changes && e.changes.length > 0
                ? `<button class="danger hist-revert-btn" data-idx="${i}">Revert</button>`
                : '') +
            `</div>` +
            `</div>`;
    }).join('');

    historyListEl.querySelectorAll('.hist-load-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const e = entries[Number(btn.dataset.idx)];
            if (Array.isArray(e.steps) && e.steps.length > 0) {
                steps = e.steps.map(s => ({ pattern: s.pattern, flags: new Set(s.flags.split('')), replacement: s.replacement }));
            } else {
                steps = [{ pattern: e.pattern, flags: new Set((e.flags || 'gi').split('')), replacement: e.replacement }];
            }
            scopeEl.value       = e.scope;
            globEl.value        = e.glob || '**/*.ts';
            filetypesEl.value   = e.fileTypes || '';
            excludeEl.value     = e.excludePattern || '';
            renderSteps();
            updateScopeVisibility();
        });
    });

    historyListEl.querySelectorAll('.hist-open-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'openHistoryFiles', uriList: entries[Number(btn.dataset.idx)].files });
        });
    });

    historyListEl.querySelectorAll('.hist-revert-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'revertHistory', index: Number(btn.dataset.idx) });
        });
    });
}

btnClearHistoryEl.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearHistory' });
});

vscode.postMessage({ type: 'loadPatterns' });
