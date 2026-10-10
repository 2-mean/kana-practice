/* SVG path → polyline sampler. Shared by the browser app and the Node build/test tools. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SvgPath = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const TOKEN = /([MmLlHhVvCcSsQqTtZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

  function tokenize(d) {
    const out = [];
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(d))) out.push(m[1] ? m[1] : parseFloat(m[2]));
    return out;
  }

  function cubic(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return [
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ];
  }

  function quad(p0, p1, p2, t) {
    const u = 1 - t;
    return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
  }

  // Returns a dense polyline (array of [x, y]) tracing the path in drawing order.
  function flatten(d, segSteps) {
    const steps = segSteps || 24;
    const tk = tokenize(d);
    const pts = [];
    let i = 0, cmd = null;
    let cur = [0, 0], start = [0, 0], lastCtrl = null, lastCmd = null;
    const num = () => tk[i++];
    const push = (p) => {
      const last = pts[pts.length - 1];
      if (!last || Math.abs(last[0] - p[0]) > 1e-6 || Math.abs(last[1] - p[1]) > 1e-6) pts.push(p);
    };
    while (i < tk.length) {
      if (typeof tk[i] === 'string') cmd = tk[i++];
      else if (cmd === 'M') cmd = 'L';
      else if (cmd === 'm') cmd = 'l';
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      if (C === 'Z') {
        push(start.slice());
        cur = start.slice();
        lastCtrl = null; lastCmd = 'Z';
        continue;
      }
      if (C === 'M') {
        const x = num(), y = num();
        cur = rel ? [cur[0] + x, cur[1] + y] : [x, y];
        start = cur.slice();
        push(cur.slice());
        lastCtrl = null;
      } else if (C === 'L') {
        const x = num(), y = num();
        cur = rel ? [cur[0] + x, cur[1] + y] : [x, y];
        push(cur.slice());
        lastCtrl = null;
      } else if (C === 'H') {
        const x = num();
        cur = [rel ? cur[0] + x : x, cur[1]];
        push(cur.slice());
        lastCtrl = null;
      } else if (C === 'V') {
        const y = num();
        cur = [cur[0], rel ? cur[1] + y : y];
        push(cur.slice());
        lastCtrl = null;
      } else if (C === 'C' || C === 'S') {
        let p1;
        if (C === 'C') {
          const x1 = num(), y1 = num();
          p1 = rel ? [cur[0] + x1, cur[1] + y1] : [x1, y1];
        } else {
          p1 = lastCtrl && (lastCmd === 'C' || lastCmd === 'S') ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur.slice();
        }
        const x2 = num(), y2 = num(), x = num(), y = num();
        const p2 = rel ? [cur[0] + x2, cur[1] + y2] : [x2, y2];
        const p3 = rel ? [cur[0] + x, cur[1] + y] : [x, y];
        const p0 = cur.slice();
        for (let s = 1; s <= steps; s++) push(cubic(p0, p1, p2, p3, s / steps));
        lastCtrl = p2;
        cur = p3;
      } else if (C === 'Q' || C === 'T') {
        let p1;
        if (C === 'Q') {
          const x1 = num(), y1 = num();
          p1 = rel ? [cur[0] + x1, cur[1] + y1] : [x1, y1];
        } else {
          p1 = lastCtrl && (lastCmd === 'Q' || lastCmd === 'T') ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur.slice();
        }
        const x = num(), y = num();
        const p2 = rel ? [cur[0] + x, cur[1] + y] : [x, y];
        const p0 = cur.slice();
        for (let s = 1; s <= steps; s++) push(quad(p0, p1, p2, s / steps));
        lastCtrl = p1;
        cur = p2;
      } else {
        throw new Error('Unsupported path command: ' + cmd);
      }
      lastCmd = C;
    }
    return pts;
  }

  function length(pts) {
    let L = 0;
    for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    return L;
  }

  // Resample a polyline to n points evenly spaced by arc length.
  function resample(pts, n) {
    if (pts.length === 0) return [];
    if (pts.length === 1 || length(pts) === 0) return Array.from({ length: n }, () => pts[0].slice());
    const total = length(pts);
    const step = total / (n - 1);
    const out = [pts[0].slice()];
    let acc = 0, k = 1, prev = pts[0].slice();
    while (out.length < n - 1 && k < pts.length) {
      const seg = Math.hypot(pts[k][0] - prev[0], pts[k][1] - prev[1]);
      if (acc + seg >= step && seg > 0) {
        const t = (step - acc) / seg;
        const q = [prev[0] + t * (pts[k][0] - prev[0]), prev[1] + t * (pts[k][1] - prev[1])];
        out.push(q);
        prev = q;
        acc = 0;
      } else {
        acc += seg;
        prev = pts[k];
        k++;
      }
    }
    while (out.length < n) out.push(pts[pts.length - 1].slice());
    return out;
  }

  function sample(d, n) {
    return resample(flatten(d), n);
  }

  return { tokenize, flatten, length, resample, sample };
});
