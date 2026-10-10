/* 원고지 writing pad for 가나 연습장 (browser only): one kana per square cell, for word / sentence writing.
 *
 *   const gp = GridPad.create(host, { cells, penOnly, onChange, label, guideText, mode, autoAdvance,
 *                                     onCellClick, pressure })
 *     cells        [{ ch, kind: 'write'|'space' }] — KanaText.cells(text); a plain string is split per code point
 *     guideText    string|null — faint model glyphs per cell for 보고 쓰기; when its length differs from the
 *                  cells, each cell's own ch is shown
 *     mode         'auto' (default: 'single' on a narrow phone when the cells don't fit one comfortable row) |
 *                  'grid' | 'single'; the built-in 모든 칸 / 한 칸씩 switch toggles it anywhere
 *     autoAdvance  single mode: move to the next cell shortly after the last stroke (default false)
 *     onCellClick  fn(i) — while disabled (after grading) the cells become buttons that call it
 *     penZone      the writing block: a pen over it pins the page (default: the host's parent — the 원고지 with its
 *                  tools and buttons; DrawPad.Ink.nearZone, css html.pad-pen-near); null for none
 *     fitScreen    single mode: the big cell ends on the first screen — its side is at most the small viewport's
 *                  height (100svh) less its distance from the top of the document, never under 12rem (css --gp-fit);
 *                  kept while the pad is disabled (graded), so the cell doesn't grow under the result (default false)
 *   gp.el, gp.cellCount
 *   gp.getCellStrokes(i)  → Array<Array<[x, y]>> in CELL coordinates (cell box 0..100, y down). Points of a
 *                           stroke that runs past the cell edge are kept, as in DrawPad.
 *   gp.getCellBox(i)      → { x: 0, y: 0, w: 100, h: 100 }
 *   gp.getStrokeCount(), gp.getCellStrokeCount(i)
 *   gp.undo()             removes the last stroke overall (single mode shows the cell it came from)
 *   gp.clearCell(i), gp.clearAll()            (also drop those cells' marks; clearAll refocuses the first cell)
 *   gp.setMarks([{ i, mark: 'o'|'t'|'x'|'-' }] | null)   red-pen ○ △ ✕ (or a grey – for "not graded") over the
 *                                                         cells; a new stroke clears its cell's mark
 *   gp.setEnabled(bool), gp.isEnabled(), gp.setGuideText(str|null), gp.setPenOnly(bool), gp.isPenOnly(), gp.hasSeenPen()
 *   gp.setMode('grid'|'single'), gp.getMode(), gp.setAutoAdvance(bool), gp.focusCell(i), gp.getFocus()
 *   gp.redraw(), gp.destroy()
 *   gp.onChange = fn({ reason: 'stroke'|'undo'|'clear'|'clearAll'|'focus'|'mode'|'autoAdvance', cell, total, manual })
 *                 manual: a 'mode' change the learner made (the 모든 칸 / 한 칸씩 switch or setMode), not the auto choice
 *
 * The 모든 칸 / 한 칸씩 switch ignores a touch while a pen is writing or hovering near the block (pen-only on, a pen
 * seen, html.pad-pen-near): that is the writing hand's palm, and switching the view under it would look like the
 * writing was wiped (and drop a stroke in progress). A finger works again once the pen is put away.
 *
 * Deviations from docs/SPEC-words.md G (all additive; the G API itself is as specified):
 *   - Guide glyphs are drawn from the stroke data the judge uses (KANA_DATA kana + extra, KANJI_DATA when it is
 *     loaded), not from the textbook font: the font's glyphs sit off the model by an amount that depends on the
 *     fallback font, while the stroke data puts small kana and 、。 exactly where box judging expects them.
 *     Characters without stroke data fall back to the font.
 *   - Extra options mode / autoAdvance / onCellClick / pressure / penZone / fitScreen, extra methods (getStrokeCount,
 *     getCellStrokeCount, isEnabled, isPenOnly, hasSeenPen, getMode, setAutoAdvance, redraw), the onChange
 *     payload above, and a neutral '-' mark (SPEC-words J: kanji without stroke data are not graded).
 *   - clearCell / clearAll also drop the marks of the cells they clear.
 *   - Rows break like Japanese text (行頭禁則): 、。ー and small kana never start a row (the cell before them moves
 *     down too), and a space that falls on a row break is not drawn — the break stands for it.
 *   - A stroke starting off the write cells goes to the write cell nearest the middle of the stroke, not of its
 *     first point (see below).
 *
 * A stroke belongs to the cell containing its first point; one starting off the write cells — on a space cell,
 * a row's border or (pen or mouse) in the gap between rows — goes to the write cell nearest the middle of what
 * it draws, so a stroke begun just above a cell lands in that cell. A stroke that never enters its cell (ink
 * included) is dropped: a tap or a flick beside the cells is not a stroke. The cell rows block scrolling
 * (touch-action: none), each with a thin ring around it (.gp-row::before, css/gridpad.css) that writes into the
 * nearest cell for a finger too, so a stroke begun at a row's edge does not pan the page; the rings leave only a
 * few px in the middle of a row gap, so scroll from the bar, the mini strip, the prompt or the margins. Once a pen
 * has been seen with pen-only on, the row gaps are writing surface too (fingers are ignored there anyway, and a pen
 * starting just outside a cell must not scroll the page instead). While a pen is over the writing block (penZone)
 * nothing on the page pans (DrawPad.Ink.nearZone), and during a stroke any scroll is undone at once (the tracker).
 * A pen stroke that starts in a gap and is then taken over by the browser (pointercancel) is dropped. In single
 * mode the big cell has a ring too (.gp-big::before).
 * Pen handling — pen-only palm rejection shared with DrawPad, coalesced events, DPR, focus hand-back — is
 * DrawPad.Ink, so js/drawpad.js must be loaded first. Styles: css/gridpad.css plus app.css (.mk .btn .chip .switch). */
(function (root, factory) {
  root.GridPad = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const UNIT = 100;                       // cell coordinates run 0..100
  const MIN = 64, MAX = 132, COMFY = 88;  // grid cell side in css px: clamp range and a comfortable writing size
  const SPACE = 0.4;                      // width of a space cell, in cells
  const ROW_BORDER = 2;                   // .gp-row border width (css/gridpad.css)
  const ADVANCE_MS = 1200;                // single mode: pause after the last stroke before moving on

  // The teacher's red-pen marks: the same hand-drawn paths and labels as app.js, styled by .mk in app.css;
  // n = neutral (not graded): a short grey dash in the upper-right corner, where it can't pass for a written ー.
  const MARKS = {
    o: { label: '정답 ○', paths: ['M34 9.5C20 9 9.5 19.5 9.8 33c.3 13.6 10.6 22.6 23.4 22.3 13.3-.3 22.2-10.5 21.6-23.4C54.2 19.4 45 10.6 31.5 11.6c-4.6.4-8.6 2.2-11.8 5'] },
    t: { label: '획순 오류 △', paths: ['M32.5 9.2C39.5 23 47 37 55.6 52.8c-15.6 1-31.4.9-47.2-.2C16 38.6 23.6 24 31 8.4'] },
    x: { label: '오답 ✕', paths: ['M14.5 14.2c12.2 11.6 24 23.6 35.8 36', 'M50.2 13.6C38.4 26.2 26.4 38.4 13.8 50.6'] },
    n: { label: '채점 안 함 –', paths: ['M42 9.4c4.4-.3 8.8-.3 13.2.1'] },
  };
  const MARK_KEY = { o: 'o', t: 't', x: 'x', n: 'n', '-': 'n', '–': 'n' };

  // Characters that never begin a row (行頭禁則): punctuation, the long-vowel mark, small kana.
  const NO_START = new Set(Array.from('、。，．,.・：；！？!?ー〜ゝゞヽヾぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ」』）〉》】'));

  function normCells(cells) {
    if (typeof cells === 'string') return Array.from(cells).map((ch) => ({ ch, kind: /\s/.test(ch) ? 'space' : 'write' }));
    return (cells || []).map((c) => ({ ch: c && c.ch != null ? String(c.ch) : '', kind: c && c.kind === 'space' ? 'space' : 'write' }));
  }

  /* Rows (arrays of cell indices) for cells of side s across avail css px: greedy, except that a row never
   * starts with a NO_START character (the cell before it moves down with it) or with a space (a space that
   * falls on the break is left out — the break stands for it). */
  function rowsFor(cells, units, s, avail) {
    const cap = avail / s + 1e-6;
    const rows = [];
    let cur = [], used = 0;
    units.forEach((u, i) => {
      if (cur.length && used + u > cap) {
        if (cells[i].kind === 'space') return;
        const carry = [];
        const prev = cur[cur.length - 1];
        if (NO_START.has(cells[i].ch) && cur.length > 1 && cells[prev].kind === 'write' && !NO_START.has(cells[prev].ch)) carry.push(cur.pop());
        rows.push(cur);
        cur = carry;
        used = carry.reduce((a, j) => a + units[j], 0);
      }
      cur.push(i);
      used += u;
    });
    if (cur.length) rows.push(cur);
    return rows;
  }

  // Largest cell side (≤ MAX) that needs no more rows than the comfortable size does.
  function planGrid(cells, units, width) {
    const avail = Math.max(1, width - 2 * ROW_BORDER);
    if (avail < MIN) { const s = Math.max(1, Math.floor(avail)); return { s, rows: rowsFor(cells, units, s, avail) }; }
    const comfy = Math.min(COMFY, avail);
    const target = rowsFor(cells, units, comfy, avail).length;
    let s = comfy;
    // (never wider than the row itself: rowsFor always puts at least one cell in a row)
    for (let t = Math.min(MAX, Math.floor(avail)); t > comfy; t -= 2) if (rowsFor(cells, units, t, avail).length <= target) { s = t; break; }
    s = Math.floor(s);
    return { s, rows: rowsFor(cells, units, s, avail) };
  }

  function create(host, options) {
    const Ink = root.DrawPad && root.DrawPad.Ink;
    if (!Ink) throw new Error('GridPad needs js/drawpad.js (DrawPad.Ink) loaded first');
    const opts = Object.assign({ penOnly: true, pressure: true, label: '원고지 — 한 칸에 한 글자씩 쓰세요', mode: 'auto', autoAdvance: false, guideText: null, fitScreen: false }, options || {});
    const doc = host.ownerDocument || document;
    const win = doc.defaultView || root;

    const cells = normCells(opts.cells);
    const n = cells.length;
    const units = cells.map((c) => (c.kind === 'space' ? SPACE : 1));
    const totalUnits = units.reduce((a, b) => a + b, 0);
    const writeIdx = [];
    cells.forEach((c, i) => { if (c.kind === 'write') writeIdx.push(i); });
    const ordinal = new Map(writeIdx.map((i, k) => [i, k + 1]));

    const data = cells.map(() => []);   // per cell: [{ pts: [{ x, y, f }], type }] in cell units
    const order = [];                   // cell index of every committed stroke, oldest first (for undo)
    const marks = new Map();            // cell index → 'o'|'t'|'x'
    let guide = null;                   // per-cell model glyphs, or null
    let enabled = true, penOnly = !!opts.penOnly, autoAdvance = !!opts.autoAdvance;
    let modeAuto = !(opts.mode === 'grid' || opts.mode === 'single');
    let mode = modeAuto ? 'grid' : opts.mode;
    let focus = writeIdx.length ? writeIdx[0] : -1;
    let ready = false, destroyed = false, rafId = 0, layoutRaf = 0, advTimer = 0;
    let dpr = 1, cellPx = 0, bigPx = 0, lastWidth = -1, gridKey = '';
    let pen = null;
    const dirty = new Set();
    let bigDirty = false;

    /* ---------------------------------------------------------- DOM */

    function h(tag, attrs, ...kids) {
      const e = doc.createElement(tag);
      if (attrs) for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'on') for (const ev in v) e.addEventListener(ev, v[ev]);
        else e.setAttribute(k, v === true ? '' : v);
      }
      kids.forEach((c) => { if (c != null) e.append(c); });
      return e;
    }

    function s(tag, attrs, parent) {
      const e = doc.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      if (parent) parent.appendChild(e);
      return e;
    }

    function chevron(d) {
      const svg = s('svg', { class: 'ic', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
      s('path', { d }, svg);
      return svg;
    }

    // One writable square: 十 guide, faint model glyph, ink canvas, red-pen mark, and a result button.
    function makeFace(cls, i) {
      const el = h('div', { class: 'gp-face ' + cls, 'data-i': i });
      const lines = s('svg', { class: 'gp-lines', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
      s('path', { d: 'M50,2V98M2,50H98', class: 'gp-cross' }, lines);
      const ghost = h('span', { class: 'gp-ghost', lang: 'ja', 'aria-hidden': 'true' });
      const canvas = h('canvas', { class: 'gp-canvas', role: 'img' });
      const mark = h('span', { class: 'gp-mark', 'aria-hidden': 'true' });
      const hit = h('button', { type: 'button', class: 'gp-hit', hidden: true });
      el.append(lines, ghost, canvas, mark, hit);
      return { el, canvas, ctx: canvas.getContext('2d'), ghost, mark, hit };
    }

    const faces = cells.map((c, i) => (c.kind === 'write' ? makeFace('gp-cell', i) : null));
    const cellEls = cells.map((c, i) => (faces[i] ? faces[i].el : h('div', { class: 'gp-space', 'data-i': i, 'aria-hidden': 'true' })));
    faces.forEach((f, i) => { if (f) f.hit.addEventListener('click', () => { setFocus(i); cellClick(i); }); });
    const sheet = h('div', { class: 'gp-sheet' });

    const big = makeFace('gp-big', '');
    const adv = h('span', { class: 'gp-adv', 'aria-hidden': 'true' });
    big.el.appendChild(adv);
    big.hit.addEventListener('click', () => cellClick(focus));
    const prevBtn = h('button', { type: 'button', class: 'btn btn-sm gp-prev', 'aria-label': '이전 칸', on: { click: () => step(-1) } },
      chevron('M15 5l-7 7 7 7'), h('span', { class: 'gp-nav-text' }, '이전'));
    const nextBtn = h('button', { type: 'button', class: 'btn btn-sm gp-next', 'aria-label': '다음 칸', on: { click: () => step(1) } },
      h('span', { class: 'gp-nav-text' }, '다음'), chevron('M9 5l7 7-7 7'));
    const posEl = h('span', { class: 'gp-pos', 'aria-live': 'polite' });
    const miniInk = [], miniMark = [];
    const minis = cells.map((c, i) => {
      if (c.kind !== 'write') return h('span', { class: 'gp-mini-gap', 'aria-hidden': 'true' });
      const b = h('button', { type: 'button', class: 'gp-mini', 'data-i': i, on: { click: () => setFocus(i) } });
      const svg = s('svg', { class: 'gp-mini-svg', viewBox: '0 0 100 100', 'aria-hidden': 'true', focusable: 'false' });
      s('path', { d: 'M50,4V96M4,50H96', class: 'gp-cross' }, svg);
      miniInk[i] = s('g', { class: 'gp-mini-ink' }, svg);
      miniMark[i] = h('span', { class: 'gp-mark', 'aria-hidden': 'true' });
      b.append(svg, miniMark[i]);
      return b;
    });
    const strip = h('div', { class: 'gp-strip', role: 'group', 'aria-label': '칸 미리보기 — 누르면 그 칸으로 가요' }, ...minis);
    const stage = h('div', { class: 'gp-stage' }, big.el, h('div', { class: 'gp-nav' }, prevBtn, posEl, nextBtn));
    const single = h('div', { class: 'gp-single' }, stage, strip);

    const autoInput = h('input', { type: 'checkbox', class: 'switch switch-sm', role: 'switch', checked: autoAdvance,
      on: { change: (e) => { autoAdvance = !!e.target.checked; if (!autoAdvance) stopAdvance(); notify('autoAdvance', null); } } });
    const autoLabel = h('label', { class: 'pen-toggle gp-auto' }, autoInput, h('span', null, '다 쓰면 다음 칸으로'));
    // The view switch: a touch on it while the pen is writing or hovering near the block is the palm (header).
    // pointerType from the click itself (a PointerEvent in current browsers), else from the pointerdown before it.
    let downType = '';
    const palmTap = (e) => {
      const type = (e && e.pointerType) || downType;
      return type === 'touch' && penOnly && Ink.hasSeenPen() && doc.documentElement.classList.contains('pad-pen-near');
    };
    const switchTo = (m) => (e) => { if (!palmTap(e)) setMode(m); };
    const modeBtns = {
      grid: h('button', { type: 'button', class: 'chip gp-mode', on: { click: switchTo('grid') } }, '모든 칸'),
      single: h('button', { type: 'button', class: 'chip gp-mode', on: { click: switchTo('single') } }, '한 칸씩'),
    };
    const modes = h('div', { class: 'gp-modes', role: 'group', 'aria-label': '칸 보기',
      on: { pointerdown: (e) => { downType = e.pointerType || ''; } } }, modeBtns.grid, modeBtns.single);
    const bar = h('div', { class: 'gp-bar' }, autoLabel, h('span', { class: 'gp-bar-gap' }), modes);
    // fitScreen: measures the small viewport's height (css 100svh)
    const vhProbe = opts.fitScreen ? h('div', { class: 'gp-vh', 'aria-hidden': 'true' }) : null;

    const el = h('div', { class: 'gp' + (opts.fitScreen ? ' gp-fit' : ''), role: 'group', 'aria-label': opts.label }, sheet, single, bar, vhProbe);
    host.appendChild(el);

    /* ---------------------------------------------------------- labels, marks, guide, minis */

    function cellLabel(i) {
      if (i < 0) return '';
      const k = data[i].length;
      const m = marks.get(i);
      return `${ordinal.get(i)}번째 칸 · ${k ? k + '획' : '빈칸'}${m ? ' · ' + MARKS[m].label : ''}`;
    }

    function labelFace(f, i) {
      const t = cellLabel(i);
      f.canvas.setAttribute('aria-label', t);
      f.hit.setAttribute('aria-label', t + ' — 결과 보기');
    }

    function renderMark(holder, m) {
      const key = m && MARKS[m] ? m : '';
      if ((holder.getAttribute('data-mark') || '') === key) return;
      holder.setAttribute('data-mark', key);
      holder.textContent = '';
      if (!key) return;
      const svg = s('svg', { class: 'mk mk-' + key, viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false' }, holder);
      MARKS[key].paths.forEach((d) => s('path', { d, pathLength: 1 }, svg));
    }

    /* Faint model glyph: the KanjiVG strokes the judge compares against (they also place small kana and
     * 、。 where they belong in the cell), like DrawPad's guide; kanji use KANJI_DATA once it is loaded, and
     * characters without stroke data fall back to the textbook font. */
    function renderGhost(holder, ch) {
      const D = root.KANA_DATA, K = root.KANJI_DATA;
      const k = ch && D && ((D.kana && D.kana[ch]) || (D.extra && D.extra[ch]));
      const kj = ch && !k && K && K.kanji && K.kanji[ch];
      const strokes = k ? k.variants[0].strokes : kj ? kj.strokes : null;
      const key = ch ? ch + (strokes ? ':s' : ':f') : '';
      if ((holder.getAttribute('data-ch') || '') === key) return;
      holder.setAttribute('data-ch', key);
      holder.textContent = '';
      if (!ch) return;
      if (!strokes) { holder.textContent = ch; return; }
      const vb = (k ? D.viewBox : K.viewBox) || 109;
      const svg = s('svg', { class: 'gp-ghost-svg', viewBox: `0 0 ${vb} ${vb}`, focusable: 'false' }, holder);
      strokes.forEach((d) => s('path', { d, class: 'gp-ghost-stroke' }, svg));
    }

    function guideChar(i) {
      if (!guide || i < 0) return '';
      return (guide.length === n ? guide[i] : cells[i].ch) || '';
    }

    function renderMini(i) {
      const g = miniInk[i];
      if (!g) return;
      while (g.firstChild) g.removeChild(g.firstChild);
      const f1 = (v) => Math.round(v * 10) / 10;
      data[i].forEach((st) => {
        const P = st.pts;
        if (P.length === 1 || (P.length === 2 && Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y) < 1.5)) {
          s('circle', { cx: f1(P[0].x), cy: f1(P[0].y), r: 4.5 }, g);
          return;
        }
        let d = `M${f1(P[0].x)},${f1(P[0].y)}`;
        for (let k = 1; k < P.length; k++) d += `L${f1(P[k].x)},${f1(P[k].y)}`;
        s('path', { d }, g);
      });
      renderMark(miniMark[i], marks.get(i));
      minis[i].setAttribute('aria-label', cellLabel(i));
    }

    // Everything about cell i outside its canvas: labels, marks, mini, the big face when it shows i.
    function refreshCell(i) {
      if (!faces[i]) return;
      labelFace(faces[i], i);
      renderMark(faces[i].mark, marks.get(i));
      renderGhost(faces[i].ghost, guideChar(i));
      renderMini(i);
      if (i === focus) renderBig();
    }

    function renderBig() {
      big.el.setAttribute('data-i', focus);
      big.el.style.setProperty('--gp-face', bigPx + 'px');
      renderGhost(big.ghost, guideChar(focus));
      renderMark(big.mark, marks.get(focus));
      labelFace(big, focus);
      const k = writeIdx.indexOf(focus);
      posEl.textContent = writeIdx.length ? `${k + 1} / ${writeIdx.length}` : '';
      prevBtn.disabled = k <= 0;
      nextBtn.disabled = k < 0 || k >= writeIdx.length - 1;
      writeIdx.forEach((i) => { if (i === focus) minis[i].setAttribute('aria-current', 'true'); else minis[i].removeAttribute('aria-current'); });
    }

    function updateClickable() {
      const on = !enabled && typeof opts.onCellClick === 'function';
      el.classList.toggle('is-clickable', on);
      faces.forEach((f) => { if (f) f.hit.hidden = !on; });
      big.hit.hidden = !on || focus < 0;
    }

    function cellClick(i) {
      if (!enabled && typeof opts.onCellClick === 'function' && i >= 0) {
        try { opts.onCellClick(i); } catch (e) { if (root.console) console.error(e); }
      }
    }

    /* ---------------------------------------------------------- layout */

    function autoMode(width) {
      if (writeIdx.length < 2) return 'grid';
      let narrow;
      try { narrow = win.matchMedia('(max-width: 559px)').matches; } catch (e) { narrow = width < 560; }
      return narrow && totalUnits * COMFY > width - 2 * ROW_BORDER ? 'single' : 'grid';
    }

    function layout() {
      layoutRaf = 0;
      if (destroyed) return;
      const width = el.clientWidth;
      let modeChanged = false;
      if (modeAuto && width >= 1) {
        const want = autoMode(width);
        if (want !== mode) { leaveMode(); mode = want; modeChanged = true; }
      }
      el.classList.toggle('is-grid', mode === 'grid');
      el.classList.toggle('is-single', mode === 'single');
      sheet.hidden = mode !== 'grid';
      single.hidden = mode !== 'single';
      autoLabel.hidden = mode !== 'single';
      modeBtns.grid.setAttribute('aria-pressed', String(mode === 'grid'));
      modeBtns.single.setAttribute('aria-pressed', String(mode === 'single'));
      if (width < 1) return; // not rendered yet: the size observer calls back once it is
      lastWidth = width;
      dpr = Ink.pixelRatio(win);
      if (mode === 'grid') {
        const plan = planGrid(cells, units, width);
        const key = plan.s + ':' + plan.rows.map((r) => r.length).join(',');
        if (key !== gridKey) {
          gridKey = key;
          el.style.setProperty('--gp-cell', plan.s + 'px');
          sheet.textContent = '';
          plan.rows.forEach((r) => sheet.appendChild(h('div', { class: 'gp-row' }, ...r.map((i) => cellEls[i]))));
        }
        cellPx = plan.s;
        faces.forEach((f) => { if (f) Ink.fitCanvas(f.canvas, cellPx, cellPx, dpr); });
      } else {
        fitScreen();
        bigPx = Math.max(1, Math.round(big.el.getBoundingClientRect().width));
        Ink.fitCanvas(big.canvas, bigPx, bigPx, dpr);
        renderBig();
        scrollStrip();
      }
      invalidateAll();
      if (modeChanged) notify('mode', null);
    }

    /* fitScreen (single mode, while the pad takes input): the big cell's side may be at most the small viewport's
     * height less the stage's offset from the top of the document and a margin — so at scroll 0 the whole cell is on
     * the first screen however tall the page above it is (css .gp-fit: never under 12rem nor over 30rem / the width).
     * Re-run when anything on the page changes size (the body's size observer below), on a resize and on a layout; a
     * new value resizes the big cell, which the size observer then lays out. */
    const FIT_MARGIN = 10;
    let fitPx = -1;
    function fitScreen() {
      if (!vhProbe || destroyed || mode !== 'single' || !enabled || !el.isConnected) return;
      const vh = vhProbe.getBoundingClientRect().height || win.innerHeight || 0;
      const top = stage.getBoundingClientRect().top + (win.scrollY || win.pageYOffset || 0);
      if (!vh) return;
      const px = Math.max(0, Math.floor(vh - top - FIT_MARGIN));
      if (px === fitPx) return;
      fitPx = px;
      el.style.setProperty('--gp-fit', px + 'px');
    }
    let stopFit = () => {};
    if (vhProbe) {
      const onFit = () => { if (!destroyed) fitScreen(); };
      const ro = win.ResizeObserver ? new win.ResizeObserver(onFit) : null;
      if (ro && doc.body) ro.observe(doc.body);
      win.addEventListener('resize', onFit);
      stopFit = () => { if (ro) ro.disconnect(); win.removeEventListener('resize', onFit); };
    }

    function scheduleLayout() {
      if (layoutRaf || destroyed) return;
      layoutRaf = win.requestAnimationFrame ? win.requestAnimationFrame(layout) : setTimeout(layout, 16);
    }

    // Size observer: re-plan only when the width, the pixel ratio or the big cell's size really changed
    // (the height changes with every re-plan, and laying out inside the callback would loop).
    const stopSize = Ink.observeSize(el, () => {
      if (destroyed) return;
      const bigChanged = mode === 'single' && Math.round(big.el.getBoundingClientRect().width) !== bigPx;
      if (el.clientWidth !== lastWidth || Ink.pixelRatio(win) !== dpr || bigChanged) scheduleLayout();
    });

    function scrollStrip() {
      const m = minis[focus];
      if (!m || single.hidden) return;
      const sl = strip.scrollLeft, w = strip.clientWidth, l = m.offsetLeft, mw = m.offsetWidth;
      if (l < sl) strip.scrollLeft = Math.max(0, l - 12);
      else if (l + mw > sl + w) strip.scrollLeft = l + mw - w + 12;
    }

    /* ---------------------------------------------------------- rendering */

    function drawFace(f, i, size, color) {
      const c = f.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, f.canvas.width, f.canvas.height);
      if (i < 0 || !size) return;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const k = size / UNIT, base = Ink.baseWidth(size);
      data[i].forEach((st) => Ink.drawStroke(c, st.pts, color, k, base));
      const a = pen && pen.active();
      if (a && a.target.cell === i) Ink.drawStroke(c, a.pts, color, k, base);
    }

    function frame() {
      rafId = 0;
      if (destroyed) return;
      const color = Ink.inkColor(win, el);
      if (mode === 'grid') dirty.forEach((i) => { if (faces[i]) drawFace(faces[i], i, cellPx, color); });
      else if (bigDirty || dirty.has(focus)) drawFace(big, focus, bigPx, color);
      dirty.clear();
      bigDirty = false;
    }

    function schedule() {
      if (rafId || destroyed) return;
      rafId = win.requestAnimationFrame ? win.requestAnimationFrame(frame) : setTimeout(frame, 16);
    }

    function invalidate(i) { if (i >= 0) dirty.add(i); schedule(); }
    function invalidateAll() { writeIdx.forEach((i) => dirty.add(i)); bigDirty = true; schedule(); }

    /* ---------------------------------------------------------- pointer input */

    function targetFor(i, f) {
      const t = {
        cell: i, el: f.el, minStep: 0.6, rect: null,
        refresh() { t.rect = f.el.getBoundingClientRect(); t.minStep = (0.6 * UNIT) / Math.max(1, t.rect.width); },
        toLocal: (ev) => [((ev.clientX - t.rect.left) * UNIT) / t.rect.width, ((ev.clientY - t.rect.top) * UNIT) / t.rect.height],
      };
      return t;
    }

    function nearestCell(x, y) {
      let best = -1, bd = Infinity;
      writeIdx.forEach((i) => {
        const r = faces[i].el.getBoundingClientRect();
        const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
        if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = i; }
      });
      return best;
    }

    function hit(e) {
      const t = e.target;
      if (!t || !t.closest) return null;
      // Belt and braces for PEN-7 (the size observer should already have caught a pixel-ratio change).
      if (Ink.pixelRatio(win) !== dpr && lastWidth > 0) layout();
      if (mode === 'single') return focus >= 0 && big.el.contains(t) && !t.closest('.gp-hit') ? targetFor(focus, big) : null;
      if (!sheet.contains(t)) return null;
      const box = t.closest('.gp-cell, .gp-space');
      let i = box && box.classList.contains('gp-cell') ? Number(box.getAttribute('data-i')) : -1;
      let free = false;
      if (i < 0) {
        // A finger in a row gap scrolls the page — except on the ring around a row (the target is the row itself,
        // via its ::before); a pen or mouse in a gap (or anything on a space or a ring) writes in the nearest cell.
        if (!box && e.pointerType === 'touch' && !t.classList.contains('gp-row')) return null;
        i = nearestCell(e.clientX, e.clientY);
        if (i < 0) return null;
        free = true;
      }
      const target = targetFor(i, faces[i]);
      // Begun off the write cells (row gap, row border, space): the stroke follows the cell it is drawn in (follow).
      target.free = free;
      // Begun in a row gap: unless the gaps are writing surface (gp-pen), the browser may pan the page from
      // there and cancel the stroke — then it is dropped rather than kept as a stub.
      target.loose = !t.closest('.gp-row');
      return target;
    }

    /* A stroke begun off the write cells belongs to the write cell nearest the middle of what has been drawn so
     * far — not to the one nearest its first point: a stroke started just above a cell, in the row gap, is that
     * cell's even when the gap's upper half is closer to the row above. Moves the stroke (points converted to the
     * new cell's units, same cell size) and returns its cell. */
    function follow(st) {
      const from = st.target.cell;
      if (!st.target.free || mode !== 'grid' || !st.pts.length) return from;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      st.pts.forEach((p) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
      const r = faces[from].el.getBoundingClientRect();
      const k = r.width / UNIT;
      const to = nearestCell(r.left + ((x0 + x1) / 2) * k, r.top + ((y0 + y1) / 2) * k);
      if (to < 0 || to === from) return from;
      const q = faces[to].el.getBoundingClientRect();
      const dx = (r.left - q.left) / k, dy = (r.top - q.top) / k;
      st.pts.forEach((p) => { p.x += dx; p.y += dy; });
      const t = targetFor(to, faces[to]);
      t.free = true;
      t.loose = st.target.loose;
      t.refresh();
      st.target = t;
      invalidate(from);
      return to;
    }

    // Once a pen is known (pen-only on), the row gaps stop scrolling the page: css .gp-pen.
    // Also: a pen near the writing block pins the page (html.pad-pen-near), and while the pad takes input the page
    // doesn't rubber-band or drag a host page (html.pad-live) — DrawPad.Ink.nearZone / setLive.
    const zone = opts.penZone === undefined ? host.parentElement : opts.penZone;
    if (Ink.nearZone) Ink.nearZone(doc, el, zone, () => enabled && !destroyed);
    function syncPenSurface() {
      el.classList.toggle('gp-pen', penOnly && Ink.hasSeenPen());
      if (Ink.setLive) Ink.setLive(doc, el, enabled && !destroyed);
      if (Ink.nearSync) Ink.nearSync(doc);
    }
    const stopPenWatch = Ink.onPenSeen ? Ink.onPenSeen(syncPenSurface) : () => {};
    syncPenSurface();

    // Touch / selection defaults are cancelled only on the writable surface, so the page scrolls elsewhere.
    function guard(e) {
      const t = e.target;
      const surface = mode === 'single' ? '.gp-big' : el.classList.contains('gp-pen') ? '.gp-sheet' : '.gp-row';
      return enabled && !!(t && t.closest && t.closest(surface));
    }

    pen = Ink.tracker(el, {
      enabled: () => enabled,
      penOnly: () => penOnly,
      pressure: !!opts.pressure,
      hit,
      guard,
      update(st) { if (advTimer) st.hadAdvance = true; stopAdvance(); invalidate(follow(st)); },
      commit(st) {
        const i = follow(st);
        // Never inside its cell, ink included (a tap or a flick on a ring or in a gap): not a stroke. An auto-advance
        // that was pending when this touch stopped it (update) carries on.
        const px = mode === 'single' ? bigPx : cellPx;
        if (px && Ink.inksBox && !Ink.inksBox(st.pts, UNIT, px / UNIT)) {
          invalidate(i);
          if (st.hadAdvance && mode === 'single' && autoAdvance && i === focus) startAdvance(i);
          return;
        }
        data[i].push({ pts: st.pts, type: st.type });
        order.push(i);
        marks.delete(i);
        if (mode === 'grid') focus = i;
        invalidate(i);
        refreshCell(i);
        notify('stroke', i);
        if (mode === 'single' && autoAdvance) startAdvance(i);
      },
      drop(st) { invalidate(st.target.cell); },
    });

    /* ---------------------------------------------------------- focus, single mode, auto-advance */

    function nextWrite(i, dir) {
      const k = writeIdx.indexOf(i) + dir;
      return k >= 0 && k < writeIdx.length ? writeIdx[k] : -1;
    }

    function setFocus(i) {
      if (i < 0 || i >= n || cells[i].kind !== 'write') return;
      stopAdvance();
      const changed = i !== focus;
      if (changed && mode === 'single') pen.cancel();
      focus = i;
      renderBig();
      updateClickable();
      if (mode === 'single') { bigDirty = true; schedule(); scrollStrip(); }
      if (changed) notify('focus', i);
    }

    function step(dir) {
      const j = nextWrite(focus, dir);
      if (j >= 0) setFocus(j);
    }

    function startAdvance(i) {
      stopAdvance();
      const j = nextWrite(i, 1);
      if (j < 0) return;
      adv.style.animationDuration = ADVANCE_MS + 'ms';
      void adv.offsetWidth; // restart the progress animation
      big.el.classList.add('is-advancing');
      advTimer = setTimeout(() => {
        advTimer = 0;
        big.el.classList.remove('is-advancing');
        if (!destroyed && enabled && mode === 'single' && focus === i) setFocus(j);
      }, ADVANCE_MS);
    }

    function stopAdvance() {
      if (advTimer) { clearTimeout(advTimer); advTimer = 0; }
      big.el.classList.remove('is-advancing');
    }

    function leaveMode() {
      pen.cancel();
      stopAdvance();
    }

    function setMode(m) {
      if (m !== 'grid' && m !== 'single') return;
      const wasAuto = modeAuto;
      modeAuto = false;
      // (the view the auto choice already showed: now the learner's choice too)
      if (m === mode) { if (wasAuto) notify('mode', null, true); return; }
      leaveMode();
      mode = m;
      layout();
      if (mode === 'grid' && focus >= 0 && el.isConnected) faces[focus].el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      notify('mode', null, true);
    }

    /* ---------------------------------------------------------- editing */

    function notify(reason, cell, manual) {
      if (!ready || typeof api.onChange !== 'function') return;
      const info = { reason, cell: cell == null ? null : cell, total: order.length };
      if (reason === 'mode') info.manual = !!manual;
      try { api.onChange(info); } catch (e) { if (root.console) console.error(e); }
    }

    function undo() {
      if (pen.active()) { pen.cancel(); return; }
      if (!order.length) return;
      const i = order.pop();
      data[i].pop();
      marks.delete(i);
      stopAdvance();
      if (mode === 'single' && i !== focus) setFocus(i);
      invalidate(i);
      refreshCell(i);
      notify('undo', i);
    }

    function clearCell(i) {
      if (!faces[i]) return;
      const a = pen.active();
      if (a && a.target.cell === i) pen.cancel();
      const had = data[i].length;
      data[i] = [];
      for (let k = order.length - 1; k >= 0; k--) if (order[k] === i) order.splice(k, 1);
      marks.delete(i);
      stopAdvance();
      invalidate(i);
      refreshCell(i);
      if (had) notify('clear', i);
    }

    function clearAll() {
      pen.cancel();
      stopAdvance();
      const had = order.length;
      data.forEach((d, i) => { data[i] = []; });
      order.length = 0;
      marks.clear();
      writeIdx.forEach(refreshCell);
      if (writeIdx.length) setFocus(writeIdx[0]);
      invalidateAll();
      if (had) notify('clearAll', null);
    }

    function setMarks(list) {
      marks.clear();
      (list || []).forEach((m) => { if (m && faces[m.i] && MARK_KEY[m.mark]) marks.set(m.i, MARK_KEY[m.mark]); });
      writeIdx.forEach(refreshCell);
    }

    function setGuideText(str) {
      guide = str == null || str === false ? null : str === true ? cells.map((c) => c.ch) : Array.from(String(str));
      writeIdx.forEach(refreshCell);
    }

    function setEnabled(v) {
      enabled = !!v;
      el.classList.toggle('is-disabled', !enabled);
      if (!enabled) { pen.cancel(); stopAdvance(); }
      updateClickable();
      syncPenSurface();
      if (enabled) fitScreen();
    }

    function getCellStrokes(i) {
      const r = (v) => Math.round(v * 100) / 100;
      return (data[i] || []).map((st) => st.pts.map((p) => [r(p.x), r(p.y)]));
    }

    // Theme: the OS scheme or the app's data-theme switch changes the ink token.
    const stopScheme = Ink.watchScheme(win, invalidateAll);
    let themeObs = null;
    if (win.MutationObserver && doc.documentElement) {
      themeObs = new win.MutationObserver(invalidateAll);
      themeObs.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      pen.destroy();
      stopPenWatch();
      if (Ink.nearZone) Ink.nearZone(doc, el, null);
      syncPenSurface();
      stopSize();
      stopScheme();
      if (themeObs) themeObs.disconnect();
      stopFit();
      stopAdvance();
      const cancel = win.cancelAnimationFrame ? (id) => win.cancelAnimationFrame(id) : clearTimeout;
      if (rafId) cancel(rafId);
      if (layoutRaf) cancel(layoutRaf);
      rafId = layoutRaf = 0;
      el.remove();
    }

    const api = {
      el,
      cellCount: n,
      onChange: typeof opts.onChange === 'function' ? opts.onChange : null,
      getCellStrokes,
      getCellBox: () => ({ x: 0, y: 0, w: UNIT, h: UNIT }),
      getStrokeCount: () => order.length,
      getCellStrokeCount: (i) => (data[i] ? data[i].length : 0),
      undo,
      clearCell,
      clearAll,
      setMarks,
      setEnabled,
      isEnabled: () => enabled,
      setGuideText,
      setPenOnly(v) { penOnly = !!v; syncPenSurface(); },
      isPenOnly: () => penOnly,
      hasSeenPen: () => Ink.hasSeenPen(),
      setMode,
      getMode: () => mode,
      setAutoAdvance(v) { autoAdvance = !!v; autoInput.checked = autoAdvance; if (!autoAdvance) stopAdvance(); },
      focusCell(i) {
        let j = Number(i);
        if (!(j >= 0 && j < n) || !writeIdx.length) return;
        if (!faces[j]) { const after = writeIdx.find((w) => w > j); j = after != null ? after : writeIdx[writeIdx.length - 1]; }
        setFocus(j);
        if (mode === 'grid' && faces[j] && el.isConnected) faces[j].el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      },
      getFocus: () => focus,
      redraw() { lastWidth = -1; layout(); },
      destroy,
    };

    setGuideText(opts.guideText);
    updateClickable();
    layout();
    ready = true;
    return api;
  }

  return { create };
});
