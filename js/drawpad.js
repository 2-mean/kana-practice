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
 *
 * Palm rejection: with penOnly on, once a 'pen' pointer has been seen, 'touch' pointers are ignored
 * (and a touch stroke in progress is dropped when the pen comes down or hovers into view). Pen detection is
 * shared by every pad of the page session and also counts a hovering pen, so a palm that lands on a fresh
 * pad before the pen's first contact is still rejected. A second finger landing during a touch stroke
 * (pinch, two-finger scroll, palm) drops that stroke.
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

  function pixelRatio(win) { return Math.max(1, Math.min(3, (win && win.devicePixelRatio) || 1)); }

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

    function drawing(on) {
      setDrawing(doc, on);
      touchEl.classList.toggle('is-drawing', on);
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
      // The box may have moved since pointerdown (smooth scroll, rotation, on-screen keyboard): re-read it.
      active.target.refresh();
      let evs = null;
      try { evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null; } catch (err) { evs = null; }
      if (!evs || !evs.length) evs = [e];
      for (const ev of evs) addPoint(ev);
      o.update(active);
    }

    function finish(e, cancelled) {
      if (!active || (e && e.pointerId !== active.id)) return;
      if (e && !cancelled && e.type === 'pointerup') { active.target.refresh(); addPoint(e); }
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
    hasSeenPen: () => penSeen, onPenSeen, watchPen, setDrawing, pixelRatio, baseWidth, widthFactor, drawStroke,
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

    pen = tracker(canvas, {
      enabled: () => enabled,
      penOnly: () => penOnly,
      pressure: !!opts.pressure,
      touchEl: wrap,
      hit() { if (measure().changed) schedule(); return box; },
      update: schedule,
      commit(s) { strokes.push({ pts: s.pts, type: s.type }); schedule(); notify('stroke'); },
      drop: schedule,
    });

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
