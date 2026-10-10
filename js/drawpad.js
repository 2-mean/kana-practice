/* Drawing pad for 가나 연습장 (browser only): a square practice box with 十 guide lines and a canvas
 * that records pen / touch / mouse strokes with Pointer Events.
 *
 *   const pad = DrawPad.create(hostElement, { onChange, penOnly, label, pressure })
 *   pad.getStrokes()        → Array<Array<[x, y]>> in canvas CSS px (y down), in drawing order
 *   pad.getStrokeCount()    → number
 *   pad.undo() / pad.clear()
 *   pad.setGuideGlyph(ch|null, variantId?)  faint model glyph inside the box (from KANA_DATA strokes)
 *   pad.setPenOnly(bool), pad.isPenOnly(), pad.hasSeenPen()
 *   pad.setEnabled(bool), pad.getBoxSize(), pad.redraw(), pad.destroy()
 *   pad.onChange = fn(strokes, { reason: 'stroke'|'undo'|'clear'|'resize' })
 *   options.penZone      the writing block: a pen over it pins the page (default: the host's parent — the pad with
 *                        its tools and buttons); null for none
 *
 * Palm rejection: with penOnly on, once a 'pen' pointer has been seen, 'touch' pointers are ignored
 * (and a touch stroke in progress is dropped when the pen comes down or hovers into view). Pen detection is
 * shared by every pad of the page session and also counts a hovering pen, so a palm that lands on a fresh
 * pad before the pen's first contact is still rejected. A second finger landing during a touch stroke
 * (pinch, two-finger scroll, palm) drops that stroke.
 *
 * Keeping the page still while writing (the box is re-read on every move, so a page that moves under the pen bends
 * the stroke): a thin ring around the box (.pad::before, css/app.css) is writing surface too, so a stroke begun just
 * outside the box writes instead of panning the page — a stroke that never enters the box is dropped; while a pen
 * is over the writing block (penZone) or writing, nothing on the page pans (html.pad-pen-near), so the writing hand
 * resting anywhere cannot scroll it between strokes; during a stroke any scroll that still happens is undone at
 * once (tracker pinScroll); and while any pad takes input the page neither rubber-bands nor chains a scroll into a
 * host page (html.pad-live).
 *
 * DrawPad.Ink is the pointer / ink plumbing shared with js/gridpad.js (not part of the app-facing API). */
(function (root, factory) {
  root.DrawPad = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const VB = 109;

  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  /* ================================================================ shared ink plumbing (DrawPad.Ink) */

  // Page-wide pen detection: set by a pen contact on any pad, or by any pen event (hover included —
  // Apple Pencil, S Pen and Windows Ink report pointerType 'pen' with buttons 0) anywhere on the page.
  let penSeen = false;
  let penSniffing = false;
  const penWatchers = new Set();

  function markPen() {
    if (penSeen) return;
    penSeen = true;
    penWatchers.forEach((fn) => { try { fn(); } catch (e) { if (root.console) console.error(e); } });
    penWatchers.clear();
  }

  // Calls fn() once, when a pen is first seen on the page (at once if it already was). Returns a stop function.
  function onPenSeen(fn) {
    if (penSeen) { fn(); return () => {}; }
    penWatchers.add(fn);
    return () => penWatchers.delete(fn);
  }

  function watchPen(doc) {
    if (penSeen || penSniffing || !doc) return;
    penSniffing = true;
    const types = ['pointerover', 'pointerdown', 'pointermove'];
    const opts = { capture: true, passive: true };
    const sniff = (e) => {
      if (e.pointerType !== 'pen') return;
      markPen();
      types.forEach((t) => doc.removeEventListener(t, sniff, opts));
    };
    types.forEach((t) => doc.addEventListener(t, sniff, opts));
  }

  function setDrawing(doc, on) {
    if (doc && doc.documentElement) doc.documentElement.classList.toggle('pad-drawing', on);
  }

  // Counted class: el has cls while at least one owner holds it (several pads can share a page or a block).
  const holds = new WeakMap();   // el → Map(cls → Set(owner))
  function hold(el, cls, owner, on) {
    if (!el || !el.classList) return;
    let m = holds.get(el);
    if (!m) { m = new Map(); holds.set(el, m); }
    let set = m.get(cls);
    if (!set) { set = new Set(); m.set(cls, set); }
    if (on) set.add(owner);
    else set.delete(owner);
    el.classList.toggle(cls, set.size > 0);
  }

  /* While a pad takes input, html.pad-live: the page neither rubber-bands nor pull-to-refreshes, and does not chain
   * a scroll into a host page (css overscroll-behavior). Not in an iframe whose document cannot scroll (an embed
   * sized to its content): there it would stop the host page from scrolling at all. */
  function setLive(doc, owner, on) {
    const win = doc.defaultView || root;
    let ok = on;
    if (ok) {
      try { ok = win.top === win || doc.documentElement.scrollHeight > (win.innerHeight || 0) + 1; } catch (e) { ok = true; }
    }
    hold(doc.documentElement, 'pad-live', owner, ok);
  }

  /* Pen near the writing block -> the whole page is pinned. While a pen has been over a live pad's block (its zone: by
   * default the host's parent — the box with its tools and buttons) within NEAR_MS, or is writing, html has
   * .pad-pen-near: touch-action none page-wide, scrollers included (css/app.css), so the writing hand resting
   * anywhere — below the box, on the gutters, on the mini strip, in a dialog — cannot pan the page between strokes.
   * Once the pen is put away a finger scrolls as usual; taps work throughout (touch-action never blocks a tap).
   * A hovering pen (S Pen, Apple Pencil on an M2 iPad Pro) arms it before the first contact, else the first stroke
   * does. */
  const NEAR_MS = 1500;
  const nearZones = new Map();      // owner -> { zone, live() }
  const nearTimers = new WeakMap(); // document -> timer
  const nearWatched = new WeakSet();

  function nearOff(doc) {
    const win = doc.defaultView || root;
    const t = nearTimers.get(doc);
    if (t) { win.clearTimeout(t); nearTimers.delete(doc); }
    doc.documentElement.classList.remove('pad-pen-near');
  }

  function openModal(doc) {
    try { return doc.querySelector('dialog:modal'); } catch (e) { return doc.querySelector('dialog[open]'); }
  }

  // A live zone (not hidden behind a modal dialog) that contains target, or whose rect — 24 px taller at the top, 12 px
  // wider at the sides, for a pen coming from the prompt above — contains (x, y); any live zone when neither is given.
  function anyLiveZone(doc, target, x, y) {
    const modal = openModal(doc);
    for (const z of nearZones.values()) {
      if (!z.live() || z.zone.ownerDocument !== doc || !z.zone.isConnected) continue;
      if (modal && !modal.contains(z.zone)) continue;
      if (!target) return true;
      if (z.zone.contains(target)) return true;
      if (x != null) {
        const r = z.zone.getBoundingClientRect();
        if (r.width && x >= r.left - 12 && x <= r.right + 12 && y >= r.top - 24 && y <= r.bottom) return true;
      }
    }
    return false;
  }

  function armNear(doc) {
    const win = doc.defaultView || root;
    const t = nearTimers.get(doc);
    if (t) win.clearTimeout(t);
    doc.documentElement.classList.add('pad-pen-near');
    nearTimers.set(doc, win.setTimeout(function expire() {
      // still writing (a long stroke): keep it
      if (doc.documentElement.classList.contains('pad-drawing') && anyLiveZone(doc)) { nearTimers.set(doc, win.setTimeout(expire, NEAR_MS)); return; }
      nearOff(doc);
    }, NEAR_MS));
  }

  function watchNear(doc) {
    if (!doc || nearWatched.has(doc)) return;
    nearWatched.add(doc);
    const fn = (e) => { if (e.pointerType === 'pen' && anyLiveZone(doc, e.target, e.clientX, e.clientY)) armNear(doc); };
    ['pointerover', 'pointermove', 'pointerdown', 'pointerup'].forEach((t) => doc.addEventListener(t, fn, { capture: true, passive: true }));
  }

  function nearSync(doc) { if (!anyLiveZone(doc)) nearOff(doc); }

  /* A palm (or finger) that was already panning the page when the pen came down: html.pad-drawing stops the pan
   * (css overflow, touch screens), but the browser resumes it the moment the stroke ends. So when a stroke ends while
   * touches are still down, html.pad-hold keeps the page still until the last of them lifts (HOLD_MAX_MS at most). */
  const HOLD_MAX_MS = 4000;
  const touchState = new WeakMap();   // document -> { down, timer }

  function watchTouches(doc) {
    if (!doc || touchState.has(doc)) return;
    const st = { down: 0, timer: 0 };
    touchState.set(doc, st);
    const upd = (e) => {
      st.down = e.touches ? e.touches.length : 0;
      if (!st.down) releaseHold(doc);
    };
    ['touchstart', 'touchend', 'touchcancel'].forEach((t) => doc.addEventListener(t, upd, { capture: true, passive: true }));
    // A touch whose target is removed from the page while it is down ends on the detached target only, never on the
    // document: listen there too, or the count stays stale and every later stroke holds the page for HOLD_MAX_MS.
    doc.addEventListener('touchstart', (e) => {
      const t = e.target;
      if (!t || !t.addEventListener) return;
      ['touchend', 'touchcancel'].forEach((type) => t.addEventListener(type, (ev) => { if (!t.isConnected) upd(ev); }, { once: true, passive: true }));
    }, { capture: true, passive: true });
  }

  function releaseHold(doc) {
    const st = touchState.get(doc);
    if (st && st.timer) { (doc.defaultView || root).clearTimeout(st.timer); st.timer = 0; }
    doc.documentElement.classList.remove('pad-hold');
  }

  function holdWhileTouched(doc) {
    const st = touchState.get(doc);
    if (!st || !st.down) return;
    const win = doc.defaultView || root;
    doc.documentElement.classList.add('pad-hold');
    if (st.timer) win.clearTimeout(st.timer);
    st.timer = win.setTimeout(() => releaseHold(doc), HOLD_MAX_MS);
  }

  // Registers (zone) or removes (zone null) a pad's block. Call nearSync() whenever the pad's liveness changes.
  function nearZone(doc, owner, zone, live) {
    if (zone) { nearZones.set(owner, { zone, live }); watchNear(doc); } else nearZones.delete(owner);
    nearSync(doc);
  }

  function pixelRatio(win) { return Math.max(1, Math.min(3, (win && win.devicePixelRatio) || 1)); }

  /* Whether stroke P (points { x, y, f } in local units, k css px per unit, box 0..side) leaves at least INK_MIN css px
   * of visible ink inside the box, from the ink drawStroke() actually lays down: a dot of radius 0.62·base·f of its
   * first point, each segment a line of half-width 0.5·base·(mean f of its ends) (base = baseWidth of the box's css
   * size). Segments, not points: a quick flick across a corner inks the box between two samples outside it. A stroke
   * begun on the ring around a box that never reaches into it this far — a tap or a flick beside the box — is not a
   * stroke.
   * Distances are signed (inside the box: minus how deep the centre line gets), so a line drawn inside the box counts
   * however thin it is: a light pen (pressure ~0.1–0.3, width factor under 1) in a small box (a 64–132 px 원고지 cell,
   * base 3–4.5 px) draws a line narrower than 2·INK_MIN, which an unsigned distance of 0 inside rejected on pen-up. */
  const INK_MIN = 1.5;
  function inksBox(P, side, k) {
    if (!P.length) return false;
    const base = baseWidth(side * k);
    const f = (p) => p.f || 1;
    // signed distance (units) from point (x, y) to the box edge: outside, the distance to the box; inside, minus the
    // distance to the nearest edge
    const dPt = (x, y) => {
      const ox = Math.max(-x, 0, x - side), oy = Math.max(-y, 0, y - side);
      return ox || oy ? Math.hypot(ox, oy) : -Math.min(x, y, side - x, side - y);
    };
    // signed distance (units) from segment a-b to the box: if it enters the box, minus its deepest point's depth (well
    // enough sampled); else the least of its ends' distances and the box corners' distances to the segment
    function dSeg(a, b) {
      if (Math.max(a.x, b.x) >= 0 && Math.min(a.x, b.x) <= side && Math.max(a.y, b.y) >= 0 && Math.min(a.y, b.y) <= side) {
        // bounding boxes overlap: does the segment actually enter the box, and how deep? sample it finely enough
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (side / 64)));
        let best = Infinity;
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          best = Math.min(best, dPt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
        }
        if (best <= 0) return best;
      }
      let d = Math.min(dPt(a.x, a.y), dPt(b.x, b.y));
      const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy;
      if (L2 > 0) {
        [[0, 0], [side, 0], [0, side], [side, side]].forEach(([cx, cy]) => {
          const t = Math.max(0, Math.min(1, ((cx - a.x) * vx + (cy - a.y) * vy) / L2));
          d = Math.min(d, Math.hypot(a.x + vx * t - cx, a.y + vy * t - cy));
        });
      }
      return d;
    }
    const dot = P.length === 1 || (P.length === 2 && Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y) * k < 1);
    if (dot) return dPt(P[0].x, P[0].y) * k <= f(P[0]) * base * 0.62 - INK_MIN;
    for (let i = 1; i < P.length; i++) {
      const half = ((f(P[i - 1]) + f(P[i])) / 2) * base * 0.5;
      if (dSeg(P[i - 1], P[i]) * k <= half - INK_MIN) return true;
    }
    return false;
  }

  // Line width (css px) of an unpressured stroke in a box of the given side.
  function baseWidth(sizePx) { return Math.max(3, sizePx * 0.034); }

  // Relative line width (1 = base) for a pointer sample, smoothed with the previous one.
  function widthFactor(e, type, prevF, pressure) {
    if (!pressure || type !== 'pen') return 1;
    // A pen's pointerup reports pressure 0: keep the previous width instead of a blob at the tail.
    if (!(e.pressure > 0)) return prevF || 1;
    const f = 0.55 + 0.9 * Math.min(1, e.pressure);
    return prevF ? prevF * 0.6 + f * 0.4 : f;
  }

  /* Draws one stroke. pts: [{ x, y, f }] in local units; k = css px per unit; base = width (px) at f = 1.
   * The context is expected to be scaled to css px already. */
  function drawStroke(ctx, P, color, k, base) {
    if (!P.length) return;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const X = (p) => p.x * k, Y = (p) => p.y * k;
    const span = P.length > 1 ? Math.hypot(X(P[P.length - 1]) - X(P[0]), Y(P[P.length - 1]) - Y(P[0])) : 0;
    if (P.length === 1 || (P.length === 2 && span < 1)) {
      ctx.beginPath();
      ctx.arc(X(P[0]), Y(P[0]), P[0].f * base * 0.62, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const uniform = P.every((p) => Math.abs(p.f - P[0].f) < 0.01);
    if (uniform) {
      ctx.lineWidth = P[0].f * base;
      ctx.beginPath();
      ctx.moveTo(X(P[0]), Y(P[0]));
      if (P.length === 2) ctx.lineTo(X(P[1]), Y(P[1]));
      for (let i = 1; i < P.length - 1; i++) {
        const mx = (X(P[i]) + X(P[i + 1])) / 2, my = (Y(P[i]) + Y(P[i + 1])) / 2;
        ctx.quadraticCurveTo(X(P[i]), Y(P[i]), mx, my);
      }
      if (P.length > 2) ctx.lineTo(X(P[P.length - 1]), Y(P[P.length - 1]));
      ctx.stroke();
      return;
    }
    // Pressure-varying width: draw each smoothed segment with its own width.
    let sx = X(P[0]), sy = Y(P[0]);
    for (let i = 1; i < P.length; i++) {
      const last = i === P.length - 1;
      const ex = last ? X(P[i]) : (X(P[i]) + X(P[i + 1])) / 2;
      const ey = last ? Y(P[i]) : (Y(P[i]) + Y(P[i + 1])) / 2;
      ctx.lineWidth = ((P[i - 1].f + P[i].f) / 2) * base;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      if (last) ctx.lineTo(ex, ey);
      else ctx.quadraticCurveTo(X(P[i]), Y(P[i]), ex, ey);
      ctx.stroke();
      sx = ex; sy = ey;
    }
  }

  // Gives a canvas a w×h css px box backed by w·dpr × h·dpr pixels. Returns true when anything changed.
  function fitCanvas(canvas, w, h, dpr) {
    const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
    const cw = w + 'px', ch = h + 'px';
    if (canvas.width === bw && canvas.height === bh && canvas.style.width === cw && canvas.style.height === ch) return false;
    canvas.width = bw;
    canvas.height = bh;
    canvas.style.width = cw;
    canvas.style.height = ch;
    return true;
  }

  function inkColor(win, el) {
    try {
      const v = win.getComputedStyle(el).getPropertyValue('--pad-ink').trim();
      return v || '#222';
    } catch (e) { return '#222'; }
  }

  /* Calls cb() when el's size or the devicePixelRatio changes (window dragged to another screen, browser
   * zoom) — a DPR change alone does not resize the css box, so a plain ResizeObserver misses it.
   * Returns a stop function. */
  function observeSize(el, cb) {
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || root;
    let stopped = false, ro = null, mql = null;
    const run = () => { if (!stopped) cb(); };
    if (win.ResizeObserver) {
      ro = new win.ResizeObserver(run);
      try { ro.observe(el, { box: 'device-pixel-content-box' }); } catch (e) { ro.observe(el); }
    } else {
      win.addEventListener('resize', run);
    }
    // Where device-pixel-content-box is unsupported (Safari): a resolution query, re-armed at each change.
    const onRes = () => { arm(); run(); };
    function arm() {
      if (mql) {
        try { if (mql.removeEventListener) mql.removeEventListener('change', onRes); else mql.removeListener(onRes); } catch (e) { /* ignore */ }
        mql = null;
      }
      if (stopped || !win.matchMedia) return;
      try {
        mql = win.matchMedia('(resolution: ' + (win.devicePixelRatio || 1) + 'dppx)');
        if (mql.addEventListener) mql.addEventListener('change', onRes); else mql.addListener(onRes);
      } catch (e) { mql = null; }
    }
    arm();
    return () => {
      stopped = true;
      if (ro) ro.disconnect();
      win.removeEventListener('resize', run);
      arm();
    };
  }

  // Calls cb() when the OS light/dark scheme flips (ink colour comes from a CSS token). Returns a stop function.
  function watchScheme(win, cb) {
    let mq = null;
    try {
      mq = win.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', cb);
    } catch (e) { mq = null; }
    return () => { if (mq && mq.removeEventListener) mq.removeEventListener('change', cb); };
  }

  /* Pointer → stroke recorder for one drawing surface.
   *   tracker(surface, {
   *     enabled() → bool, penOnly() → bool, pressure: bool,
   *     hit(e) → target|null    where a stroke starting with this pointerdown goes (null = not ours, e.g. a
   *                             gap that should scroll the page). target = { el, refresh(), toLocal(ev) → [x, y],
   *                             minStep, loose } — el is the box (focus inside it is kept), refresh() re-reads its
   *                             rect, toLocal maps client coordinates to local units, minStep ≈ 0.6 css px in units,
   *                             loose = the stroke began where the browser may still pan the page (it is dropped
   *                             if the browser then cancels it).
   *     guard(e) → bool         whether to cancel touch scrolling / selection / context menu for this event
   *     touchEl                 element that gets those default-cancelling listeners and the is-drawing class
   *                             during a stroke (default: surface)
   *     update(stroke), commit(stroke), drop(stroke)   stroke = { id, type, target, pts: [{ x, y, f }] }
   *   }) → { active() → stroke|null, cancel(), destroy() } */
  function tracker(surface, o) {
    const doc = surface.ownerDocument || document;
    const guard = o.guard || (() => true);
    const touchEl = o.touchEl || surface;
    let active = null;
    watchPen(doc);
    watchTouches(doc);

    function drawing(on) {
      // record the scroll positions before html.pad-drawing changes any scroller's overflow (css)
      if (on) pinScroll(true);
      setDrawing(doc, on);
      touchEl.classList.toggle('is-drawing', on);
      if (!on) { pinScroll(false); holdWhileTouched(doc); }
    }

    /* While a stroke is being written the page and every scroller around the box are pinned: whatever scrolls them
     * — a palm pan that began before the stroke, a browser's hover-scroll at the screen edge (S Pen Air view),
     * momentum — is undone at once, so the box cannot move under the pen (its rect is re-read on every move). */
    const win = doc.defaultView || root;
    let pins = null;
    const restore = () => {
      if (!pins) return;
      for (const p of pins) {
        if (p.el === win) {
          if (win.scrollX !== p.x || win.scrollY !== p.y) {
            try { win.scrollTo({ left: p.x, top: p.y, behavior: 'instant' }); } catch (e) { win.scrollTo(p.x, p.y); }
          }
        } else if (p.el.scrollLeft !== p.x || p.el.scrollTop !== p.y) {
          p.el.scrollLeft = p.x;
          p.el.scrollTop = p.y;
        }
      }
    };
    const scrollOpts = { capture: true, passive: true };
    function pinScroll(on) {
      if (on && !pins && active) {
        pins = [{ el: win, x: win.scrollX, y: win.scrollY }];
        for (let a = active.target.el.parentElement; a && a !== doc.body && a !== doc.documentElement; a = a.parentElement) {
          const cs = win.getComputedStyle(a);
          if (/auto|scroll|hidden/.test(cs.overflowY + ' ' + cs.overflowX) && (a.scrollHeight > a.clientHeight || a.scrollWidth > a.clientWidth)) {
            pins.push({ el: a, x: a.scrollLeft, y: a.scrollTop });
          }
        }
        doc.addEventListener('scroll', restore, scrollOpts);
      } else if (!on && pins) {
        pins = null;
        doc.removeEventListener('scroll', restore, scrollOpts);
      }
    }

    // A touch stroke is the writing hand's palm once a pen is known to be around (pen-only mode).
    const palmLike = (s) => s.type === 'touch' && o.penOnly() && penSeen;

    function addPoint(e) {
      const P = active.pts;
      const xy = active.target.toLocal(e);
      const last = P[P.length - 1];
      if (last && Math.hypot(xy[0] - last.x, xy[1] - last.y) < active.target.minStep) return;
      P.push({ x: xy[0], y: xy[1], f: widthFactor(e, active.type, last && last.f, o.pressure !== false) });
    }

    function cancel() {
      if (!active) return null;
      const s = active;
      active = null;
      drawing(false);
      o.drop(s);
      return s;
    }

    function onDown(e) {
      if (e.pointerType === 'pen') markPen();
      if (!o.enabled()) return;
      const target = o.hit(e);
      if (!target) return;
      if (e.pointerType === 'touch' && o.penOnly() && penSeen) { if (e.cancelable) e.preventDefault(); return; }
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // The eraser end of a pen (button 5 / buttons 32) never inks. The barrel button (2) still writes.
      if (e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32))) { if (e.cancelable) e.preventDefault(); return; }
      if (active) {
        // A palm (touch) started first and the pen just landed: drop the palm stroke.
        if (active.type === 'touch' && e.pointerType === 'pen') cancel();
        else {
          // A second finger on a touch stroke is a pinch, a two-finger scroll or a palm, not writing: drop the
          // stroke. Any other extra pointer is ignored while a stroke is in progress.
          if (active.type === 'touch' && e.pointerType === 'touch') cancel();
          if (e.cancelable) e.preventDefault();
          return;
        }
      }
      if (e.cancelable) e.preventDefault();
      // preventDefault also stops the focus change, so a toolbar button clicked earlier (지우기, 되돌리기 …)
      // would keep focus and Enter would press it again instead of grading: hand focus back to the page.
      const ae = doc.activeElement;
      if (ae && ae !== doc.body && !target.el.contains(ae) && typeof ae.blur === 'function') ae.blur();
      target.refresh();
      try { surface.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      active = { id: e.pointerId, type: e.pointerType || 'mouse', target, pts: [] };
      addPoint(e);
      drawing(true);
      o.update(active);
    }

    function onMove(e) {
      if (e.pointerType === 'pen') markPen();
      if (!active || e.pointerId !== active.id) return;
      if (e.cancelable) e.preventDefault();
      // The pen showed up (hovering) while this touch stroke was going on: it is the palm, drop it.
      if (palmLike(active)) { cancel(); return; }
      // Undo any scroll first (pinScroll), so this sample is measured against the pinned box; then re-read the box,
      // which may still have moved since pointerdown (rotation, on-screen keyboard).
      restore();
      active.target.refresh();
      let evs = null;
      try { evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null; } catch (err) { evs = null; }
      if (!evs || !evs.length) evs = [e];
      for (const ev of evs) addPoint(ev);
      o.update(active);
    }

    function finish(e, cancelled) {
      if (!active || (e && e.pointerId !== active.id)) return;
      if (e && !cancelled && e.type === 'pointerup') { restore(); active.target.refresh(); addPoint(e); }
      const s = active;
      active = null;
      drawing(false);
      try { if (e) surface.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      // Dropped: a cancelled touch (most likely the browser or a palm taking over), a cancelled stroke that
      // began where the page can pan (the browser scrolled instead), and a touch that turned out to be a palm.
      const drop = !s.pts.length || palmLike(s) || (cancelled && (s.type === 'touch' || !!s.target.loose));
      if (drop) o.drop(s);
      else o.commit(s);
    }

    const onUp = (e) => finish(e, false);
    const onCancel = (e) => finish(e, true);
    const onLost = (e) => { if (active && e.pointerId === active.id) finish(e, false); };
    const prevent = (e) => { if (e.cancelable && guard(e)) e.preventDefault(); };

    const pointer = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp],
      ['pointercancel', onCancel], ['lostpointercapture', onLost]];
    // iPad Safari / Android Chrome: no scrolling, zooming, selection, callout or double-tap zoom in the box.
    const defaults = ['touchstart', 'touchmove', 'touchend', 'contextmenu', 'selectstart', 'dblclick', 'gesturestart', 'dragstart'];
    const passiveFalse = { passive: false };
    pointer.forEach(([t, fn]) => surface.addEventListener(t, fn));
    defaults.forEach((t) => touchEl.addEventListener(t, prevent, passiveFalse));

    return {
      active: () => active,
      cancel,
      destroy() {
        pointer.forEach(([t, fn]) => surface.removeEventListener(t, fn));
        defaults.forEach((t) => touchEl.removeEventListener(t, prevent, passiveFalse));
        if (active) { active = null; drawing(false); }
      },
    };
  }

  const Ink = {
    hasSeenPen: () => penSeen, onPenSeen, watchPen, setDrawing, hold, setLive, nearZone, nearSync, inksBox, pixelRatio, baseWidth, widthFactor, drawStroke,
    fitCanvas, inkColor, observeSize, watchScheme, tracker,
  };

  /* ================================================================ the single-glyph pad */

  function create(host, options) {
    const opts = Object.assign({ penOnly: true, pressure: true, label: '글자 쓰는 칸' }, options || {});
    const doc = host.ownerDocument || document;
    const win = doc.defaultView || root;

    const wrap = doc.createElement('div');
    wrap.className = 'pad';
    const guide = svgEl('svg', { viewBox: `0 0 ${VB} ${VB}`, class: 'pad-guide', 'aria-hidden': 'true', focusable: 'false' });
    svgEl('rect', { x: 0.6, y: 0.6, width: VB - 1.2, height: VB - 1.2, rx: 2.5, class: 'pad-border' }, guide);
    svgEl('path', { d: `M${VB / 2},1.5V${VB - 1.5}M1.5,${VB / 2}H${VB - 1.5}`, class: 'pad-cross' }, guide);
    const ghost = svgEl('g', { class: 'pad-ghost' }, guide);
    const canvas = doc.createElement('canvas');
    canvas.className = 'pad-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', opts.label);
    wrap.appendChild(guide);
    wrap.appendChild(canvas);
    host.appendChild(wrap);

    const ctx = canvas.getContext('2d');
    let strokes = [];          // committed: [{ pts: [{x, y, f}], type }] in canvas css px
    let size = 0, dpr = 1;
    let penOnly = !!opts.penOnly;
    let enabled = true;
    let rafId = 0;
    let destroyed = false;
    let pen = null;            // pointer tracker (below)

    const api = {
      el: wrap,
      canvas,
      onChange: typeof opts.onChange === 'function' ? opts.onChange : null,
      getStrokes,
      getStrokeCount: () => strokes.length,
      undo,
      clear,
      setGuideGlyph,
      setPenOnly(v) { penOnly = !!v; },
      isPenOnly: () => penOnly,
      hasSeenPen: () => penSeen,
      setEnabled(v) {
        enabled = !!v;
        wrap.classList.toggle('is-disabled', !enabled);
        if (!enabled) pen.cancel();
        syncHolds();
      },
      isEnabled: () => enabled,
      getBoxSize: () => size,
      redraw: () => { measure(); draw(); },
      destroy,
    };

    function notify(reason) {
      if (typeof api.onChange === 'function') {
        try { api.onChange(getStrokes(), { reason }); } catch (e) { if (root.console) console.error(e); }
      }
    }

    function getStrokes() {
      return strokes.map((s) => s.pts.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]));
    }

    /* ---------------------------------------------------------- sizing */

    // Returns { changed, resized }: resized = the css box changed (stored points were rescaled).
    function measure() {
      const rect = wrap.getBoundingClientRect();
      // Not rendered (display:none, detached): keep the last size rather than squashing the strokes to 1 px.
      if (!rect.width && size) return { changed: false, resized: false };
      const newSize = Math.max(1, Math.round(Math.min(rect.width, rect.height) || rect.width || 1));
      const newDpr = pixelRatio(win);
      const resized = !!size && newSize !== size;
      if (resized) {
        const k = newSize / size;
        const scale = (s) => s.pts.forEach((p) => { p.x *= k; p.y *= k; });
        strokes.forEach(scale);
        const a = pen && pen.active();
        if (a) scale(a);
      }
      size = newSize;
      dpr = newDpr;
      const changed = fitCanvas(canvas, size, size, dpr);
      return { changed, resized };
    }

    const stopSize = observeSize(wrap, () => {
      if (destroyed) return;
      const m = measure();
      if (m.changed) { draw(); if (m.resized && strokes.length) notify('resize'); }
    });

    /* ---------------------------------------------------------- rendering */

    function draw() {
      rafId = 0;
      if (destroyed) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const color = inkColor(win, wrap);
      const base = baseWidth(size);
      for (const s of strokes) drawStroke(ctx, s.pts, color, 1, base);
      const a = pen && pen.active();
      if (a) drawStroke(ctx, a.pts, color, 1, base);
    }

    function schedule() {
      if (rafId) return;
      rafId = win.requestAnimationFrame ? win.requestAnimationFrame(draw) : setTimeout(draw, 16);
    }

    /* ---------------------------------------------------------- pointer input */

    let rect = null;
    const box = {
      el: wrap,
      minStep: 0.6,
      refresh() { rect = canvas.getBoundingClientRect(); },
      toLocal: (ev) => [ev.clientX - rect.left, ev.clientY - rect.top],
    };

    // On the wrap, not the canvas: the wrap's ::before ring (css/app.css) reaches a few px past the box, so a stroke
    // begun at the very edge writes instead of panning the page. The canvas fills the rest of the wrap.

    pen = tracker(wrap, {
      enabled: () => enabled,
      penOnly: () => penOnly,
      pressure: !!opts.pressure,
      touchEl: wrap,
      guard: () => enabled,   // after grading the page may scroll over the box again (css .pad.is-disabled)
      hit() { if (measure().changed) schedule(); return box; },
      update: schedule,
      commit(s) {
        // Begun in the ring and never inside the box, ink included (a tap or a flick beside it): not a stroke.
        if (!inksBox(s.pts, size, 1)) { schedule(); return; }
        strokes.push({ pts: s.pts, type: s.type });
        schedule();
        notify('stroke');
      },
      drop: schedule,
    });

    // A pen near this block pins the page (html.pad-pen-near); while the pad takes input the page doesn't
    // rubber-band or drag a host page (html.pad-live). See nearZone() / setLive().
    const zone = opts.penZone === undefined ? host.parentElement : opts.penZone;
    nearZone(doc, api, zone, () => enabled && !destroyed);
    function syncHolds() {
      setLive(doc, api, enabled && !destroyed);
      nearSync(doc);
    }
    syncHolds();

    /* ---------------------------------------------------------- editing */

    function undo() {
      if (pen.active()) { pen.cancel(); return; }
      if (!strokes.length) return;
      strokes.pop();
      schedule();
      notify('undo');
    }

    function clear() {
      pen.cancel();
      const had = strokes.length;
      strokes = [];
      schedule();
      if (had) notify('clear');
    }

    function setGuideGlyph(ch, variantId) {
      while (ghost.firstChild) ghost.removeChild(ghost.firstChild);
      const D = root.KANA_DATA;
      const k = ch && D && ((D.kana && D.kana[ch]) || (D.extra && D.extra[ch]));
      if (!k) return;
      const v = k.variants.find((x) => x.id === variantId) || k.variants[0];
      v.strokes.forEach((d) => svgEl('path', { d, class: 'pad-ghost-stroke' }, ghost));
    }

    const stopScheme = watchScheme(win, schedule);

    function destroy() {
      destroyed = true;
      pen.destroy();
      nearZone(doc, api, null);
      syncHolds();
      stopSize();
      stopScheme();
      if (rafId && win.cancelAnimationFrame) win.cancelAnimationFrame(rafId);
      wrap.remove();
    }

    measure();
    draw();
    return api;
  }

  return { create, Ink };
});
