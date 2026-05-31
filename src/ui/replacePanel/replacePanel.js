const vscode = acquireVsCodeApi();

// ─── Tab switching + view-state persistence ───────────────────────────────────

let currentActiveTab = 'replace';

function saveViewState() {
    vscode.setState({ tab: currentActiveTab, scrollY: window.scrollY, auditScope });
}

function switchTab(tab) {
    currentActiveTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + tab));
    saveViewState();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Restore tab + scroll after the script loads — survives sidebar hide/show cycles.
(function restoreViewState() {
    const state = vscode.getState();
    if (!state) { return; }
    if (state.tab) { switchTab(state.tab); }
    if (state.scrollY) { requestAnimationFrame(() => window.scrollTo(0, state.scrollY)); }
    if (state.auditScope) { auditScope = state.auditScope; updateScopeDisplay(); }
})();

// Persist scroll position continuously (debounced).
let _scrollSaveTimer = null;
window.addEventListener('scroll', () => {
    clearTimeout(_scrollSaveTimer);
    _scrollSaveTimer = setTimeout(saveViewState, 150);
}, { passive: true });

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
const btnCancelSearchEl      = $('btn-cancel-search');
const searchProgressTextEl   = $('search-progress-text');
const liveCountBarEl         = $('live-count-bar');
const filetypesChipsEl       = $('filetypes-chips');
const btnAnalyzeEl           = $('btn-analyze');
const btnExportEl            = $('btn-export-patterns');
const btnImportEl            = $('btn-import-patterns');
const btnSavePlannerEl       = $('btn-save-planner');
const btnUsePreviewEl        = $('btn-use-preview');
const btnPreviewEl           = $('btn-preview');
const selectAllEl            = $('select-all');
const btnReplSelEl           = $('btn-replace-sel');
const btnApplyPipelineEl     = $('btn-apply-pipeline');
const historyListEl          = $('history-list');
const btnClearHistoryEl      = $('btn-clear-history');

// ─── Planner element refs ─────────────────────────────────────────────────────

const plannerLoadingEl   = $('planner-loading');
const sampleEmptyEl      = $('sample-empty');
const plannerHintEl      = $('planner-hint');
const sampleInteractiveEl = $('sample-interactive');
const regionsListEl      = $('regions-list');
const reanalyzeBtn       = $('btn-reanalyze');
const btnClearRegions    = $('btn-clear-regions');
const markToolbarEl      = $('mark-toolbar');
const btnMarkLiteral     = $('btn-mark-literal');
const btnMarkCapture     = $('btn-mark-capture');
const btnMarkAttr        = $('btn-mark-attr');
const btnMarkSkip        = $('btn-mark-skip');
const btnMarkMust        = $('btn-mark-must');
const btnMarkOuter       = $('btn-mark-outer');
const suggestionsEl      = $('suggestions');
const noSuggestEl        = $('no-suggestions');
const sugCountBadgeEl    = $('sug-count');
const customPatternEl    = $('custom-pattern');
const customReplEl       = $('custom-replacement');
const customMatchCountEl = $('custom-match-count');
const useCustomBtn       = $('btn-use-custom');

let sampleText       = '';
let customFlags      = new Set(['g', 'i']);
let liveCountTimer   = null;
let activeSuggestions = [];

// Region marking state
let regions      = [];   // { id, start, end, type: 'literal'|'capture'|'skip'|'mustcontain' }
let nextRid      = 0;
let pendingSel   = null; // { start, end } — saved on mouseup, used by toolbar buttons
let previewType  = 'literal'; // last-used mark type, shown as preview while toolbar is open

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
            <div class="case-transforms">
              <span class="ct-lbl">Case:</span>
              <button type="button" class="ct-btn" data-mod="\\u" title="Uppercase next char">\\u</button>
              <button type="button" class="ct-btn" data-mod="\\l" title="Lowercase next char">\\l</button>
              <button type="button" class="ct-btn" data-mod="\\U" title="Start ALL UPPER block">\\U</button>
              <button type="button" class="ct-btn" data-mod="\\L" title="Start all lower block">\\L</button>
              <button type="button" class="ct-btn" data-mod="\\E" title="End case block">\\E</button>
            </div>
        </div>
    `).join('');

    // Set values and wire events (setting via .value avoids HTML-encoding issues)
    container.querySelectorAll('.step').forEach((el, i) => {
        const patEl  = el.querySelector('.step-pattern');
        const replEl = el.querySelector('.step-replacement');
        patEl.value  = steps[i].pattern;
        replEl.value = steps[i].replacement;

        patEl.addEventListener('input',  e => { steps[i].pattern     = e.target.value; if (i === 0) { scheduleLiveCount(); } });
        replEl.addEventListener('input', e => { steps[i].replacement = e.target.value; });

        el.querySelectorAll('.ct-btn').forEach(btn => {
            btn.addEventListener('mousedown', e => e.preventDefault());
            btn.addEventListener('click', () => {
                const mod = btn.dataset.mod;
                const s = replEl.selectionStart ?? replEl.value.length;
                const e2 = replEl.selectionEnd   ?? replEl.value.length;
                replEl.value = replEl.value.slice(0, s) + mod + replEl.value.slice(e2);
                steps[i].replacement = replEl.value;
                replEl.setSelectionRange(s + mod.length, s + mod.length);
                replEl.focus();
            });
        });

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
    const hideFiletypes = s === 'currentFile' || s === 'selection';
    filetypesRowEl.classList.toggle('hidden', hideFiletypes);
    filetypesChipsEl.classList.toggle('hidden', hideFiletypes);
    excludeRowEl.classList.toggle('hidden', s !== 'workspaceFolder' && s !== 'glob');
}
scopeEl.addEventListener('change', updateScopeVisibility);
updateScopeVisibility();

// ─── Buttons ──────────────────────────────────────────────────────────────────

$('btn-preview').addEventListener('click', () => dispatch('preview'));
btnCancelSearchEl.addEventListener('click', () => vscode.postMessage({ type: 'cancelPreview' }));
btnExportEl.addEventListener('click', () => vscode.postMessage({ type: 'exportPatterns' }));
btnImportEl.addEventListener('click', () => vscode.postMessage({ type: 'importPatterns' }));

btnAnalyzeEl.addEventListener('click', () => {
    plannerLoadingEl.classList.remove('hidden');
    sampleInteractiveEl.classList.add('hidden');
    plannerHintEl.classList.add('hidden');
    sampleEmptyEl.classList.add('hidden');
    vscode.postMessage({ type: 'reanalyze' });
});

btnSavePlannerEl.addEventListener('click', () => {
    const pat = customPatternEl.value.trim();
    if (!pat) { return; }
    vscode.postMessage({ type: 'savePlannerPattern', pattern: pat, flags: [...customFlags].join(''), replacement: customReplEl.value });
});

btnUsePreviewEl.addEventListener('click', () => {
    const pat = customPatternEl.value.trim();
    if (!pat) { return; }
    usePattern(pat, [...customFlags].join(''), customReplEl.value);
    dispatch('preview');
});

// ─── Live match count ─────────────────────────────────────────────────────────

function scheduleLiveCount() {
    clearTimeout(liveCountTimer);
    const pat = steps[0]?.pattern;
    if (!pat) { liveCountBarEl.textContent = ''; liveCountBarEl.className = 'live-count-bar'; return; }
    liveCountTimer = setTimeout(() => {
        vscode.postMessage({ type: 'liveMatchCount', pattern: pat, flags: [...(steps[0]?.flags ?? new Set(['g','i']))].join('') });
    }, 400);
}

// ─── File type chips ──────────────────────────────────────────────────────────

document.querySelectorAll('#filetypes-chips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
        const ext = chip.dataset.ext;
        const current = filetypesEl.value.split(',').map(e => e.trim()).filter(Boolean);
        const idx = current.indexOf(ext);
        if (idx >= 0) { current.splice(idx, 1); chip.classList.remove('active'); }
        else          { current.push(ext);       chip.classList.add('active'); }
        filetypesEl.value = current.join(', ');
    });
});

filetypesEl.addEventListener('input', () => {
    const active = new Set(filetypesEl.value.split(',').map(e => e.trim()).filter(Boolean));
    document.querySelectorAll('#filetypes-chips .chip').forEach(chip => {
        chip.classList.toggle('active', active.has(chip.dataset.ext));
    });
});
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

        searchProgressTextEl.textContent = 'Searching…';
        loadingEl.classList.remove('hidden');
        btnPreviewEl.disabled = true;
    }

    vscode.postMessage({ type, ...state });
}

function searchDone() {
    loadingEl.classList.add('hidden');
    searchProgressTextEl.textContent = 'Searching…';
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

// ─── Planner: region helpers ─────────────────────────────────────────────────

// Detects the outer delimiter pair of a string, e.g. "{{VALUE}}" → { prefix:'{{', suffix:'}}' }
function detectWrapper(text) {
    const pairs = [
        ['{{', '}}'], ['[[', ']]'],
        ['{', '}'], ['[', ']'], ['(', ')'], ['<', '>'],
        ['"', '"'], ["'", "'"], ['`', '`'],
    ];
    for (const [open, close] of pairs) {
        if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length) {
            return { prefix: open, suffix: close };
        }
    }
    return { prefix: '', suffix: '' };
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeCharClass(c) {
    return c.replace(/[\\^\]-]/g, '\\$&');
}

// Map a DOM text position (node + offset) to a character offset within container.
// Uses Range.toString() which correctly ignores HTML tags.
function textOffset(container, node, offset) {
    const r = document.createRange();
    r.setStart(container, 0);
    r.setEnd(node, offset);
    return r.toString().length;
}

// ─── Planner: mark toolbar ────────────────────────────────────────────────────

function showMarkToolbar(selRect) {
    // Replace native selection with a colored preview immediately
    window.getSelection()?.removeAllRanges();
    renderInteractiveSample({ id: '__preview__', ...pendingSel, type: previewType });

    markToolbarEl.classList.remove('hidden');
    const tw = markToolbarEl.offsetWidth || 240;
    const th = markToolbarEl.offsetHeight || 36;
    let top  = selRect.top - th - 8;
    let left = selRect.left + (selRect.width - tw) / 2;
    if (top < 4)                           { top  = selRect.bottom + 8; }
    if (left < 4)                          { left = 4; }
    if (left + tw > window.innerWidth - 4) { left = window.innerWidth - tw - 4; }
    markToolbarEl.style.top  = top  + 'px';
    markToolbarEl.style.left = left + 'px';
}

function hideMarkToolbar(skipRender = false) {
    markToolbarEl.classList.add('hidden');
    pendingSel = null;
    if (!skipRender) { renderInteractiveSample(); }
}

// Prevent button mousedown from stealing the text selection
[btnMarkLiteral, btnMarkCapture, btnMarkAttr, btnMarkSkip, btnMarkMust, btnMarkOuter].forEach(b =>
    b.addEventListener('mousedown', e => e.preventDefault())
);

btnMarkLiteral.addEventListener('click', () => applyMark('literal'));
btnMarkCapture.addEventListener('click', () => applyMark('capture'));
btnMarkAttr.addEventListener('click',    () => applyMark('captureattr'));
btnMarkSkip.addEventListener('click',    () => applyMark('skip'));
btnMarkMust.addEventListener('click',    () => applyMark('mustcontain'));
btnMarkOuter.addEventListener('click',   () => applyMark('outer'));

// Live-preview the mark color when hovering over toolbar buttons
const _markTypeOf = {
    'btn-mark-literal': 'literal',
    'btn-mark-capture': 'capture',
    'btn-mark-attr':    'captureattr',
    'btn-mark-skip':    'skip',
    'btn-mark-must':    'mustcontain',
    'btn-mark-outer':   'outer',
};
[btnMarkLiteral, btnMarkCapture, btnMarkAttr, btnMarkSkip, btnMarkMust, btnMarkOuter].forEach(btn => {
    btn.addEventListener('mouseenter', () => {
        if (!pendingSel) { return; }
        previewType = _markTypeOf[btn.id];
        renderInteractiveSample({ id: '__preview__', ...pendingSel, type: previewType });
    });
});

sampleInteractiveEl.addEventListener('mouseup', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideMarkToolbar(); return; }
    if (!sampleInteractiveEl.contains(sel.anchorNode)) { return; }

    let s = textOffset(sampleInteractiveEl, sel.anchorNode, sel.anchorOffset);
    let e = textOffset(sampleInteractiveEl, sel.focusNode,  sel.focusOffset);
    if (s > e) { [s, e] = [e, s]; }
    if (s === e) { hideMarkToolbar(); return; }

    // Clamp to valid text range (guards against clicking into region-delete buttons)
    s = Math.max(0, Math.min(s, sampleText.length));
    e = Math.max(0, Math.min(e, sampleText.length));
    if (s === e) { hideMarkToolbar(); return; }

    pendingSel = { start: s, end: e };
    showMarkToolbar(sel.getRangeAt(0).getBoundingClientRect());
});

// Hide toolbar when clicking outside
document.addEventListener('mousedown', e => {
    if (!markToolbarEl.contains(e.target) && e.target !== sampleInteractiveEl) {
        hideMarkToolbar();
    }
});

function applyMark(type) {
    if (!pendingSel) { return; }
    previewType = type; // remember for next selection
    const { start, end } = pendingSel;
    regions = regions.filter(r => r.end <= start || r.start >= end);
    regions.push({ id: nextRid++, start, end, type });
    regions.sort((a, b) => a.start - b.start);
    pendingSel = null;
    hideMarkToolbar(true); // skip render — we render below with the final region
    renderInteractiveSample();
    renderRegionsList();
    rebuildPattern();
}

// ─── Planner: rendering ───────────────────────────────────────────────────────

function renderInteractiveSample(previewRegion = null) {
    if (!sampleText) { return; }
    let displayRegions = regions;
    if (previewRegion) {
        // Overlay preview: exclude actual regions that overlap the pending selection
        displayRegions = [
            ...regions.filter(r => r.end <= previewRegion.start || r.start >= previewRegion.end),
            previewRegion,
        ];
    }
    const sorted = [...displayRegions].sort((a, b) => a.start - b.start);
    const html = [];
    let pos = 0;

    for (const r of sorted) {
        if (r.start > pos) { html.push(esc(sampleText.slice(pos, r.start))); }
        const cls = r.type === 'literal' ? 'seg-lit' : r.type === 'capture' ? 'seg-cap' : r.type === 'captureattr' ? 'seg-attr' : r.type === 'mustcontain' ? 'seg-must' : r.type === 'outer' ? 'seg-out' : 'seg-any';
        const extra = r.id === '__preview__' ? ' seg-preview' : '';
        html.push(`<span class="${cls}${extra}" data-rid="${r.id}">${esc(sampleText.slice(r.start, r.end))}</span>`);
        pos = r.end;
    }
    if (pos < sampleText.length) { html.push(esc(sampleText.slice(pos))); }
    sampleInteractiveEl.innerHTML = html.join('');
}

function renderRegionsList() {
    if (regions.length === 0) { regionsListEl.innerHTML = ''; return; }

    const sorted = [...regions].sort((a, b) => a.start - b.start);
    let capN = 0;
    regionsListEl.innerHTML = sorted.map(r => {
        const cls   = r.type === 'literal' ? 'rlit' : r.type === 'capture' ? 'rcap' : r.type === 'captureattr' ? 'rattr' : r.type === 'mustcontain' ? 'rmust' : r.type === 'outer' ? 'rout' : 'rany';
        const label = r.type === 'literal' ? 'lit' : r.type === 'capture' ? `$${++capN}` : r.type === 'captureattr' ? `"$${++capN}"` : r.type === 'mustcontain' ? 'must' : r.type === 'outer' ? `{$${++capN}}` : 'skip';
        return `<div class="region-item">` +
            `<span class="region-badge ${cls}">${label}</span>` +
            `<span class="region-text">${esc(sampleText.slice(r.start, r.end))}</span>` +
            `<button class="region-del" data-rid="${r.id}" title="Remove">&#215;</button>` +
            `</div>`;
    }).join('');

    regionsListEl.querySelectorAll('.region-del').forEach(btn => {
        btn.addEventListener('click', () => {
            regions = regions.filter(r => r.id !== Number(btn.dataset.rid));
            renderInteractiveSample();
            renderRegionsList();
            rebuildPattern();
        });
    });
}

function rebuildPattern() {
    if (regions.length === 0) {
        customPatternEl.value = '';
        customReplEl.value    = '';
        updateCustomPreview();
        return;
    }

    // Must-contain regions become lookaheads; all others are positional.
    const mustContains = regions.filter(r => r.type === 'mustcontain');
    const positional   = [...regions.filter(r => r.type !== 'mustcontain')].sort((a, b) => a.start - b.start);

    let pattern = '';
    let pos     = 0;
    let capN    = 0;
    const replParts = [];

    for (let i = 0; i < positional.length; i++) {
        const r = positional[i];

        if (i > 0 && r.start > pos) { pattern += '[\\s\\S]*?'; }  // gap between regions (never before the first)

        if (r.type === 'literal') {
            pattern += escapeRe(sampleText.slice(r.start, r.end));
        } else if (r.type === 'capture') {
            capN++;
            const next = positional[i + 1];
            if (next && next.type === 'literal' && next.start === r.end) {
                const boundary = escapeCharClass(sampleText[next.start]);
                pattern += `([^${boundary}]*)`;
            } else {
                pattern += '([\\s\\S]*?)';
            }
            replParts.push('$' + capN);
        } else if (r.type === 'captureattr') {
            capN++;
            const attrText = sampleText.slice(r.start, r.end);
            const eqIdx = attrText.search(/=["']/);
            if (eqIdx !== -1) {
                const quote = attrText[eqIdx + 1];          // " or '
                const prefix = attrText.slice(0, eqIdx + 2); // e.g. placeholder="
                const boundary = escapeCharClass(quote);
                pattern += escapeRe(prefix) + `([^${boundary}]*)` + quote;
                replParts.push(escapeRe(prefix) + '$' + capN + quote);
            } else {
                // Fallback: no attr= structure — capture non-quote content
                pattern += '([^"]*)';
                replParts.push('$' + capN);
            }
        } else if (r.type === 'outer') {
            capN++;
            const { prefix, suffix } = detectWrapper(sampleText.slice(r.start, r.end));
            pattern += escapeRe(prefix) + '([\\s\\S]*?)' + escapeRe(suffix);
            replParts.push(escapeRe(prefix) + '$' + capN + escapeRe(suffix));
        } else {
            pattern += '[\\s\\S]*?';
        }

        pos = r.end;
    }

    // Prepend a lookahead for each must-contain region.
    const lookaheads = mustContains
        .map(r => `(?=[\\s\\S]*${escapeRe(sampleText.slice(r.start, r.end))})`)
        .join('');
    pattern = lookaheads + pattern;

    // Collapse adjacent [\s\S]*? wildcards — consecutive lazy wildcards cause
    // catastrophic backtracking (O(N²) or worse).  Collapsing is always safe
    // because the quantifiers match the same content; the engine just does it
    // in linear time with a single wildcard.
    //   [\s\S]*?[\s\S]*?      → [\s\S]*?
    //   [\s\S]*?([\s\S]*?)    → ([\s\S]*?)   (outer wildcard is absorbed by capture)
    //   ([\s\S]*?)[\s\S]*?    → ([\s\S]*?)   (trailing wildcard is absorbed by capture)
    const W = '[\\s\\S]*?';
    const CW = '([\\s\\S]*?)';
    for (let pass = 0; pass < 4; pass++) {
        pattern = pattern.split(W + W).join(W)
                         .split(W + CW).join(CW)
                         .split(CW + W).join(CW);
    }

    customPatternEl.value = pattern;
    if (replParts.length && !customReplEl.value) {
        customReplEl.value = replParts.join('');
    }
    updateCustomPreview();
}

// ─── Planner: controls ────────────────────────────────────────────────────────

btnClearRegions.addEventListener('click', () => {
    regions = [];
    renderInteractiveSample();
    renderRegionsList();
    customPatternEl.value = '';
    customReplEl.value    = '';
    updateCustomPreview();
});

reanalyzeBtn.addEventListener('click', () => {
    plannerLoadingEl.classList.remove('hidden');
    sampleInteractiveEl.classList.add('hidden');
    plannerHintEl.classList.add('hidden');
    sampleEmptyEl.classList.add('hidden');
    vscode.postMessage({ type: 'reanalyze' });
});

document.querySelectorAll('#custom-flags .flag').forEach(btn => {
    const f = btn.dataset.flag;
    btn.addEventListener('click', () => {
        if (customFlags.has(f)) { customFlags.delete(f); btn.classList.remove('on'); }
        else                    { customFlags.add(f);    btn.classList.add('on'); }
        updateCustomPreview();
    });
});

customPatternEl.addEventListener('input', () => { regions = []; renderInteractiveSample(); renderRegionsList(); updateCustomPreview(); });
customReplEl.addEventListener('input', updateCustomPreview);

useCustomBtn.addEventListener('click', () => {
    const pat = customPatternEl.value.trim();
    if (!pat) { return; }
    usePattern(pat, [...customFlags].join(''), customReplEl.value);
});

function updateCustomPreview() {
    const pat = customPatternEl.value.trim();
    if (!pat || !sampleText) {
        customMatchCountEl.textContent = '';
        customMatchCountEl.className   = 'match-count';
        return;
    }
    try {
        const flags  = [...customFlags].join('');
        const gFlags = flags.includes('g') ? flags : flags + 'g';
        const count  = (sampleText.match(new RegExp(pat, gFlags)) ?? []).length;
        customMatchCountEl.textContent = count === 0 ? 'No matches' : `${count} match${count !== 1 ? 'es' : ''} in sample`;
        customMatchCountEl.className   = 'match-count ' + (count > 0 ? 'has-matches' : 'no-matches');
    } catch {
        customMatchCountEl.textContent = 'Invalid pattern';
        customMatchCountEl.className   = 'match-count no-matches';
    }
}

function renderSuggestions(sugs) {
    if (!sugs.length) {
        noSuggestEl.classList.remove('hidden');
        suggestionsEl.innerHTML = '';
        sugCountBadgeEl.classList.add('hidden');
        return;
    }
    noSuggestEl.classList.add('hidden');
    sugCountBadgeEl.classList.remove('hidden');
    sugCountBadgeEl.textContent = sugs.length + ' found';

    suggestionsEl.innerHTML = sugs.map((s, i) => `
        <div class="suggestion-card">
            <div class="sug-hdr">
                <span class="sug-label">${esc(s.label)}</span>
                <span class="sug-match-count">${s.matchCount} match${s.matchCount !== 1 ? 'es' : ''}</span>
            </div>
            <div class="sug-desc">${esc(s.description)}</div>
            <div class="sug-pattern">/${esc(s.pattern)}/<em>${esc(s.flags)}</em></div>
            ${s.replacement ? `<div class="sug-repl">&#8594; ${esc(s.replacement)}</div>` : ''}
            <div class="sug-actions">
                <button class="sec sug-load-btn" data-idx="${i}">Load pattern</button>
                <button class="sug-use-btn" data-idx="${i}">Use in Replace</button>
            </div>
        </div>`).join('');

    // "Load pattern" populates Pattern Builder so user can inspect/edit
    suggestionsEl.querySelectorAll('.sug-load-btn').forEach(btn => {
        const s = sugs[Number(btn.dataset.idx)];
        btn.addEventListener('click', () => {
            customPatternEl.value = s.pattern;
            customReplEl.value    = s.replacement || '';
            customFlags = new Set(s.flags.split(''));
            document.querySelectorAll('#custom-flags .flag').forEach(b => {
                b.classList.toggle('on', customFlags.has(b.dataset.flag));
            });
            regions = [];
            renderInteractiveSample();
            renderRegionsList();
            updateCustomPreview();
        });
    });
    suggestionsEl.querySelectorAll('.sug-use-btn').forEach(btn => {
        const s = sugs[Number(btn.dataset.idx)];
        btn.addEventListener('click', () => usePattern(s.pattern, s.flags, s.replacement));
    });
}

function usePattern(pattern, flags, replacement) {
    steps = [{ pattern, flags: new Set(flags.split('')), replacement: replacement || '' }];
    renderSteps();
    switchTab('replace');
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

        case 'searchCancelled':
            searchDone();
            break;

        case 'searchProgress':
            searchProgressTextEl.textContent = `${msg.current} / ${msg.total} files`;
            break;

        case 'liveMatchCountResult': {
            if (!msg.fileName) { liveCountBarEl.textContent = ''; liveCountBarEl.className = 'live-count-bar'; break; }
            const fname = msg.fileName.split(/[\\/]/).pop();
            if (msg.count < 0) {
                liveCountBarEl.textContent = 'Invalid pattern';
                liveCountBarEl.className = 'live-count-bar no-matches';
            } else if (msg.count === 0) {
                liveCountBarEl.textContent = `No matches in ${fname}`;
                liveCountBarEl.className = 'live-count-bar no-matches';
            } else {
                liveCountBarEl.textContent = `${msg.count} match${msg.count !== 1 ? 'es' : ''} in ${fname}`;
                liveCountBarEl.className = 'live-count-bar has-matches';
            }
            break;
        }

        case 'importDone':
            break;

        case 'configData': {
            if (msg.settings) {
                chkAutoImportEl.checked  = !!msg.settings.autoImport;
                chkMobileFirstEl.checked = !!msg.settings.convertToMobileFirst;
            }
            renderLastExtraction(msg.lastExtraction ?? null);
            break;
        }

        case 'angularTodosResult': {
            const items = msg.items ?? [];
            if (!items.length) {
                angularListEl.innerHTML = '<p class="angular-empty">No extracted components found. Use "Extract to Angular Component" to create one.</p>';
                break;
            }
            angularListEl.innerHTML = items.map(item => {
                const pct = item.total ? Math.round(item.done / item.total * 100) : 0;
                const allDone = item.done === item.total && item.total > 0;
                return '<div class="comp-item" data-path="' + esc(item.fsPath) + '">' +
                    '<div class="comp-item-hdr">' +
                    '<span class="comp-name">' + esc(item.component) + '</span>' +
                    '<span class="comp-progress' + (allDone ? ' done' : '') + '">' + item.done + '/' + item.total + '</span>' +
                    '</div>' +
                    '<div class="comp-origins">' + esc(item.originFiles.join(', ')) + '</div>' +
                    '<div class="comp-bar"><div class="comp-bar-fill" style="width:' + pct + '%"></div></div>' +
                    '</div>';
            }).join('');
            break;
        }

        case 'auditScopeSelected': {
            if (msg.scopeType === 'folder' && msg.uriString) {
                auditScope = { type: 'folder', uriString: msg.uriString, label: msg.label };
            } else if (msg.scopeType === 'files' && msg.uriStrings) {
                auditScope = { type: 'files', uriStrings: msg.uriStrings, label: msg.label };
            }
            updateScopeDisplay();
            break;
        }

        case 'auditScanStart': {
            if (msg.command) { showAuditLoading(msg.command); }
            break;
        }

        case 'auditResult': {
            renderAuditFindings(msg.command, msg.findings ?? []);
            break;
        }

        case 'auditFixApplied': {
            markFindingApplied(msg.uri, msg.findingIndex);
            break;
        }

        case 'error':
            searchDone();
            showError(msg.message);
            break;

        case 'history':
            renderHistory(msg.entries);
            break;

        case 'switchTab':
            switchTab(msg.tab);
            break;

        case 'sampleResult':
            plannerLoadingEl.classList.add('hidden');
            sampleText = msg.text ?? '';
            activeSuggestions = msg.suggestions ?? [];
            // Clear old marks whenever the sample changes
            regions = [];
            regionsListEl.innerHTML = '';
            if (sampleText) {
                sampleEmptyEl.classList.add('hidden');
                plannerHintEl.classList.remove('hidden');
                sampleInteractiveEl.classList.remove('hidden');
                renderInteractiveSample();
            } else {
                sampleInteractiveEl.classList.add('hidden');
                plannerHintEl.classList.add('hidden');
                sampleEmptyEl.classList.remove('hidden');
            }
            renderSuggestions(activeSuggestions);
            updateCustomPreview();
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

// ─── Angular tab ──────────────────────────────────────────────────────────────

const angularListEl = $('angular-list');

function loadAngularTodos() {
    angularListEl.innerHTML = '<p class="angular-empty">Scanning workspace…</p>';
    vscode.postMessage({ type: 'loadAngularTodos' });
}

document.querySelector('[data-tab="angular"]').addEventListener('click', loadAngularTodos);

// ─── Config tab ───────────────────────────────────────────────────────────────

const chkAutoImportEl   = $('chk-auto-import');
const chkMobileFirstEl  = $('chk-mobile-first');
const lastExtractionEl  = $('last-extraction-info');
const revertAreaEl      = $('revert-area');
const btnRevertEl       = $('btn-revert');

document.querySelector('[data-tab="config"]').addEventListener('click', () => {
    vscode.postMessage({ type: 'loadConfig' });
});

chkAutoImportEl.addEventListener('change', () => {
    vscode.postMessage({ type: 'setAutoImport', value: chkAutoImportEl.checked });
});

chkMobileFirstEl.addEventListener('change', () => {
    vscode.postMessage({ type: 'setConvertToMobileFirst', value: chkMobileFirstEl.checked });
});

btnRevertEl.addEventListener('click', () => {
    vscode.postMessage({ type: 'revertLastExtraction' });
});

function renderLastExtraction(le) {
    if (!le) {
        lastExtractionEl.textContent = 'No extraction recorded yet.';
        revertAreaEl.classList.add('hidden');
        return;
    }
    const date = new Date(le.timestamp).toLocaleString();
    lastExtractionEl.innerHTML =
        '<div class="last-extraction-card">' +
        '<div class="le-name">' + esc(le.componentName) + '</div>' +
        '<div class="le-meta">' + date + '</div>' +
        '<div class="le-meta">Dir: ' + esc(le.componentDir) + '</div>' +
        '<div class="le-meta">Parent: ' + esc(le.parentFilePath) + '</div>' +
        '</div>';
    revertAreaEl.classList.remove('hidden');
}
$('btn-refresh-angular').addEventListener('click', loadAngularTodos);

angularListEl.addEventListener('click', e => {
    const item = e.target.closest('.comp-item');
    if (item) { vscode.postMessage({ type: 'openTodoReview', fsPath: item.dataset.path }); }
});

// ─── Audit tab — scope selector ───────────────────────────────────────────────

// { type: 'workspace' | 'folder' | 'files', uriString?, uriStrings?, label? }
let auditScope = { type: 'workspace' };

function updateScopeDisplay() {
    const isWorkspace = auditScope.type === 'workspace';
    $('btn-scope-workspace').classList.toggle('active', isWorkspace);
    $('btn-scope-folder').classList.toggle('active', auditScope.type === 'folder');
    $('btn-scope-files').classList.toggle('active', auditScope.type === 'files');
    const display = $('audit-scope-display');
    if (isWorkspace) {
        display.classList.add('hidden');
    } else {
        display.classList.remove('hidden');
        $('audit-scope-path').textContent = auditScope.label || auditScope.uriString || '';
    }
    saveViewState(); // persist scope alongside tab + scroll
}

$('btn-scope-workspace').addEventListener('click', () => {
    auditScope = { type: 'workspace' };
    updateScopeDisplay();
});

$('btn-scope-folder').addEventListener('click', () => {
    vscode.postMessage({ type: 'selectAuditFolder' });
});

$('btn-scope-files').addEventListener('click', () => {
    vscode.postMessage({ type: 'selectAuditFiles' });
});

$('btn-scope-clear').addEventListener('click', () => {
    auditScope = { type: 'workspace' };
    updateScopeDisplay();
});

// ─── Audit tab ────────────────────────────────────────────────────────────────

const AUDIT_COMMANDS = [
    'dpa-rex-refacror.detectDefaultChangeDetection',
    'dpa-rex-refacror.detectManualChangeDetection',
    'dpa-rex-refacror.detectShareReplayLeak',
    'dpa-rex-refacror.detectNestedSwitchMap',
    'dpa-rex-refacror.detectNestedSubscriptions',
    'dpa-rex-refacror.detectListTracking',
    'dpa-rex-refacror.detectTemplateFunctionCalls',
    'dpa-rex-refacror.detectRepeatedExpressions',
    'dpa-rex-refacror.detectLargeRenderedLists',
    'dpa-rex-refacror.detectHttpInEffect',
    'dpa-rex-refacror.detectUnsafeToSignal',
    'dpa-rex-refacror.detectHeavyImports',
    'dpa-rex-refacror.detectEagerlyLoadedRoutes',
    'dpa-rex-refacror.detectUnmanagedSubscriptions',
    'dpa-rex-refacror.detectUnmanagedTimersAndListeners',
    'dpa-rex-refacror.detectUnoptimizedImages',
];

/** Returns the results div for a given command, or null. */
function getAuditResultsDiv(cmd) {
    return document.querySelector('.audit-results[data-cmd="' + cmd + '"]');
}

/** Show a loading spinner inside the results div for a command. */
function showAuditLoading(cmd) {
    const div = getAuditResultsDiv(cmd);
    if (!div) { return; }
    div.classList.remove('hidden');
    div.innerHTML = '<div class="audit-loading"><span class="spinner"></span> Scanning…</div>';
}

/** Render the findings array into the results div for a command. */
function renderAuditFindings(cmd, findings) {
    const div = getAuditResultsDiv(cmd);
    if (!div) { return; }
    div.classList.remove('hidden');
    div.classList.remove('collapsed'); // always expand on fresh results

    const count = findings ? findings.length : 0;

    // ── header row (always rendered, click toggles body) ──────────────────
    const countHtml = count === 0
        ? '<span class="audit-ok-inline">&#10003;&nbsp;No issues</span>'
        : count + ' issue' + (count !== 1 ? 's' : '');

    // ── body content ───────────────────────────────────────────────────────
    const bodyHtml = count === 0
        ? '<p class="audit-ok">No issues found.</p>'
        : findings.map((f, idx) => {
            const locText = esc(f.file) + ':' + f.line;
            const hasFix = f.originalText !== null && f.fixText !== null;

            const diffHtml = hasFix
                ? '<div class="finding-diff">' +
                  '<div class="diff-del">- ' + esc(f.originalText) + '</div>' +
                  '<div class="diff-add">+ ' + esc(f.fixText) + '</div>' +
                  '</div>'
                : '';

            const actionsHtml = hasFix
                ? '<div class="finding-actions">' +
                  '<button class="finding-apply"' +
                  ' data-uri="' + esc(f.uri) + '"' +
                  ' data-start-line="' + f.line + '"' +
                  ' data-start-col="' + f.col + '"' +
                  ' data-end-line="' + f.endLine + '"' +
                  ' data-end-col="' + f.endCol + '"' +
                  ' data-fix-text="' + esc(f.fixText) + '"' +
                  ' data-index="' + idx + '"' +
                  '>Apply Fix</button>' +
                  '</div>'
                : '';

            const suggestionHtml = f.fixDescription
                ? '<div class="finding-suggestion">Suggestion: ' + esc(f.fixDescription) + '</div>'
                : '';

            return '<div class="audit-finding" data-index="' + idx + '">' +
                '<div class="finding-hdr">' +
                '<a class="finding-loc" style="cursor:pointer"' +
                ' data-uri="' + esc(f.uri) + '"' +
                ' data-line="' + f.line + '"' +
                '>' + locText + '</a>' +
                '<span class="finding-code">' + esc(f.code) + '</span>' +
                '</div>' +
                '<div class="finding-msg">' + esc(f.message) + '</div>' +
                diffHtml + actionsHtml + suggestionHtml +
                '</div>';
        }).join('');

    div.innerHTML =
        '<div class="audit-results-hdr">' +
        '<span class="audit-results-chevron">&#9660;</span>' +
        '<span class="audit-results-count">' + countHtml + '</span>' +
        '</div>' +
        '<div class="audit-results-body">' + bodyHtml + '</div>';

    div.querySelector('.audit-results-hdr').addEventListener('click', () => {
        div.classList.toggle('collapsed');
    });

    // Attach click handlers for location links
    div.querySelectorAll('.finding-loc').forEach(link => {
        link.addEventListener('click', e => {
            e.preventDefault();
            vscode.postMessage({
                type: 'openFile',
                uri: link.dataset.uri,
                line: Number(link.dataset.line),
            });
        });
    });

    // Attach click handlers for Apply Fix buttons
    div.querySelectorAll('.finding-apply').forEach(btn => {
        btn.addEventListener('click', () => {
            vscode.postMessage({
                type: 'applyAuditFix',
                uri: btn.dataset.uri,
                startLine: Number(btn.dataset.startLine),
                startCol: Number(btn.dataset.startCol),
                endLine: Number(btn.dataset.endLine),
                endCol: Number(btn.dataset.endCol),
                fixText: btn.dataset.fixText,
                findingIndex: Number(btn.dataset.index),
            });
        });
    });
}

/** Grey out a finding after its fix has been applied. */
function markFindingApplied(uri, findingIndex) {
    // Search all results divs for the finding with matching index
    document.querySelectorAll('.audit-results').forEach(resultsDiv => {
        const finding = resultsDiv.querySelector('.audit-finding[data-index="' + findingIndex + '"]');
        if (!finding) { return; }
        // Verify the uri matches by checking the location link
        const loc = finding.querySelector('.finding-loc');
        if (loc && loc.dataset.uri === uri) {
            finding.classList.add('finding-applied');
            const applyBtn = finding.querySelector('.finding-apply');
            if (applyBtn) { applyBtn.disabled = true; }
        }
    });
}

document.querySelectorAll('.audit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        if (cmd) {
            showAuditLoading(cmd);
            vscode.postMessage({ type: 'runAudit', command: cmd, auditScopeData: auditScope });
        }
    });
});

$('btn-audit-all').addEventListener('click', () => {
    AUDIT_COMMANDS.forEach(cmd => showAuditLoading(cmd));
    vscode.postMessage({ type: 'runAuditAll', commands: AUDIT_COMMANDS, auditScopeData: auditScope });
});
