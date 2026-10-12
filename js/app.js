/* 가나 연습장 — screens, state, storage and wiring. Depends on (globals, loaded first):
 * SvgPath, KANA_DATA, KanaRecognizer, Quiz, StrokeView, DrawPad; optional: KanaText (js/romaji.js, 요음 table),
 * KanaStore (js/store.js — persistence + claude.ai sync; without it a single localStorage key is used).
 * Other modules (js/words.js) plug in only through window.KanaApp — see "extension API" at the end. */
(function () {
  'use strict';

  const D = window.KANA_DATA;
  const Q = window.Quiz;
  const SV = window.StrokeView;
  const DP = window.DrawPad;
  const STORE_KEY = 'kana-practice-v1';
  const REPORTS_KEY = STORE_KEY + ':reports'; // '판정 신고' (this browser only; never synced, never sent anywhere)
  const REPORTS_MAX = 100;
  const APP_VERSION = '2.1.0-kp (2026-10-10)'; // goes into 판정 신고 exports
  const SVGNS = 'http://www.w3.org/2000/svg';
  const VB = (D && D.viewBox) || 109;

  /* ================================================================ DOM helpers */

  function h(tag, props) {
    const el = document.createElement(tag);
    setProps(el, props);
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }

  function s(tag, props) {
    const el = document.createElementNS(SVGNS, tag);
    setProps(el, props);
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }

  function setProps(el, props) {
    if (!props) return;
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]);
      else if (k === 'style') el.setAttribute('style', v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }

  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach((x) => add(el, x)); return; }
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const jp = (ch, cls) => h('span', { class: 'jp ' + (cls || ''), lang: 'ja' }, ch);
  const srOnly = (text) => h('span', { class: 'sr-only' }, text);
  // Korean text with embedded kana or kanji: wrap those runs so they use the textbook face.
  const KANA_RUN = /[぀-ヿ㐀-䶿一-鿿々〆]+/g; // kana (with ゛゜), kanji, 々 〆
  function richText(text) {
    const out = [];
    const str = String(text == null ? '' : text);
    let last = 0, m;
    KANA_RUN.lastIndex = 0;
    while ((m = KANA_RUN.exec(str))) {
      if (m.index > last) out.push(str.slice(last, m.index));
      out.push(jp(m[0], 'inline-kana'));
      last = m.index + m[0].length;
    }
    if (last < str.length) out.push(str.slice(last));
    return out;
  }

  function icon(name) {
    const P = {
      undo: 'M9 7 4 12l5 5M4.5 12H14a5.5 5.5 0 0 1 0 11h-3',
      clear: 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13',
      play: 'M8 5.5v13l10.5-6.5z',
      pause: 'M8.5 5.5v13M15.5 5.5v13',
      prev: 'M15 5.5 8.5 12l6.5 6.5',
      next: 'M9 5.5 15.5 12 9 18.5',
      replay: 'M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 4.5v4h4',
      close: 'M6 6l12 12M18 6 6 18',
      grid: 'M4 4h16v16H4zM4 12h16M12 4v16',
      sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
      moon: 'M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z',
      auto: 'M12 3.5a8.5 8.5 0 1 0 0 17zM12 3.5a8.5 8.5 0 0 1 0 17',
      arrow: 'M5 12h13M13 6.5 18.5 12 13 17.5',
      pen: 'M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5zM13.5 7l3 3',
      stop: 'M7.5 7.5h9v9h-9z',
      book: 'M4 5.5C6.5 4.5 9.5 4.5 12 6c2.5-1.5 5.5-1.5 8-.5V19c-2.5-1-5.5-1-8 .5-2.5-1.5-5.5-1.5-8-.5zM12 6v13.5',
      flag: 'M5.5 21V4M5.5 4.5h11.5l-2.6 4.2 2.6 4.3H5.5',
      copy: 'M9 9h10.5v11.5H9zM15 9V4.5H4.5V15H9',
    };
    const svg = s('svg', { class: 'ic', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    if (name === 'auto') {
      svg.appendChild(s('circle', { cx: 12, cy: 12, r: 8.5 }));
      svg.appendChild(s('path', { d: 'M12 3.5a8.5 8.5 0 0 1 0 17z', class: 'ic-fill' }));
      return svg;
    }
    svg.appendChild(s('path', { d: P[name] || '', class: name === 'play' || name === 'stop' ? 'ic-fill' : null }));
    return svg;
  }

  /* Teacher's red-pen grading marks (hand-drawn paths, drawn on with a short animation). */
  const MARKS = {
    o: { sym: '○', label: '정답', paths: ['M34 9.5C20 9 9.5 19.5 9.8 33c.3 13.6 10.6 22.6 23.4 22.3 13.3-.3 22.2-10.5 21.6-23.4C54.2 19.4 45 10.6 31.5 11.6c-4.6.4-8.6 2.2-11.8 5'] },
    t: { sym: '△', label: '획순 오류', paths: ['M32.5 9.2C39.5 23 47 37 55.6 52.8c-15.6 1-31.4.9-47.2-.2C16 38.6 23.6 24 31 8.4'] },
    x: { sym: '✕', label: '오답', paths: ['M14.5 14.2c12.2 11.6 24 23.6 35.8 36', 'M50.2 13.6C38.4 26.2 26.4 38.4 13.8 50.6'] },
  };

  function markSvg(mark, cls) {
    const m = MARKS[mark] || MARKS.x;
    const svg = s('svg', { class: 'mk mk-' + mark + ' ' + (cls || ''), viewBox: '0 0 64 64', role: 'img', 'aria-label': m.label + ' ' + m.sym });
    m.paths.forEach((d) => svg.appendChild(s('path', { d, pathLength: 1 })));
    return svg;
  }

  function markChip(mark, count, extraCls) {
    const m = MARKS[mark] || MARKS.x;
    return h('span', { class: 'mchip mchip-' + mark + ' ' + (extraCls || '') },
      h('span', { class: 'mchip-sym', 'aria-hidden': 'true' }, m.sym), srOnly(m.label + ' '), count != null ? h('span', { class: 'mchip-n' }, count) : null);
  }

  const SCRIPT_LABEL = { hira: '히라가나', kata: '가타카나', mix: '혼합' };

  function badge(script, cls) {
    return h('span', { class: 'badge badge-' + script + ' ' + (cls || '') },
      h('span', { class: 'badge-glyph jp', lang: 'ja', 'aria-hidden': 'true' }, script === 'kata' ? 'ア' : 'あ'), SCRIPT_LABEL[script]);
  }

  const ISSUE_LABEL = { count: '획수', order: '획순', direction: '방향', shape: '모양', lookalike: '닮은 글자', script: '문자', size: '크기·위치', keypoint: '구별 포인트' };

  /* Form label shown with the stroke count: '2획 · 이어 쓴 형태 (명조·고딕 등 인쇄체)'. Only the std label's
   * '교과서체 · ' (the switcher already says it) and the relative '1획 적음/많음' (the count is printed) go. */
  function variantText(k, v) {
    const desc = v.label ? (v.id === 'std' ? v.label.replace(/^교과서체 · /, '') : v.label).replace(/ · 1획 (적음|많음)/, '') : '';
    return `${v.strokes.length}획${k.base ? ' (' + (k.group === 'handakuten' ? '゜' : '゛') + ' 포함)' : ''}${desc ? ' · ' + desc : ''}`;
  }

  // Romaji spellings worth showing next to a kana: the 'l' spellings and nn/m are typing leniencies only.
  const shownAlt = (k) => (k.romajiAlt || []).filter((a) => !/^l/.test(a) && a !== 'nn' && a !== 'm');

  /* Korean particles after a kana: decided by the 받침 of its Korean reading (only ん/ン → 응 have one).
   * josa(ch, '와', '과'), josa(ch, '를', '을'), josa(ch, '는', '은'); josaRo(ch) → '로' | '으로'. */
  function finalJamo(text) {
    const s = String(text || '');
    const code = s.charCodeAt(s.length - 1) - 0xac00;
    return code >= 0 && code < 11172 ? code % 28 : 0;
  }
  const koOf = (ch) => {
    const k = charInfo(ch);
    if (!k) return '';
    return k.ko || (k.big && D.kana[k.big] ? D.kana[k.big].ko : '') || shortName(ch); // っ → 츠, ー → 장음
  };
  const josa = (ch, noBatchim, batchim) => (finalJamo(koOf(ch)) ? batchim : noBatchim);
  const josaRo = (ch) => { const f = finalJamo(koOf(ch)); return f && f !== 8 ? '으로' : '로'; }; // 8 = ㄹ

  /* Any character the app can show: the 142 kana (KANA_DATA.kana) and the word-only extras
   * (KANA_DATA.extra: small kana, ヴ, ー, 、。). Extras never enter the single-kana tests or the records grid. */
  function charInfo(ch) {
    return (D && D.kana && D.kana[ch]) || (D && D.extra && D.extra[ch]) || null;
  }
  const isExtra = (ch) => !!(D && D.extra && D.extra[ch] && !D.kana[ch]);

  /* A kanji cell of 단어/문장 쓰기 (SPEC-words J) is drawn and graded but never taught here: its strokes come
   * from window.KANJI_DATA once words.js has loaded it. Same record shape as a kana (one 'std' form). */
  const kanjiCache = new Map();
  function kanjiInfo(ch) {
    const K = window.KANJI_DATA;
    const e = K && K.kanji && K.kanji[ch];
    if (!e || !Array.isArray(e.strokes) || !e.strokes.length) return null;
    let k = kanjiCache.get(ch);
    if (!k) { k = { ch, kanji: true, strokeCount: e.strokes.length, variants: [{ id: 'std', label: null, strokes: e.strokes }] }; kanjiCache.set(ch, k); }
    return k;
  }
  // Anything with stroke data: kana, extras, loaded kanji (stroke pictures and the graded-drawing detail only).
  const drawInfo = (ch) => charInfo(ch) || kanjiInfo(ch);

  // Name of an extra that has no reading of its own ('촉음', '장음', '쉼표', '마침표'); '' otherwise.
  function shortName(ch) {
    const x = D.extra && D.extra[ch];
    if (!x) return '';
    if (/^[a-z]+$/.test(x.romaji || '')) return '';
    return String(x.label || '').split(/[ ·(]/)[0];
  }
  // Reading for captions: 'ka · 카' (also ゃ 'ya · 야'), or the extra's name.
  function readingText(ch) {
    const k = charInfo(ch);
    if (!k) return '';
    if (k.romaji && /^[a-z]+$/.test(k.romaji)) return `${k.romaji} · ${k.ko}`;
    return shortName(ch);
  }

  function reduceMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  /* ================================================================ post-answer scroll (one rule for every screen)
   * revealBelow(anchor, keep, { instant, keepEnd }) — once an answer is graded: bring the result (anchor) into view
   * without pushing the control that moves on (keep: 다음 문제 / 다음, or the next step's input — an element, a list
   * of them, or null) off the screen. Used by every test / practice screen here and in js/words.js
   * (KanaApp.ui.revealBelow).
   *   · nothing moves while keep is on screen and the result already shows (its top in view, with a good part of it);
   *   · when the result and keep fit on screen together, the page scrolls just far enough to show both;
   *   · otherwise their top goes to the top of the screen, but never so far that keep leaves it — keep wins, and the
   *     learner scrolls on for the rest of the result. A keep list counts as one block from its first top to its last
   *     bottom; when even that block is taller than the screen, its top goes to the top of the screen — or, with
   *     opts.keepEnd (a block that ends with the control that moves on: an answered 뜻 step, then 다음), its bottom
   *     to the bottom.
   * So the control that moves on sits ABOVE a result that can grow tall (다음 문제 under the pad, 다음 under the
   * answer row): a keep below it would push the result's head off the top on a short screen.
   * The screen is the window below the sticky top bar (inside a dialog: its scroller below the sheet's sticky head)
   * and above an on-screen keyboard (visualViewport). Parts inside a sticky block (the wide layout's pad column) do
   * not move with the page, so they are left out. Smooth unless reduced motion is asked for (or the page is hidden);
   * opts.instant for a pad that is about to take strokes (a stroke begun while the page glides would be bent).
   * Returns true when it scrolled. */
  const REVEAL_GAP = 12;
  function revealBelow(anchor, keep, opts) {
    const o = opts || {};
    const shown = (el) => !!(el && el.isConnected && !el.hidden && el.getClientRects().length);
    const keeps = (Array.isArray(keep) ? keep : [keep]).filter(shown);
    const first = shown(anchor) ? anchor : keeps[0];
    if (!first) return false;
    const scroller = scrollParentOf(first);
    const stuck = (el) => {
      for (let x = el; x && x !== scroller && x !== document.body; x = x.parentElement) {
        if (getComputedStyle(x).position === 'sticky') return true;
      }
      return false;
    };
    const union = (rects) => rects.reduce((u, r) => (!r ? u : !u ? { top: r.top, bottom: r.bottom }
      : { top: Math.min(u.top, r.top), bottom: Math.max(u.bottom, r.bottom) }), null);
    const A = shown(anchor) && !stuck(anchor) ? anchor.getBoundingClientRect() : null;
    const K = union(keeps.filter((el) => !stuck(el)).map((el) => el.getBoundingClientRect()));
    const R = union([A, K]);
    if (!R) return false;
    // the visible band, in client coordinates
    let top = 0, bottom = window.innerHeight;
    const vv = window.visualViewport;
    if (vv) { top = Math.max(top, vv.offsetTop); bottom = Math.min(bottom, vv.offsetTop + vv.height); }
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      top = Math.max(top, sr.top + scroller.clientTop);
      bottom = Math.min(bottom, sr.top + scroller.clientTop + scroller.clientHeight);
      Array.from(scroller.children).forEach((c) => {
        if (getComputedStyle(c).position === 'sticky') top = Math.max(top, c.getBoundingClientRect().bottom);
      });
    } else {
      const bar = $('.topbar');
      if (bar && /^(sticky|fixed)$/.test(getComputedStyle(bar).position)) top = Math.max(top, bar.getBoundingClientRect().bottom);
    }
    if (bottom - top < 80) return false;                 // nothing sensible to aim at (tiny or hidden view)
    const keepIn = !K || (K.top >= top - 1 && K.bottom <= bottom + 1);
    const showMin = A ? Math.min(A.height, 200, (bottom - top) * 0.4) : 0;
    const anchorIn = !A || (A.top >= top - 1 && A.top + showMin <= bottom + 1);
    if (keepIn && anchorIn) return false;
    const lo = top + REVEAL_GAP, hi = bottom - REVEAL_GAP;
    let d;
    if (R.bottom - R.top <= hi - lo) d = R.bottom > hi ? R.bottom - hi : R.top < lo ? R.top - lo : 0;
    else {
      d = R.top - lo;
      // clamp into [K.bottom - hi, K.top - lo]; a K taller than the screen empties that range: its top (or end) wins
      if (K) d = o.keepEnd ? Math.max(Math.min(d, K.top - lo), K.bottom - hi) : Math.min(Math.max(d, K.bottom - hi), K.top - lo);
    }
    const se = scroller || document.scrollingElement || document.documentElement;
    const from = scroller ? scroller.scrollTop : window.scrollY;
    const to = Math.max(0, Math.min(from + d, se.scrollHeight - se.clientHeight));
    if (Math.abs(to - from) < 2) return false;
    const behavior = o.instant || reduceMotion() || document.hidden ? 'instant' : 'smooth';
    const target = scroller || window;
    try { target.scrollTo({ top: to, behavior }); } catch (e) { target.scrollTo(scroller ? scroller.scrollLeft : window.scrollX, to); }
    return true;
  }
  // The nearest ancestor that scrolls vertically (a dialog's panel), or null for the page itself.
  function scrollParentOf(el) {
    for (let x = el.parentElement; x && x !== document.body && x !== document.documentElement; x = x.parentElement) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(x).overflowY) && x.scrollHeight > x.clientHeight + 1) return x;
    }
    return null;
  }

  /* ================================================================ stroke pictures (kana + extras + kanji)
   * StrokeView draws the kana and (newer versions) KANA_DATA.extra. Should it not know a character (an extra
   * such as っ ー 。, or a kanji cell of 단어/문장 쓰기), the same SVG shapes are built here: the static glyph in
   * its 十 box and the numbered step frames; the detail sheet then shows a numbered glyph instead of the animation. */

  function svKnows(ch) {
    try { return SV.strokesOf(ch).length > 0; } catch (e) { return false; }
  }

  function strokesOf(ch, variantId) {
    const k = drawInfo(ch);
    if (!k) return [];
    const v = k.variants.find((x) => x.id === variantId) || k.variants[0];
    return v ? v.strokes : [];
  }

  const polyCache = new Map();
  function polyOf(d) {
    let p = polyCache.get(d);
    if (!p) { p = window.SvgPath.flatten(d, 14); polyCache.set(d, p); }
    return p;
  }

  const f1 = (v) => Math.round(v * 10) / 10;

  function boxSvg(cls, label) {
    const svg = s('svg', { viewBox: `0 0 ${VB} ${VB}`, class: 'sv ' + cls, role: label ? 'img' : null, 'aria-label': label || null, 'aria-hidden': label ? null : 'true', focusable: 'false' });
    svg.appendChild(s('rect', { x: 0.75, y: 0.75, width: VB - 1.5, height: VB - 1.5, rx: 3, class: 'sv-box' }));
    svg.appendChild(s('path', { d: `M${VB / 2},2V${VB - 2}M2,${VB / 2}H${VB - 2}`, class: 'sv-guide' }));
    return svg;
  }

  function addNum(g, pos, n, cls) {
    g.appendChild(s('text', { x: f1(pos.x), y: f1(pos.y), class: 'sv-num ' + (cls || ''), 'text-anchor': 'middle', 'dominant-baseline': 'central' }, String(n)));
  }

  function addArrow(g, ar, cls) {
    if (!ar) return;
    const [a, b] = ar.line;
    const [t, l, r] = ar.head;
    g.appendChild(s('path', { d: `M${f1(a[0])},${f1(a[1])}L${f1(b[0])},${f1(b[1])}`, class: 'sv-arrow-line ' + (cls || '') }));
    g.appendChild(s('path', { d: `M${f1(t[0])},${f1(t[1])}L${f1(l[0])},${f1(l[1])}L${f1(r[0])},${f1(r[1])}Z`, class: 'sv-arrow-head ' + (cls || '') }));
  }

  // Static glyph in its box (KanjiVG coordinates = its real place in the cell). opts: { variantId, numbers, label, className }
  function strokeGlyph(ch, opts) {
    const o = opts || {};
    if (svKnows(ch)) return SV.glyph(ch, o);
    const svg = boxSvg('sv-static ' + (o.className || ''), o.label);
    const strokes = strokesOf(ch, o.variantId);
    const g = s('g', { class: 'sv-ink' });
    strokes.forEach((d) => g.appendChild(s('path', { d, class: 'sv-stroke' })));
    svg.appendChild(g);
    if (o.numbers) {
      const ng = s('g', { class: 'sv-nums' });
      SV.labelPositions(strokes.map(polyOf)).forEach((p, i) => addNum(ng, p, i + 1));
      svg.appendChild(ng);
    }
    return svg;
  }

  // Cumulative step frames (same look as StrokeView.frames).
  function strokeFrames(ch, opts) {
    const o = opts || {};
    if (svKnows(ch)) return SV.frames(ch, o);
    const strokes = strokesOf(ch, o.variantId);
    const polys = strokes.map(polyOf);
    const pos = SV.labelPositions(polys);
    const list = h('ol', { class: 'sv-frames ' + (o.className || ''), 'aria-label': '획순 단계' });
    strokes.forEach((d, i) => {
      const svg = boxSvg('sv-step', `${i + 1}번째 획`);
      const todo = s('g', { class: 'sv-todo' }), done = s('g', { class: 'sv-ink' }), cur = s('g', { class: 'sv-cur' });
      strokes.forEach((dd, j) => { if (j < i) done.appendChild(s('path', { d: dd, class: 'sv-stroke' })); else if (j > i) todo.appendChild(s('path', { d: dd, class: 'sv-stroke' })); });
      cur.appendChild(s('path', { d, class: 'sv-stroke' }));
      const p0 = polys[i][0];
      cur.appendChild(s('circle', { cx: f1(p0[0]), cy: f1(p0[1]), r: 3.2, class: 'sv-start' }));
      addArrow(cur, SV.arrowFor(polys[i], polys), 'is-cur');
      const ng = s('g', { class: 'sv-nums' });
      addNum(ng, pos[i], i + 1, 'is-cur');
      [todo, done, cur, ng].forEach((g) => svg.appendChild(g));
      list.appendChild(h('li', { class: 'sv-frame' }, svg, h('span', { class: 'sv-frame-n' }, String(i + 1))));
    });
    return list;
  }

  /* ================================================================ persistence
   * The ONE place that knows where persisted state lives. Screens only touch state.settings / state.stats /
   * state.prefs in memory, call persist() after a change, and read stats for display through viewStats().
   *   persistence.load()           → { settings, stats, prefs } as stored (raw; sanitized by the caller)
   *   persistence.save(snapshot)   ← { settings, stats, prefs }
   *   persistence.stats(state)     → stats to SHOW / weigh with (records; the '…위주' options of a test)
   *   persistence.resetStats(state)  clears the learner's records
   *   persistence.isLocal()        → false when nothing survives a reload (storage blocked → in-memory only)
   * With js/store.js loaded (the normal case) everything goes through KanaStore (SPEC-words F): load →
   * KanaStore.init({ key }) (state.stats IS the store's live device-stats object), save → KanaStore.saveState(),
   * stats → KanaStore.allStats() (this device + the learner's other devices), resetStats → KanaStore.resetStats()
   * (every device), isLocal → status().local === 'ok' or the cloud mirror is on. Remote / other-tab merges arrive
   * through KanaStore.onChange (wired in init(): adopt settings / device stats, re-render home & 기록).
   * Without KanaStore (store.js missing) the old single localStorage key is used, every access guarded. */
  const KS = window.KanaStore && typeof window.KanaStore.init === 'function' ? window.KanaStore : null;

  // KanaStore's status().uid: the claude.ai account its data is bound to (null: none yet); undefined when the store
  // does not report it.
  function storeUid() {
    if (!KS) return undefined;
    try {
      const st = KS.status();
      if (st && typeof st === 'object' && 'uid' in st) return typeof st.uid === 'string' && st.uid ? st.uid : null;
    } catch (e) { /* not reported */ }
    return undefined;
  }
  // The account this browser's data belongs to: the store's, else the uid KanaStore's main record carries
  // (<key>.uid, written on every local save); null outside claude.ai.
  function accountUid() {
    const u = storeUid();
    if (u !== undefined) return u;
    try {
      const v = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null');
      return v && typeof v === 'object' && typeof v.uid === 'string' && v.uid ? v.uid : null;
    } catch (e) { return null; }
  }
  // An opaque, stable tag for an account id (FNV-1a): reports are told apart without storing the id with them.
  function acctTag(uid) {
    let x = 0x811c9dc5;
    const str = String(uid);
    for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    return 'a' + x.toString(36) + '-' + str.length.toString(36);
  }

  const persistence = {
    available: true,
    store: KS,
    load() {
      if (KS) {
        try { return KS.init({ key: STORE_KEY }); } catch (e) { console.error(e); }
      }
      let raw = null;
      try { raw = window.localStorage.getItem(STORE_KEY); } catch (e) { this.available = false; return null; }
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    },
    save(snap) {
      if (KS) {
        KS.saveState({ settings: snap.settings, stats: snap.stats, prefs: snap.prefs });
        updateStorageNote();
        return true;
      }
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, settings: snap.settings, stats: snap.stats, prefs: snap.prefs }));
        return true;
      } catch (e) {
        if (this.available) { this.available = false; showStorageNote(); }
        return false;
      }
    },
    stats(st) { return KS ? KS.allStats() : st.stats; },
    resetStats(st) {
      if (KS) { st.stats = KS.resetStats(); this.save(st); return; }
      st.stats = Q.emptyStats(); this.save(st);
    },
    isLocal() {
      if (!KS) return this.available;
      const s = KS.status();
      return s.local === 'ok' || s.cloud === 'on';
    },
    /* '판정 신고' — drawings the learner flagged with '판정이 이상해요', for improving the judge. Their own
     * localStorage key (<key>:reports, newest last, ≤ REPORTS_MAX in all), deliberately outside KanaStore: they never
     * reach the cloud mirror or any network; the learner exports them by copying JSON from 기록. Read fresh on every
     * call (another tab may have added some); without usable storage they live in memory for this page only.
     * Like KanaStore's data they belong to the claude.ai account this browser is bound to: each report carries an
     * opaque tag of that account (`acct`, a hash of the id — never the id itself, and left out of exports), and every
     * call below sees only the current account's reports. Untagged ones (saved before any account was known, or by an
     * older version) go to the first account that reads them; with no account (outside claude.ai) only they are seen.
     *   reports.list() → [report]   reports.add(report) → { ok, count, memory, dropped }   reports.remove(id)   reports.clear()
     *   (dropped = older reports removed to make room: past REPORTS_MAX, or storage full)
     *   reports.exportable(report) → the report as exported (no account tag) */
    reports: {
      mem: null, // in-memory list (every account's) when localStorage is unusable
      owner() { const uid = accountUid(); return uid ? acctTag(uid) : null; },
      // this account's reports; claims the untagged ones once an account is known
      read() {
        const all = this.readAll(), me = this.owner();
        if (me && all.some((x) => !x.acct)) { all.forEach((x) => { if (!x.acct) x.acct = me; }); this.write(all); }
        return all.filter((x) => (x.acct || null) === me);
      },
      readAll() {
        if (this.mem) return this.mem.slice();
        let raw = null;
        try { raw = window.localStorage.getItem(REPORTS_KEY); } catch (e) { this.mem = []; return []; }
        let list = [];
        try { const v = raw ? JSON.parse(raw) : null; list = v && Array.isArray(v.reports) ? v.reports : []; } catch (e) { list = []; }
        return list.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && Number.isFinite(x.ts) && typeof x.target === 'string')
          .map((x) => (x.acct == null || typeof x.acct === 'string' ? x : Object.assign({}, x, { acct: null })))
          .slice(-REPORTS_MAX);
      },
      // → { local: saved to localStorage, kept: how many of the newest reports were kept }
      write(list) {
        if (this.mem) { this.mem = list.slice(-REPORTS_MAX); return { local: false, kept: this.mem.length }; }
        let keep = list.slice(-REPORTS_MAX);
        // storage full: drop the oldest reports until the list fits (at least the newest one is tried)
        while (keep.length) {
          try { window.localStorage.setItem(REPORTS_KEY, JSON.stringify({ v: 1, reports: keep })); return { local: true, kept: keep.length }; } catch (e) {
            if (keep.length === 1) break;
            keep = keep.slice(Math.ceil(keep.length / 4));
          }
        }
        this.mem = list.slice(-REPORTS_MAX);
        return { local: false, kept: this.mem.length };
      },
      list() { return this.read(); },
      add(rep) {
        this.read(); // claim untagged reports first
        const me = this.owner();
        const all = this.readAll();
        all.push(Object.assign({}, rep, { acct: me }));
        const w = this.write(all);
        const mine = (x) => (x.acct || null) === me;
        const cut = Math.max(0, all.length - w.kept); // the oldest ones that did not fit
        return { ok: true, count: all.slice(cut).filter(mine).length, memory: !w.local, dropped: all.slice(0, cut).filter(mine).length };
      },
      remove(id) {
        const me = this.owner();
        this.write(this.readAll().filter((x) => !(x.id === id && (x.acct || null) === me)));
      },
      // this account's reports only; the key goes when nothing else is left in it
      clear() {
        const me = this.owner();
        const rest = this.readAll().filter((x) => (x.acct || null) !== me);
        if (rest.length) { this.write(rest); return; }
        if (this.mem) { this.mem = []; return; }
        try { window.localStorage.removeItem(REPORTS_KEY); } catch (e) { this.mem = []; }
      },
      exportable(x) { const o = Object.assign({}, x); delete o.acct; return o; },
    },
  };

  // prefs.ext = { <module>: plain JSON object } — UI preferences of other modules (KanaApp.getPrefs / setPrefs),
  // e.g. the 단어장 practice setup. Kept opaque here; each module sanitizes its own.
  const EXT_PREFS_MAX = 8000;
  function sanitizeExtPrefs(ext) {
    const out = {};
    if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return out;
    for (const k of Object.keys(ext).slice(0, 8)) {
      const v = ext[k];
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
      try { const j = JSON.stringify(v); if (j.length <= EXT_PREFS_MAX) out[k] = JSON.parse(j); } catch (e) { /* not JSON-safe: drop */ }
    }
    return out;
  }

  function sanitizePrefs(p) {
    const o = { theme: 'system', chartView: 'hira', recordsView: 'hira', guide: true, ext: {} };
    if (!p || typeof p !== 'object') return o;
    if (['system', 'light', 'dark'].includes(p.theme)) o.theme = p.theme;
    if (['hira', 'kata', 'both'].includes(p.chartView)) o.chartView = p.chartView;
    if (['hira', 'kata'].includes(p.recordsView)) o.recordsView = p.recordsView;
    if (typeof p.guide === 'boolean') o.guide = p.guide;
    o.ext = sanitizeExtPrefs(p.ext);
    return o;
  }

  const saved = persistence.load() || {};
  const state = {
    screen: 'home',
    params: null,
    settings: Q.sanitizeSettings(saved.settings),
    // KanaStore hands out its LIVE device-stats object (already sanitized with Quiz): keep that identity, so
    // merges from other tabs / devices land in what the app records into.
    stats: KS && saved.stats && typeof saved.stats === 'object' && saved.stats.chars ? saved.stats : Q.sanitizeStats(saved.stats),
    prefs: sanitizePrefs(saved.prefs),
    test: null,
    lastTest: null,
  };

  function persist() { persistence.save(state); }
  function viewStats() { return persistence.stats(state); }

  /* ================================================================ toast / notes */

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), 3200);
  }

  function showStorageNote() {
    const n = $('#storage-note');
    if (n) n.hidden = false;
  }

  // KanaStore: the footer note follows status() (nothing survives a reload: no localStorage and no cloud mirror).
  function updateStorageNote() {
    const n = $('#storage-note');
    if (n) n.hidden = persistence.isLocal();
  }

  /* ================================================================ dialogs */

  const supportsDialog = typeof HTMLDialogElement === 'function' && typeof HTMLDialogElement.prototype.showModal === 'function';
  // Without HTMLDialogElement a <dialog> has no `open` property: the attribute is the source of truth.
  const isOpen = (d) => (supportsDialog ? !!d.open : d.hasAttribute('open'));

  function openDialog(d) {
    if (isOpen(d)) return;
    if (supportsDialog) d.showModal();
    else { d.setAttribute('open', ''); d.classList.add('dialog-fallback'); }
    syncModalClass();
  }

  function closeDialog(d) {
    if (!isOpen(d)) return;
    if (supportsDialog) d.close();
    else { d.removeAttribute('open'); d.dispatchEvent(new Event('close')); }
    syncModalClass();
  }

  function syncModalClass() {
    document.documentElement.classList.toggle('modal-open', anyDialogOpen());
    // a pad behind a modal no longer holds the page pinned for a nearby pen (DrawPad.Ink.nearZone)
    if (DP && DP.Ink && DP.Ink.nearSync) DP.Ink.nearSync(document);
  }

  function anyDialogOpen() {
    return Array.from(document.querySelectorAll('dialog')).some(isOpen);
  }

  function wireDialog(d, onClose) {
    d.addEventListener('click', (e) => { if (e.target === d) closeDialog(d); });
    d.addEventListener('close', () => { syncModalClass(); if (onClose) onClose(); });
    d.addEventListener('cancel', () => setTimeout(syncModalClass, 0));
  }

  /* After a dialog (컨닝, confirm, detail sheet) closes during a test, give the keyboard back to the question:
   * the answer box in 읽기, the page (Enter = 채점 / 다음) in 쓰기. The close event fires after the browser's own
   * focus restore (to the button that opened the dialog), so this wins. */
  function refocusTest() {
    if (anyDialogOpen() || !state.test || !state.test.active) return;
    const target = state.screen === 'read' ? $('#answer') : state.screen === 'write' ? $('#main') : null;
    if (target) { try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); } }
  }

  // In-page confirmation (alert/confirm/prompt are not allowed). opts: { title, message|body, ok, cancel, danger }
  let pendingConfirm = null;
  function askConfirm(opts) {
    const d = $('#confirm');
    if (pendingConfirm) pendingConfirm(false, true); // a newer question replaces an unanswered one
    return new Promise((resolve) => {
      let answered = false;
      // A late 'close' event from an earlier confirm must not answer this one: only a real close counts.
      const onClose = () => { if (!isOpen(d)) done(false); };
      const done = (v, keepOpen) => {
        if (answered) return;
        answered = true;
        d.removeEventListener('close', onClose);
        if (pendingConfirm === done) pendingConfirm = null;
        if (!keepOpen) closeDialog(d);
        resolve(v);
      };
      pendingConfirm = done;
      d.textContent = '';
      const msg = opts.message || opts.body;
      const ok = h('button', { type: 'button', class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'), on: { click: () => done(true) } }, opts.ok || '확인');
      const cancel = h('button', { type: 'button', class: 'btn', on: { click: () => done(false) } }, opts.cancel || '취소');
      d.appendChild(h('div', { class: 'confirm-panel' },
        h('h2', { id: 'confirm-title', class: 'confirm-title' }, opts.title),
        msg ? h('p', { class: 'confirm-msg' }, msg) : null,
        h('div', { class: 'confirm-actions' }, cancel, ok)));
      d.addEventListener('close', onClose);
      openDialog(d);
      cancel.focus();
    });
  }

  /* ================================================================ routing & chrome */

  const disposers = [];
  function onCleanup(fn) { disposers.push(fn); }
  function cleanupScreen() {
    while (disposers.length) { try { disposers.pop()(); } catch (e) { console.error(e); } }
  }

  // Built-in screens: SCREENS[id](main, params). Screens added by other modules through
  // KanaApp.registerScreen live in REGISTERED as well (nav tab + #id deep link).
  const SCREENS = {};
  const REGISTERED = {};
  let pendingRoute = null; // a #id deep link whose screen was not registered yet
  let started = false;

  /* Show a screen. opts: { params, force (skip the leave confirmations), keepScroll, noFocus,
   *   reentry (the current registered screen re-selected from the nav: its confirmLeave() still applies) } */
  function go(screen, opts) {
    const o = opts || {};
    if (!SCREENS[screen]) screen = 'home';
    if (state.test && state.test.active && !o.force && screen !== state.screen) {
      confirmQuit(screen, o.params);
      return;
    }
    const leaving = REGISTERED[state.screen];
    if (leaving && leaving.confirmLeave && !o.force && (screen !== state.screen || o.reentry)) {
      let ask = null;
      try { ask = leaving.confirmLeave(); } catch (e) { console.error(e); }
      if (ask) {
        askConfirm(typeof ask === 'object' ? ask : { title: String(ask), ok: '나가기', cancel: '계속하기', danger: true })
          .then((yes) => { if (yes) go(screen, Object.assign({}, o, { force: true })); else setHash(state.screen); });
        return;
      }
    }
    cleanupScreen();
    state.screen = screen;
    state.params = o.params || null;
    updateNav();
    setHash(screen);
    const main = $('#main');
    main.textContent = '';
    main.dataset.screen = screen;
    try { SCREENS[screen](main, state.params); } catch (e) {
      console.error(e);
      main.textContent = '';
      main.appendChild(h('p', { class: 'note-warn' }, '이 화면을 여는 중에 문제가 생겼어요.'));
    }
    if (!o.keepScroll) window.scrollTo(0, 0);
    if (!o.noFocus) {
      const target = main.querySelector('[data-autofocus]') || main.querySelector('h1');
      if (target) {
        if (!target.hasAttribute('tabindex') && !/^(INPUT|BUTTON|TEXTAREA|SELECT|A)$/.test(target.tagName)) target.setAttribute('tabindex', '-1');
        try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
      }
    }
  }

  const hashId = () => (location.hash || '').replace(/^#/, '');
  const routable = (id) => id === 'chart' || id === 'records' || !!REGISTERED[id];

  function routeFromHash() {
    const hsh = hashId();
    if (hsh === '' || hsh === 'home') return 'home';
    return routable(hsh) ? hsh : null;
  }

  function setHash(screen) {
    const want = routable(screen) ? '#' + screen : '';
    if ((location.hash || '') === want) return;
    try {
      history.replaceState(null, '', want || location.pathname + location.search);
    } catch (e) {
      try { if (want) location.hash = want; } catch (e2) { /* ignore */ }
    }
  }

  function updateNav() {
    const ids = Array.from(document.querySelectorAll('[data-nav]')).map((b) => b.dataset.nav);
    const cur = ids.includes(state.screen) ? state.screen : 'home';
    document.querySelectorAll('[data-nav]').forEach((b) => {
      if (b.dataset.nav === cur) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    document.documentElement.classList.toggle('in-test', !!(state.test && state.test.active));
  }

  // Nav tab for a registered screen, placed before 기록 (연습 / 글자표 / 단어장 / 기록).
  function addNavTab(id, label) {
    const nav = $('.tabs');
    if (!nav || nav.querySelector(`[data-nav="${id}"]`)) return;
    const b = h('button', { type: 'button', class: 'tab', 'data-nav': id }, label);
    const before = nav.querySelector('[data-nav="records"]');
    if (before) nav.insertBefore(b, before); else nav.appendChild(b);
    updateNav();
  }

  function onNavClick(target) {
    if (state.test && state.test.active) {
      if (target === 'chart') { openCheat(); return; }
      confirmQuit(target);
      return;
    }
    if (target === 'chart' && chartHandled()) return;
    // Re-selecting the tab of the registered screen on show (단어장 → back to its list) asks the same leave
    // question as switching away — e.g. mid-practice or with an unsaved form.
    go(target, target === state.screen && REGISTERED[target] ? { reentry: true } : undefined);
  }

  // 글자표 tab / #chart while a registered screen is shown: that screen may handle it (a running 단어 practice
  // opens the chart overlay as 컨닝, like the kana tests) — true = handled, stay.
  function chartHandled() {
    const def = REGISTERED[state.screen];
    if (!def || typeof def.chartNav !== 'function') return false;
    try { return !!def.chartNav(); } catch (e) { console.error(e); return false; }
  }

  function confirmQuit(target, params) {
    const t = state.test;
    askConfirm({
      title: '테스트를 그만둘까요?',
      message: t.answers.length ? `지금까지 푼 ${t.answers.length}문제는 기록에 남고 결과 화면으로 가요.` : '아직 푼 문제가 없어요.',
      ok: '그만두기', cancel: '계속 풀기', danger: true,
    }).then((yes) => {
      if (!yes) return;
      if (t.answers.length) finishTest();
      else { state.test = null; go(target || 'home', { force: true, params }); }
    });
  }

  /* ---------------------------------------------------------------- theme */

  function applyTheme() {
    const t = state.prefs.theme;
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    const btn = $('#theme-btn');
    if (btn) {
      btn.textContent = '';
      const name = t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'auto';
      btn.appendChild(icon(name));
      const label = t === 'light' ? '밝은 화면' : t === 'dark' ? '어두운 화면' : '기기 설정 따름';
      btn.setAttribute('aria-label', '화면 테마: ' + label + ' (눌러서 바꾸기)');
      btn.title = '화면 테마: ' + label;
    }
    padRegistry.forEach((p) => p.redraw());
  }

  const padRegistry = new Set();
  function trackPad(p) { padRegistry.add(p); return p; }
  function dropPad(p) { if (p) { padRegistry.delete(p); p.destroy(); } }

  /* ================================================================ chart builders */

  const COLS = ['a', 'i', 'u', 'e', 'o'];

  function kanaTable(rowIds, view, cellFn, caption) {
    const rows = D.rows.filter((r) => rowIds.includes(r.id));
    const table = h('table', { class: 'ktable view-' + view });
    if (caption) table.appendChild(h('caption', { class: 'sr-only' }, caption));
    table.appendChild(h('thead', null, h('tr', null,
      h('th', { scope: 'col', class: 'kt-corner' }, srOnly('행')),
      COLS.map((c) => h('th', { scope: 'col', class: 'kt-col' }, c)))));
    const tb = h('tbody');
    for (const r of rows) {
      const lab = (view === 'kata' ? r.kata : r.hira).find(Boolean);
      const tr = h('tr', null, h('th', { scope: 'row', class: 'kt-row' }, jp(lab), srOnly('행')));
      for (let c = 0; c < 5; c++) {
        const pair = { hira: r.hira[c], kata: r.kata[c] };
        tr.appendChild(h('td', { class: 'kt-cell' }, pair.hira || pair.kata ? cellFn(pair, view) : null));
      }
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    return table;
  }

  function cellButton(ch, onPick, compact) {
    const k = D.kana[ch];
    const multi = k.variants.length > 1;
    return h('button', {
      type: 'button', class: 'kcell s-' + k.script + (compact ? ' kcell-sm' : ''), 'data-ch': ch,
      'aria-label': `${ch} ${k.romaji} ${k.ko}${multi ? ', 쓰는 방법 2가지' : ''}`,
      on: { click: () => onPick(ch) },
    },
    h('span', { class: 'kc-glyph jp', lang: 'ja', 'aria-hidden': 'true' }, ch),
    compact ? null : h('span', { class: 'kc-read', 'aria-hidden': 'true' }, h('span', { class: 'kc-romaji' }, k.romaji), h('span', { class: 'kc-ko' }, k.ko)),
    multi ? h('span', { class: 'kc-badge', 'aria-hidden': 'true' }, '2') : null);
  }

  function chartCell(onPick) {
    return (pair, view) => {
      if (view === 'both') {
        const k = D.kana[pair.hira];
        return h('div', { class: 'kpair' },
          h('div', { class: 'kpair-glyphs' }, cellButton(pair.hira, onPick, true), cellButton(pair.kata, onPick, true)),
          h('span', { class: 'kc-read', 'aria-hidden': 'true' }, h('span', { class: 'kc-romaji' }, k.romaji), h('span', { class: 'kc-ko' }, k.ko)));
      }
      return cellButton(pair[view], onPick);
    };
  }

  function confusableCards(view, onPick) {
    const groups = D.confusableGroups.filter((g) => !g.derived && (view === 'both' || g.chars.some((c) => D.kana[c].script === view)));
    return h('div', { class: 'cgroups' }, groups.map((g) => h('article', { class: 'cgroup' + (g.cross ? ' is-cross' : '') },
      h('div', { class: 'cgroup-chars' }, g.chars.map((c) => {
        const k = D.kana[c];
        return h('button', { type: 'button', class: 'cg-char s-' + k.script, 'aria-label': `${c} ${k.romaji} ${k.ko}`, on: { click: () => onPick(c) } },
          jp(c, 'cg-glyph'), h('span', { class: 'cg-read', 'aria-hidden': 'true' }, k.romaji));
      })),
      g.cross ? h('p', { class: 'cgroup-kind' }, '히라가나 ↔ 가타카나') : null,
      h('p', { class: 'cgroup-tip' }, richText(g.tip)))));
  }

  /* 작은 글자·기호 (KANA_DATA.extra) — needed for words and sentences; never in the tests or the records grid.
   * Each cell is a small 원고지 box so the glyph shows its size and place in the cell. A group's title names only what
   * the current view shows (name: 나란히 view, nameHira / nameKata: one script); a group with nothing to show is left
   * out (ー and ヴ belong to katakana: the 히라가나 view lists only the punctuation). */
  const EXTRA_GROUPS = [
    { name: '작은 모음', hira: 'ぁぃぅぇぉ', kata: 'ァィゥェォ' },
    { name: '촉음 (작은 つ·ツ)', nameHira: '촉음 (작은 つ)', nameKata: '촉음 (작은 ツ)', hira: 'っ', kata: 'ッ' },
    { name: '요음에 쓰는 작은 글자', hira: 'ゃゅょ', kata: 'ャュョ' },
    { name: '장음 · ヴ', hira: '', kata: 'ーヴ' },
    { name: '문장 부호', hira: '、。', kata: '、。' },
  ];
  const extraGroupName = (g, view) => (view === 'hira' && g.nameHira) || (view === 'kata' && g.nameKata) || g.name;

  function extraButton(ch, onPick) {
    const x = D.extra[ch];
    const read = /^[a-z]+$/.test(x.romaji || '')
      ? [h('span', { class: 'kc-romaji' }, x.romaji), h('span', { class: 'kc-ko' }, x.ko)]
      : h('span', { class: 'kc-ko' }, shortName(ch));
    return h('button', {
      type: 'button', class: 'kcell xcell s-' + x.script, 'data-ch': ch, 'aria-label': `${ch} ${x.label}`,
      on: { click: () => onPick(ch) },
    },
    h('span', { class: 'kbox xcell-box', 'aria-hidden': 'true' }, h('span', { class: 'xcell-glyph jp', lang: 'ja' }, ch)),
    h('span', { class: 'kc-read', 'aria-hidden': 'true' }, read));
  }

  function extraCells(view, onPick) {
    const wrap = h('div', { class: 'xgroups' });
    for (const g of EXTRA_GROUPS) {
      const chars = [];
      const addChars = (str) => Array.from(str).forEach((c) => { if (D.extra[c] && !chars.includes(c)) chars.push(c); });
      if (view !== 'kata') addChars(g.hira);
      if (view !== 'hira') addChars(g.kata);
      if (!chars.length) continue;
      wrap.appendChild(h('div', { class: 'xgroup' },
        h('p', { class: 'xgroup-name' }, richText(extraGroupName(g, view))),
        h('div', { class: 'xgroup-cells' }, chars.map((c) => extraButton(c, onPick)))));
    }
    return wrap;
  }

  /* 요음 reading reference (きゃ … ぴょ) from KanaText.YOON (js/romaji.js). Returns null — the chart then simply
   * has no 요음 section — when that module is missing or its table is unusable. Not interactive, not tested. */
  function yoonTable(view) {
    try {
      const T = window.KanaText;
      const list = T && Array.isArray(T.YOON) ? T.YOON : [];
      const rows = [];
      const byBase = new Map();
      for (const y of list) {
        if (!y || typeof y.hira !== 'string' || typeof y.kata !== 'string') continue;
        const hs = Array.from(y.hira), ks = Array.from(y.kata);
        const col = 'ゃゅょ'.indexOf(hs[1]);
        if (hs.length !== 2 || ks.length !== 2 || col < 0) continue;
        let row = byBase.get(hs[0]);
        if (!row) { row = { hira: hs[0], kata: ks[0], cells: [null, null, null] }; byBase.set(hs[0], row); rows.push(row); }
        row.cells[col] = y;
      }
      if (!rows.length) return null;
      const smalls = view === 'kata' ? ['ャ', 'ュ', 'ョ'] : ['ゃ', 'ゅ', 'ょ'];
      const glyphs = (y) => (view === 'both'
        ? h('span', { class: 'yc-glyphs' }, jp(y.hira, 'yc-glyph s-hira'), jp(y.kata, 'yc-glyph s-kata'))
        : h('span', { class: 'yc-glyphs' }, jp(view === 'kata' ? y.kata : y.hira, 'yc-glyph')));
      const table = h('table', { class: 'ktable ytable view-' + view },
        h('caption', { class: 'sr-only' }, '요음 표'),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col', class: 'kt-corner' }, srOnly('행')),
          ['ya', 'yu', 'yo'].map((c, i) => h('th', { scope: 'col', class: 'kt-col' }, jp(smalls[i], 'yt-small'), ' ', c)))),
        h('tbody', null, rows.map((r) => h('tr', null,
          h('th', { scope: 'row', class: 'kt-row' }, jp(view === 'kata' ? r.kata : r.hira), srOnly('행')),
          r.cells.map((y) => h('td', { class: 'kt-cell' }, y ? h('div', { class: 'ycell' },
            glyphs(y),
            h('span', { class: 'kc-read' }, h('span', { class: 'kc-romaji' }, String(y.romaji || '')), h('span', { class: 'kc-ko' }, String(y.ko || '')))) : null))))));
      return table;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  function segmented(name, label, options, value, onChange, cls) {
    const id = 'seg-' + name + '-' + Math.random().toString(36).slice(2, 7);
    return h('fieldset', { class: 'seg-field ' + (cls || '') },
      h('legend', { class: label ? 'field-label' : 'sr-only', id }, label || name),
      h('div', { class: 'seg' }, options.map((o) => h('label', { class: 'seg-opt' },
        h('input', {
          type: 'radio', name: id, value: String(o.value), checked: String(o.value) === String(value) ? true : null,
          'aria-label': o.aria || null,
          on: { change: (e) => { if (e.target.checked) onChange(o.value); } },
        }),
        h('span', { class: 'seg-face' }, o.glyph ? jp(o.glyph, 'seg-glyph') : null, o.label)))));
  }

  function buildChart(view, onPick, opts) {
    const o = opts || {};
    const wrap = h('div', { class: 'chart' });
    const sections = [];
    const jump = h('nav', { class: 'chart-jump', 'aria-label': '글자표 구역' });
    const addSection = (title, sub, body) => {
      const sec = h('section', { class: 'chart-sec' }, h('h2', { class: 'chart-h' }, title, sub ? h('small', null, sub) : null), body);
      sections.push(sec);
      jump.appendChild(h('button', { type: 'button', class: 'chip chip-link', on: { click: () => sec.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }) } }, title));
      return sec;
    };
    const cell = chartCell(onPick);
    addSection('기본 (청음)', '46자', kanaTable(Q.BASIC_ROWS, view, cell, '기본 글자표'));
    addSection('탁음 · 반탁음', '゛ ゜', kanaTable(Q.DAKUTEN_ROWS.concat(Q.HANDAKUTEN_ROWS), view, cell, '탁음·반탁음 글자표'));
    const yoon = yoonTable(view);
    if (yoon) {
      addSection('요음', view === 'kata' ? 'キャ キュ キョ' : 'きゃ きゅ きょ', h('div', { class: 'ysec' },
        h('p', { class: 'sec-note' }, view === 'kata' ? 'イ단 글자 뒤에 작은 ャ·ュ·ョ를 붙여 한 소리로 읽어요. 읽기 참고용이에요.'
          : view === 'both' ? 'い단(イ단) 글자 뒤에 작은 ゃ·ゅ·ょ(ャ·ュ·ョ)를 붙여 한 소리로 읽어요. 읽기 참고용이에요.'
            : 'い단 글자 뒤에 작은 ゃ·ゅ·ょ를 붙여 한 소리로 읽어요. 읽기 참고용이에요.'), yoon));
    }
    if (D.extra) {
      addSection('작은 글자·기호', view === 'kata' ? 'ッ ャ ー 。' : view === 'both' ? 'っ ャ ー 。' : 'っ ゃ 、 。', h('div', { class: 'xsec' },
        h('p', { class: 'sec-note' }, '단어·문장을 쓸 때 필요한 글자예요. 누르면 칸 안의 크기·위치와 획순을 볼 수 있어요.'),
        extraCells(view, onPick)));
    }
    addSection('헷갈리는 글자', null, confusableCards(view, onPick));
    if (!o.noJump) wrap.appendChild(jump);
    wrap.appendChild(h('p', { class: 'chart-legend' },
      h('span', { class: 'kc-badge kc-badge-inline', 'aria-hidden': 'true' }, '2'), ' 쓰는 방법이 두 가지인 글자 (둘 다 정답)'));
    sections.forEach((x) => wrap.appendChild(x));
    return wrap;
  }

  /* ================================================================ 홈 */

  SCREENS.home = function (main) {
    const st = state.settings;
    const summary = h('p', { class: 'range-summary', 'aria-live': 'polite' });
    const startRead = h('button', { type: 'button', class: 'start-btn start-read', on: { click: () => startTest('read') } },
      h('span', { class: 'start-glyph jp', lang: 'ja', 'aria-hidden': 'true' }, 'あ'),
      h('span', { class: 'start-text' }, h('span', { class: 'start-title' }, '읽기 테스트'), h('span', { class: 'start-desc' }, '글자를 보고 발음 입력')),
      icon('arrow'));
    const startWrite = h('button', { type: 'button', class: 'start-btn start-write', on: { click: () => startTest('write') } },
      h('span', { class: 'start-glyph start-glyph-pen', 'aria-hidden': 'true' }, icon('pen')),
      h('span', { class: 'start-text' }, h('span', { class: 'start-title' }, '쓰기 테스트'), h('span', { class: 'start-desc' }, '발음을 보고 글자 그리기')),
      icon('arrow'));

    const chipsBox = h('div', { class: 'row-chips' });

    function chipLabel(chip) {
      const scr = st.script === 'kata' ? 'kata' : 'hira';
      if (chip.id === 'wa') return scr === 'kata' ? 'ワ·ン' : 'わ·ん';
      const row = D.rows.find((r) => r.id === chip.rows[0]);
      return row[scr].find(Boolean);
    }

    function renderChips() {
      chipsBox.textContent = '';
      const groups = [['basic', '청음'], ['dakuten', '탁음'], ['handakuten', '반탁음']];
      for (const [g, name] of groups) {
        const line = h('div', { class: 'chip-line' }, h('span', { class: 'chip-group' }, name));
        Q.ROW_CHIPS.filter((c) => c.group === g).forEach((chip) => {
          const on = chip.rows.every((r) => st.rows.includes(r));
          line.appendChild(h('button', {
            type: 'button', class: 'chip chip-row', 'aria-pressed': on ? 'true' : 'false', 'aria-label': chipLabel(chip) + '행',
            on: { click: () => {
              const next = new Set(st.rows);
              if (on) chip.rows.forEach((r) => next.delete(r)); else chip.rows.forEach((r) => next.add(r));
              st.rows = Q.ALL_ROWS.filter((r) => next.has(r));
              changed();
            } },
          }, jp(chipLabel(chip))));
        });
        chipsBox.appendChild(line);
      }
    }

    function renderSummary() {
      const n = Q.charsFor(st, D).length;
      if (!n) summary.textContent = '행을 하나 이상 골라 주세요.';
      else if (st.count === 'endless') summary.textContent = `선택한 글자 ${n}자 → 무한 모드 (그만할 때까지)`;
      else {
        const q = Q.questionCount(st, n);
        // every char once (전체, or a count equal to the selection): the '…위주' options have nothing to weigh
        const once = q === n && (st.focusConfusable || st.focusWrong || st.focusLess);
        summary.textContent = `선택한 글자 ${n}자 → ${q}문제${q > n ? ' (같은 글자가 여러 번 나와요)' : once ? ' (모두 한 번씩 나와서 「…위주」는 적용되지 않아요)' : ''}`;
      }
      summary.classList.toggle('is-empty', !n);
      startRead.disabled = !n;
      startWrite.disabled = !n;
    }

    function changed() { persist(); renderChips(); renderSummary(); }

    const hasStats = Q.hasHistory(viewStats());
    const strictField = segmented('strict', '쓰기 채점', [
      { value: 'lenient', label: '너그럽게' }, { value: 'normal', label: '보통' }, { value: 'strict', label: '엄격하게' },
    ], st.strictness, (v) => { st.strictness = v; persist(); });
    const strictHint = h('p', { class: 'seg-hint', id: 'strict-hint' }, '글자 모양을 얼마나 깐깐하게 볼지 정해요. 획순·방향 채점은 같아요.');
    strictField.appendChild(strictHint);
    strictField.setAttribute('aria-describedby', 'strict-hint');

    const setup = h('section', { class: 'card setup', 'aria-labelledby': 'setup-h' },
      h('h2', { class: 'card-h', id: 'setup-h' }, '테스트 설정'),
      segmented('script', '문자', [
        { value: 'hira', label: '히라가나', glyph: 'あ' }, { value: 'kata', label: '가타카나', glyph: 'ア' }, { value: 'mix', label: '혼합', glyph: 'あア' },
      ], st.script, (v) => { st.script = v; changed(); }),
      h('fieldset', { class: 'seg-field' },
        h('legend', { class: 'field-label' }, '범위'),
        chipsBox,
        h('div', { class: 'quick-row' },
          h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => { st.rows = Q.BASIC_ROWS.slice(); changed(); } } }, '기본 46자 전체'),
          h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => { st.rows = Q.ALL_ROWS.slice(); changed(); } } }, '전체 (탁음·반탁음 포함)'),
          h('button', { type: 'button', class: 'btn btn-sm btn-quiet', on: { click: () => { st.rows = []; changed(); } } }, '모두 해제')),
        summary),
      segmented('count', '문제 수', [
        { value: 10, label: '10' }, { value: 20, label: '20' }, { value: 30, label: '30' }, { value: 'all', label: '전체' },
        { value: 'endless', label: '∞ 무한', aria: '무한 — 그만할 때까지' },
      ], st.count, (v) => { st.count = v; changed(); }, 'seg-count'),
      h('fieldset', { class: 'seg-field' },
        h('legend', { class: 'field-label' }, '옵션'),
        toggleRow('헷갈리는 글자 위주', '닮은 글자가 있는 글자를 더 자주 내요.', st.focusConfusable, (v) => { st.focusConfusable = v; persist(); renderSummary(); }),
        toggleRow('틀린 글자 위주', hasStats ? '기록에서 자주 틀린 글자를 더 자주 내요.' : '기록이 쌓이면 자주 틀린 글자를 더 자주 내요.', st.focusWrong, (v) => { st.focusWrong = v; persist(); renderSummary(); }),
        toggleRow('학습 덜 한 글자 위주', '덜 풀어 본 글자, 오래 안 푼 글자를 더 자주 내요.', !!st.focusLess, (v) => {
          // kept only while on (absent = off), the shape Q.sanitizeSettings gives back
          if (v) st.focusLess = true; else delete st.focusLess;
          persist();
          renderSummary();
        }),
        h('p', { class: 'seg-hint' }, '「…위주」는 그 글자를 더 자주 낼 뿐, 다른 글자도 계속 나와요. 함께 켜면 효과가 겹쳐요.')),
      h('details', { class: 'more' },
        h('summary', null, '세부 설정'),
        segmented('font', '읽기 글꼴', [
          { value: 'textbook', label: '교과서체' }, { value: 'gothic', label: '고딕' }, { value: 'mix', label: '섞기' },
        ], st.readFont, (v) => { st.readFont = v; persist(); }),
        strictField,
        toggleRow('펜 전용 모드', '펜이 감지되면 손가락·손바닥 터치를 무시해요.', st.penOnly, (v) => { st.penOnly = v; persist(); })));

    const recent = viewStats().sessions.slice(-1)[0];
    const side = h('div', { class: 'home-side' },
      h('div', { class: 'start-box' }, startRead, startWrite),
      h('button', { type: 'button', class: 'chart-entry', on: { click: () => go('chart') } },
        h('span', { class: 'chart-entry-glyphs jp', lang: 'ja', 'aria-hidden': 'true' }, h('span', null, 'あいうえお'), h('span', null, 'アイウエオ')),
        h('span', { class: 'chart-entry-text' }, h('span', { class: 'chart-entry-title' }, '글자표'), h('span', { class: 'chart-entry-desc' }, '획순 애니메이션 · 헷갈리는 글자 · 따라 써보기')),
        icon('arrow')),
      recent ? h('button', { type: 'button', class: 'last-session', on: { click: () => go('records') } },
        h('span', { class: 'last-label' }, '최근 테스트'),
        h('span', { class: 'last-body' }, `${recent.mode === 'write' ? '쓰기' : '읽기'} · ${SCRIPT_LABEL[recent.script] || ''}${recent.endless ? ' · ∞ 무한' : ''} · ${recent.n}문제`),
        h('span', { class: 'last-marks' }, markChip('o', recent.o), recent.mode === 'write' ? markChip('t', recent.tri) : null, markChip('x', recent.x))) : null);

    main.appendChild(h('div', { class: 'home' },
      h('header', { class: 'page-head' },
        h('h1', { class: 'page-title' }, '오늘의 연습'),
        h('p', { class: 'page-sub' }, '히라가나·가타카나를 읽고, 펜으로 직접 써 보세요. 획순까지 확인해 드려요.')),
      h('div', { class: 'home-grid' }, setup, side)));
    renderChips();
    renderSummary();
  };

  function toggleRow(label, hint, value, onChange) {
    const id = 'tg-' + Math.random().toString(36).slice(2, 8);
    return h('div', { class: 'toggle-row' },
      h('input', { type: 'checkbox', class: 'switch', id, role: 'switch', checked: value ? true : null, 'aria-describedby': id + '-d', on: { change: (e) => onChange(e.target.checked) } }),
      h('label', { for: id, class: 'toggle-label' }, label),
      h('p', { class: 'toggle-hint', id: id + '-d' }, hint));
  }

  /* ================================================================ test lifecycle
   * state.test = { mode, script, active, retry, label, questions: [{ ch, script, font, retry? }], index, answers, cur,
   *                endless: null | { run, pool, mult } }   — 무한 모드 appends one question at a time (Q.nextEndless). */

  function makeQuestion(q) {
    const pref = state.settings.readFont;
    return { ch: q.ch, script: q.script, font: pref === 'mix' ? (Math.random() < 0.5 ? 'textbook' : 'gothic') : pref };
  }

  function nextEndlessQuestion(t) {
    const e = t.endless;
    const pick = Q.nextEndless(e.run, e.pool, e.mult, Math.random, { pairOf: (c) => (D.kana[c] ? D.kana[c].pair : null) });
    return Object.assign(makeQuestion({ ch: pick.key, script: D.kana[pick.key].script }), { retry: pick.retry });
  }

  function startTest(mode, chars, meta) {
    const st = state.settings;
    const endless = !chars && st.count === 'endless';
    let pool = [];
    let endlessRun = null;
    if (endless) {
      const all = Q.charsFor(st, D);
      // the '…위주' multipliers come from the history before the run (SPEC-words A): taken once, kept with the run
      if (all.length) {
        const mult = Q.focusTable(all, Q.endlessStatsOf(viewStats(), mode, st, D, all));
        endlessRun = { run: Q.endlessStart({ retryTri: mode === 'write' }), pool: all, mult };
      }
    } else {
      pool = chars ? Q.poolFromChars(chars, D, Math.random) : Q.buildPool(st, D, viewStats(), Math.random, mode);
    }
    if (!pool.length && !endlessRun) { toast('선택한 글자가 없어요. 범위를 골라 주세요.'); return; }
    let script = st.script;
    if (chars) {
      const scripts = new Set(pool.map((q) => q.script));
      script = scripts.size > 1 ? 'mix' : pool[0].script;
    }
    const t = {
      mode, script, active: true, retry: !!chars, label: (meta && meta.label) || null, endless: endlessRun,
      questions: pool.map(makeQuestion), index: 0, answers: [], cur: null,
    };
    if (endlessRun) t.questions.push(nextEndlessQuestion(t));
    state.test = t;
    go(mode, { force: true });
  }

  function newCur() {
    return { cheat: false, graded: false, practice: false };
  }

  // A graded answer of the running test (무한 모드: a ✕ — or △ in writing — is scheduled for a spaced retry, once per
  // char per run and within 15 % of the questions; SPEC-words A).
  function addAnswer(t, answer) {
    t.answers.push(answer);
    if (t.endless) Q.endlessRecord(t.endless.run, answer.ch, answer.mark, Math.random, t.endless.pool.length);
  }

  // Move to the next question; false when a finite test is over.
  function advance(t) {
    t.index++;
    if (t.endless && t.index >= t.questions.length) t.questions.push(nextEndlessQuestion(t));
    return t.index < t.questions.length;
  }

  const isLastQuestion = (t) => !t.endless && t.index + 1 >= t.questions.length;

  // Ends the test (그만하기 / last question / confirmed quit): an unanswered current question is not counted.
  function finishTest() {
    const t = state.test;
    if (!t) return;
    t.active = false;
    const sum = Q.summarize(t.answers);
    if (t.answers.length) {
      Q.recordSession(state.stats, Object.assign({ mode: t.mode, script: t.script, retry: t.retry, endless: !!t.endless }, sum));
      persist();
    }
    state.lastTest = t;
    state.test = null;
    go(t.answers.length ? 'result' : 'home', { force: true });
  }

  function testBar(t, onQuit) {
    const endless = !!t.endless;
    const label = h('span', { class: 'tb-n' });
    const fill = h('span', { class: 'tb-fill' });
    const bar = endless ? null : h('div', { class: 'tb-bar', role: 'progressbar', 'aria-label': '진행', 'aria-valuemin': 0, 'aria-valuemax': t.questions.length }, fill);
    const tally = h('div', { class: 'tally', role: 'group', 'aria-label': '지금까지 결과' });
    const quit = endless
      ? h('button', { type: 'button', class: 'btn btn-sm tb-stop', on: { click: () => finishTest() } }, icon('stop'), '그만하기')
      : h('button', { type: 'button', class: 'btn btn-sm btn-quiet tb-quit', on: { click: onQuit } }, '그만두기');
    const el = h('div', { class: 'test-bar' + (endless ? ' is-endless' : '') },
      quit,
      h('div', { class: 'tb-mid' },
        h('span', { class: 'tb-kind' }, (t.mode === 'write' ? '쓰기' : '읽기') + ' · ' + (t.label || SCRIPT_LABEL[t.script]) + (endless ? ' · 무한 모드' : '')),
        h('div', { class: 'tb-progress' }, bar, label)),
      tally);
    function update() {
      if (endless) {
        label.textContent = `∞ · ${t.index + 1}문제째`;
      } else {
        const i = Math.min(t.index + 1, t.questions.length);
        label.textContent = `${i} / ${t.questions.length}`;
        fill.style.width = (100 * t.answers.length / t.questions.length).toFixed(1) + '%';
        bar.setAttribute('aria-valuenow', t.answers.length);
      }
      const sum = Q.summarize(t.answers);
      tally.textContent = '';
      tally.appendChild(markChip('o', sum.o));
      if (t.mode === 'write') tally.appendChild(markChip('t', sum.t));
      tally.appendChild(markChip('x', sum.x));
    }
    update();
    return { el, update };
  }

  function cheatTag() {
    return h('span', { class: 'cheat-tag', hidden: true }, h('span', { 'aria-hidden': 'true' }, '컨닝'), srOnly('컨닝한 문제'));
  }

  // 무한 모드: marks a question that came back because it was missed a few questions ago.
  function retryTag() {
    return h('span', { class: 'retry-tag', hidden: true }, '다시 나온 문제');
  }

  /* ================================================================ 읽기 테스트 */

  SCREENS.read = function (main) {
    const t = state.test;
    if (!t) { go('home', { force: true }); return; }
    const bar = testBar(t, () => confirmQuit('home'));
    const glyph = h('div', { class: 'q-glyph jp', lang: 'ja' });
    const tag = cheatTag();
    const again = retryTag();
    const scriptNote = h('span', { class: 'q-script' });
    const input = h('input', {
      id: 'answer', type: 'text', class: 'answer-input', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off',
      spellcheck: 'false', enterkeyhint: 'done', placeholder: '로마자 또는 한글로 입력', 'aria-describedby': 'answer-help', 'data-autofocus': true,
    });
    const submitBtn = h('button', { type: 'button', class: 'btn btn-primary answer-go', on: { click: () => submit() } }, '확인');
    const feedback = h('div', { class: 'feedback', 'aria-live': 'polite' });
    const nextBtn = h('button', { type: 'button', class: 'btn btn-primary btn-next', hidden: true, on: { click: () => next() } }, '다음', h('kbd', null, 'Enter'), icon('arrow'));
    const skipBtn = h('button', { type: 'button', class: 'btn', on: { click: () => skip() } }, '모르겠어요');
    const cheatBtn = h('button', { type: 'button', class: 'btn', on: { click: () => openCheat() } }, icon('grid'), '컨닝 (글자표)');

    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.isComposing || e.keyCode === 229) return; // Korean IME still composing: let it commit first
      e.preventDefault();
      if (t.cur && t.cur.graded) next(); else submit();
    });

    // The action row sits right under the answer row, above the feedback: once graded it holds only 다음, so 다음
    // stays on screen above the result however tall it gets (look-alike comparison) — as 다음 문제 sits above the
    // result in the 쓰기 test. Before grading the feedback is empty and nothing changes.
    main.appendChild(h('section', { class: 'test test-read', 'aria-label': '읽기 테스트' },
      bar.el,
      h('div', { class: 'read-layout' },
        h('div', { class: 'q-card card' },
          h('div', { class: 'q-card-top' }, h('span', { class: 'q-kind' }, '이 글자는?'), scriptNote, again, tag),
          h('div', { class: 'kbox q-box' }, glyph),
          segmented('qfont', '글꼴', [{ value: 'textbook', label: '교과서체' }, { value: 'gothic', label: '고딕' }, { value: 'mix', label: '섞기' }],
            state.settings.readFont, (v) => {
              state.settings.readFont = v;
              persist();
              for (let i = t.index; i < t.questions.length; i++) t.questions[i].font = v === 'mix' ? (Math.random() < 0.5 ? 'textbook' : 'gothic') : v;
              applyFont();
            }, 'font-toggle')),
        h('div', { class: 'answer card' },
          h('label', { for: 'answer', class: 'answer-label' }, '발음을 입력하세요'),
          h('p', { class: 'answer-help', id: 'answer-help' }, '로마자로 써도, 한글로 써도 정답으로 인정해요.'),
          h('div', { class: 'answer-row' }, input, submitBtn),
          h('div', { class: 'test-actions' }, skipBtn, cheatBtn, nextBtn),
          feedback))));

    function show() {
      const q = t.questions[t.index];
      t.cur = newCur();
      glyph.textContent = q.ch;
      applyFont();
      scriptNote.textContent = '';
      tag.hidden = true;
      again.hidden = !q.retry;
      input.value = '';
      input.readOnly = false;
      input.classList.remove('is-right', 'is-wrong');
      feedback.textContent = '';
      submitBtn.hidden = false;
      skipBtn.hidden = false;
      cheatBtn.hidden = false;
      nextBtn.hidden = true;
      bar.update();
      try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    }

    function applyFont() {
      const q = t.questions[t.index];
      glyph.className = 'q-glyph jp ' + (q.font === 'gothic' ? 'f-gothic' : 'f-textbook');
    }

    function nudge(text) {
      feedback.textContent = '';
      feedback.appendChild(h('p', { class: 'fb-nudge' }, text));
      input.focus();
    }

    function submit() {
      if (t.cur.graded) return;
      const q = t.questions[t.index];
      const res = Q.checkReading(input.value, q.ch, D);
      if (res.empty) { nudge('답을 입력해 주세요. 모르겠으면 「모르겠어요」를 누르세요.'); return; }
      // Kana typed through a Japanese IME is a keyboard problem, not a wrong reading: ask again, record nothing.
      if (res.kind === 'other' && /[぀-ヿ]/.test(input.value)) {
        nudge('가나 대신 로마자나 한글로 입력해 주세요. 일본어 키보드가 켜져 있으면 바꿔 주세요.');
        return;
      }
      grade(res.correct, res, input.value);
    }

    function skip() {
      if (t.cur.graded) return;
      grade(false, { skipped: true, lookalike: null, readingOf: [] }, '');
    }

    function grade(correct, res, given) {
      const q = t.questions[t.index];
      const k = D.kana[q.ch];
      const cur = t.cur;
      cur.graded = true;
      cur.answerY = window.scrollY;
      const answer = { ch: q.ch, mark: correct ? 'o' : 'x', cheat: cur.cheat, input: given, skipped: !!res.skipped, lookalike: res.lookalike || null, readingOf: res.readingOf || [] };
      addAnswer(t, answer);
      Q.recordReading(state.stats, q.ch, { correct, cheat: cur.cheat, confusedWith: res.lookalike ? res.lookalike.ch : null });
      persist();
      input.readOnly = true;
      input.classList.add(correct ? 'is-right' : 'is-wrong');
      scriptNote.textContent = '';
      scriptNote.appendChild(badge(k.script, 'badge-sm'));
      submitBtn.hidden = true;
      skipBtn.hidden = true;
      cheatBtn.hidden = true;
      nextBtn.hidden = false;
      feedback.textContent = '';
      feedback.appendChild(readingFeedback(answer));
      bar.update();
      // the feedback comes up under 다음, which stays on screen (a look-alike comparison runs on below the fold)
      revealBelow(feedback, nextBtn);
      try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    }

    function next() {
      if (!t.cur.graded) return;
      const y = t.cur.answerY || 0;
      if (!advance(t)) { finishTest(); return; }
      show();
      // revealBelow may have scrolled the page: back to where the answer was typed (the next glyph above the input,
      // the input above an on-screen keyboard that stayed up). At once — this also stops a reveal still gliding.
      window.scrollTo({ top: y, behavior: 'auto' });
    }

    onCleanup(() => { /* nothing persistent */ });
    main._readApi = { submit, next, skip };
    show();
  };

  function readingFeedback(a) {
    const k = D.kana[a.ch];
    const correct = a.mark === 'o';
    const alt = shownAlt(k);
    const wrap = h('div', { class: 'fb fb-' + a.mark });
    wrap.appendChild(h('div', { class: 'fb-head' },
      markSvg(a.mark, 'mk-md'),
      h('div', { class: 'fb-text' },
        h('p', { class: 'fb-title' }, correct ? '정답!' : a.skipped ? '정답을 확인하세요' : '아쉬워요'),
        h('p', { class: 'fb-reading' }, jp(a.ch, 'fb-glyph'), ' = ', h('b', null, k.romaji), ' · ', h('b', null, k.ko),
          alt.length ? h('span', { class: 'fb-alt' }, ` (${alt.join(', ')}도 정답)`) : null),
        !correct && a.input ? h('p', { class: 'fb-given' }, '입력한 답: ', h('span', { class: 'given' }, a.input)) : null,
        a.cheat ? h('p', { class: 'fb-cheat' }, '컨닝한 문제로 기록돼요.') : null)));
    if (!correct && a.lookalike) {
      wrap.appendChild(lookalikeBox(a.ch, a.lookalike.ch, a.lookalike.tip, { question: '문제', other: '입력한 발음의 글자' }));
    } else if (!correct && a.readingOf && a.readingOf.length) {
      // the input is that kana's reading, so the kana's Korean reading decides the particle (ka → 카는, n → 응은)
      wrap.appendChild(h('p', { class: 'fb-note' }, `「${a.input.trim()}」${josa(a.readingOf[0], '는', '은')} `, a.readingOf.slice(0, 3).map((c, i) => [i ? ', ' : '', jp(c)]), '의 발음이에요.'));
    }
    return wrap;
  }

  // Reading in parentheses after a glyph: 'ma', or the extra's name ('촉음').
  function parenRead(ch) {
    const k = charInfo(ch);
    if (!k) return '';
    return k.romaji && /^[a-z]+$/.test(k.romaji) ? k.romaji : shortName(ch);
  }

  /* "X와 헷갈렸나요?" — both glyphs side by side + the look-alike group tip. Works for kana and extras. */
  function lookalikeBox(target, other, tip, labels, opts) {
    const o = opts || {};
    const useStrokes = !!o.strokes;
    // opts.kp = { glyph, note }: the target drawn with its 구별 포인트 rings (graded drawings)
    const kp = o.kp && o.kp.glyph ? o.kp : null;
    const fig = (ch, cap, cls, kpFig) => h('figure', { class: 'la-fig ' + (cls || '') + (kpFig ? ' has-kp' : '') },
      kpFig ? h('div', { class: 'la-svg' }, kpFig.glyph)
        : useStrokes ? h('div', { class: 'la-svg' }, strokeGlyph(ch, { label: ch })) : h('div', { class: 'kbox la-box' }, jp(ch, 'la-glyph')),
      h('figcaption', null, h('span', { class: 'la-read' }, jp(ch, 'la-small'), ' ' + readingText(ch)), h('span', { class: 'la-cap' }, cap),
        kpFig ? h('span', { class: 'la-kp legend' }, kpFig.note) : null));
    const title = o.title || [jp(other), `(${parenRead(other)})${josa(other, '와', '과')} 헷갈렸나요?`];
    return h('div', { class: 'lookalike', role: 'note' },
      h('p', { class: 'la-q' }, title),
      h('div', { class: 'la-pair' },
        fig(target, labels.question, 'is-target', kp),
        h('span', { class: 'la-vs', 'aria-hidden': 'true' }, '↔'),
        fig(other, labels.other, 'is-other')),
      tip ? h('p', { class: 'la-tip' }, h('b', null, '구별법 '), richText(tip)) : null,
      h('div', { class: 'la-links' },
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet', on: { click: () => openDetail(target) } }, jp(target), ' 획순 보기'),
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet', on: { click: () => openDetail(other) } }, jp(other), ' 획순 보기')));
  }

  /* ================================================================ 쓰기 테스트 */

  SCREENS.write = function (main) {
    const t = state.test;
    if (!t) { go('home', { force: true }); return; }
    const bar = testBar(t, () => confirmQuit('home'));
    const tag = cheatTag();
    const again = retryTag();
    const promptCard = h('div', { class: 'prompt card w-prompt' });
    const padHost = h('div', { class: 'pad-host' });
    const counter = h('span', { class: 'stroke-count', 'aria-live': 'polite' });
    const resultBox = h('section', { class: 'w-result', 'aria-live': 'polite', 'aria-label': '채점 결과' });
    const practiceNote = h('p', { class: 'practice-note', hidden: true }, '연습 중이에요 — 다시 채점해도 이 문제의 기록은 바뀌지 않아요.');
    const gradeBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg grade-btn', on: { click: () => grade() } }, '채점', h('kbd', null, 'Enter'));
    // A pointer click on a pad tool hands the keyboard back to the page (Enter = 채점); keyboard activation
    // (click with detail 0) keeps focus on the button.
    const tool = (fn) => (e) => { fn(); if (e && e.detail > 0) pullFocus(); };
    const undoBtn = h('button', { type: 'button', class: 'btn btn-sm tool-btn', 'aria-label': '되돌리기', on: { click: tool(() => pad.undo()) }, title: '되돌리기 (Ctrl+Z)' }, icon('undo'), h('span', { class: 'tool-text' }, '되돌리기'));
    const clearBtn = h('button', { type: 'button', class: 'btn btn-sm tool-btn', 'aria-label': '지우기', on: { click: tool(() => pad.clear()) }, title: '모두 지우기' }, icon('clear'), h('span', { class: 'tool-text' }, '지우기'));
    const penToggle = h('label', { class: 'pen-toggle' },
      h('input', { type: 'checkbox', class: 'switch switch-sm', role: 'switch', checked: state.settings.penOnly ? true : null,
        on: { change: (e) => { state.settings.penOnly = e.target.checked; pad.setPenOnly(e.target.checked); persist(); updatePenHint(); } } }),
      h('span', null, '펜 전용'));
    const penHint = h('span', { class: 'pen-hint' });
    const skipBtn = h('button', { type: 'button', class: 'btn', 'data-act': 'skip', on: { click: () => skip() } }, '모르겠어요');
    const cheatBtn = h('button', { type: 'button', class: 'btn', 'data-act': 'cheat', 'aria-label': '컨닝 (글자표)', title: '컨닝 (글자표)', on: { click: () => openCheat() } }, icon('grid'), h('span', { class: 'act-text' }, '컨닝'));
    const padNext = h('button', { type: 'button', class: 'btn btn-primary btn-lg grade-btn pad-next', hidden: true, on: { click: () => next() } }, '다음 문제', h('kbd', null, 'Enter'), icon('arrow'));
    // 채점 / 모르겠어요 / 컨닝 — and 다음 문제 once graded — sit at the foot of the prompt card, and the pad tools right
    // above the pad (with a clear band before the box, css .pad-tools-top), so the question, its buttons, 되돌리기 /
    // 지우기 and the whole box are on one screen without scrolling.
    const actRow = h('div', { class: 'act-row' }, gradeBtn, padNext, skipBtn, cheatBtn);
    const promptMain = h('div', { class: 'prompt-main' });
    promptCard.append(promptMain, actRow);

    main.appendChild(h('section', { class: 'test test-write', 'aria-label': '쓰기 테스트' },
      bar.el,
      h('div', { class: 'write-layout' },
        promptCard,
        h('div', { class: 'w-pad' },
          practiceNote,
          h('div', { class: 'pad-tools pad-tools-top' }, undoBtn, clearBtn, counter, h('span', { class: 'pad-tools-gap' }), penToggle),
          padHost,
          penHint),
        resultBox)));

    // Drawing a stroke pulls keyboard focus off the last-clicked control (tool button, 컨닝, pen switch),
    // so Enter grades instead of re-activating that control.
    function pullFocus() {
      if (anyDialogOpen() || document.activeElement === main) return;
      try { main.focus({ preventScroll: true }); } catch (e) { main.focus(); }
    }

    const pad = trackPad(DP.create(padHost, {
      penOnly: state.settings.penOnly,
      label: '글자 쓰는 칸 — 펜이나 손가락으로 쓰세요',
      onChange: (strokes, info) => {
        updateCounter(strokes.length);
        updatePenHint();
        if (info && info.reason === 'stroke') pullFocus();
      },
    }));
    onCleanup(() => dropPad(pad));

    function updateCounter(n) {
      counter.textContent = '';
      counter.appendChild(h('b', null, String(n)));
      counter.appendChild(document.createTextNode('획'));
    }

    function updatePenHint() {
      penHint.textContent = pad.hasSeenPen() && pad.isPenOnly() ? '펜이 감지됐어요 — 손가락 터치는 무시해요.' : '';
    }

    function show() {
      const q = t.questions[t.index];
      const k = D.kana[q.ch];
      t.cur = newCur();
      promptMain.textContent = '';
      promptCard.className = 'prompt card w-prompt s-' + k.script + (t.script === 'mix' ? ' is-mix' : '');
      tag.hidden = true;
      again.hidden = !q.retry;
      const alt = shownAlt(k);
      // one line: 'あ 히라가나로 쓰세요   ka 카' (tags at its end), the hint (if any) under it
      add(promptMain, [
        h('div', { class: 'prompt-top' },
          h('p', { class: 'prompt-label' }, badge(k.script, t.script === 'mix' ? 'badge-lg' : ''), h('span', null, '로 쓰세요')),
          h('p', { class: 'prompt-say' },
            h('span', { class: 'prompt-romaji', lang: 'en' }, k.romaji,
              alt.length ? h('span', { class: 'prompt-alt' }, ' / ' + alt.slice(0, 2).join(' / ')) : null),
            h('span', { class: 'prompt-ko' }, k.ko)),
          h('span', { class: 'prompt-tags' }, again, tag)),
        k.hint ? h('p', { class: 'prompt-hint' }, h('span', { class: 'prompt-hint-label' }, '힌트'), h('span', null, richText(k.hint))) : null]);
      skipBtn.hidden = false;
      cheatBtn.hidden = false;
      resultBox.textContent = '';
      practiceNote.hidden = true;
      pad.clear();
      pad.setEnabled(true);
      pad.setGuideGlyph(null);
      updateCounter(0);
      updatePenHint();
      gradeBtn.hidden = false;
      gradeBtn.disabled = false;
      padNext.hidden = true;
      bar.update();
    }

    function grade() {
      const q = t.questions[t.index];
      const cur = t.cur;
      if (cur.graded && !cur.practice) return;
      const strokes = pad.getStrokes();
      if (!strokes.length) { toast('칸 안에 글자를 먼저 써 주세요.'); return; }
      let result;
      const t0 = performance.now();
      try {
        result = window.KanaRecognizer.judge(strokes, q.ch, { strictness: state.settings.strictness });
      } catch (e) {
        console.error(e);
        toast('채점 중 문제가 생겼어요. 다시 써 보세요.');
        return;
      }
      result._ms = performance.now() - t0;
      result._opts = { strictness: state.settings.strictness }; // for '판정이 이상해요' reports
      const mark = Q.markOfVerdict(result.verdict);
      const box = pad.getBoxSize();
      if (!cur.graded) {
        cur.graded = true;
        addAnswer(t, { ch: q.ch, mark, cheat: cur.cheat, result, strokes, box });
        Q.recordWriting(state.stats, q.ch, { mark, cheat: cur.cheat, confusedWith: confusedOf(result, q.ch) });
        persist();
        bar.update();
      }
      pad.setEnabled(false);
      gradeBtn.hidden = true;
      skipBtn.hidden = true;
      cheatBtn.hidden = true;
      practiceNote.hidden = true;
      renderResult({ ch: q.ch, mark, result, strokes, box, practice: cur.practice, cheat: cur.cheat, firstMark: t.answers[t.answers.length - 1].mark });
    }

    function skip() {
      const q = t.questions[t.index];
      const cur = t.cur;
      if (cur.graded) return;
      cur.graded = true;
      addAnswer(t, { ch: q.ch, mark: 'x', cheat: cur.cheat, skipped: true, result: null, strokes: [], box: pad.getBoxSize() });
      Q.recordWriting(state.stats, q.ch, { mark: 'x', cheat: cur.cheat });
      persist();
      bar.update();
      pad.setEnabled(false);
      gradeBtn.hidden = true;
      skipBtn.hidden = true;
      cheatBtn.hidden = true;
      renderResult({ ch: q.ch, mark: 'x', result: null, strokes: [], box: pad.getBoxSize(), skipped: true, cheat: cur.cheat });
    }

    function practiceAgain() {
      t.cur.practice = true;
      pad.clear();
      pad.setEnabled(true);
      updateCounter(0);
      gradeBtn.hidden = false;
      padNext.hidden = true;
      practiceNote.hidden = false;
      resultBox.classList.add('is-stale');
      // back to the pad: all of it on screen, then 채점 above it, as far as they fit (instant: a stroke begun while the
      // page glides would be bent by it)
      revealBelow(actRow, [padHost, gradeBtn], { instant: true });
      gradeBtn.focus({ preventScroll: true });
    }

    function next() {
      if (!t.cur.graded) return;
      if (!advance(t)) { finishTest(); return; }
      show();
      window.scrollTo({ top: 0, behavior: 'auto' });
    }

    function renderResult(info) {
      resultBox.textContent = '';
      resultBox.classList.remove('is-stale');
      const nextLabel = isLastQuestion(t) ? '결과 보기' : '다음 문제';
      const panel = writingResultPanel(info, {
        source: 'test',
        actions: [
          h('button', { type: 'button', class: 'btn', on: { click: practiceAgain } }, icon('pen'), '다시 써보기'),
          h('button', { type: 'button', class: 'btn btn-primary btn-next', 'data-next': true, on: { click: next } },
            nextLabel, h('kbd', null, 'Enter'), icon('arrow')),
        ],
      });
      resultBox.appendChild(panel);
      padNext.hidden = false;
      padNext.firstChild.textContent = nextLabel;
      // the result comes up under 다음 문제 (right below the pad), which stays on screen
      revealBelow(resultBox, padNext);
      padNext.focus({ preventScroll: true });
    }

    main._writeApi = {
      enter() { if (!gradeBtn.hidden) grade(); else if (t.cur.graded) next(); },
      undo() { if (pad.isEnabled()) pad.undo(); },
      pad,
    };
    show();
  };

  // The look-alike recorded for a writing answer: the recognizer's confusedWith, or the other script.
  function confusedOf(result, ch) {
    if (!result) return null;
    const k = D.kana[ch];
    const c = result.confusedWith || (result.crossScript ? (result.recognized || (k ? k.pair : null)) : null);
    return c && !(D.sameShape || []).some((p) => p.includes(c) && p.includes(ch)) ? c : null; // (り/リ: drawing either is right)
  }

  /* ================================================================ graded-drawing detail (shared component)
   * One component wherever a drawing is graded: the 쓰기 test result, the 결과 list, the chart's 따라 써보기 and,
   * through KanaApp.ui.judgeDetail, every 원고지 cell of 단어/문장 쓰기 — so they all look and read the same.
   *   result   JudgeResult (KanaRecognizer or KanjiJudge), or null (모르겠어요 / empty cell)
   *   strokes  the user's strokes in drawing order
   *   o.ch       target char (default result.target): kana, extra, or a kanji in the loaded KANJI_DATA
   *              (no stroke data → the drawing with '채점하지 않아요', no mark)
   *   o.variant  form to show as 바른 획순 (default result.variantId)
   *   o.box      pad side length in px, or a cell box { x, y, w, h } in the strokes' coordinates
   *   o.mark     'o' | 't' | 'x' (default from result.verdict)       o.skipped / o.empty  모르겠어요 / 빈칸
   *   o.cheat, o.practice, o.firstMark, o.compact, o.actions (Element[])   test-screen extras
   *   o.source   'test' | 'result' | 'practice' | 'word' (default: 'word' for a cell box, else 'test') — for reports
   *   o.report   false hides the '판정이 이상해요' control (shown for every graded drawing otherwise)
   * Red strokes in '내가 쓴 순서' (contract with js/recognizer.js — JudgeResult.structure, tolerated when absent):
   *   reversed ∪ structure.misplaced ∪ merged ∪ split ∪ extra.
   * 구별 포인트 (JudgeResult.keypoints, tolerated when absent — kanji cells, older results): the critical points the judge
   *   measured, on the correct glyph — inside the look-alike comparison when the drawing was read as that look-alike,
   *   else in a small block; missed ones (✕) also listed by number in the issues ('놓친 곳'), weak ones on a ○/△ as a
   *   gentle '주의'. Strictness / box of the judge call are taken from result._opts when the caller set it. */

  function badStrokes(r, n) {
    const bad = new Set();
    if (!r) return bad;
    const addAll = (list) => { if (Array.isArray(list)) list.forEach((i) => { if (Number.isInteger(i) && i >= 0 && i < n) bad.add(i); }); };
    addAll(r.reversed);
    const st = r.structure;
    if (st && typeof st === 'object') {
      addAll(Array.isArray(st.misplaced) ? st.misplaced : (r.orderErrors || []).map((e) => e.user));
      addAll(st.merged);
      addAll(st.split);
      addAll(st.extra);
      addAll(st.specks);
    } else {
      // Recognizer without `structure`: order errors and, for △, unmatched strokes and two strokes on one
      // template stroke (a ✕ mapping is against a shape that did not match, so it is not painted).
      addAll((r.orderErrors || []).map((e) => e.user));
      const map = Array.isArray(r.mapping) ? r.mapping : [];
      if (r.verdict === 'order') {
        addAll(map.map((m, i) => (m === -1 ? i : -1)));
        addAll(map.map((m, i) => (m >= 0 && map.indexOf(m) !== map.lastIndexOf(m) ? i : -1)));
      }
    }
    return bad;
  }

  // Strokes + box in pad px (box = side length) or in a cell box {x, y, w, h} → what StrokeView.userDrawing takes.
  function drawingFrame(strokes, box) {
    if (box && typeof box === 'object') {
      const ox = box.x || 0, oy = box.y || 0;
      return { strokes: strokes.map((st) => st.map((p) => [p[0] - ox, p[1] - oy])), box: Math.max(box.w || 0, box.h || 0) || null };
    }
    return { strokes, box: box || null };
  }

  // っ written big (target small, read as つ) or や written small (target big, read as ゃ).
  function sizeTwin(target, other) {
    const xt = isExtra(target) ? D.extra[target] : null, xo = isExtra(other) ? D.extra[other] : null;
    if (xt && xt.big === other) return 'big';
    if (xo && xo.big === target) return 'small';
    return null;
  }

  /* ---------------------------------------------------------------- 구별 포인트 (key points)
   * The judge measures every drawing at the places that tell a character from its look-alikes (JudgeResult.keypoints,
   * KanaRecognizer.keypoints(ch, variantId) — docs/SPEC.md "Key points"). They are drawn on the CORRECT glyph
   * (StrokeView.keypointGlyph; x, y in the 109 box of KANA_DATA): in the chart's '구별 포인트' (numbered, grouped by
   * look-alike) and in the graded-drawing detail (hit = calm ring, missed = red-pen ring + number listed in the
   * issues, weak on a ○/△ = dashed ring). Only critical points are shown; points closer than KP_NEAR share one
   * marker. Results without keypoints (kanji cells, older recognizers) and forms without critical points show none.
   * The chart lists, per look-alike, how to write each place so it is not that look-alike (point.hint[lookalike]) when
   * the recognizer gives it, else the point's label (the place only). */
  const KP_NEAR = 8;
  const KP_RANK = { hit: 0, info: 1, weak: 2, miss: 3 };
  const KP_SHOW = 4; // missed places named on a graded drawing (the rest: '그 밖에 N곳')
  const KP_KIND_ORDER = ['loop', 'hook', 'dot', 'count', 'direction', 'cross', 'corner', 'end', 'start', 'feature'];

  // the textbook difference of a classic pair (id 'lead-<C>'): first in its marker, first in its look-alike's group
  const kpIsLead = (p, other) => /^lead-/.test(String(p.id)) && (!other || p.against.includes(other));
  const kpValid = (p) => !!p && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y) && typeof p.label === 'string'
    && p.critical === true && Array.isArray(p.against) && p.against.length > 0;

  function kpOfForm(ch, variantId) {
    const R = window.KanaRecognizer;
    if (!R || typeof R.keypoints !== 'function' || !charInfo(ch)) return null;
    try {
      const k = R.keypoints(ch, variantId);
      return k && Array.isArray(k.points) ? k : null;
    } catch (e) { return null; }
  }

  // Points → markers [{ x, y, state, stroke, direction, items: [{ p, state }] }]; stateOf(p) → 'hit'|'miss'|'weak'|'info'.
  function kpCluster(points, stateOf) {
    const out = [];
    points.forEach((p) => {
      const st = stateOf(p);
      let m = out.find((c) => Math.hypot(c.x - p.x, c.y - p.y) < KP_NEAR);
      if (!m) { m = { x: p.x, y: p.y, state: st, stroke: p.stroke, direction: false, items: [] }; out.push(m); }
      m.items.push({ p, state: st });
      if (KP_RANK[st] > KP_RANK[m.state]) m.state = st;
    });
    out.forEach((m) => {
      // the ring sits on the middle of the points it stands for (a dot's start and its position check → the dot)
      m.x = m.items.reduce((t, it) => t + it.p.x, 0) / m.items.length;
      m.y = m.items.reduce((t, it) => t + it.p.y, 0) / m.items.length;
      const dir = m.items.find((it) => it.p.kind === 'direction' && it.state === m.state);
      if (dir && Number.isInteger(dir.p.stroke)) { m.direction = true; m.stroke = dir.p.stroke; }
    });
    return out;
  }

  // What a point says. Against a given look-alike: how to write it so it is not that look-alike — the point's
  // hint[other] (the instruction the judge gives on a miss, e.g. '2번째 획은 1번째 획에서 멈춰요'), else its label
  // (which names the place only: '1번째 획 끝이 2번째 획에 닿음').
  function kpText(p, other) {
    const hint = other && p.hint && typeof p.hint === 'object' ? p.hint[other] : null;
    return typeof hint === 'string' && hint.trim() ? hint.trim() : p.label;
  }

  // Texts of a marker's points that pass `keep` (a closure check next to its own loop says the same thing),
  // most telling kind first; at most `max` of them. With `other`: as told apart from that look-alike (kpText).
  function kpLabels(m, keep, max, other) {
    const rank = (it) => (kpIsLead(it.p) ? 0 : (KP_KIND_ORDER.indexOf(it.p.kind) + 1) || 99);
    const items = m.items.filter((it) => !keep || keep(it)).slice().sort((a, b) => rank(a) - rank(b));
    const hasLoop = items.some((it) => it.p.kind === 'loop' && !/^closure/.test(String(it.p.id)));
    const out = [];
    items.forEach((it) => {
      if (hasLoop && /^closure/.test(String(it.p.id))) return;
      const text = kpText(it.p, other);
      if (!out.includes(text)) out.push(text);
    });
    return max ? out.slice(0, max) : out;
  }

  const kpStrokes = (markers) => Array.from(new Set(markers.flatMap((m) => m.items.map((it) => it.p.stroke)).filter(Number.isInteger)));
  const kpNum = (n, state) => h('span', { class: 'kp-num kp-num-' + state, 'aria-hidden': 'true' }, String(n));
  // 'め·ね와' — look-alikes joined, particle after the last one
  const kpOthers = (list, noBatchim, batchim) => (list.length ? list.join('·') + josa(list[list.length - 1], noBatchim, batchim) : '');

  /* The chart's view of a form: markers numbered in look-alike order, and per look-alike the markers that tell it
   * apart. → { variantId, markers, groups: [{ other, items: [marker] }] } | null (no critical point). */
  function kpChartView(ch, variantId) {
    const k = kpOfForm(ch, variantId);
    if (!k) return null;
    const pts = k.points.filter(kpValid);
    if (!pts.length) return null;
    const markers = kpCluster(pts, () => 'info');
    const order = [];
    const info = charInfo(ch);
    ((info && info.confusables) || []).forEach((c) => { if (!order.includes(c)) order.push(c); });
    pts.forEach((p) => p.against.forEach((c) => { if (!order.includes(c)) order.push(c); }));
    const leadOf = (m, other) => m.items.some((it) => kpIsLead(it.p, other));
    const groups = order.map((other) => ({ other, items: markers.filter((m) => m.items.some((it) => it.p.against.includes(other))) }))
      .filter((g) => g.items.length);
    groups.forEach((g) => g.items.sort((a, b) => leadOf(b, g.other) - leadOf(a, g.other)));
    let n = 0;
    groups.forEach((g) => g.items.forEach((m) => { if (m.n == null) m.n = ++n; }));
    groups.forEach((g) => g.items.sort((a, b) => leadOf(b, g.other) - leadOf(a, g.other) || a.n - b.n));
    return { variantId: k.variantId, markers, groups };
  }

  /* The graded drawing's view: the critical points the judge measured (hit true/false; null = not judged is left out).
   * When the drawing was read as a look-alike C, only the points that tell the target from C. Missed points (miss on a
   * ✕, weak on a ○/△) are numbered 1… in the issues and on the glyph.
   * → { variantId, other, markers, missed, hits, others } | null */
  function kpResultView(r, ch, mark) {
    const kp = r && r.keypoints;
    if (!kp || typeof kp !== 'object' || !Array.isArray(kp.points) || (kp.ch && kp.ch !== ch)) return null;
    // (a ✕ that names the target itself — its own loop left out, ほ without the loop — shows that loop although it is
    // not a critical point; other non-critical points stay out)
    const failedIds = Array.isArray(kp.failed) ? kp.failed : [];
    const selfMiss = r.verdict === 'wrong' && r.recognized === ch && !r.confusedWith;
    const ownMiss = (p) => selfMiss && !!p && typeof p === 'object' && p.kind === 'loop' && Number.isFinite(p.x) && Number.isFinite(p.y)
      && typeof p.label === 'string' && p.hit === false && failedIds.includes(p.id) && Array.isArray(p.against);
    const pts = kp.points.filter((p) => (kpValid(p) || ownMiss(p)) && (p.hit === true || p.hit === false));
    if (!pts.length) return null;
    const other = r.confusedWith || (r.recognized && r.recognized !== ch ? r.recognized : null);
    const focus = other ? pts.filter((p) => p.against.includes(other)) : pts;
    if (!focus.length) return null;
    const missState = mark === 'x' ? 'miss' : 'weak';
    const all = kpCluster(focus, (p) => (p.hit ? 'hit' : missState));
    // missed places, most telling first (a loop / flick / dot before a length or a position); at most KP_SHOW
    const prio = (m) => Math.min(...m.items.filter((it) => it.state === m.state).map((it) => (kpIsLead(it.p) ? 0 : (KP_KIND_ORDER.indexOf(it.p.kind) + 1) || 99)));
    const missedAll = all.filter((m) => m.state !== 'hit').sort((a, b) => prio(a) - prio(b));
    if (mark === 'x' && !missedAll.length) return null; // a ✕ never shows "well written" rings: the shape decided it
    const missed = missedAll.slice(0, KP_SHOW);
    missed.forEach((m, i) => { m.n = i + 1; });
    const markers = all.filter((m) => m.state === 'hit' || missed.includes(m));
    const more = missedAll.length - missed.length;
    const others = [];
    (missed.length ? missed : markers).forEach((m) => m.items.forEach((it) => {
      if (missed.length && it.state === 'hit') return;
      it.p.against.forEach((c) => { if ((!other || c === other) && !others.includes(c)) others.push(c); });
    }));
    const conf = (charInfo(ch) && charInfo(ch).confusables) || [];
    const rank = (c) => (conf.indexOf(c) < 0 ? 99 : conf.indexOf(c));
    others.sort((a, b) => rank(a) - rank(b));
    return { variantId: kp.variantId || null, other, markers, missed, more, hits: markers.filter((m) => m.state === 'hit'), others };
  }

  // The correct glyph with the result's markers (missed strokes drawn stronger than the rest).
  function kpResultGlyph(ch, v, label) {
    return SV.keypointGlyph(ch, v.markers.map((m) => ({ x: m.x, y: m.y, state: m.state, n: m.n, stroke: m.stroke, direction: m.direction })), {
      variantId: v.variantId, label, focusStrokes: v.missed.length ? kpStrokes(v.missed) : null,
    });
  }

  const kpLegend = (v) => (v.missed.length
    ? (v.missed[0].state === 'miss' ? '빨간 동그라미 = 놓친 곳 (번호는 위 설명과 같아요)' : '점선 동그라미 = 약하게 쓴 곳 (번호는 위 설명과 같아요)')
    : '동그라미 = 잘 쓴 구별 포인트');

  // Issue line listing the missed points by number (✕: '놓친 곳'; ○/△: a gentle '주의').
  function kpIssue(v, mark) {
    if (!v || !v.missed.length) return null;
    const refs = h('span', { class: 'kp-refs' }, v.missed.map((m) => h('span', { class: 'kp-ref' },
      kpNum(m.n, m.state), srOnly(m.n + '번: '), kpLabels(m, (it) => it.state === m.state, 2).join(' · '))),
      v.more ? h('span', { class: 'kp-ref kp-more' }, `그 밖에 ${v.more}곳`) : null);
    if (mark === 'x') {
      return h('li', { class: 'issue issue-keypoint issue-kpmiss' }, h('span', { class: 'issue-type' }, '놓친 곳'), h('span', { class: 'issue-msg' }, refs));
    }
    const who = v.others.length ? kpOthers(v.others, '', '') + '에 가까워 보여요' : '조금 약해요';
    return h('li', { class: 'issue issue-kpweak' }, h('span', { class: 'issue-type' }, '주의'),
      h('span', { class: 'issue-msg' }, richText(`정답으로 봤지만 이 부분은 ${who}. 다음에는 더 분명하게 써 보세요.`), ' ', refs));
  }

  // Stand-alone block when no look-alike comparison carries the glyph: the glyph with rings + a one-line summary.
  function kpBlock(ch, v, mark) {
    let text;
    if (v.missed.length && mark === 'x') text = '빨간 동그라미가 놓친 곳이에요. 바른 글자에서는 이렇게 써요.';
    else if (v.missed.length) text = '점선 동그라미가 약하게 쓴 곳이에요. 나머지 구별 포인트는 잘 썼어요.';
    else text = `${kpOthers(v.others, '와', '과')} 구별되는 곳 ${v.markers.length}곳을 잘 썼어요.`;
    return h('div', { class: 'kp-block' + (v.missed.length ? ' has-miss' : '') },
      h('div', { class: 'kp-block-fig' }, kpResultGlyph(ch, v, ch + ' 구별 포인트')),
      h('div', { class: 'kp-block-text' },
        h('p', { class: 'kp-block-h' }, '구별 포인트'),
        h('p', null, richText(text)),
        h('p', { class: 'legend' }, kpLegend(v))));
  }

  /* ---------------------------------------------------------------- '판정이 이상해요' (judge reports) */

  let reportSeq = 0;
  const r1 = (v) => Math.round(v * 10) / 10;

  const REPORT_KINDS = [
    { id: 'reject', label: '바르게 썼는데 틀렸다고 나와요' },
    { id: 'accept', label: '다른 글자를 썼는데 맞았다고 나와요' },
    { id: 'order', label: '획순·방향 판정이 이상해요' },
    { id: 'other', label: '그 밖의 문제' },
  ];
  const reportKindLabel = (id) => (REPORT_KINDS.find((x) => x.id === id) || REPORT_KINDS[3]).label;
  const REPORT_SOURCE = { test: '쓰기 테스트', result: '결과 화면', practice: '따라 써보기', word: '단어장' };

  function buildReport(r, strokes, o, ch, mark, kind, note) {
    const box = o.box && typeof o.box === 'object'
      ? { x: r1(o.box.x || 0), y: r1(o.box.y || 0), w: r1(o.box.w || 0), h: r1(o.box.h || 0) }
      : (Number.isFinite(o.box) ? r1(o.box) : null);
    const jo = r && r._opts && typeof r._opts === 'object' ? r._opts : {};
    const kp = r && r.keypoints && typeof r.keypoints === 'object' ? r.keypoints : null;
    return {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      target: ch,
      variantId: (r && r.variantId) || (kp && kp.variantId) || null,
      strokes: strokes.map((st) => st.map((p) => [r1(p[0]), r1(p[1])])),
      box,
      verdict: r ? r.verdict : null,
      mark,
      recognized: r ? r.recognized || null : null,
      confusedWith: r ? r.confusedWith || null : null,
      crossScript: !!(r && r.crossScript),
      issues: r && Array.isArray(r.issues) ? r.issues.map((it) => ({ type: String(it.type), message: String(it.message) })) : [],
      notes: r && Array.isArray(r.notes) ? r.notes.map((it) => ({ type: String(it.type), message: String(it.message) })) : [],
      keypointsFailed: kp && Array.isArray(kp.failed) ? kp.failed.slice() : null,
      candidates: r && Array.isArray(r.candidates)
        ? r.candidates.slice(0, 5).map((c) => ({ ch: c.ch, variantId: c.variantId || null, score: Number.isFinite(c.score) ? Math.round(c.score * 1e4) / 1e4 : null })) : [],
      judge: {
        engine: drawInfo(ch) && drawInfo(ch).kanji ? 'kanji' : 'kana',
        strictness: jo.strictness || state.settings.strictness,
        boxMode: !!(jo.box || (o.box && typeof o.box === 'object')),
      },
      source: o.source || (o.box && typeof o.box === 'object' ? 'word' : 'test'),
      kind,
      userNote: note || '',
      appVersion: APP_VERSION,
    };
  }

  /* The quiet '판정이 이상해요' control at the bottom of a graded drawing: opens an inline form (what was wrong + an
   * optional note), saves the drawing and the verdict to persistence.reports and confirms in place. */
  function reportControl(r, strokes, o, ch, mark) {
    const id = 'rep-' + (++reportSeq);
    const wrap = h('div', { class: 'rep-ctl' });
    const btn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet rep-btn', 'aria-expanded': 'false', 'aria-controls': id + '-form' },
      icon('flag'), '판정이 이상해요');
    const pre = r.verdict === 'wrong' ? 'reject' : r.verdict === 'order' ? 'order' : 'accept';
    const kinds = h('fieldset', { class: 'rep-kinds' },
      h('legend', { class: 'field-label' }, '어떤 점이 이상했나요?'),
      REPORT_KINDS.map((k) => h('label', { class: 'rep-kind' },
        h('input', { type: 'radio', name: id + '-kind', value: k.id, checked: k.id === pre ? true : null }), h('span', null, k.label))));
    const note = h('textarea', { id: id + '-note', class: 'rep-note', rows: 2, maxlength: 300, placeholder: '예: め를 일부러 썼는데 ぬ로 맞았어요' });
    const cancel = h('button', { type: 'button', class: 'btn btn-sm' }, '취소');
    const save = h('button', { type: 'button', class: 'btn btn-sm btn-primary' }, '신고 저장');
    const form = h('div', { class: 'rep-form', id: id + '-form', role: 'group', 'aria-labelledby': id + '-h', hidden: true },
      h('p', { class: 'rep-h', id: id + '-h' }, '판정 신고'),
      h('p', { class: 'rep-hint' }, '이 글씨와 채점 결과를 이 기기에만 저장해요. 인터넷으로 보내지 않아요. 기록 화면의 ‘판정 신고’에서 모아 보고 내보낼 수 있어요.'),
      kinds,
      h('label', { class: 'field-label rep-note-label', for: id + '-note' }, '메모 (선택)'),
      note,
      h('div', { class: 'rep-form-actions' }, cancel, save));
    const done = h('p', { class: 'rep-done', role: 'status', tabindex: '-1', hidden: true });
    const checkedKind = () => Array.from(kinds.querySelectorAll('input')).find((i) => i.checked) || null;
    btn.addEventListener('click', () => {
      const open = form.hidden;
      form.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        const c = checkedKind() || kinds.querySelector('input');
        if (c) { try { c.focus({ preventScroll: true }); } catch (e) { c.focus(); } }
        try { form.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'nearest' }); } catch (e) { /* ignore */ }
      }
    });
    cancel.addEventListener('click', () => { form.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); });
    save.addEventListener('click', () => {
      const c = checkedKind();
      const rep = buildReport(r, strokes, o, ch, mark, c ? c.value : 'other', String(note.value || '').trim().slice(0, 300));
      const res = persistence.reports.add(rep);
      form.hidden = true;
      btn.hidden = true;
      done.hidden = false;
      done.textContent = res.memory
        ? '판정 신고를 받았어요. 다만 이 브라우저에는 저장할 수 없어서 창을 닫으면 사라져요. 기록 화면의 ‘판정 신고’에서 바로 내보내 주세요.'
        : `판정 신고를 저장했어요 (${res.count}/${REPORTS_MAX}).${res.dropped ? ` 자리가 모자라 가장 오래된 신고 ${res.dropped}건은 지웠어요.` : ''} 기록 화면의 ‘판정 신고’에서 보고 내보낼 수 있어요. 고마워요!`;
      try { done.focus({ preventScroll: true }); } catch (e) { done.focus(); }
    });
    [btn, form, done].forEach((x) => wrap.appendChild(x));
    return wrap;
  }

  function judgeDetail(result, strokes, opts) {
    const o = opts || {};
    const r = result || null;
    const ch = o.ch || (r && r.target);
    const k = drawInfo(ch);
    const list = Array.isArray(strokes) ? strokes.filter((st) => st && st.length) : [];
    if (!k) {
      // no stroke data (a kanji outside KANJI_DATA, or the data not loaded): show the drawing, grade nothing
      const fr = drawingFrame(list, o.box);
      return h('div', { class: 'wres wres-none' + (o.compact ? ' is-compact' : '') },
        h('p', { class: 'wres-verdict' }, ch ? [jp(ch), ' — '] : null, '획 데이터가 없는 글자라 채점하지 않아요'),
        list.length ? h('div', { class: 'wres-compare' }, h('figure', { class: 'wres-mine' },
          h('div', { class: 'wres-mine-svg' }, SV.userDrawing(fr.strokes, { box: fr.box, label: '내가 쓴 글자와 쓴 순서' })),
          h('figcaption', null, h('b', null, '내가 쓴 순서')))) : null,
        o.actions ? h('div', { class: 'wres-actions' }, o.actions) : null);
    }
    const mark = o.mark || (r ? Q.markOfVerdict(r.verdict) : 'x');
    const panel = h('div', { class: 'wres wres-' + mark + (o.compact ? ' is-compact' : '') });

    let headline;
    if (o.skipped) headline = '모르겠어요 — 바른 획순을 보고 다시 써 보세요';
    else if (o.empty || (!r && !list.length)) headline = '빈칸이에요 — 바른 획순을 보고 써 보세요';
    else if (mark === 'o') headline = '정답이에요';
    else if (mark === 't') headline = '모양은 맞았어요 — 획순·방향·획수를 확인하세요';
    else headline = '오답이에요';

    const rk = r && r.recognized ? charInfo(r.recognized) : null;
    const recog = r ? (r.recognized ? h('p', { class: 'wres-recog' }, '인식된 글자: ', jp(r.recognized, 'wres-rglyph'), rk ? ` (${parenRead(r.recognized)})` : '')
      : h('p', { class: 'wres-recog' }, '인식된 글자: 알아보기 어려워요')) : null;
    let variantNote = null;
    if (r && r.verdict !== 'wrong' && r.variantId && k.variants.length > 1) {
      const v = k.variants.find((x) => x.id === r.variantId);
      if (v) variantNote = h('p', { class: 'wres-variant' }, (r.variantId === 'alt' ? '다른 쓰는 법으로 인정: ' : '쓰는 법: ') + variantText(k, v));
    }
    panel.appendChild(h('div', { class: 'wres-head' },
      markSvg(mark, 'mk-lg'),
      h('div', { class: 'wres-headtext' },
        o.practice ? h('p', { class: 'wres-practice' }, `연습 결과 · 기록된 점수는 그대로 (${MARKS[o.firstMark || 'x'].sym})`) : null,
        h('p', { class: 'wres-verdict' }, headline),
        recog, variantNote,
        o.cheat && !o.practice ? h('p', { class: 'fb-cheat' }, '컨닝한 문제로 기록돼요.') : null)));

    // 구별 포인트 measured on this drawing (kana and extras; none for kanji cells or results without keypoints)
    const kpv = r && charInfo(ch) && !o.skipped && !o.empty && list.length ? kpResultView(r, ch, mark) : null;
    const issueItems = r && Array.isArray(r.issues) ? r.issues.filter((it) => it && it.message).map((it) =>
      h('li', { class: 'issue issue-' + it.type }, h('span', { class: 'issue-type' }, ISSUE_LABEL[it.type] || '참고'), h('span', { class: 'issue-msg' }, richText(it.message)))) : [];
    const kpLine = kpIssue(kpv, mark);
    if (kpLine) issueItems.push(kpLine);
    // gentle notes of the recognizer (result.notes, additive: り / リ drawn like the other script's form) — information only,
    // the grade stays
    if (r && Array.isArray(r.notes) && mark !== 'x') for (const n of r.notes) {
      if (n && n.message) issueItems.push(h('li', { class: 'issue issue-note' }, h('span', { class: 'issue-type' }, '참고'), h('span', { class: 'issue-msg' }, richText(String(n.message)))));
    }
    if (issueItems.length) panel.appendChild(h('ul', { class: 'issues' }, issueItems));
    let kpShown = false; // the glyph with the rings went into the look-alike comparison
    const kpTarget = (other) => {
      if (!kpv || !kpv.markers.length || kpv.other !== other) return null;
      kpShown = true;
      return { glyph: kpResultGlyph(ch, kpv, `${ch} — 구별 포인트 표시`), note: kpLegend(kpv) };
    };

    // Look-alike, size twin (っ/つ), other-script or same-sound comparison.
    const labels = { question: '써야 할 글자', other: '내 글씨와 닮은 글자' };
    if (r && (r.confusedWith || r.crossScript)) {
      const other = r.confusedWith || r.recognized || k.pair;
      if (other && other !== ch && charInfo(other)) {
        const g = D.kana[ch] && D.kana[other] ? Q.groupFor(ch, other, D) : null;
        const size = sizeTwin(ch, other);
        let title = null;
        let tip = g ? g.tip : null;
        if (size === 'big') {
          title = ['크게 써서 ', jp(other), '처럼 보여요.'];
          tip = `작은 ${ch}${josa(ch, '는', '은')} 칸의 왼쪽 아래에 보통 글자의 절반 정도 크기로 써요.`;
        } else if (size === 'small') {
          title = ['작게 써서 작은 ', jp(other), '처럼 보여요.'];
          tip = `${ch}${josa(ch, '는', '은')} 칸을 채워 크게 써요. 작게 쓰면 작은 ${other}${josa(other, '가', '이')} 돼요.`;
        } else if (r.crossScript && !r.confusedWith) {
          const ok = charInfo(other);
          // The recognizer's 'script' issue above already says which script to write: name the pair instead of
          // repeating it, and point at what every screen shows (the kana test's badge, the word test's 답안 형태).
          title = [jp(other), josa(other, '는', '은') + ' ', jp(ch), '의 ' + (SCRIPT_LABEL[ok.script] || '') + ' 짝이에요.'];
          tip = tip || '히라가나와 가타카나는 소리가 같아도 모양이 달라요. 문제에서 어느 문자로 쓰라고 했는지 확인하세요.';
        }
        panel.appendChild(lookalikeBox(ch, other, tip, labels, { strokes: true, title, kp: kpTarget(other) }));
      }
    } else if (r && r.verdict === 'wrong' && r.recognized && r.recognized !== ch && D.kana[r.recognized] && D.kana[ch]
      && D.kana[r.recognized].ko === k.ko) {
      // Same sound, different letter (じ for ぢ, ず for づ, お for を).
      const rec = r.recognized;
      panel.appendChild(lookalikeBox(ch, rec, '둘 다 같은 소리로 읽지만 다른 글자예요.' + (k.hint ? ' ' + k.hint : ''),
        { question: '써야 할 글자', other: '내가 쓴 글자' },
        { strokes: true, title: [jp(rec), josa(rec, '는', '은') + ' 소리만 같은 다른 글자예요.'], kp: kpTarget(rec) }));
    }
    if (kpv && kpv.markers.length && !kpShown) panel.appendChild(kpBlock(ch, kpv, mark));

    // The user's drawing (their order + arrows, wrong strokes red) next to the correct stroke-order frames.
    const variantId = o.variant || (r && r.variantId) || 'std';
    const bad = mark !== 'o' ? badStrokes(r, list.length) : new Set();
    const compare = h('div', { class: 'wres-compare' });
    if (list.length) {
      const fr = drawingFrame(list, o.box);
      compare.appendChild(h('figure', { class: 'wres-mine' },
        h('div', { class: 'wres-mine-svg' }, SV.userDrawing(fr.strokes, { box: fr.box, bad: Array.from(bad), reversed: r ? r.reversed : [], label: '내가 쓴 글자와 쓴 순서' })),
        h('figcaption', null, h('b', null, '내가 쓴 순서'),
          bad.size ? h('span', { class: 'legend legend-bad' }, '빨간 획 = 순서·방향·획수가 틀린 획') : h('span', { class: 'legend' }, '숫자 = 쓴 순서, 화살표 = 방향'))));
    }
    const v = k.variants.find((x) => x.id === variantId) || k.variants[0];
    const missing = r && r.structure && Array.isArray(r.structure.missing) ? r.structure.missing.filter((j) => Number.isInteger(j) && j >= 0 && j < v.strokes.length) : [];
    compare.appendChild(h('figure', { class: 'wres-model' },
      strokeFrames(ch, { variantId: v.id }),
      h('figcaption', null, h('b', null, '바른 획순'),
        h('span', { class: 'legend' }, jp(ch), ' ' + (D.kana[ch] ? variantText(k, v) : `${v.strokes.length}획`)),
        missing.length && mark !== 'o' ? h('span', { class: 'legend legend-bad' }, '빠뜨린 획: ' + missing.map((j) => j + 1 + '번째').join(', ')) : null)));
    panel.appendChild(compare);

    if (o.actions) panel.appendChild(h('div', { class: 'wres-actions' }, o.actions));
    if (r && list.length && !o.skipped && !o.empty && o.report !== false) panel.appendChild(reportControl(r, list, o, ch, mark));
    return panel;
  }

  // The writing test / result list / practice pad entry point (info = { ch, mark, result, strokes, box, … }).
  function writingResultPanel(info, opts) {
    return judgeDetail(info.result, info.strokes || [], Object.assign({
      ch: info.ch, box: info.box, mark: info.mark, skipped: info.skipped, cheat: info.cheat, practice: info.practice, firstMark: info.firstMark,
    }, opts));
  }

  /* ================================================================ 컨닝 overlay */

  /* The chart in a dialog. During a test it flags the current (ungraded) question as 컨닝.
   * script: 'hira' | 'kata' | 'mix' | 'both' (default: the test's script, else the chart preference).
   * opts: { note, inTest } for other modules' practice screens. → Promise resolved when it closes. */
  function openCheat(script, opts) {
    const o = opts || {};
    const t = state.test;
    const inTest = !!(t && t.active);
    if (inTest && t.cur && !t.cur.graded) {
      t.cur.cheat = true;
      const tag = $('#main .cheat-tag');
      if (tag) tag.hidden = false;
    }
    const flagged = !!(inTest && t.cur && t.cur.cheat && !t.cur.graded);
    const d = $('#cheat');
    d.textContent = '';
    const want = typeof script === 'string' ? script : null;
    let view = state.prefs.chartView;
    if (want) view = want === 'mix' ? 'both' : ['hira', 'kata', 'both'].includes(want) ? want : view;
    else if (inTest) view = t.script === 'mix' ? 'both' : t.script;
    const body = h('div', { class: 'cheat-body' });
    const renderBody = () => { body.textContent = ''; body.appendChild(buildChart(view, (ch) => openDetail(ch))); };
    const closeBtn = h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => closeDialog(d) } }, inTest || o.inTest ? '문제로 돌아가기' : '닫기');
    let note = null;
    if (flagged) note = h('p', { class: 'cheat-note' }, h('span', { class: 'cheat-tag' }, '컨닝'), ' 이 문제는 컨닝으로 표시돼요. 글자를 누르면 획순을 볼 수 있어요.');
    else if (inTest && t.cur && t.cur.cheat) note = h('p', { class: 'cheat-note' }, '이 문제는 채점 전에 컨닝한 문제로 기록됐어요. 글자를 누르면 획순을 볼 수 있어요.');
    else if (inTest) note = h('p', { class: 'cheat-note' }, '이미 채점한 문제라 컨닝으로 기록되지 않아요. 글자를 누르면 획순을 볼 수 있어요.');
    else if (o.note) note = h('p', { class: 'cheat-note' }, o.note);
    d.appendChild(h('div', { class: 'sheet-panel' },
      h('header', { class: 'sheet-head cheat-head' },
        h('div', null, h('h2', { id: 'cheat-title', class: 'sheet-h' }, '글자표 보기'), note),
        closeBtn),
      h('div', { class: 'sheet-body' },
        segmented('cheatview', '보기', [
          { value: 'hira', label: '히라가나' }, { value: 'kata', label: '가타카나' }, { value: 'both', label: '나란히' },
        ], view, (v) => { view = v; renderBody(); }, 'view-toggle'),
        body)));
    renderBody();
    const closed = new Promise((resolve) => d.addEventListener('close', function onClose() {
      if (isOpen(d)) return;
      d.removeEventListener('close', onClose);
      resolve();
    }));
    openDialog(d);
    closeBtn.focus();
    return closed;
  }

  /* ================================================================ 글자 상세 (detail sheet) */

  let sheetCleanup = [];
  let kpOpen = true; // the sheet's '구별 포인트' section open (kept for the session)
  function clearSheet() {
    while (sheetCleanup.length) { try { sheetCleanup.pop()(); } catch (e) { console.error(e); } }
  }

  // Size/position in a 원고지 cell (horizontal writing) for the extras.
  function extraNote(ch) {
    const x = D.extra[ch];
    if (x.kind === 'small') return `가로쓰기에서는 칸의 왼쪽 아래에 보통 글자의 절반 정도 크기로 작게 써요. 크게 쓰면 ${x.big}${josa(x.big, '가', '이')} 돼요.`;
    if (ch === '、' || ch === '。') return '가로쓰기에서는 칸의 왼쪽 아래 구석에 작게 찍어요. 원고지에서는 부호도 한 칸을 차지해요.';
    if (ch === 'ー') return '칸 가운데를 가로지르는 가로선이에요. 앞 글자의 모음을 길게 늘여 읽어요. (세로쓰기에서는 세로선)';
    return '보통 글자처럼 칸을 채워 크게 써요.';
  }

  function extraPlace(ch) {
    const x = D.extra[ch];
    if (x.kind === 'small') return '작게 · 왼쪽 아래';
    if (ch === '、' || ch === '。') return '왼쪽 아래 구석';
    if (ch === 'ー') return '가운데 가로선';
    return '칸을 채워 크게';
  }

  // The same extra in the other script (っ ↔ ッ, ゃ ↔ ャ); null for ヴ ー 、 。
  function extraPair(ch) {
    const x = D.extra[ch];
    const bigPair = x && x.big && D.kana[x.big] ? D.kana[x.big].pair : null;
    if (!bigPair) return null;
    return Object.values(D.extra).find((e) => e.big === bigPair) || null;
  }

  function openDetail(ch, variantId) {
    const k = charInfo(ch);
    if (!k) return;
    const extra = isExtra(ch);
    const x = extra ? D.extra[ch] : null;
    const d = $('#sheet');
    clearSheet();
    d.textContent = '';
    let vid = variantId || 'std';
    const animated = svKnows(ch); // StrokeView can animate it (always true for the 142 kana)

    const stepLabel = h('span', { class: 'step-label', 'aria-live': 'polite' });
    const playBtn = h('button', { type: 'button', class: 'btn btn-sm ctrl-play' });
    const playerBox = h('div', { class: 'player' });
    const framesBox = h('div', { class: 'frames-box' });
    const countEl = h('span', { class: 'meta-count' });
    let player = null;

    function setPlayIcon(playing) {
      playBtn.textContent = '';
      playBtn.appendChild(icon(playing ? 'pause' : 'play'));
      playBtn.appendChild(document.createTextNode(playing ? '멈춤' : '재생'));
      playBtn.setAttribute('aria-label', playing ? '애니메이션 멈춤' : '획순 애니메이션 재생');
    }

    function buildPlayer() {
      if (player) player.destroy();
      player = null;
      playerBox.textContent = '';
      if (animated) {
        player = SV.create(playerBox, {
          ch, variantId: vid,
          onStep: (step, total, playing) => {
            stepLabel.textContent = `${playing ? Math.min(step + 1, total) : step} / ${total}획`;
            setPlayIcon(playing);
          },
        });
      } else {
        playerBox.appendChild(strokeGlyph(ch, { numbers: true, label: ch + ' 획순 (숫자 = 쓰는 순서)' }));
      }
      framesBox.textContent = '';
      framesBox.appendChild(strokeFrames(ch, { variantId: vid }));
      countEl.textContent = `${strokesOf(ch, vid).length}획`;
      if (!player) return;
      if (!reduceMotion()) setTimeout(() => { if (player && isOpen(d)) player.play(); }, 250);
      else player.setStep(player.total());
    }
    sheetCleanup.push(() => { if (player) player.destroy(); player = null; });
    playBtn.addEventListener('click', () => player && player.toggle());

    const variantSwitch = k.variants.length > 1 ? h('div', { class: 'variant-switch', role: 'group', 'aria-label': '쓰는 방법' },
      k.variants.map((v) => {
        const b = h('button', { type: 'button', class: 'vbtn', 'aria-pressed': v.id === vid ? 'true' : 'false', on: { click: () => {
          vid = v.id;
          variantSwitch.querySelectorAll('.vbtn').forEach((y) => y.setAttribute('aria-pressed', y === b ? 'true' : 'false'));
          buildPlayer();
          buildKp();
          if (practicePad && state.prefs.guide) practicePad.setGuideGlyph(ch, vid);
        } } },
        h('span', { class: 'vbtn-kind' }, v.id === 'std' ? '교과서체' : '다른 형태'),
        h('span', { class: 'vbtn-label' }, variantText(k, v)));
        return b;
      })) : null;

    // 따라 써보기 (extras are judged inside the cell box, so size and position count too)
    const practiceHost = h('div', { class: 'practice-pad' });
    const practiceOut = h('div', { class: 'practice-out', 'aria-live': 'polite' });
    const pcount = h('span', { class: 'stroke-count' }, h('b', null, '0'), '획');
    let practicePad = null;
    const practiceGradeBtn = h('button', { type: 'button', class: 'btn btn-primary practice-grade', on: { click: () => practiceGrade() } }, '채점');
    const resetPractice = () => { if (!practicePad) return; practicePad.clear(); practicePad.setEnabled(true); practiceOut.textContent = ''; practiceGradeBtn.disabled = false; };
    const guideToggle = h('label', { class: 'pen-toggle' },
      h('input', { type: 'checkbox', class: 'switch switch-sm', role: 'switch', checked: state.prefs.guide ? true : null,
        on: { change: (e) => { state.prefs.guide = e.target.checked; persist(); if (practicePad) practicePad.setGuideGlyph(e.target.checked ? ch : null, vid); } } }),
      h('span', null, '흐린 글자'));

    /* 구별 포인트: the critical key points of the shown form (KanaRecognizer.keypoints), numbered on the glyph and
     * listed per look-alike ('め와 구별 · 2번째 획 끝의 작은 고리'); a look-alike button highlights its points. */
    const kpSec = h('section', { class: 'detail-sec kp-sec', 'aria-labelledby': 'kp-h', hidden: true });
    let kpPick = null;
    let kpPickTouched = false;
    function buildKp() {
      kpSec.textContent = '';
      const view = kpChartView(ch, vid);
      if (!view) { kpSec.hidden = true; return; }
      kpSec.hidden = false;
      if (kpPick && !view.groups.some((g) => g.other === kpPick)) kpPick = null;
      // a busy glyph (さ: 9 places) opens on its first look-alike; pressing that button again shows them all
      if (kpPick === null && !kpPickTouched && view.groups.length > 1 && view.markers.length > 5) kpPick = view.groups[0].other;
      const figBox = h('div', { class: 'kp-fig' });
      const drawFig = () => {
        figBox.textContent = '';
        const g = kpPick ? view.groups.find((x) => x.other === kpPick) : null;
        const inGroup = g ? new Set(g.items) : null;
        figBox.appendChild(SV.keypointGlyph(ch, view.markers.map((m) => ({
          x: m.x, y: m.y, state: 'info', n: m.n, stroke: m.stroke, direction: m.direction, dim: inGroup ? !inGroup.has(m) : false,
        })), {
          variantId: view.variantId,
          label: `${ch} 구별 포인트 ${view.markers.length}곳` + (g ? ` — ${g.other}${josa(g.other, '와', '과')} 구별하는 곳을 강조` : ''),
          focusStrokes: g ? kpStrokes(g.items) : null,
        }));
      };
      const gbtns = [];
      const groupsBox = h('div', { class: 'kp-groups' }, view.groups.map((g) => {
        const b = h('button', { type: 'button', class: 'kp-gbtn', 'aria-pressed': kpPick === g.other ? 'true' : 'false', 'data-other': g.other },
          jp(g.other, 'kp-gglyph'), h('span', { class: 'kp-gtext' }, josa(g.other, '와', '과') + ' 구별'), h('span', { class: 'kp-gcount' }, `${g.items.length}곳`));
        b.addEventListener('click', () => {
          kpPickTouched = true;
          kpPick = kpPick === g.other ? null : g.other;
          gbtns.forEach((x) => x.setAttribute('aria-pressed', x.dataset.other === kpPick ? 'true' : 'false'));
          drawFig();
        });
        gbtns.push(b);
        return h('div', { class: 'kp-group' }, b,
          h('ul', { class: 'kp-list' }, g.items.map((m) => h('li', null,
            kpNum(m.n, 'info'), srOnly(m.n + '번: '),
            h('span', null, richText(kpLabels(m, (it) => it.p.against.includes(g.other), 0, g.other).join(' · ')))))));
      }));
      drawFig();
      const body = h('div', { class: 'kp-body', id: 'kp-body', hidden: !kpOpen },
        h('p', { class: 'sec-note' }, '닮은 글자와 모양이 갈리는 곳이에요. 이곳을 분명하게 쓰면 닮은 글자와 헷갈리지 않아요. 닮은 글자를 누르면 그 글자와 구별하는 곳만 진하게 보여요.'),
        h('div', { class: 'kp-layout' }, figBox, groupsBox));
      const toggle = h('button', { type: 'button', class: 'btn btn-sm btn-quiet kp-toggle', 'aria-expanded': kpOpen ? 'true' : 'false', 'aria-controls': 'kp-body' },
        kpOpen ? '접기' : '펼치기');
      toggle.addEventListener('click', () => {
        kpOpen = !kpOpen;
        body.hidden = !kpOpen;
        toggle.setAttribute('aria-expanded', kpOpen ? 'true' : 'false');
        toggle.textContent = kpOpen ? '접기' : '펼치기';
      });
      kpSec.appendChild(h('div', { class: 'kp-head' },
        h('h3', { class: 'sec-h', id: 'kp-h' }, '구별 포인트', h('small', null, `${view.markers.length}곳`)), toggle));
      kpSec.appendChild(body);
    }

    // Look-alikes: a derived (탁음) group is skipped when an explicit group already pairs most of it (ジ/ヅ), or
    // when it is just the same-shape pair (べ/ベ: the same-shape note below already says it).
    const sameShape = extra ? null : (D.sameShape || []).find((p) => p.includes(ch));
    const lookGroups = extra ? [] : D.confusableGroups.filter((g) => g.chars.includes(ch)
      && !(g.derived && D.confusableGroups.some((e) => !e.derived && e.chars.includes(ch) && g.chars.filter((c) => e.chars.includes(c)).length >= 2))
      && !(g.derived && sameShape && g.chars.every((c) => sameShape.includes(c))));
    const pair = extra ? extraPair(ch) : (k.pair && D.kana[k.pair]);
    const hasRomaji = !!(k.romaji && /^[a-z]+$/.test(k.romaji));
    const alt = extra ? [] : shownAlt(k);
    const scriptBadge = k.script === 'hira' || k.script === 'kata' ? badge(k.script, 'badge-sm') : h('span', { class: 'badge badge-mix badge-sm' }, '문장 부호');

    // Extras: the char in a 원고지 cell at its real place, next to its full-size twin.
    const cellSec = extra ? h('section', { class: 'detail-sec cell-sec' },
      h('h3', { class: 'sec-h' }, '칸 안의 크기·위치'),
      h('div', { class: 'cell-figs' },
        h('figure', { class: 'cell-fig' }, strokeGlyph(ch, { label: `${ch} — 원고지 칸 안의 위치` }), h('figcaption', null, jp(ch), ' ' + extraPlace(ch))),
        x.big && D.kana[x.big] ? h('figure', { class: 'cell-fig is-big' }, strokeGlyph(x.big, { label: `${x.big} — 보통 크기` }), h('figcaption', null, jp(x.big), ' 보통 크기')) : null),
      h('p', { class: 'cell-note' }, richText(extraNote(ch))),
      x.big && D.kana[x.big] ? h('button', { type: 'button', class: 'btn btn-sm btn-quiet', on: { click: () => openDetail(x.big) } }, jp(x.big), ' 큰 글자 획순 보기') : null) : null;

    const panel = h('div', { class: 'sheet-panel detail' },
      h('header', { class: 'sheet-head detail-head' },
        h('div', { class: 'kbox detail-glyph-box' }, jp(ch, 'detail-glyph')),
        h('div', { class: 'detail-meta' },
          h('h2', { id: 'sheet-title', class: 'sheet-h' }, srOnly(ch + ' '),
            hasRomaji ? [h('span', { class: 'detail-romaji' }, k.romaji), srOnly(' · '), h('span', { class: 'detail-ko' }, k.ko)]
              : h('span', { class: 'detail-romaji detail-name' }, shortName(ch) || ch),
            k.hint ? srOnly(', ' + k.hint) : null),
          h('p', { class: 'detail-tags' }, scriptBadge, countEl,
            alt.length ? h('span', { class: 'meta-alt' }, '또는 ' + alt.join(', ')) : null),
          k.hint ? h('p', { class: 'detail-hint' }, richText(k.hint)) : null,
          extra ? h('p', { class: 'detail-hint' }, richText(x.label)) : null),
        h('button', { type: 'button', class: 'icon-btn sheet-close', 'aria-label': '닫기', on: { click: () => closeDialog(d) } }, icon('close'))),
      h('div', { class: 'sheet-body' },
        variantSwitch,
        cellSec,
        h('div', { class: 'detail-grid' },
          h('section', { class: 'player-col', 'aria-label': animated ? '획순 애니메이션' : '획순' },
            playerBox,
            animated ? h('div', { class: 'player-ctrl' },
              h('button', { type: 'button', class: 'btn btn-sm icon-only', 'aria-label': '이전 획', on: { click: () => player && player.prev() } }, icon('prev')),
              playBtn,
              h('button', { type: 'button', class: 'btn btn-sm icon-only', 'aria-label': '다음 획', on: { click: () => player && player.next() } }, icon('next')),
              h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => player && player.replay() } }, icon('replay'), '처음부터'),
              stepLabel) : null),
          h('section', { class: 'frames-col' },
            h('h3', { class: 'sec-h' }, '획순 단계'),
            h('p', { class: 'sec-note' }, '빨간 획이 그 단계에서 쓰는 획이에요. 점은 시작점, 화살표는 방향.'),
            framesBox)),
        h('section', { class: 'detail-sec practice-sec' },
          h('h3', { class: 'sec-h' }, '따라 써보기'),
          extra ? h('p', { class: 'sec-note' }, '칸 전체가 원고지 한 칸이에요. 크기와 위치도 채점해요.') : null,
          h('div', { class: 'practice-grid' },
            h('div', { class: 'practice-left' },
              h('div', { class: 'act-row' }, practiceGradeBtn),
              // the tools above the box, as on the 쓰기 test (css .pad-tools-top keeps a clear band before the box)
              h('div', { class: 'pad-tools pad-tools-top' },
                h('button', { type: 'button', class: 'btn btn-sm tool-btn', 'aria-label': '되돌리기', title: '되돌리기', on: { click: () => practicePad && practicePad.undo() } }, icon('undo'), h('span', { class: 'tool-text' }, '되돌리기')),
                h('button', { type: 'button', class: 'btn btn-sm tool-btn', 'aria-label': '지우기', title: '모두 지우기', on: { click: resetPractice } }, icon('clear'), h('span', { class: 'tool-text' }, '지우기')),
                pcount, h('span', { class: 'pad-tools-gap' }), guideToggle),
              practiceHost),
            practiceOut)),
        kpSec,
        lookGroups.length || sameShape ? h('section', { class: 'detail-sec' },
          h('h3', { class: 'sec-h' }, '닮은 글자'),
          sameShape ? h('p', { class: 'sec-note' }, jp(sameShape[0]), '와 ', jp(sameShape[1]), k.twinNote
            ? '는 손글씨로는 모양이 거의 같아서 쓰기에서는 둘 다 정답이에요.' : '는 모양이 같아서 쓰기에서는 둘 다 정답이에요.') : null,
          lookGroups.map((g) => h('div', { class: 'look-group' },
            h('div', { class: 'look-chars' }, g.chars.map((c) => {
              const kc = D.kana[c];
              return c === ch
                ? h('span', { class: 'look-char is-self s-' + kc.script }, jp(c, 'look-glyph'), h('span', { class: 'look-read' }, kc.romaji))
                : h('button', { type: 'button', class: 'look-char s-' + kc.script, 'aria-label': `${c} ${kc.romaji} 자세히 보기`, on: { click: () => openDetail(c) } },
                  jp(c, 'look-glyph'), h('span', { class: 'look-read' }, kc.romaji));
            })),
            h('p', { class: 'look-tip' }, richText(g.tip))))) : null,
        pair ? h('section', { class: 'detail-sec counterpart' },
          h('h3', { class: 'sec-h' }, SCRIPT_LABEL[pair.script] + ' 짝'),
          h('button', { type: 'button', class: 'pair-link s-' + pair.script, on: { click: () => openDetail(pair.ch) } },
            jp(pair.ch, 'pair-glyph'), h('span', { class: 'pair-text' }, badge(pair.script, 'badge-sm'), h('span', null, `${readingText(pair.ch)} — 같은 소리`)), icon('arrow'))) : null));

    d.appendChild(panel);
    openDialog(d);
    d.scrollTop = 0;
    const inner = d.querySelector('.sheet-panel');
    if (inner) inner.scrollTop = 0;
    buildPlayer();
    buildKp();

    practicePad = trackPad(DP.create(practiceHost, {
      penOnly: state.settings.penOnly,
      label: ch + ' 따라 쓰는 칸',
      onChange: (strokes) => { pcount.textContent = ''; pcount.append(h('b', null, String(strokes.length)), '획'); },
    }));
    if (state.prefs.guide) practicePad.setGuideGlyph(ch, vid);
    sheetCleanup.push(() => { dropPad(practicePad); practicePad = null; });

    function practiceGrade() {
      if (!practicePad) return; // sheet already closed
      const strokes = practicePad.getStrokes();
      if (!strokes.length) { toast('칸 안에 글자를 먼저 써 보세요.'); return; }
      const box = practicePad.getBoxSize();
      const jopts = { strictness: state.settings.strictness };
      if (extra) jopts.box = { x: 0, y: 0, w: box, h: box };
      let result;
      try { result = window.KanaRecognizer.judge(strokes, ch, jopts); } catch (e) {
        console.error(e); toast(extra ? '이 글자는 아직 채점할 수 없어요.' : '채점 중 문제가 생겼어요.'); return;
      }
      result._opts = Object.assign({}, jopts);
      practicePad.setEnabled(false);
      practiceGradeBtn.disabled = true;
      practiceOut.textContent = '';
      const again = h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => {
        resetPractice();
        // back up to the pad — all of it, 채점 too when it fits (instant: a stroke begun while the sheet glides
        // would be bent by it); this button is gone with the result, so the focus goes to 채점
        revealBelow(practiceGradeBtn, [practiceHost, practiceGradeBtn], { instant: true });
        try { practiceGradeBtn.focus({ preventScroll: true }); } catch (e) { practiceGradeBtn.focus(); }
      } } }, icon('pen'), '다시 쓰기');
      practiceOut.appendChild(judgeDetail(result, strokes, { ch, box, compact: true, source: 'practice', actions: [again] }));
      // the result (below the pad on narrow sheets) comes into view, its verdict first: there is no 다음 here, and
      // its own 다시 쓰기 sits at its end
      revealBelow(practiceOut, null);
    }

    const closeBtn = d.querySelector('.sheet-close');
    if (closeBtn) closeBtn.focus();
  }

  /* ================================================================ 글자표 screen */

  SCREENS.chart = function (main) {
    const body = h('div', { class: 'chart-body' });
    const render = () => { body.textContent = ''; body.appendChild(buildChart(state.prefs.chartView, (ch) => openDetail(ch))); };
    main.appendChild(h('div', { class: 'chart-page' },
      h('header', { class: 'page-head page-head-row' },
        h('div', null,
          h('h1', { class: 'page-title' }, '글자표'),
          h('p', { class: 'page-sub' }, '글자를 누르면 획순 애니메이션과 따라 쓰기가 열려요.')),
        segmented('chartview', '보기', [
          { value: 'hira', label: '히라가나', glyph: 'あ' }, { value: 'kata', label: '가타카나', glyph: 'ア' }, { value: 'both', label: '나란히 보기' },
        ], state.prefs.chartView, (v) => { state.prefs.chartView = v; persist(); render(); }, 'view-toggle')),
      body));
    render();
  };

  /* ================================================================ 결과 */

  SCREENS.result = function (main) {
    const t = state.lastTest;
    if (!t) { go('home', { force: true }); return; }
    const sum = Q.summarize(t.answers);
    const wrong = t.answers.filter((a) => a.mark === 'x').map((a) => a.ch);
    const tri = t.answers.filter((a) => a.mark === 't').map((a) => a.ch);
    const unanswered = t.endless ? 0 : t.questions.length - t.answers.length;
    const uniq = (list) => Array.from(new Set(list));

    const tiles = h('div', { class: 'score-tiles' },
      scoreTile('o', sum.o, '정답'),
      t.mode === 'write' ? scoreTile('t', sum.t, '획순·방향·획수') : null,
      scoreTile('x', sum.x, '오답'),
      sum.cheat ? h('div', { class: 'score-tile tile-cheat' }, h('span', { class: 'tile-n' }, sum.cheat), h('span', { class: 'tile-label' }, '컨닝')) : null);

    const list = h('ol', { class: 'qlist' }, t.answers.map((a, i) => resultItem(t, a, i)));
    main.appendChild(h('div', { class: 'result-page' },
      h('header', { class: 'page-head' },
        h('h1', { class: 'page-title' }, '결과'),
        h('p', { class: 'page-sub' }, `${t.mode === 'write' ? '쓰기' : '읽기'} 테스트 · ${t.label || SCRIPT_LABEL[t.script]}${t.endless ? ' · ∞ 무한 모드' : ''} · ${t.answers.length}문제`,
          unanswered ? ` (그만두기 전까지, ${unanswered}문제 남음)` : '')),
      h('section', { class: 'card result-summary' },
        tiles,
        h('div', { class: 'result-actions' },
          wrong.length ? h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => startTest(t.mode, wrong, { label: '틀린 것만 다시' }) } }, `틀린 것만 다시 (${uniq(wrong).length})`) : null,
          t.mode === 'write' && tri.length ? h('button', { type: 'button', class: 'btn', on: { click: () => startTest('write', tri, { label: '△ 획순 연습' }) } },
            h('span', { class: 'mchip-sym tri-sym', 'aria-hidden': 'true' }, '△'), srOnly('세모(△) 받은 글자'), `만 다시 · 획순 연습 (${uniq(tri).length})`) : null,
          h('button', { type: 'button', class: 'btn', on: { click: () => startTest(t.mode) } }, '같은 설정으로 새 테스트'),
          h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => go('home') } }, '홈으로'))),
      h('section', { class: 'result-list' },
        h('h2', { class: 'sec-h' }, '문제별 결과', h('small', null, ' 누르면 자세히')),
        list)));
  };

  function scoreTile(mark, n, label) {
    return h('div', { class: 'score-tile tile-' + mark }, markSvg(mark, 'mk-md'), h('span', { class: 'tile-n' }, n), h('span', { class: 'tile-label' }, label));
  }

  function resultItem(t, a, i) {
    const k = D.kana[a.ch];
    const detail = h('div', { class: 'qdetail', hidden: true });
    let built = false;
    const rec = a.result && a.result.recognized && a.result.recognized !== a.ch ? a.result.recognized : null;
    const btn = h('button', { type: 'button', class: 'qitem', 'aria-expanded': 'false' },
      h('span', { class: 'qi-n' }, i + 1),
      h('span', { class: 'qi-glyph jp', lang: 'ja' }, a.ch),
      h('span', { class: 'qi-read' }, h('span', null, k.romaji), h('span', { class: 'qi-ko' }, k.ko)),
      a.skipped ? h('span', { class: 'qi-given is-skip' }, '모르겠어요')
        : t.mode === 'read' ? (a.mark === 'o' ? h('span', { class: 'qi-given' }) : h('span', { class: 'qi-given is-input' }, srOnly('입력한 답 '), a.input))
          : h('span', { class: 'qi-given' }, rec ? [jp(rec, 'qi-rec'), josaRo(rec) + ' 인식'] : ''),
      a.cheat ? h('span', { class: 'cheat-tag' }, '컨닝') : null,
      markChip(a.mark, null, 'qi-mark'));
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (!built) {
        built = true;
        if (t.mode === 'read') detail.appendChild(readingFeedback(a));
        else detail.appendChild(writingResultPanel({ ch: a.ch, mark: a.mark, result: a.result, strokes: a.strokes, box: a.box, skipped: a.skipped, cheat: a.cheat }, { compact: true, source: 'result' }));
        detail.appendChild(h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => openDetail(a.ch) } }, jp(a.ch), ' 글자 자세히 · 획순'));
      }
      detail.hidden = open;
    });
    return h('li', { class: 'qrow qrow-' + a.mark }, btn, detail);
  }

  /* ================================================================ 기록 */

  SCREENS.records = function (main) {
    const stats = viewStats();
    let view = state.prefs.recordsView;
    const info = h('div', { class: 'cell-info', 'aria-live': 'polite' });
    const gridBox = h('div', { class: 'mastery-grid' });

    const totals = { read: 0, readOk: 0, o: 0, t: 0, x: 0, cheat: 0 };
    for (const ch of Object.keys(stats.chars)) {
      const c = stats.chars[ch];
      totals.read += c.read.ok + c.read.ng; totals.readOk += c.read.ok;
      totals.o += c.write.o; totals.t += c.write.t; totals.x += c.write.x;
      totals.cheat += c.read.cheat + c.write.cheat;
    }

    function showInfo(ch) {
      const k = D.kana[ch];
      const m = Q.charMastery(stats, ch);
      const fromWords = (stats.chars[ch] && stats.chars[ch].write.word) || 0;
      info.textContent = '';
      info.appendChild(h('div', { class: 'cell-info-card card' },
        jp(ch, 'ci-glyph'),
        h('div', { class: 'ci-text' },
          h('p', { class: 'ci-title' }, `${k.romaji} · ${k.ko}`, ' ', badge(k.script, 'badge-sm')),
          h('p', null, '읽기 ', m.read.rate == null ? '기록 없음' : `${m.read.ok}/${m.read.ok + m.read.ng} (${Math.round(m.read.rate * 100)}%)`),
          h('p', { class: 'ci-write' }, '쓰기 ', markChip('o', m.write.o), markChip('t', m.write.t), markChip('x', m.write.x),
            fromWords ? h('span', { class: 'ci-words' }, `단어·문장에서 ${fromWords}회`) : null),
          m.read.cheat + m.write.cheat ? h('p', null, `컨닝 ${m.read.cheat + m.write.cheat}회`) : null),
        h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => openDetail(ch) } }, '획순 보기')));
    }

    function masteryCell(pair, v) {
      const ch = pair[v];
      const m = Q.charMastery(stats, ch);
      const wt = m.write.o + m.write.t + m.write.x;
      const label = `${ch} ${D.kana[ch].romaji}: ` + (m.attempts
        ? `읽기 ${m.read.rate == null ? '없음' : Math.round(m.read.rate * 100) + '%'}, 쓰기 정답 ${m.write.o}, 획순 오류 ${m.write.t}, 오답 ${m.write.x}`
        : m.level ? `컨닝으로만 풀었음 (${m.read.cheat + m.write.cheat}회)` : '기록 없음');
      return h('button', { type: 'button', class: 'kcell mcell lv-' + (m.level || 'none'), 'aria-label': label, on: { click: () => showInfo(ch) } },
        h('span', { class: 'kc-glyph jp', lang: 'ja', 'aria-hidden': 'true' }, ch),
        h('span', { class: 'mbars', 'aria-hidden': 'true' },
          h('span', { class: 'mbar mbar-read', title: '읽기' }, h('span', { class: 'mbar-fill', style: `width:${m.read.rate == null ? 0 : Math.round(m.read.rate * 100)}%` })),
          h('span', { class: 'mbar mbar-write', title: '쓰기' }, wt ? [
            h('span', { class: 'mseg mseg-o', style: `flex-grow:${m.write.o}` }),
            h('span', { class: 'mseg mseg-t', style: `flex-grow:${m.write.t}` }),
            h('span', { class: 'mseg mseg-x', style: `flex-grow:${m.write.x}` })] : null)));
    }

    function renderGrid() {
      gridBox.textContent = '';
      gridBox.appendChild(kanaTable(Q.BASIC_ROWS, view, masteryCell, '기본 글자 숙련도'));
      gridBox.appendChild(kanaTable(Q.DAKUTEN_ROWS.concat(Q.HANDAKUTEN_ROWS), view, masteryCell, '탁음·반탁음 숙련도'));
    }

    const confusions = Q.topConfusions(stats, 8, D);
    const trouble = Q.orderTrouble(stats, 24);
    const sessions = stats.sessions.slice().reverse().slice(0, 12);
    const any = Q.hasHistory(stats) || stats.sessions.length > 0;
    const fmt = (ts) => {
      try { return new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
    };

    main.appendChild(h('div', { class: 'records-page' },
      h('header', { class: 'page-head' },
        h('h1', { class: 'page-title' }, '기록'),
        h('p', { class: 'page-sub' }, any ? '글자별로 얼마나 익숙한지 한눈에 보여요.' : '아직 기록이 없어요. 테스트를 풀면 여기에 쌓여요.')),
      h('section', { class: 'card totals' },
        h('div', { class: 'total' }, h('span', { class: 'total-n' }, totals.read ? Math.round(100 * totals.readOk / totals.read) + '%' : '—'), h('span', { class: 'total-l' }, `읽기 정답률 (${totals.read}문제)`)),
        h('div', { class: 'total' }, h('span', { class: 'total-marks' }, markChip('o', totals.o), markChip('t', totals.t), markChip('x', totals.x)), h('span', { class: 'total-l' }, '쓰기 결과')),
        h('div', { class: 'total' }, h('span', { class: 'total-n' }, totals.cheat), h('span', { class: 'total-l' }, '컨닝'))),
      h('section', { class: 'rec-sec' },
        h('div', { class: 'rec-head' },
          h('h2', { class: 'sec-h' }, '글자별 숙련도'),
          segmented('recview', '문자', [{ value: 'hira', label: '히라가나', glyph: 'あ' }, { value: 'kata', label: '가타카나', glyph: 'ア' }], view,
            (v) => { view = v; state.prefs.recordsView = v; persist(); renderGrid(); info.textContent = ''; }, 'view-toggle')),
        h('div', { class: 'mastery-legend', 'aria-hidden': 'true' },
          h('span', { class: 'lg lg-high' }, '익숙함'), h('span', { class: 'lg lg-mid' }, '보통'), h('span', { class: 'lg lg-low' }, '연습 필요'), h('span', { class: 'lg lg-none' }, '기록 없음'),
          h('span', { class: 'lg-bars' }, h('span', { class: 'mbar mbar-read' }, h('span', { class: 'mbar-fill', style: 'width:70%' })), ' 읽기'),
          h('span', { class: 'lg-bars' }, h('span', { class: 'mbar mbar-write' }, h('span', { class: 'mseg mseg-o', style: 'flex-grow:3' }), h('span', { class: 'mseg mseg-t', style: 'flex-grow:1' }), h('span', { class: 'mseg mseg-x', style: 'flex-grow:1' })), ' 쓰기 ○△✕')),
        info,
        gridBox),
      h('div', { class: 'rec-cols' },
        h('section', { class: 'rec-sec card' },
          h('h2', { class: 'sec-h' }, '자주 헷갈린 글자'),
          confusions.length ? h('ul', { class: 'conf-list' }, confusions.map((c) => {
            const g = D.kana[c.a] && D.kana[c.b] ? Q.groupFor(c.a, c.b, D) : null;
            return h('li', { class: 'conf-item' },
              h('div', { class: 'conf-pair' },
                h('button', { type: 'button', class: 'conf-glyph', 'aria-label': c.a + ' 자세히', on: { click: () => openDetail(c.a) } }, jp(c.a)),
                h('span', { class: 'conf-vs', 'aria-hidden': 'true' }, '↔'),
                h('button', { type: 'button', class: 'conf-glyph', 'aria-label': c.b + ' 자세히', on: { click: () => openDetail(c.b) } }, jp(c.b)),
                h('span', { class: 'conf-count' }, `${c.count}회`)),
              g ? h('p', { class: 'conf-tip' }, richText(g.tip)) : null);
          })) : h('p', { class: 'empty' }, '아직 헷갈린 글자가 없어요.')),
        h('section', { class: 'rec-sec card' },
          h('h2', { class: 'sec-h' }, '획순 주의 글자 ', h('span', { class: 'mchip-sym tri-sym', 'aria-hidden': 'true' }, '△')),
          trouble.length ? [
            h('ul', { class: 'trouble-list' }, trouble.map((x) => h('li', null,
              h('button', { type: 'button', class: 'trouble-item', 'aria-label': `${x.ch} 획순 보기, △ ${x.t}회`, on: { click: () => openDetail(x.ch) } },
                jp(x.ch, 'trouble-glyph'), h('span', { class: 'trouble-n' }, `△ ${x.t}`))))),
            h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => startTest('write', trouble.map((x) => x.ch), { label: '획순 주의 글자' }) } }, icon('pen'), '이 글자들 쓰기 연습'),
          ] : h('p', { class: 'empty' }, '획순(△) 기록이 아직 없어요.'))),
      h('section', { class: 'rec-sec card' },
        h('h2', { class: 'sec-h' }, '최근 테스트'),
        sessions.length ? h('ul', { class: 'session-list' }, sessions.map((x) => h('li', { class: 'session' },
          h('span', { class: 'ses-date' }, fmt(x.t)),
          h('span', { class: 'ses-kind' }, `${x.mode === 'write' ? '쓰기' : '읽기'} · ${SCRIPT_LABEL[x.script] || ''}${x.retry ? ' · 다시' : ''}${x.endless ? ' · ∞ 무한' : ''} · ${x.n}문제`),
          h('span', { class: 'ses-marks' }, markChip('o', x.o), x.mode === 'write' ? markChip('t', x.tri) : null, markChip('x', x.x), x.cheat ? h('span', { class: 'cheat-tag' }, `컨닝 ${x.cheat}`) : null)))) : h('p', { class: 'empty' }, '아직 푼 테스트가 없어요.')),
      reportSection(),
      h('section', { class: 'rec-sec rec-reset' },
        h('button', { type: 'button', class: 'btn btn-danger-quiet', disabled: any ? null : true, on: { click: () => {
          // name the other devices only when this browser syncs (or has synced) with a claude.ai account
          let synced = false;
          try { const s = KS && KS.status(); synced = !!(s && ((s.cloud && s.cloud !== 'off') || s.uid)); } catch (e) { synced = false; }
          const where = synced ? '이 기기와 같은 계정으로 동기화된 모든 기기에서' : '이 기기에서';
          askConfirm({ title: '기록을 모두 지울까요?', message: `글자별 기록, 헷갈린 글자, 최근 테스트가 ${where} 사라져요. 단어장 기록과 판정 신고는 그대로 남아요. 되돌릴 수 없어요.`, ok: '모두 지우기', cancel: '취소', danger: true })
            .then((yes) => { if (!yes) return; persistence.resetStats(state); toast('기록을 지웠어요.'); go('records', { force: true }); });
        } } }, '기록 초기화'))));
    renderGrid();
  };

  /* '판정 신고' on 기록: the reports saved with '판정이 이상해요' (newest first), each with the drawing; export as JSON
   * (a read-only text box + 복사하기 — no downloads, nothing is sent anywhere) and 모두 지우기 (in-page confirmation).
   * Re-renders itself in place. */
  const REPORTS_SHOWN = 10;
  function reportSection(showAll) {
    const list = persistence.reports.list().slice().reverse();
    const sec = h('section', { class: 'rec-sec card rep-sec', 'aria-labelledby': 'rep-sec-h' });
    const rerender = (all, focusSel) => {
      const next = reportSection(all);
      if (sec.parentNode) sec.parentNode.replaceChild(next, sec);
      const f = focusSel ? next.querySelector(focusSel) : null;
      if (f) {
        if (!f.hasAttribute('tabindex') && !/^(BUTTON|TEXTAREA|INPUT|A)$/.test(f.tagName)) f.setAttribute('tabindex', '-1');
        try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); }
      }
    };
    const fmt = (ts) => {
      try { return new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
    };
    sec.appendChild(h('h2', { class: 'sec-h', id: 'rep-sec-h' }, '판정 신고', h('small', null, list.length ? `${list.length}건 · 이 기기에만 저장` : '이 기기에만 저장')));
    sec.appendChild(h('p', { class: 'sec-note' }, `채점 결과에서 ‘판정이 이상해요’를 누른 글씨가 여기에 모여요 (최대 ${REPORTS_MAX}건). 인터넷으로 보내지 않아요. 내보내기로 복사해 두면 채점을 고칠 때 자료로 쓸 수 있어요.`));
    if (!list.length) {
      sec.appendChild(h('p', { class: 'empty' }, '아직 신고한 판정이 없어요.'));
      return sec;
    }
    const STRICT = { lenient: '너그럽게', normal: '보통', strict: '엄격하게' };
    const shown = showAll ? list : list.slice(0, REPORTS_SHOWN);
    sec.appendChild(h('ul', { class: 'rep-list', 'aria-label': '신고한 판정' }, shown.map((x) => {
      const mark = x.mark === 'o' || x.mark === 't' ? x.mark : 'x';
      const strokes = Array.isArray(x.strokes) ? x.strokes.filter((st) => Array.isArray(st) && st.length) : [];
      let thumb = null;
      try {
        const fr = drawingFrame(strokes, x.box);
        thumb = SV.userDrawing(fr.strokes, { box: fr.box, numbers: false, arrows: false, label: `${x.target} 자리에 쓴 글씨` });
      } catch (e) { thumb = null; }
      const rec = x.recognized && x.recognized !== x.target ? x.recognized : null;
      const meta = [fmt(x.ts), REPORT_SOURCE[x.source] || '', x.judge && STRICT[x.judge.strictness] ? '채점 ' + STRICT[x.judge.strictness] : ''].filter(Boolean).join(' · ');
      return h('li', { class: 'rep-item' },
        h('div', { class: 'rep-thumb' }, thumb),
        h('div', { class: 'rep-main' },
          h('p', { class: 'rep-title' }, jp(x.target, 'rep-glyph'), h('span', null, '쓰기'), markChip(mark, null, 'rep-mark'),
            rec ? h('span', { class: 'rep-rec' }, jp(rec), josaRo(rec) + ' 인식') : null),
          h('p', { class: 'rep-kindtext' }, reportKindLabel(x.kind)),
          x.userNote ? h('p', { class: 'rep-usernote' }, '“' + x.userNote + '”') : null,
          h('p', { class: 'rep-meta' }, meta)),
        h('button', { type: 'button', class: 'icon-btn rep-del', 'aria-label': `${fmt(x.ts)} ${x.target} 신고 지우기`, title: '이 신고 지우기',
          on: { click: () => { persistence.reports.remove(x.id); toast('신고 1건을 지웠어요.'); rerender(showAll, '#rep-sec-h'); } } }, icon('close')));
    })));
    if (!showAll && list.length > shown.length) {
      sec.appendChild(h('button', { type: 'button', class: 'btn btn-sm btn-quiet rep-more', on: { click: () => rerender(true, '.rep-list') } },
        `${list.length - shown.length}건 더 보기`));
    }
    const exportBox = h('div', { class: 'rep-export', id: 'rep-export', hidden: true });
    const exportBtn = h('button', { type: 'button', class: 'btn btn-sm', 'aria-expanded': 'false', 'aria-controls': 'rep-export' }, icon('copy'), '내보내기 (JSON)');
    exportBtn.addEventListener('click', () => {
      const open = exportBox.hidden;
      exportBox.hidden = !open;
      exportBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) return;
      exportBox.textContent = '';
      const all = persistence.reports.list();
      const text = '{"kind":"kana-judge-reports","v":1,"appVersion":' + JSON.stringify(APP_VERSION) + ',"exportedAt":' + JSON.stringify(new Date().toISOString())
        + ',"count":' + all.length + ',"reports":[\n' + all.map((x) => JSON.stringify(persistence.reports.exportable(x))).join(',\n') + '\n]}\n';
      const ta = h('textarea', { id: 'rep-json', class: 'rep-json', readonly: true, rows: 7, spellcheck: 'false', 'aria-describedby': 'rep-copy-status' });
      ta.value = text;
      const status = h('p', { class: 'rep-copy-status', id: 'rep-copy-status', role: 'status' });
      const copyBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary' }, icon('copy'), '복사하기');
      copyBtn.addEventListener('click', () => copyText(ta, status));
      add(exportBox, [h('label', { class: 'field-label', for: 'rep-json' }, `내보낼 내용 (JSON, ${all.length}건 · 약 ${Math.max(1, Math.round(text.length / 1024))}KB)`), ta,
        h('div', { class: 'rep-export-actions' }, copyBtn, status)]);
      try { ta.focus({ preventScroll: true }); ta.select(); } catch (e) { /* focus / select unsupported: the text is still there */ }
    });
    const clearBtn = h('button', { type: 'button', class: 'btn btn-sm btn-danger-quiet' }, '모두 지우기');
    clearBtn.addEventListener('click', () => {
      askConfirm({ title: '판정 신고를 모두 지울까요?', message: `저장된 신고 ${list.length}건이 이 기기에서 사라져요. 필요하면 먼저 내보내기로 복사해 두세요.`, ok: '모두 지우기', cancel: '취소', danger: true })
        .then((yes) => {
          if (!yes) return;
          persistence.reports.clear();
          toast('판정 신고를 모두 지웠어요.');
          rerender(false, '#rep-sec-h');
        });
    });
    sec.appendChild(h('div', { class: 'rep-actions' }, exportBtn, clearBtn));
    sec.appendChild(exportBox);
    return sec;
  }

  // Copy a text box's content: the async clipboard, else the selection + execCommand, else leave it selected.
  function copyText(ta, status) {
    const okMsg = '복사했어요. 메모장이나 메시지에 붙여 넣으세요.';
    const fallback = () => {
      let ok = false;
      try { ta.focus(); ta.select(); ok = !!(document.execCommand && document.execCommand('copy')); } catch (e) { ok = false; }
      status.textContent = ok ? okMsg : '자동 복사가 안 돼요. 글 상자의 내용이 모두 선택돼 있으니 Ctrl+C를 누르거나 길게 눌러 복사해 주세요.';
      if (!ok) { try { ta.focus(); ta.select(); } catch (e) { /* ignore */ } }
    };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(ta.value).then(() => { status.textContent = okMsg; }, fallback);
        return;
      }
    } catch (e) { /* fall through */ }
    fallback();
  }

  /* ================================================================ global wiring */

  function init() {
    if (!D || !Q || !SV || !DP) {
      document.getElementById('main').textContent = '필요한 파일을 불러오지 못했어요. 페이지를 새로 고쳐 주세요.';
      return;
    }
    applyTheme();
    if (!persistence.isLocal()) showStorageNote();
    if (KS) KS.onChange(onStoreChange);

    Object.keys(REGISTERED).forEach((id) => addNavTab(id, REGISTERED[id].navLabel)); // registered before the DOM was ready
    // Delegated, so tabs added later by registerScreen work too.
    document.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-nav]') : null;
      if (!b) return;
      e.preventDefault();
      onNavClick(b.dataset.nav);
    });
    const brand = $('#brand');
    if (brand) brand.addEventListener('click', (e) => { e.preventDefault(); if (state.test && state.test.active) confirmQuit('home'); else go('home'); });
    const skip = $('#skip-link');
    if (skip) skip.addEventListener('click', (e) => { e.preventDefault(); const m = $('#main'); m.focus(); });
    $('#theme-btn').addEventListener('click', () => {
      const order = ['system', 'light', 'dark'];
      state.prefs.theme = order[(order.indexOf(state.prefs.theme) + 1) % order.length];
      persist();
      applyTheme();
      toast(state.prefs.theme === 'system' ? '화면 테마: 기기 설정 따름' : state.prefs.theme === 'light' ? '화면 테마: 밝게' : '화면 테마: 어둡게');
    });

    wireDialog($('#sheet'), () => { clearSheet(); refocusTest(); });
    wireDialog($('#cheat'), refocusTest);
    wireDialog($('#confirm'), refocusTest);

    window.addEventListener('hashchange', () => {
      const r = routeFromHash();
      if (!r) { if (hashId()) pendingRoute = hashId(); return; } // maybe a screen that registers later
      if (r === state.screen) return;
      if (state.test && state.test.active) { setHash(state.screen); if (r === 'chart') openCheat(); else confirmQuit(r); return; }
      if (r === 'chart' && chartHandled()) { setHash(state.screen); return; }
      go(r);
    });

    document.addEventListener('keydown', (e) => {
      if (anyDialogOpen()) return;
      const tag = e.target && e.target.tagName;
      const interactive = /^(BUTTON|INPUT|TEXTAREA|SELECT|A|SUMMARY)$/.test(tag || '');
      const main = $('#main');
      if (state.screen === 'write' && main._writeApi) {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
          if ((tag === 'INPUT' && e.target.type === 'text') || tag === 'TEXTAREA') return;
          e.preventDefault();
          main._writeApi.undo();
          return;
        }
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !interactive) {
          e.preventDefault();
          main._writeApi.enter();
        }
      } else if (state.screen === 'read' && main._readApi && e.key === 'Enter' && !interactive && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        main._readApi.next();
      }
    });

    const first = routeFromHash();
    if (!first && hashId()) pendingRoute = hashId();
    started = true;
    go(first || 'home', { noFocus: true });
    // Cloud sync lights up after the first render (never during the first synchronous run).
    if (KS) setTimeout(() => { try { KS.connectCloud(); } catch (e) { console.error(e); } }, 0);
  }

  /* KanaStore.onChange: another tab / device changed settings or stats (or sync status changed). Adopt them, then
   * re-render the screens that only show data (홈, 기록) — never a running test or an open dialog. Registered
   * screens (단어장) subscribe to KanaStore themselves. */
  function onStoreChange(c) {
    if (!c) return;
    let rerender = false;
    if (c.settings && typeof c.settings === 'object') { state.settings = Q.sanitizeSettings(c.settings); rerender = true; }
    if (c.deviceStats && typeof c.deviceStats === 'object') { state.stats = c.deviceStats; rerender = true; }
    if (c.stats) rerender = true;
    if (c.prefs && typeof c.prefs === 'object') {
      const p = sanitizePrefs(c.prefs);
      const themeChanged = p.theme !== state.prefs.theme;
      state.prefs = p;
      if (themeChanged) applyTheme();
    }
    if (c.status) updateStorageNote();
    // another claude.ai account signed in: a store that does not report status().uid writes its main record (whose
    // uid tells whose 판정 신고 to show) only after a short delay — write it now so 기록 below shows this account's
    if (c.account && storeUid() === undefined) { try { KS.flush(); } catch (e) { /* the next save writes it */ } }
    if (!rerender || (state.test && state.test.active) || anyDialogOpen()) return;
    if (state.screen !== 'home' && state.screen !== 'records') return;
    const main = $('#main');
    const a = document.activeElement;
    // don't pull the page out from under a control the learner is using on 홈 (a chip, a switch …) or in 기록's 판정 신고
    if (state.screen === 'home' && a && a !== main && main && main.contains(a)) return;
    if (state.screen === 'records' && a && a.closest && a.closest('.rep-sec') && !c.account) return;
    go(state.screen, { force: true, keepScroll: true, noFocus: true });
  }

  /* ================================================================ extension API — window.KanaApp
   * The only surface other modules (js/words.js) may use; nothing else in this file is public.
   *   registerScreen(id, { navLabel, render(container, params), onLeave?(), confirmLeave?(), chartNav?() })
   *       Adds a nav tab (before 기록) and the #id deep link. render() fills the emptied <main> (params from go()).
   *       onLeave() runs whenever that render is torn down (another screen, or go(id, otherParams)).
   *       confirmLeave() → null | { title, body, ok, cancel } asks before navigating away (e.g. mid-practice).
   *       chartNav() → true when the screen handles the 글자표 tab itself (e.g. KanaApp.openCheat during a
   *       practice, tagging the question as 컨닝); otherwise the tab navigates to 글자표 (after confirmLeave).
   *   go(id, params)                            'home' | 'chart' | 'records' | a registered id
   *   openCheat(script?, { note?, inTest? })    chart overlay ('hira' | 'kata' | 'mix'); → Promise, resolved on close
   *   openDetail(ch)                            detail sheet for any kana or extra (っ ゃ ー 。 …)
   *   confirm({ title, body, ok, cancel, danger? }) → Promise<boolean>   in-page dialog (no native dialogs)
   *   recordWriting(ch, mark, { cheat, source: 'word', result?, confusedWith? }) → bool
   *       per-char writing stats for the 기록 screen (kana only; extras are not in the records → false)
   *   getSettings()                             copy of the test settings { script, rows, count, strictness, penOnly, … }
   *   store                                     window.KanaStore when loaded, else null
   *   ui.resultMark(mark, { size: 'sm'|'md'|'lg' })              red-pen ○ / △ / ✕ (SVG)
   *   ui.judgeDetail(result, strokes, { ch, variant, box, … })   the shared graded-drawing detail (see judgeDetail);
   *                                                              kana, extras and kanji once KANJI_DATA is loaded;
   *                                                              draws the result's 구별 포인트 and carries the
   *                                                              '판정이 이상해요' report control ({ report: false } hides it)
   *   ui.revealBelow(anchor, keep, { instant?, keepEnd? }) → bool  the post-answer scroll: brings the result (anchor)
   *                                                              into view while keep (다음 문제 / the next step; element
   *                                                              or list) stays on screen (see revealBelow)
   *   ui.glyph(ch, { strokes, numbers, className })              kana in the textbook face (<span lang="ja">), or with
   *                                                              strokes:true its stroke SVG in a 十 box (real position;
   *                                                              kanji too, from KANJI_DATA)
   *   toast(message)                                             the app's short status message (bottom of the page)
   *   getPrefs(name) → object | null, setPrefs(name, object)     a module's own device-local UI preferences (e.g. the
   *                                                              단어장 practice setup), saved with the app's prefs
   *                                                              (prefs.ext[name]; plain JSON, ≤ 8 KB, never synced)
   * Also exposed for debugging / automated checks: state, startTest, persist. */

  function registerScreen(id, def) {
    if (!/^[a-z][a-z0-9-]*$/.test(String(id)) || !def || typeof def.render !== 'function') throw new Error('KanaApp.registerScreen: bad screen ' + id);
    if (SCREENS[id] && !REGISTERED[id]) throw new Error('KanaApp.registerScreen: "' + id + '" is a built-in screen');
    REGISTERED[id] = def;
    SCREENS[id] = (main, params) => {
      onCleanup(() => { if (typeof def.onLeave === 'function') def.onLeave(); });
      def.render(main, params || null);
    };
    if (def.navLabel) addNavTab(id, def.navLabel);
    if (started && pendingRoute === id) {
      pendingRoute = null;
      if (state.screen === 'home' && !(state.test && state.test.active)) go(id);
    }
  }

  window.KanaApp = {
    registerScreen,
    go: (id, params) => go(id, { params }),
    openCheat: (script, opts) => openCheat(script || null, opts),
    openDetail: (ch) => openDetail(ch),
    confirm: (o) => askConfirm(Object.assign({}, o || {}, { message: (o && (o.body || o.message)) || null })),
    recordWriting(ch, mark, opts) {
      const o = opts || {};
      if (!D.kana[ch]) return false;
      const m = mark === 'o' || mark === 't' ? mark : 'x';
      Q.recordWriting(state.stats, ch, { mark: m, cheat: !!o.cheat, source: o.source || null, confusedWith: o.confusedWith || confusedOf(o.result, ch) });
      persist();
      return true;
    },
    getSettings: () => JSON.parse(JSON.stringify(state.settings)),
    get store() { return window.KanaStore || null; },
    toast: (msg) => toast(String(msg == null ? '' : msg)),
    getPrefs(name) {
      const v = state.prefs.ext && state.prefs.ext[name];
      return v ? JSON.parse(JSON.stringify(v)) : null;
    },
    setPrefs(name, value) {
      const next = sanitizeExtPrefs(Object.assign({}, state.prefs.ext, { [name]: value }));
      if (!next[name]) return false;
      state.prefs.ext = next;
      persist();
      return true;
    },
    ui: {
      resultMark: (mark, o) => markSvg(MARKS[mark] ? mark : 'x', 'mk-' + ((o && o.size) || 'md')),
      judgeDetail: (result, strokes, o) => judgeDetail(result, strokes, o),
      revealBelow: (anchor, keep, o) => revealBelow(anchor, keep, o),
      glyph(ch, o) {
        const opt = o || {};
        if (opt.strokes) return strokeGlyph(ch, { numbers: !!opt.numbers, label: ch, className: opt.className });
        return jp(ch, opt.className);
      },
    },
    // debugging / automated checks only
    state, startTest, persist,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
