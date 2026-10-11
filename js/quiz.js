/* Pure quiz logic for 가나 연습장: question pools, reading-answer checking, look-alike detection, stats.
 * No DOM access. UMD so the Node tests can require() it. Every function that needs the kana table
 * takes it as a parameter (`data` = KANA_DATA); randomness comes from an injected rng() in [0, 1). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Quiz = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BASIC_ROWS = ['a', 'ka', 'sa', 'ta', 'na', 'ha', 'ma', 'ya', 'ra', 'wa', 'n'];
  const DAKUTEN_ROWS = ['ga', 'za', 'da', 'ba'];
  const HANDAKUTEN_ROWS = ['pa'];
  const ALL_ROWS = BASIC_ROWS.concat(DAKUTEN_ROWS, HANDAKUTEN_ROWS);

  // Home-screen chips. わ·ん is one chip covering two data rows.
  const ROW_CHIPS = [
    { id: 'a', rows: ['a'], group: 'basic' },
    { id: 'ka', rows: ['ka'], group: 'basic' },
    { id: 'sa', rows: ['sa'], group: 'basic' },
    { id: 'ta', rows: ['ta'], group: 'basic' },
    { id: 'na', rows: ['na'], group: 'basic' },
    { id: 'ha', rows: ['ha'], group: 'basic' },
    { id: 'ma', rows: ['ma'], group: 'basic' },
    { id: 'ya', rows: ['ya'], group: 'basic' },
    { id: 'ra', rows: ['ra'], group: 'basic' },
    { id: 'wa', rows: ['wa', 'n'], group: 'basic' },
    { id: 'ga', rows: ['ga'], group: 'dakuten' },
    { id: 'za', rows: ['za'], group: 'dakuten' },
    { id: 'da', rows: ['da'], group: 'dakuten' },
    { id: 'ba', rows: ['ba'], group: 'dakuten' },
    { id: 'pa', rows: ['pa'], group: 'handakuten' },
  ];

  const COUNTS = [10, 20, 30, 'all', 'endless']; // 'endless' = 무한 모드 (see nextEndless)
  const SCRIPTS = ['hira', 'kata', 'mix'];
  const STRICTNESS = ['lenient', 'normal', 'strict'];
  const FONTS = ['textbook', 'gothic', 'mix'];
  const RECENT_MAX = 8;
  const SESSIONS_MAX = 40;

  function defaultSettings() {
    return {
      script: 'hira',
      rows: BASIC_ROWS.slice(),
      count: 10,
      focusConfusable: false,
      focusWrong: false,
      readFont: 'textbook',
      strictness: 'normal',
      penOnly: true,
    };
  }

  // Repair settings loaded from storage (unknown keys dropped, bad values replaced by defaults).
  function sanitizeSettings(raw) {
    const d = defaultSettings();
    if (!raw || typeof raw !== 'object') return d;
    const out = d;
    if (SCRIPTS.includes(raw.script)) out.script = raw.script;
    if (Array.isArray(raw.rows)) {
      const rows = raw.rows.filter((r) => ALL_ROWS.includes(r));
      out.rows = ALL_ROWS.filter((r) => rows.includes(r));
    }
    if (COUNTS.includes(raw.count)) out.count = raw.count;
    out.focusConfusable = !!raw.focusConfusable;
    out.focusWrong = !!raw.focusWrong;
    if (FONTS.includes(raw.readFont)) out.readFont = raw.readFont;
    if (STRICTNESS.includes(raw.strictness)) out.strictness = raw.strictness;
    if (typeof raw.penOnly === 'boolean') out.penOnly = raw.penOnly;
    return out;
  }

  /* ---------------------------------------------------------------- randomness */

  // Small seeded PRNG (mulberry32) for deterministic tests.
  function makeRng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    const r = rng || Math.random;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // Weighted sampling without replacement (Efraimidis–Spirakis): key = u^(1/w), keep the n largest.
  function weightedSample(items, n, weightOf, rng) {
    const r = rng || Math.random;
    const keyed = items.map((it, i) => {
      const w = Math.max(1e-6, weightOf(it));
      let u = r();
      if (u <= 0) u = 1e-12;
      return { it, i, k: Math.pow(u, 1 / w) };
    });
    keyed.sort((a, b) => b.k - a.k || a.i - b.i);
    return keyed.slice(0, Math.max(0, Math.min(n, keyed.length))).map((x) => x.it);
  }

  /* ---------------------------------------------------------------- pools */

  function scriptsOf(script) {
    return script === 'mix' ? ['hira', 'kata'] : [script === 'kata' ? 'kata' : 'hira'];
  }

  // All characters selected by settings.script + settings.rows, in gojūon order (hiragana first in mix).
  function charsFor(settings, data) {
    const rows = new Set(settings.rows || []);
    const out = [];
    for (const script of scriptsOf(settings.script)) {
      for (const row of data.rows) {
        if (!rows.has(row.id)) continue;
        for (const ch of row[script]) if (ch) out.push(ch);
      }
    }
    return out;
  }

  function questionCount(settings, available) {
    if (settings.count === 'all' || settings.count === 'endless') return available;
    const n = Number(settings.count) || 10;
    return Math.max(0, Math.min(n, available));
  }

  function charStats(stats, ch) {
    return (stats && stats.chars && stats.chars[ch]) || null;
  }

  // 0..1: how badly this char has gone so far (overall rate blended with the most recent answers).
  function wrongness(stats, ch, mode) {
    const s = charStats(stats, ch);
    if (!s) return 0;
    let bad = 0, total = 0;
    if (mode !== 'write' && s.read) { bad += s.read.ng || 0; total += (s.read.ok || 0) + (s.read.ng || 0); }
    if (mode !== 'read' && s.write) {
      bad += (s.write.x || 0) + 0.5 * (s.write.t || 0);
      total += (s.write.o || 0) + (s.write.t || 0) + (s.write.x || 0);
    }
    if (!total) return 0;
    const overall = bad / (total + 1);
    const recent = (s.recent || []).filter((r) => !mode || r.m === mode || !r.m);
    let rec = 0;
    if (recent.length) rec = recent.reduce((acc, r) => acc + (r.g === 'x' ? 1 : r.g === 't' ? 0.5 : 0), 0) / recent.length;
    return Math.min(1, 0.5 * overall + 0.5 * rec);
  }

  /* Build the question list for a test.
   *   settings: { script, rows, count, focusConfusable, focusWrong }
   *   mode: 'read' | 'write' (what counts as practised / missed in this mode); now: the clock (default Date.now())
   * Returns [{ ch, script }] — no repeats; mixed mode always contains both scripts when it can. The chars are drawn
   * by finiteWeights (the "rigged random" across tests, SPEC-words A): never-practised and long-unpractised chars
   * first, the chars of the last tests rarely. Always in a shuffled order (전체 is every char, shuffled). */
  function buildPool(settings, data, stats, rng, mode, now) {
    const r = rng || Math.random;
    const chars = charsFor(settings, data);
    if (!chars.length) return [];
    const n = questionCount(settings, chars.length);
    const weights = n < chars.length
      ? finiteWeights(chars, endlessStatsOf(stats, mode, settings, data, chars), { focusWrong: !!settings.focusWrong, rng: r, now })
      : {};
    const w = (ch) => weights[ch];
    let picked;
    if (settings.script === 'mix' && n < chars.length) {
      const hira = chars.filter((c) => data.kana[c].script === 'hira');
      const kata = chars.filter((c) => data.kana[c].script === 'kata');
      let nh = Math.floor(n / 2), nk = n - nh;
      if (n % 2 && r() < 0.5) { nh++; nk--; }
      if (n >= 2) { nh = Math.max(1, nh); nk = Math.max(1, nk); }
      if (nh > hira.length) { nk += nh - hira.length; nh = hira.length; }
      if (nk > kata.length) { nh += nk - kata.length; nk = kata.length; }
      picked = weightedSample(hira, nh, w, r).concat(weightedSample(kata, nk, w, r));
    } else {
      picked = n < chars.length ? weightedSample(chars, n, w, r) : chars.slice();
    }
    shuffle(picked, r);
    spreadPairs(picked, data);
    return picked.map((ch) => ({ ch, script: data.kana[ch].script }));
  }

  // Avoid showing a char right after its other-script twin (か then カ) when a swap can fix it.
  function spreadPairs(list, data) {
    for (let i = 1; i < list.length; i++) {
      const prev = data.kana[list[i - 1]];
      if (prev && prev.pair === list[i]) {
        for (let j = i + 1; j < list.length; j++) {
          const cand = data.kana[list[j]];
          if (cand && cand.pair !== list[i - 1] && (i + 1 >= list.length || data.kana[list[i + 1]].pair !== list[j])) {
            const t = list[i]; list[i] = list[j]; list[j] = t;
            break;
          }
        }
      }
    }
    return list;
  }

  // A retry test from an explicit list (틀린 것만 다시, △만 다시, 획순 주의 글자).
  function poolFromChars(chars, data, rng) {
    const seen = new Set();
    const list = [];
    for (const ch of chars) if (data.kana[ch] && !seen.has(ch)) { seen.add(ch); list.push(ch); }
    shuffle(list, rng || Math.random);
    spreadPairs(list, data);
    return list.map((ch) => ({ ch, script: data.kana[ch].script }));
  }

  /* ---------------------------------------------------------------- reading answers */

  const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힯ꥠ-꥿ힰ-퟿]/;
  const LATIN_RE = /[a-z]/i;

  function normalizeRomaji(s) {
    return String(s == null ? '' : s)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s　\-_'’`.,·・ー~]/g, '');
  }

  function normalizeHangul(s) {
    return String(s == null ? '' : s).normalize('NFC').replace(/[\s　.,·~\-]/g, '');
  }

  function inputKind(s) {
    const t = String(s == null ? '' : s);
    if (HANGUL_RE.test(t)) return 'hangul';
    if (LATIN_RE.test(t.normalize('NFKC'))) return 'romaji';
    return t.trim() ? 'other' : 'empty';
  }

  function readingsOf(k) {
    return {
      romaji: [k.romaji].concat(k.romajiAlt || []).map(normalizeRomaji),
      ko: [k.ko].concat(k.koAlt || []).map(normalizeHangul),
    };
  }

  function matchesReading(input, k) {
    if (!k) return false;
    const kind = inputKind(input);
    const r = readingsOf(k);
    if (kind === 'hangul') return r.ko.includes(normalizeHangul(input));
    if (kind === 'romaji') return r.romaji.includes(normalizeRomaji(input));
    return false;
  }

  function sameReading(a, b) {
    return !!a && !!b && normalizeRomaji(a.romaji) === normalizeRomaji(b.romaji);
  }

  // The look-alike group that explains the mix-up between a and b (checks script twins too).
  function groupFor(a, b, data) {
    const groups = data.confusableGroups || [];
    const ka = data.kana[a], kb = data.kana[b];
    const as = [a, ka && ka.pair].filter(Boolean);
    const bs = [b, kb && kb.pair].filter(Boolean);
    for (const x of as) for (const y of bs) {
      const g = groups.find((gr) => gr.chars.includes(x) && gr.chars.includes(y) && x !== y);
      if (g) return g;
    }
    return null;
  }

  /* If `input` is wrong for `ch` but is the reading of one of its own look-alikes, return
   * { ch, romaji, ko, group, tip }; otherwise null. Look-alikes of the other-script twin are NOT used:
   * the learner only sees `ch`, so あ answered 'ma' is not a mix-up with マ (genuine cross-script
   * look-alikes such as し/レ are already in ch's own confusables). */
  function findLookalikeAnswer(input, ch, data) {
    const k = data.kana[ch];
    if (!k || matchesReading(input, k)) return null;
    const cands = [];
    const add = (c) => { if (c && c !== ch && c !== k.pair && !cands.includes(c)) cands.push(c); };
    k.confusables.forEach(add);
    for (const c of cands) {
      const ck = data.kana[c];
      if (!ck || sameReading(ck, k)) continue;
      if (matchesReading(input, ck)) {
        const group = groupFor(ch, c, data);
        return { ch: c, romaji: ck.romaji, ko: ck.ko, group: group ? group.id : null, tip: group ? group.tip : null };
      }
    }
    return null;
  }

  // Kana (any script) whose reading equals the input, for a gentle "ka는 か의 발음이에요" note.
  function charsWithReading(input, data, script) {
    const out = [];
    for (const ch of Object.keys(data.kana)) {
      const k = data.kana[ch];
      if (script && k.script !== script) continue;
      if (matchesReading(input, k)) out.push(ch);
    }
    return out;
  }

  /* Check a reading-test answer.
   * → { correct, empty, kind, lookalike: {ch, romaji, ko, group, tip}|null, readingOf: [ch...] } */
  function checkReading(input, ch, data) {
    const k = data.kana[ch];
    const kind = inputKind(input);
    const empty = kind === 'empty';
    const correct = !empty && matchesReading(input, k);
    const res = { correct, empty, kind, lookalike: null, readingOf: [] };
    if (!correct && !empty) {
      res.lookalike = findLookalikeAnswer(input, ch, data);
      res.readingOf = charsWithReading(input, data, k ? k.script : null).filter((c) => c !== ch);
    }
    return res;
  }

  /* ---------------------------------------------------------------- stats */

  function emptyStats() {
    return { v: 1, chars: {}, confusions: {}, sessions: [] };
  }

  function emptyCharStats() {
    return { read: { ok: 0, ng: 0, cheat: 0 }, write: { o: 0, t: 0, x: 0, cheat: 0 }, recent: [], last: 0 };
  }

  const nat = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

  function sanitizeStats(raw) {
    const s = emptyStats();
    if (!raw || typeof raw !== 'object') return s;
    if (raw.chars && typeof raw.chars === 'object') {
      for (const ch of Object.keys(raw.chars)) {
        const c = raw.chars[ch];
        if (!c || typeof c !== 'object' || ch.length > 2) continue;
        const e = emptyCharStats();
        if (c.read) { e.read.ok = nat(c.read.ok); e.read.ng = nat(c.read.ng); e.read.cheat = nat(c.read.cheat); }
        if (c.write) {
          e.write.o = nat(c.write.o); e.write.t = nat(c.write.t); e.write.x = nat(c.write.x); e.write.cheat = nat(c.write.cheat);
          if (nat(c.write.word)) e.write.word = nat(c.write.word);
        }
        if (Array.isArray(c.recent)) {
          e.recent = c.recent
            .filter((r) => r && ['o', 't', 'x'].includes(r.g))
            .slice(-RECENT_MAX)
            .map((r) => ({ m: r.m === 'write' ? 'write' : 'read', g: r.g }));
        }
        e.last = nat(c.last);
        s.chars[ch] = e;
      }
    }
    if (raw.confusions && typeof raw.confusions === 'object') {
      for (const key of Object.keys(raw.confusions)) {
        if (/^.{1,2}>.{1,2}$/u.test(key)) s.confusions[key] = nat(raw.confusions[key]);
      }
    }
    if (Array.isArray(raw.sessions)) {
      s.sessions = raw.sessions
        .filter((x) => x && typeof x === 'object')
        .slice(-SESSIONS_MAX)
        .map((x) => Object.assign({
          t: nat(x.t), mode: x.mode === 'write' ? 'write' : 'read', script: SCRIPTS.includes(x.script) ? x.script : 'hira',
          n: nat(x.n), o: nat(x.o), tri: nat(x.tri), x: nat(x.x), cheat: nat(x.cheat), retry: !!x.retry,
        }, x.endless ? { endless: true } : null));
    }
    return s;
  }

  function ensureChar(stats, ch) {
    if (!stats.chars[ch]) stats.chars[ch] = emptyCharStats();
    return stats.chars[ch];
  }

  function pushRecent(c, mode, grade) {
    c.recent.push({ m: mode, g: grade });
    if (c.recent.length > RECENT_MAX) c.recent.splice(0, c.recent.length - RECENT_MAX);
  }

  function addConfusion(stats, target, other) {
    if (!other || other === target) return;
    const key = target + '>' + other;
    stats.confusions[key] = (stats.confusions[key] || 0) + 1;
  }

  /* Reading answer. A 컨닝 answer only counts toward `cheat` (and `ng` when it was still wrong); a cheated
   * correct answer is not a success, so it is also kept out of `recent` (틀린 글자 위주 / 무한 모드 weights). */
  function recordReading(stats, ch, res, now) {
    const c = ensureChar(stats, ch);
    const correct = !!res.correct;
    if (res.cheat) {
      c.read.cheat++;
      if (!correct) c.read.ng++;
    } else if (correct) c.read.ok++;
    else c.read.ng++;
    if (!(res.cheat && correct)) pushRecent(c, 'read', correct ? 'o' : 'x');
    if (!correct && res.confusedWith) addConfusion(stats, ch, res.confusedWith);
    c.last = now || Date.now();
    return stats;
  }

  /* Writing answer. mark: 'o' | 't' | 'x'. With 컨닝, ○ counts only as `cheat` (and stays out of `recent`);
   * △/✕ are still recorded. res.source === 'word' tags answers that came from 단어/문장 쓰기 (write.word). */
  function recordWriting(stats, ch, res, now) {
    const c = ensureChar(stats, ch);
    const g = res.mark === 'o' || res.mark === 't' ? res.mark : 'x';
    if (res.cheat) c.write.cheat++;
    if (!(res.cheat && g === 'o')) c.write[g]++;
    if (res.source === 'word') c.write.word = (c.write.word || 0) + 1;
    if (!(res.cheat && g === 'o')) pushRecent(c, 'write', g);
    if (g === 'x' && res.confusedWith) addConfusion(stats, ch, res.confusedWith);
    c.last = now || Date.now();
    return stats;
  }

  function markOfVerdict(verdict) {
    return verdict === 'correct' ? 'o' : verdict === 'order' ? 't' : 'x';
  }

  // answers: [{ mark: 'o'|'t'|'x', cheat }]
  function summarize(answers) {
    const s = { total: answers.length, o: 0, t: 0, x: 0, cheat: 0 };
    for (const a of answers) {
      if (a.mark === 'o') s.o++;
      else if (a.mark === 't') s.t++;
      else s.x++;
      if (a.cheat) s.cheat++;
    }
    return s;
  }

  function recordSession(stats, info, now) {
    const ses = {
      t: now || Date.now(), mode: info.mode === 'write' ? 'write' : 'read', script: info.script || 'hira',
      n: info.total || 0, o: info.o || 0, tri: info.t || 0, x: info.x || 0, cheat: info.cheat || 0, retry: !!info.retry,
    };
    if (info.endless) ses.endless = true;
    stats.sessions.push(ses);
    if (stats.sessions.length > SESSIONS_MAX) stats.sessions.splice(0, stats.sessions.length - SESSIONS_MAX);
    return stats;
  }

  /* Per-char summary for the 기록 screen.
   * level: null (no data) | 'low' | 'mid' | 'high' */
  function charMastery(stats, ch) {
    const c = charStats(stats, ch);
    if (!c) return { read: { ok: 0, ng: 0, cheat: 0, rate: null }, write: { o: 0, t: 0, x: 0, cheat: 0 }, attempts: 0, score: null, level: null };
    const readN = c.read.ok + c.read.ng;
    const writeN = c.write.o + c.write.t + c.write.x;
    const attempts = readN + writeN;
    const score = attempts ? (c.read.ok + c.write.o + 0.5 * c.write.t) / attempts : null;
    let level = null;
    if (score != null) level = score >= 0.8 ? 'high' : score >= 0.5 ? 'mid' : 'low';
    else if (c.read.cheat + c.write.cheat > 0) level = 'low'; // only ever answered with the chart open
    return {
      read: { ok: c.read.ok, ng: c.read.ng, cheat: c.read.cheat, rate: readN ? c.read.ok / readN : null },
      write: { o: c.write.o, t: c.write.t, x: c.write.x, cheat: c.write.cheat },
      attempts, score, level,
    };
  }

  // Most-confused pairs (direction-merged): [{ a, b, count, ab, ba }] sorted by count.
  function topConfusions(stats, n) {
    const pairs = new Map();
    for (const key of Object.keys((stats && stats.confusions) || {})) {
      const [a, b] = Array.from(key.split('>'));
      const cnt = stats.confusions[key];
      if (!a || !b || !cnt) continue;
      const id = a < b ? a + '|' + b : b + '|' + a;
      const e = pairs.get(id) || { a: a < b ? a : b, b: a < b ? b : a, count: 0, ab: 0, ba: 0 };
      e.count += cnt;
      if (a === e.a) e.ab += cnt; else e.ba += cnt;
      pairs.set(id, e);
    }
    return Array.from(pairs.values()).sort((x, y) => y.count - x.count || (x.a < y.a ? -1 : 1)).slice(0, n || 10);
  }

  // Chars with △ history (획순 주의): [{ ch, t, total }] sorted by △ count.
  function orderTrouble(stats, n) {
    const out = [];
    for (const ch of Object.keys((stats && stats.chars) || {})) {
      const w = stats.chars[ch].write;
      if (w && w.t > 0) out.push({ ch, t: w.t, total: w.o + w.t + w.x });
    }
    out.sort((a, b) => b.t - a.t || b.t / (b.total || 1) - a.t / (a.total || 1) || (a.ch < b.ch ? -1 : 1));
    return out.slice(0, n || 30);
  }

  // Any answer recorded (컨닝 answers included).
  function hasHistory(stats, mode) {
    if (!stats || !stats.chars) return false;
    const r = (c) => c.read.ok + c.read.ng + c.read.cheat;
    const w = (c) => c.write.o + c.write.t + c.write.x + c.write.cheat;
    return Object.values(stats.chars).some((c) => (mode === 'read' ? r(c) : mode === 'write' ? w(c) : r(c) + w(c)) > 0);
  }

  /* ---------------------------------------------------------------- "rigged random" selection (SPEC-words A)
   * Shared by the finite tests (10/20/30/전체: which items a test asks) and 무한 모드 (the next question), for kana
   * and for 단어장 entries alike. Keys are any strings (kana, or word ids). statsOf(key) → { x, t, miss?, seen,
   * lastAt?, mult? }: recent ✕ / △ count of the item in this mode, its decayed miss score (missScore; derived from
   * x / t when absent), whether it was ever answered in this mode, when it was last answered (ms, any mode; 0 =
   * unknown), and the focus multiplier (헷갈리는 / 틀린 … 위주, 1 = none). No rounds, no deck, no fixed rotation: every
   * pick is a weighted random draw, but an item that has not come up for a while gets steadily likelier (a pity
   * counter), so nothing hogs the practice and nothing is left out for long — yet nothing is ever forced.
   *
   * Common factors:
   *   nudge  = 1 + 0.5 · min(1, miss) · 0.5^(idle / 7 days)   (≤ 1.5×) — past mistakes nudge, they never dominate.
   *            miss = missScore of the item's recent answers in this mode (✕ 1, △ ½, each halved by every later
   *            answer); idle = time from the item's lastAt to the newest lastAt in the pool, so a mistake fades as
   *            the learner practises on (a break between sessions changes nothing by itself).
   *   mult   = focus, clamped to 1..4 (bad values / below 1 → 1, so nothing starves): 틀린 … 위주 1 + 2 · wrong rate
   *            (≤ 3×); 헷갈리는 글자 위주 ×3 with a look-alike in the pool, else ×1.75. A focused item's pity clock runs
   *            faster, so it is due sooner, yet right after it is asked it starts from 1 again like everything else
   *            (no clustering): ≈ mult× as often, up to ≈ 3×.
   *
   * Finite tests (finiteWeights / pickFinite) — weighted sampling without replacement (Efraimidis–Spirakis) with
   *   weight = nudge · e^(8 · min(poolSize, age · mult) / poolSize)
   *   age = how many pool items were answered (any mode) after this one: its rank by lastAt, newest 0 — the number
   *   of questions since it came up, as far as the stats can tell (lastAt unknown: poolSize, the stalest). Each
   *   eighth of the pool practised since makes an item ≈ 2.7× likelier; the stalest is ≈ 3000× likelier than the
   *   one just asked, so back-to-back tests walk through the whole set instead of re-drawing the same items, while
   *   which stale items a test gets stays random.
   *   An item never answered in this mode weighs × 100 the stalest practised one (× 10 with 틀린 … 위주, so missed
   *   items still get a share), times its mult: new / untouched items come first. A lastAt more than a day in the
   *   future (a fast clock elsewhere) is unknown: that item gets a random age each test (≈ a plain shuffle's share).
   *   Simulated (172 words, 20 a test, 30 % ✕): every word asked within 9 tests (plain shuffles: ≈ 56 never asked),
   *   ≈ 0.01 words a test repeated from the previous one (2.3), over 40 tests the longest wait ≈ 15 tests (ideal 8.6).
   *   The picked items always come in a shuffled order; 전체 is the whole pool, shuffled (no weights).
   *
   * 무한 모드 — a run keeps asking from `pool` until the learner stops. Pure and deterministic given rng:
   *   run  = endlessStart({ retryTri })                   → { asked, retries, retryStreak, retryTri, retried, retryCount }
   *   pick = nextEndless(run, pool, statsOf, rng, opts)   → { key, retry } (key is appended to run.asked)
   *   endlessRecord(run, key, mark, rng, poolSize)        after the answer is graded ('o' | 't' | 'x')
   * The run state is plain JSON. opts.pairOf(key) → key that should not come right after it (か then カ); opts.now:
   * the clock for the lastAt check (default Date.now(); a lastAt over a day ahead counts as unknown).
   *  - fresh pick: draw among the pool minus the last min(5, ⌊poolSize / 2⌋) asked items (at least half of a small
   *    pool stays drawable, so a pool of 3–6 is not a fixed rotation) with
   *      weight = nudge · pity(age · mult^1.5)    (× 0.2 for the twin of the previous item; ×3 → ≈ 2.5× as often)
   *      pity   = min(100, (1 + age / s)^2.5), s = max(1, poolSize / 2)
   *               (≈ 5.7 at half a pool, 15.6 at one pool, 56 at two pools, capped from ≈ 2.65 pools on)
   *      age    = other questions asked since the item was last asked in this run. An item not asked yet in this
   *               run has age = head + questions so far, head = poolSize · (0.75 + 0.5·stale), where stale = 1 if it
   *               was never answered in this mode or its lastAt is unknown (½ when in the future), else
   *               ln(1 + idle hours) / ln(1 + 14 · 24) capped at 1, idle
   *               being the time from its lastAt to the newest lastAt in the pool (so unseen / long-unseen items
   *               lead, and everything not yet asked keeps gaining weight as the run goes on);
   *    tuned by simulation (pool 46, all ○: every item seen by ≈ 60 questions, p99 gap ≈ 2 pools, per-item count
   *    spread about half of the old flat weights);
   *  - spaced retry: an item answered ✕ (or △ when retryTri — kana writing; 단어장 never retries △) is re-asked
   *    once, after gap = max(5, min(20, round(poolSize / 3))) ± 30 % other questions, but at least
   *    min(5, poolSize − 1) (never inside the no-repeat window; exactly poolSize − 1 in pools of 2–6, where a fresh
   *    draw often brings the item back sooner and settles the retry). At most once per item per run: a miss on the
   *    retry, or a later miss of an item already retried, schedules nothing. A due retry is asked before fresh
   *    picks, oldest first, never more than two in a row, and only while retries stay within 15 % of the questions
   *    asked (counting the one about to be asked); a retry still waiting 3 questions after it fell due is dropped
   *    (so the excess goes oldest first). A retry, like any question, resets the item's age. */
  const ENDLESS_WINDOW = 5;
  const RETRY_GAP_MIN = 5, RETRY_GAP_MAX = 20, RETRY_GAP_DIV = 3, RETRY_JITTER = 0.3;
  const RETRY_RUN = 2, RETRY_SHARE = 0.15, RETRY_GRACE = 3;
  const PITY_SCALE = 1 / 2, PITY_POW = 2.5, PITY_CAP = 100;
  const HEAD_MIN = 0.75, HEAD_MAX = 1.25;     // head-start age of an item not asked yet in this run, × poolSize
  const STALE_HOURS = 14 * 24;                // idle time (log scale) at which an item counts as fully stale
  const HOUR = 3600000;
  const FOCUS_MAX = 4, FOCUS_POW = 1.5;       // mult (헷갈리는 / 틀린 … 위주): 무한 pity clock × (mult in 1..4)^1.5
  const MISS_NUDGE = 0.5, MISS_HALF_HOURS = 7 * 24;
  const NEW_BOOST = 100, NEW_BOOST_FOCUS = 10; // finite tests: never answered in this mode (× the stalest practised)
  const PICK_STEEP = 8;                       // finite tests: weight e^(8 · age / poolSize)

  // Decayed mistake score of an item's recent answers (chronological 'o' | 't' | 'x'): ✕ 1, △ ½, halved per later answer.
  function missScore(marks) {
    let m = 0;
    for (const g of marks || []) m = m / 2 + (g === 'x' ? 1 : g === 't' ? 0.5 : 0);
    return m;
  }

  // The ≤ 1.5× mistake nudge, fading with the time from the item's last answer to `ref` (the newest in the pool).
  function missNudge(s, ref) {
    const raw = Number.isFinite(s.miss) ? s.miss : upTo3(s.x) + 0.5 * upTo3(s.t);
    const miss = Math.min(1, Math.max(0, raw));
    if (!miss) return 1;
    const last = Number(s.lastAt) || 0;
    const idle = last > 0 && ref > last ? (ref - last) / HOUR : 0;
    return 1 + MISS_NUDGE * miss * Math.pow(0.5, idle / MISS_HALF_HOURS);
  }

  // Focus multiplier clamped to 1..4 (bad values and values below 1 count as ×1: a slower clock could starve an item).
  const focusMult = (s) => (s.mult > 1 ? Math.min(FOCUS_MAX, s.mult) : 1);
  // 무한 모드's pity-clock speed of a focused item: (mult clamped to 1..4)^1.5.
  const focusSpeed = (s) => Math.pow(focusMult(s), FOCUS_POW);

  /* The items' stats, with lastAt checked against the clock: a time more than a day ahead of `now` (another device's
   * clock running fast, a hand-edited import) says nothing about when the item was practised — it would stay "the
   * newest" until that date and starve the item — so it counts as unknown (lastAt 0, future: true) and is left out
   * of `ref`, the newest answer in the pool. */
  const SKEW_MS = 24 * 3600000;
  function statsMap(items, statsOf, now) {
    const limit = (Number.isFinite(now) ? now : Date.now()) + SKEW_MS;
    const stats = new Map();
    let ref = 0;
    for (const k of items) {
      let s = (statsOf && statsOf(k)) || {};
      const at = Number(s.lastAt);
      if (at > limit) s = Object.assign({}, s, { lastAt: 0, future: true });
      else if (at > ref) ref = at;
      stats.set(k, s);
    }
    return { stats, ref };
  }

  /* { key: weight } of a finite test's draw (see above). opts.focusWrong: 틀린 … 위주 is on (untouched items get
   * × 10 instead of × 100, so the focused mistakes can compete with them). opts.now: the clock (default Date.now());
   * opts.rng: the draw's rng — an item whose lastAt is in the future (statsMap) gets a random age each test, i.e. it
   * comes up about as often as with a plain shuffle (without opts.rng: half the pool). */
  function finiteWeights(pool, statsOf, opts) {
    const o = opts || {};
    const items = uniqueKeys(pool);
    const size = items.length;
    const { stats, ref } = statsMap(items, statsOf, o.now);
    const lastOf = (k) => { const v = Number(stats.get(k).lastAt); return v > 0 ? v : 0; };
    const sorted = items.map(lastOf).sort((a, b) => b - a);
    // rank: how many pool items were answered after this one (binary search in the newest-first list)
    const newerThan = (t) => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] > t) lo = mid + 1; else hi = mid; } return lo; };
    const boost = o.focusWrong ? NEW_BOOST_FOCUS : NEW_BOOST;
    const out = {};
    for (const k of items) {
      const s = stats.get(k);
      // age: its rank by lastAt; unknown (practised before lastAt was kept, or an import without it) = the stalest
      const age = s.future ? size * (o.rng ? o.rng() : 0.5) : lastOf(k) > 0 ? newerThan(lastOf(k)) : size;
      // a focused item's clock runs mult× faster (due sooner), but it never outweighs the stalest practised item
      out[k] = s.seen
        ? missNudge(s, ref) * finitePity(Math.min(size, age * focusMult(s)), size)
        : boost * focusMult(s) * missNudge(s, ref) * finitePity(size, size);
    }
    return out;
  }

  // Finite tests: weight of an item `age` pool items after it was last practised (age ≤ poolSize).
  function finitePity(age, size) {
    return Math.exp(PICK_STEEP * Math.max(0, age) / Math.max(1, size));
  }

  /* A finite test's keys: n of the pool, no repeats, by finiteWeights, in a shuffled order — 전체 too: its sampling
   * order (stalest first) would replay the previous test's order almost exactly (a rotation). opts: finiteWeights'. */
  function pickFinite(pool, n, statsOf, rng, opts) {
    const r = rng || Math.random;
    const items = uniqueKeys(pool);
    const k = Math.max(0, Math.min(items.length, n == null ? items.length : n));
    if (k >= items.length) return shuffle(items, r);
    const w = finiteWeights(items, statsOf, Object.assign({}, opts, { rng: r }));
    return shuffle(weightedSample(items, k, (key) => w[key], r), r);
  }

  function endlessStart(opts) {
    return { asked: [], retries: [], retryStreak: 0, retryTri: !!(opts && opts.retryTri), retried: [], retryCount: 0 };
  }

  // Weight factor for an item `age` questions after it was last asked (grows smoothly, capped).
  function endlessPity(age, poolSize) {
    const s = Math.max(1, (poolSize || 1) * PITY_SCALE);
    return Math.min(PITY_CAP, Math.pow(1 + Math.max(0, age) / s, PITY_POW));
  }

  // 0..1: how long ago the item was answered, relative to `ref` (the newest answer in the pool); 1 = never in this mode.
  // (lastAt unknown — practised before it was kept: as stale as can be; a future stamp, statsMap: half way)
  function endlessStale(s, ref) {
    if (!s.seen) return 1;
    if (s.future) return 0.5;
    const last = Number(s.lastAt) || 0;
    if (!(last > 0)) return 1;
    if (!(ref > last)) return 0;
    return Math.min(1, Math.log(1 + (ref - last) / HOUR) / Math.log(1 + STALE_HOURS));
  }

  const upTo3 = (v) => Math.min(3, Math.max(0, Number(v) || 0));

  function uniqueKeys(pool) {
    const items = [];
    for (const k of pool || []) if (k != null && !items.includes(k)) items.push(k);
    return items;
  }

  /* The last min(5, ⌊size / 2⌋) asked keys: neither a fresh pick nor a retry may repeat one of them. At least half
   * of a small pool stays drawable — with size − 1 a pool of 3–6 (one kana row, a 5-word selection) was a fixed
   * rotation, the first round's order repeated forever. */
  const windowSize = (size) => Math.max(0, Math.min(ENDLESS_WINDOW, Math.floor(size / 2)));
  function endlessWindow(run, size) {
    const m = windowSize(size);
    return m > 0 ? run.asked.slice(Math.max(0, run.asked.length - m)) : [];
  }

  // Candidates and weights of the next fresh pick (the rules above).
  function freshWeights(run, items, statsOf, o) {
    const n = run.asked.length;
    const size = items.length;
    const recent = endlessWindow(run, size);
    let cands = items.filter((k) => !recent.includes(k));
    if (!cands.length) cands = items;
    const twin = n > 0 && o.pairOf ? o.pairOf(run.asked[n - 1]) : null;
    const lastIdx = new Map();
    run.asked.forEach((k, i) => lastIdx.set(k, i));
    const { stats, ref } = statsMap(items, statsOf, o.now);
    const weights = cands.map((k) => {
      const s = stats.get(k);
      const at = lastIdx.has(k) ? lastIdx.get(k) : -1;
      const age = at >= 0 ? n - 1 - at : n + size * (HEAD_MIN + (HEAD_MAX - HEAD_MIN) * endlessStale(s, ref));
      // a focused item's pity clock runs faster (it is due sooner), but it starts from 1 again once asked
      let w = missNudge(s, ref) * endlessPity(age * focusSpeed(s), size);
      if (twin != null && k === twin && cands.length > 1) w *= 0.2;
      return w;
    });
    return { cands, weights };
  }

  // { key: probability } of the next fresh pick (due retries aside) — for tests and tuning.
  function endlessOdds(run, pool, statsOf, opts) {
    const items = uniqueKeys(pool);
    if (!items.length) return {};
    const { cands, weights } = freshWeights(run, items, statsOf, opts || {});
    const total = weights.reduce((a, b) => a + b, 0);
    const out = {};
    cands.forEach((k, i) => { out[k] = weights[i] / total; });
    return out;
  }

  // State saved by an older version (before the retry limits) gets the new fields.
  function runState(run) {
    if (!Array.isArray(run.retries)) run.retries = [];
    if (!Array.isArray(run.retried)) run.retried = [];
    if (!(run.retryCount >= 0)) run.retryCount = 0;
    if (!(run.retryStreak >= 0)) run.retryStreak = 0;
    return run;
  }

  function nextEndless(run, pool, statsOf, rng, opts) {
    const r = rng || Math.random;
    const items = uniqueKeys(pool);
    if (!items.length) return null;
    runState(run);
    const n = run.asked.length;
    // a retry held back more than RETRY_GRACE questions past its due (budget / two in a row) is dropped
    run.retries = run.retries.filter((x) => n - x.due <= RETRY_GRACE);
    let key = null, retry = false;
    const budget = Math.floor(RETRY_SHARE * (n + 1) + 1e-9) - run.retryCount;
    if (run.retryStreak < RETRY_RUN && budget >= 1) {
      const tooSoon = endlessWindow(run, items.length);
      const due = run.retries
        .filter((x) => x.due <= n && items.includes(x.key) && !tooSoon.includes(x.key))
        .sort((a, b) => a.due - b.due);
      if (due.length) { key = due[0].key; retry = true; }
    }
    if (key == null) {
      const { cands, weights } = freshWeights(run, items, statsOf, opts || {});
      const total = weights.reduce((a, b) => a + b, 0);
      let u = r() * total;
      key = cands[cands.length - 1];
      for (let i = 0; i < cands.length; i++) {
        u -= weights[i];
        if (u < 0) { key = cands[i]; break; }
      }
    }
    run.asked.push(key);
    run.retries = run.retries.filter((x) => x.key !== key);
    run.retryStreak = retry ? run.retryStreak + 1 : 0;
    if (retry) {
      run.retryCount++;
      if (!run.retried.includes(key)) run.retried.push(key);
    }
    return { key, retry };
  }

  // Questions between a miss and its retry: max(5, min(20, round(size / 3))) ± 30 %, never inside the no-repeat window.
  function retryGap(size, r) {
    const mid = Math.max(RETRY_GAP_MIN, Math.min(RETRY_GAP_MAX, Math.round(size / RETRY_GAP_DIV)));
    const gap = Math.round(mid * (1 - RETRY_JITTER + 2 * RETRY_JITTER * r()));
    return Math.max(1, Math.min(size - 1, Math.max(Math.min(ENDLESS_WINDOW, size - 1), gap)));
  }

  function endlessRecord(run, key, mark, rng, poolSize) {
    const wrong = mark === 'x' || (mark === 't' && run.retryTri);
    const size = poolSize == null ? Infinity : poolSize;
    if (!wrong || size < 2) return run;
    runState(run);
    if (run.retried.includes(key)) return run;          // re-asked once already in this run
    const r = rng || Math.random;
    const at = run.asked.lastIndexOf(key);
    run.retries = run.retries.filter((x) => x.key !== key);
    run.retries.push({ key, due: (at >= 0 ? at : run.asked.length - 1) + 1 + retryGap(size, r) });
    return run;
  }

  /* statsOf for kana (finite tests and endless runs): recent ✕ / △ of the char in this mode (stats.chars[ch].recent)
   * and their missScore, whether it was ever answered in this mode, when it was last answered in any mode
   * (stats.chars[ch].last), and the focus multiplier: 헷갈리는 글자 위주 (×3 / ×1.75) times 틀린 글자 위주
   * (1 + 2 · wrongness). */
  function endlessStatsOf(stats, mode, settings, data, pool) {
    const available = new Set(pool || []);
    return (ch) => {
      const c = charStats(stats, ch);
      let x = 0, t = 0, seen = false, lastAt = 0;
      const marks = [];
      if (c) {
        for (const e of c.recent || []) {
          if (mode && e.m && e.m !== mode) continue;
          marks.push(e.g);
          if (e.g === 'x') x++;
          else if (e.g === 't') t++;
        }
        const r = c.read.ok + c.read.ng + c.read.cheat, w = c.write.o + c.write.t + c.write.x + c.write.cheat;
        seen = (mode === 'read' ? r : mode === 'write' ? w : r + w) > 0;
        lastAt = nat(c.last);
      }
      let mult = 1;
      const k = data && data.kana[ch];
      if (settings && settings.focusConfusable && k && k.confusables.length) {
        mult = k.confusables.some((p) => available.has(p)) ? 3 : 1.75;
      }
      // 틀린 글자 위주: same scale as 단어장's 틀린 것 위주 (1 + 2 · wrong rate), on top of the small ✕/△ nudge
      if (settings && settings.focusWrong) mult *= 1 + 2 * wrongness(stats, ch, mode);
      return { x, t, miss: missScore(marks), seen, lastAt, mult };
    };
  }

  return {
    BASIC_ROWS, DAKUTEN_ROWS, HANDAKUTEN_ROWS, ALL_ROWS, ROW_CHIPS, COUNTS,
    defaultSettings, sanitizeSettings,
    makeRng, shuffle, weightedSample,
    charsFor, questionCount, buildPool, poolFromChars, wrongness,
    normalizeRomaji, normalizeHangul, inputKind, readingsOf, matchesReading,
    groupFor, findLookalikeAnswer, charsWithReading, checkReading,
    emptyStats, sanitizeStats, recordReading, recordWriting, markOfVerdict, summarize, recordSession,
    charMastery, topConfusions, orderTrouble, hasHistory,
    endlessStart, nextEndless, endlessRecord, endlessStatsOf, endlessPity, endlessOdds,
    missScore, finiteWeights, pickFinite,
  };
});
