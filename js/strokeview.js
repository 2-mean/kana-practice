/* Stroke-order rendering for 가나 연습장 (browser only).
 * Draws KANA_DATA stroke paths (kana + KANA_DATA.extra; kanji from KANJI_DATA once loaded — 109×109 box, y down) as SVG: animated stroke-order player, cumulative
 * step frames, static glyphs, glyphs with 구별 포인트 markers (keypointGlyph), and re-rendering of a user's drawing
 * with order numbers + direction arrows.
 * Colours come from CSS classes (sv-*) so themes stay in app.css. */
(function (root, factory) {
  root.StrokeView = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const VB = 109;
  const C = VB / 2;

  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function reducedMotion() {
    try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  /* A kanji of 단어/문장 쓰기 (SPEC-words J), once js/kanji-data.js is loaded (KanjiJudge.load()): its KanjiVG
   * strokes as a kana-shaped record with one 'std' form, so every view below (frames, glyph, player, guide) works
   * for kanji cells too. The record is rebuilt if KANJI_DATA is replaced. */
  const kanjiCache = new Map();
  function kanjiOf(ch) {
    const K = root.KANJI_DATA;
    const e = K && K.kanji && typeof ch === 'string' ? K.kanji[ch] : null;
    if (!e || !Array.isArray(e.strokes) || !e.strokes.length) return null;
    let k = kanjiCache.get(ch);
    if (!k || k.src !== e) {
      k = { ch, kanji: true, src: e, strokeCount: e.strokes.length, variants: [{ id: 'std', label: null, strokes: e.strokes }] };
      kanjiCache.set(ch, k);
    }
    return k;
  }

  // A kana, a small kana / symbol from KANA_DATA.extra (っ ゃ ー 。 …: same shape of record), or a loaded kanji.
  function kanaOf(ch) {
    const D = root.KANA_DATA;
    return (D && ((D.kana && D.kana[ch]) || (D.extra && D.extra[ch]))) || kanjiOf(ch) || null;
  }

  function variantOf(ch, variantId) {
    const k = kanaOf(ch);
    if (!k) return null;
    return k.variants.find((v) => v.id === variantId) || k.variants[0];
  }

  function strokesOf(ch, variantId) {
    const v = variantOf(ch, variantId);
    return v ? v.strokes : [];
  }

  /* ------------------------------------------------------------ geometry */

  const polyCache = new Map();
  function polyOf(d) {
    let p = polyCache.get(d);
    if (!p) {
      p = root.SvgPath.flatten(d, 14);
      polyCache.set(d, p);
    }
    return p;
  }

  function polyLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return L;
  }

  function distToSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  function distToPoly(p, poly) {
    if (poly.length === 1) return Math.hypot(p[0] - poly[0][0], p[1] - poly[0][1]);
    let m = Infinity;
    for (let i = 1; i < poly.length; i++) m = Math.min(m, distToSeg(p, poly[i - 1], poly[i]));
    return m;
  }

  // Point and unit tangent at fraction f (0..1) of the arc length.
  function pointAt(poly, f) {
    if (poly.length < 2) return { p: poly[0] || [C, C], t: [1, 0] };
    const total = polyLength(poly);
    let target = total * f, acc = 0;
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc + seg >= target && seg > 0) {
        const u = (target - acc) / seg;
        return { p: [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])], t: [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg] };
      }
      acc += seg;
    }
    const a = poly[poly.length - 2], b = poly[poly.length - 1];
    const s = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return { p: b.slice(), t: [(b[0] - a[0]) / s, (b[1] - a[1]) / s] };
  }

  // Direction leaving the start point (looks a few units ahead to skip jitter).
  function startDir(poly) {
    const p0 = poly[0];
    let q = null;
    for (const p of poly) if (Math.hypot(p[0] - p0[0], p[1] - p0[1]) > 5) { q = p; break; }
    q = q || poly[poly.length - 1];
    const dx = q[0] - p0[0], dy = q[1] - p0[1];
    const L = Math.hypot(dx, dy);
    return L ? [dx / L, dy / L] : [1, 0];
  }

  /* Number positions near each stroke's start, nudged off the lines and away from other numbers.
   * polys: Array<Array<[x,y]>> in the 109 box. Returns [{x, y}] (text centre). */
  function labelPositions(polys) {
    const placed = [];
    return polys.map((poly) => {
      if (!poly.length) { placed.push([C, C]); return { x: C, y: C }; }
      const p0 = poly[0];
      const d = startDir(poly);
      const back = Math.atan2(-d[1], -d[0]);
      let best = null, bestScore = -Infinity;
      for (const r of [7.5, 10, 13]) {
        for (let a = 0; a < 16; a++) {
          const k = Math.ceil(a / 2) * (a % 2 ? 1 : -1);
          const ang = back + (k * Math.PI) / 8;
          const c = [p0[0] + Math.cos(ang) * r, p0[1] + Math.sin(ang) * r];
          if (c[0] < 5 || c[0] > VB - 5 || c[1] < 6 || c[1] > VB - 4) continue;
          let dLine = Infinity;
          for (const pl of polys) dLine = Math.min(dLine, distToPoly(c, pl));
          let dLab = Infinity;
          for (const pp of placed) dLab = Math.min(dLab, Math.hypot(c[0] - pp[0], c[1] - pp[1]));
          const score = Math.min(dLine, 7) * 2.2 + Math.min(dLab, 11) * 1.2 - r * 0.4 - Math.abs(k) * 0.35;
          if (score > bestScore) { bestScore = score; best = c; }
        }
      }
      if (!best) best = [Math.max(5, Math.min(VB - 5, p0[0] - 7)), Math.max(6, Math.min(VB - 4, p0[1] - 7))];
      placed.push(best);
      return { x: best[0], y: best[1] };
    });
  }

  /* A short arrow drawn beside the stroke (textbook style) showing its direction, placed on the side
   * with more free space. Returns null for tiny strokes (dots / dakuten marks). */
  function arrowFor(poly, polys, opts) {
    const L = polyLength(poly);
    const minLen = (opts && opts.minLen) || 14;
    if (L < minLen) return null;
    const f = (opts && opts.at) || 0.5;
    const { p, t } = pointAt(poly, f);
    const n = [-t[1], t[0]];
    const off = (opts && opts.offset) || 7;
    const half = Math.min(6.5, L * 0.18);
    let best = null, bestFree = -Infinity;
    for (const side of [1, -1]) {
      const m = [p[0] + n[0] * off * side, p[1] + n[1] * off * side];
      if (m[0] < 3 || m[0] > VB - 3 || m[1] < 3 || m[1] > VB - 3) continue;
      let free = Infinity;
      for (const pl of polys) free = Math.min(free, distToPoly(m, pl));
      if (free > bestFree) { bestFree = free; best = m; }
    }
    if (!best) best = p;
    const a = [best[0] - t[0] * half, best[1] - t[1] * half];
    const b = [best[0] + t[0] * half, best[1] + t[1] * half];
    const hw = 2.4, hl = 3.4;
    const tip = [b[0] + t[0] * 1.2, b[1] + t[1] * 1.2];
    const left = [b[0] - t[0] * hl + n[0] * hw, b[1] - t[1] * hl + n[1] * hw];
    const right = [b[0] - t[0] * hl - n[0] * hw, b[1] - t[1] * hl - n[1] * hw];
    return { line: [a, b], head: [tip, left, right] };
  }

  const f1 = (v) => Math.round(v * 10) / 10;

  // Polyline → smooth path (quadratic curves through segment midpoints), like the drawing pad renders it.
  function smoothD(poly) {
    let d = `M${f1(poly[0][0])},${f1(poly[0][1])}`;
    if (poly.length === 2) return d + `L${f1(poly[1][0])},${f1(poly[1][1])}`;
    for (let k = 1; k < poly.length - 1; k++) {
      const mx = (poly[k][0] + poly[k + 1][0]) / 2, my = (poly[k][1] + poly[k + 1][1]) / 2;
      d += `Q${f1(poly[k][0])},${f1(poly[k][1])} ${f1(mx)},${f1(my)}`;
    }
    const L = poly[poly.length - 1];
    return d + `L${f1(L[0])},${f1(L[1])}`;
  }

  function drawArrow(g, arrow, cls) {
    if (!arrow) return;
    const [a, b] = arrow.line;
    svgEl('path', { d: `M${f1(a[0])},${f1(a[1])}L${f1(b[0])},${f1(b[1])}`, class: 'sv-arrow-line ' + (cls || '') }, g);
    const [t, l, r] = arrow.head;
    svgEl('path', { d: `M${f1(t[0])},${f1(t[1])}L${f1(l[0])},${f1(l[1])}L${f1(r[0])},${f1(r[1])}Z`, class: 'sv-arrow-head ' + (cls || '') }, g);
  }

  /* ------------------------------------------------------------ building blocks */

  function baseSvg(opts) {
    const o = opts || {};
    const svg = svgEl('svg', {
      viewBox: `0 0 ${VB} ${VB}`, class: 'sv ' + (o.className || ''), role: o.label ? 'img' : null,
      'aria-label': o.label || null, 'aria-hidden': o.label ? null : 'true', focusable: 'false',
    });
    if (o.box !== false) {
      svgEl('rect', { x: 0.75, y: 0.75, width: VB - 1.5, height: VB - 1.5, rx: 3, class: 'sv-box' }, svg);
      svgEl('path', { d: `M${C},2V${VB - 2}M2,${C}H${VB - 2}`, class: 'sv-guide' }, svg);
    }
    return svg;
  }

  function addNumber(g, pos, n, cls) {
    const t = svgEl('text', { x: f1(pos.x), y: f1(pos.y), class: 'sv-num ' + (cls || ''), 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
    t.textContent = String(n);
    return t;
  }

  /* Static glyph from stroke data. opts: { variantId, numbers, className, label, box } */
  function glyph(ch, opts) {
    const o = opts || {};
    const strokes = strokesOf(ch, o.variantId);
    const svg = baseSvg({ className: 'sv-static ' + (o.className || ''), label: o.label, box: o.box });
    const g = svgEl('g', { class: 'sv-ink' }, svg);
    strokes.forEach((d) => svgEl('path', { d, class: 'sv-stroke' }, g));
    if (o.numbers) {
      const pos = labelPositions(strokes.map(polyOf));
      const ng = svgEl('g', { class: 'sv-nums' }, svg);
      pos.forEach((p, i) => addNumber(ng, p, i + 1));
    }
    return svg;
  }

  /* Cumulative step frames: frame i shows strokes < i in ink, stroke i in the accent with a start dot,
   * number and direction arrow, later strokes faint. opts: { variantId, max, className } → <ol>. */
  function frames(ch, opts) {
    const o = opts || {};
    const strokes = strokesOf(ch, o.variantId);
    const polys = strokes.map(polyOf);
    const pos = labelPositions(polys);
    const list = document.createElement('ol');
    list.className = 'sv-frames ' + (o.className || '');
    list.setAttribute('aria-label', '획순 단계');
    strokes.forEach((d, i) => {
      const li = document.createElement('li');
      li.className = 'sv-frame';
      const svg = baseSvg({ className: 'sv-step', label: `${i + 1}번째 획` });
      const gTodo = svgEl('g', { class: 'sv-todo' }, svg);
      const gDone = svgEl('g', { class: 'sv-ink' }, svg);
      strokes.forEach((dd, j) => {
        if (j < i) svgEl('path', { d: dd, class: 'sv-stroke' }, gDone);
        else if (j > i) svgEl('path', { d: dd, class: 'sv-stroke' }, gTodo);
      });
      const gCur = svgEl('g', { class: 'sv-cur' }, svg);
      svgEl('path', { d, class: 'sv-stroke' }, gCur);
      const p0 = polys[i][0];
      svgEl('circle', { cx: f1(p0[0]), cy: f1(p0[1]), r: 3.2, class: 'sv-start' }, gCur);
      drawArrow(gCur, arrowFor(polys[i], polys), 'is-cur');
      addNumber(svgEl('g', { class: 'sv-nums' }, svg), pos[i], i + 1, 'is-cur');
      li.appendChild(svg);
      const cap = document.createElement('span');
      cap.className = 'sv-frame-n';
      cap.textContent = String(i + 1);
      li.appendChild(cap);
      list.appendChild(li);
    });
    return list;
  }

  /* ------------------------------------------------------------ animated player */

  /* create(container, { ch, variantId, numbers=true, onStep(step, total, playing) })
   * → { el, play(), pause(), toggle(), replay(), next(), prev(), setStep(n), setVariant(id), getStep(),
   *     total(), isPlaying(), destroy() }
   * step = number of completed strokes (0..total). */
  function create(container, opts) {
    const o = Object.assign({ numbers: true }, opts || {});
    let variantId = o.variantId || 'std';
    let svg, inkPaths = [], lengths = [], nums = [], starts = [], polys = [];
    let step = 0, raf = 0, playing = false, t0 = 0, timeline = [];
    const reduce = reducedMotion();

    function build() {
      if (svg) svg.remove();
      const strokes = strokesOf(o.ch, variantId);
      const k = kanaOf(o.ch);
      svg = baseSvg({ className: 'sv-player', label: (k ? k.ch : '') + ' 획순 애니메이션' });
      const ghost = svgEl('g', { class: 'sv-ghost' }, svg);
      const ink = svgEl('g', { class: 'sv-ink' }, svg);
      const dots = svgEl('g', { class: 'sv-starts' }, svg);
      const ng = svgEl('g', { class: 'sv-nums' }, svg);
      polys = strokes.map(polyOf);
      const pos = labelPositions(polys);
      inkPaths = []; lengths = []; nums = []; starts = [];
      strokes.forEach((d, i) => {
        svgEl('path', { d, class: 'sv-stroke' }, ghost);
        const p = svgEl('path', { d, class: 'sv-stroke' }, ink);
        inkPaths.push(p);
        const p0 = polys[i][0];
        starts.push(svgEl('circle', { cx: f1(p0[0]), cy: f1(p0[1]), r: 3.2, class: 'sv-start' }, dots));
        nums.push(addNumber(ng, pos[i], i + 1));
      });
      container.appendChild(svg);
      lengths = inkPaths.map((p, i) => {
        let L = 0;
        try { L = p.getTotalLength(); } catch (e) { L = 0; }
        if (!L || !isFinite(L)) L = polyLength(polys[i]);
        return Math.max(1, L);
      });
      inkPaths.forEach((p, i) => {
        p.style.strokeDasharray = `${lengths[i]} ${lengths[i] + 4}`;
      });
      // Timeline: each stroke takes time proportional to its length, with a short pause between strokes.
      timeline = [];
      let t = 0;
      lengths.forEach((L) => {
        const dur = Math.max(320, Math.min(1100, L * 9));
        timeline.push({ start: t, dur });
        t += dur + 260;
      });
      render(step > strokes.length ? strokes.length : step, null);
    }

    function total() { return inkPaths.length; }

    // Show `done` complete strokes; optionally stroke index `done` partially drawn (0..1).
    function render(done, partial) {
      inkPaths.forEach((p, i) => {
        const L = lengths[i];
        let shown;
        if (i < done) shown = 1;
        else if (i === done && partial != null) shown = partial;
        else shown = 0;
        p.style.visibility = shown > 0 ? 'visible' : 'hidden';
        p.style.strokeDashoffset = String(L * (1 - shown));
        const current = partial != null ? i === done : i === done - 1;
        p.classList.toggle('is-current', current);
        const started = i < done || (i === done && partial != null);
        nums[i].classList.toggle('is-hidden', !started);
        nums[i].classList.toggle('is-cur', current);
        starts[i].classList.toggle('is-hidden', !current);
      });
    }

    function emit() {
      if (typeof o.onStep === 'function') o.onStep(step, total(), playing);
    }

    function stopRaf() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    function pause() {
      if (!playing) return;
      stopRaf();
      playing = false;
      render(step, null);
      emit();
    }

    function play() {
      stopRaf();
      if (step >= total()) step = 0;
      if (reduce) {
        step = total();
        playing = false;
        render(step, null);
        emit();
        return;
      }
      playing = true;
      const from = step;
      const offset = timeline[from] ? timeline[from].start : 0;
      t0 = performance.now() - offset;
      emit();
      const tick = (now) => {
        const t = now - t0;
        let i = from;
        while (i < timeline.length && t >= timeline[i].start + timeline[i].dur) i++;
        if (i >= timeline.length) {
          step = total();
          playing = false;
          raf = 0;
          render(step, null);
          emit();
          return;
        }
        const seg = timeline[i];
        const part = t < seg.start ? 0 : Math.min(1, (t - seg.start) / seg.dur);
        const eased = 1 - Math.pow(1 - part, 1.6);
        if (i !== step) { step = i; emit(); }
        render(i, t < seg.start ? null : eased);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    function setStep(n) {
      stopRaf();
      playing = false;
      step = Math.max(0, Math.min(total(), n));
      render(step, null);
      emit();
    }

    const api = {
      get el() { return svg; },
      play,
      pause,
      toggle() { if (playing) pause(); else play(); },
      replay() { setStep(0); play(); },
      next() { setStep(step + 1); },
      prev() { setStep(step - 1); },
      setStep,
      getStep() { return step; },
      total,
      isPlaying() { return playing; },
      setVariant(id) { stopRaf(); playing = false; variantId = id; step = 0; build(); emit(); },
      destroy() { stopRaf(); playing = false; if (svg) svg.remove(); },
    };
    step = o.startStep != null ? o.startStep : 0;
    build();
    if (o.autoplay) play();
    else emit();
    return api;
  }

  /* ------------------------------------------------------------ key points (판별 포인트) on a glyph */

  // A hand-drawn red-pen ring (a loop that overshoots its start a little, like the teacher's ○), deterministic per seed.
  function penRing(cx, cy, r, seed) {
    const s = (seed || 0) % 7;
    const a0 = -2.4 + s * 0.41;
    const turn = Math.PI * 2 + 0.5;
    const pts = [];
    const N = 18;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const a = a0 + turn * t;
      const rr = r * (1 + 0.07 * Math.sin(3 * a + s) - 0.05 * t);
      pts.push([cx + rr * 1.1 * Math.cos(a), cy + rr * 0.93 * Math.sin(a)]);
    }
    return smoothD(pts);
  }

  /* Number tag next to a marker: on the side with the most free space (away from the strokes, the other markers and
   * the tags already placed), inside the box. */
  function tagPos(m, r, polys, markers, placed) {
    let best = null, bestScore = -Infinity;
    for (const dist of [r + 4.2, r + 7]) {
      for (let a = 0; a < 12; a++) {
        const ang = -Math.PI / 4 + (a * Math.PI) / 6;
        const c = [m.x + Math.cos(ang) * dist, m.y + Math.sin(ang) * dist];
        if (c[0] < 5 || c[0] > VB - 5 || c[1] < 5 || c[1] > VB - 5) continue;
        let dLine = Infinity;
        for (const pl of polys) dLine = Math.min(dLine, distToPoly(c, pl));
        let dOther = Infinity;
        for (const o of markers) if (o !== m) dOther = Math.min(dOther, Math.hypot(c[0] - o.x, c[1] - o.y) - 3);
        for (const p of placed) dOther = Math.min(dOther, Math.hypot(c[0] - p[0], c[1] - p[1]) - 4);
        const score = Math.min(dLine, 6) * 2 + Math.min(dOther, 9) * 1.6 - (dist - r) * 0.3;
        if (score > bestScore) { bestScore = score; best = c; }
      }
    }
    return best || [Math.max(5, Math.min(VB - 5, m.x + r + 5)), Math.max(5, Math.min(VB - 5, m.y - r - 3))];
  }

  /* keypointGlyph(ch, markers, { variantId, label, className, focusStrokes })
   * The glyph (its real place in the 十 box, like glyph()) with key-point markers in the 109 box:
   *   markers: [{ x, y, state: 'hit' | 'miss' | 'weak' | 'info', n?: number (tag), stroke?: template stroke index,
   *              direction?: true (also draw that stroke's direction arrow), dim?: true, key?: string }]
   *   hit  = a small calm ring (the drawing has it)      miss = a red-pen ring (the drawing missed it, ✕)
   *   weak = a dashed ring (drawn weakly, ○ / △)         info = a 朱 ring (the chart's '구별 포인트')
   * focusStrokes: template strokes drawn a little stronger than the rest (the strokes the points sit on).
   * Colours come from the sv-kp-* classes in app.css. */
  function keypointGlyph(ch, markers, opts) {
    const o = opts || {};
    const strokes = strokesOf(ch, o.variantId);
    const polys = strokes.map(polyOf);
    const svg = baseSvg({ className: 'sv-static sv-kpglyph ' + (o.className || ''), label: o.label, box: o.box });
    const focus = new Set(o.focusStrokes || []);
    const g = svgEl('g', { class: 'sv-ink' + (focus.size ? ' has-focus' : '') }, svg);
    strokes.forEach((d, i) => svgEl('path', { d, class: 'sv-stroke' + (focus.has(i) ? ' is-focus' : '') }, g));
    const list = (markers || []).filter((m) => m && isFinite(m.x) && isFinite(m.y));
    const gm = svgEl('g', { class: 'sv-kps' }, svg);
    const placed = [];
    // calm rings first, so the red and numbered ones are drawn on top
    const order = list.map((m, i) => i).sort((a, b) => (list[a].state === 'hit' ? 0 : 1) - (list[b].state === 'hit' ? 0 : 1) || a - b);
    order.forEach((idx) => {
      const m = list[idx];
      const st = ['hit', 'miss', 'weak', 'info'].includes(m.state) ? m.state : 'info';
      const mg = svgEl('g', { class: 'sv-kp sv-kp-' + st + (m.dim ? ' is-dim' : ''), 'data-kp': m.key || null }, gm);
      if (m.direction && polys[m.stroke]) {
        drawArrow(mg, arrowFor(polys[m.stroke], polys, { offset: 7.5 }), 'sv-kp-arrow'); // none on dots: the ring says it
      }
      const r = st === 'hit' ? 5.2 : st === 'info' ? 7.4 : 8.4; // a teacher's ring around the place, not on its line
      if (st === 'miss') svgEl('path', { d: penRing(m.x, m.y, r, idx + 1), class: 'sv-kp-ring' }, mg);
      else svgEl('circle', { cx: f1(m.x), cy: f1(m.y), r, class: 'sv-kp-ring' }, mg);
      if (m.n != null) {
        const c = tagPos(m, r, polys, list, placed);
        placed.push(c);
        svgEl('circle', { cx: f1(c[0]), cy: f1(c[1]), r: 4.6, class: 'sv-kp-tag' }, mg);
        const t = svgEl('text', { x: f1(c[0]), y: f1(c[1]), class: 'sv-kp-n', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, mg);
        t.textContent = String(m.n);
      }
    });
    return svg;
  }

  /* ------------------------------------------------------------ the user's drawing */

  let clipSeq = 0;

  /* userDrawing(strokes, { box, bad: number[], reversed: number[], numbers=true, arrows=true, label })
   * strokes: Array<Array<[x,y]>> in pad CSS px (y down); box = the pad's side length in px (when omitted
   * the drawing is fitted to its bounding box). Stroke numbers follow the user's order.
   * With a box, ink and arrows are clipped to it like the pad's canvas clipped them (points recorded
   * past the edge under pointer capture would otherwise paint over the neighbouring frames). */
  function userDrawing(strokes, opts) {
    const o = Object.assign({ numbers: true, arrows: true }, opts || {});
    const list = (strokes || []).filter((s) => s && s.length);
    let scale, ox = 0, oy = 0;
    if (o.box) {
      scale = VB / o.box;
    } else {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      list.forEach((s) => s.forEach((p) => {
        minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
      }));
      const size = Math.max(maxX - minX, maxY - minY, 1);
      scale = (VB * 0.78) / size;
      ox = C - ((minX + maxX) / 2) * scale;
      oy = C - ((minY + maxY) / 2) * scale;
    }
    const polys = list.map((s) => s.map((p) => [p[0] * scale + ox, p[1] * scale + oy]));
    const bad = new Set(o.bad || []);
    const rev = new Set(o.reversed || []);
    const svg = baseSvg({ className: 'sv-user', label: o.label || '내가 쓴 글자' });
    let clip = null;
    if (o.box) {
      const id = 'sv-clip-' + (++clipSeq);
      const cp = svgEl('clipPath', { id }, svgEl('defs', null, svg));
      svgEl('rect', { x: 0, y: 0, width: VB, height: VB }, cp);
      clip = `url(#${id})`;
    }
    const g = svgEl('g', { class: 'sv-mine', 'clip-path': clip }, svg);
    polys.forEach((poly, i) => {
      const cls = 'sv-stroke' + (bad.has(i) || rev.has(i) ? ' is-bad' : '');
      const L = polyLength(poly);
      if (poly.length === 1 || L < 1.5) {
        svgEl('circle', { cx: f1(poly[0][0]), cy: f1(poly[0][1]), r: 2.6, class: cls + ' is-dot' }, g);
      } else {
        svgEl('path', { d: smoothD(poly), class: cls }, g);
      }
    });
    if (o.arrows) {
      const ga = svgEl('g', { class: 'sv-arrows', 'clip-path': clip }, svg);
      polys.forEach((poly, i) => drawArrow(ga, arrowFor(poly, polys, { minLen: 12 }), bad.has(i) || rev.has(i) ? 'is-bad' : ''));
    }
    if (o.numbers) {
      const ng = svgEl('g', { class: 'sv-nums' }, svg);
      labelPositions(polys).forEach((p, i) => addNumber(ng, p, i + 1, bad.has(i) || rev.has(i) ? 'is-bad' : ''));
    }
    return svg;
  }

  return {
    VB, create, frames, glyph, keypointGlyph, userDrawing, labelPositions, arrowFor, strokesOf, variantOf, reducedMotion,
  };
});
