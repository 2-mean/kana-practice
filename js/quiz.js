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

  function weightFor(ch, ctx) {
    const { settings, data, stats, mode, available } = ctx;
    let w = 1;
    const k = data.kana[ch];
    if (settings.focusConfusable && k) {
      const partners = k.confusables.filter((c) => available.has(c));
      if (partners.length) w *= 5;
      else if (k.confusables.length) w *= 2.5;
    }
    if (settings.focusWrong) w *= 1 + 8 * wrongness(stats, ch, mode);
    return w;
  }

  /* Build the question list for a test.
   *   settings: { script, rows, count, focusConfusable, focusWrong }
   *   mode: 'read' | 'write' (only used to weigh "틀린 글자 위주")
   * Returns [{ ch, script }] — no repeats; mixed mode always contains both scripts when it can. */
  function buildPool(settings, data, stats, rng, mode) {
    const r = rng || Math.random;
    const chars = charsFor(settings, data);
    if (!chars.length) return [];
    const n = questionCount(settings, chars.length);
    const ctx = { settings, data, stats, mode, available: new Set(chars) };
    const w = (ch) => weightFor(ch, ctx);
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
      picked = weightedSample(chars, n, w, r);
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

  /* ---------------------------------------------------------------- 무한 모드 (endless runs)
   * A run keeps asking from `pool` (any string keys: kana, or word ids in 단어장) until the learner stops.
   * Pure and deterministic given rng (SPEC-words A):
   *   run  = endlessStart({ retryTri })                   → { asked: [], retries: [], retryStreak: 0, retryTri }
   *   pick = nextEndless(run, pool, statsOf, rng, opts)   → { key, retry } (key is appended to run.asked)
   *   endlessRecord(run, key, mark, rng, poolSize)        after the answer is graded ('o' | 't' | 'x')
   * The run state is plain JSON. statsOf(key) → { x, t, seen, lastAt?, mult? }: recent ✕ / △ count of the item,
   * whether it was ever answered in this mode, when it was last answered (ms, any mode; 0 = never), optional
   * focus multiplier (헷갈리는 / 틀린 … 위주). opts.pairOf(key) → key that should not come right after it (か then カ).
   * Rules — "rigged random" (no rounds, no deck): every fresh pick is a weighted random draw, but an item that has
   * not come up for a while gets steadily likelier (a pity counter), so nothing hogs the run and nothing is left out
   * for long — yet nothing is ever forced:
   *  - fresh pick: draw among the pool minus the last min(5, poolSize − 1) asked items with
   *      weight = base · pity(age · f)           (× 0.2 for the twin of the previous item)
   *      base   = 1 + 0.5·min(x, 3) + 0.3·min(t, 3)       — past mistakes nudge, they no longer dominate
   *      f      = (mult clamped to 1..4)^1.5: a focused item's pity clock runs faster, so it is due sooner — ×3 → about
   *               2.5× as often as an unfocused one (≈ the strength of the old flat ×3), yet right after it is
   *               asked it starts from 1 again like everything else, so it does not cluster
   *      pity   = min(100, (1 + age / s)^2.5),  s = max(1, poolSize / 2)
   *               (≈ 5.7 at half a pool, 15.6 at one pool, 56 at two pools, capped from ≈ 2.65 pools on)
   *      age    = other questions asked since the item was last asked in this run. An item not asked yet in this
   *               run has age = head + questions so far, head = poolSize · (0.75 + 0.5·stale), where stale = 1 if it
   *               was never answered in this mode, else ln(1 + idle hours) / ln(1 + 14 · 24) capped at 1, idle
   *               being the time from its lastAt to the newest lastAt in the pool (so unseen / long-unseen items
   *               lead, and everything not yet asked keeps gaining weight as the run goes on);
   *    tuned by simulation (pool 46, all ○: every item seen by ≈ 60 questions, p99 gap ≈ 2 pools, per-item count
   *    spread about half of the old flat weights);
   *  - an item answered ✕ (or △ when retryTri, i.e. writing) is re-asked after 3–6 other questions, but never
   *    inside the no-repeat window above: 5–6 others in pools of 7+, exactly poolSize − 1 in smaller pools. A due
   *    retry is asked before fresh picks, oldest first — but never more than two retries in a row. A retry, like
   *    any question, resets the item's age. */
  const ENDLESS_WINDOW = 5;
  const RETRY_MIN = 3, RETRY_MAX = 6, RETRY_RUN = 2;
  const PITY_SCALE = 1 / 2, PITY_POW = 2.5, PITY_CAP = 100;
  const HEAD_MIN = 0.75, HEAD_MAX = 1.25;     // head-start age of an item not asked yet in this run, × poolSize
  const STALE_HOURS = 14 * 24;                // idle time (log scale) at which an item counts as fully stale
  const HOUR = 3600000;
  const FOCUS_MAX = 4, FOCUS_POW = 1.5;       // mult (헷갈리는 / 틀린 … 위주): pity clock × (mult in 1..4)^1.5

  function endlessStart(opts) {
    return { asked: [], retries: [], retryStreak: 0, retryTri: !!(opts && opts.retryTri) };
  }

  // Weight factor for an item `age` questions after it was last asked (grows smoothly, capped).
  function endlessPity(age, poolSize) {
    const s = Math.max(1, (poolSize || 1) * PITY_SCALE);
    return Math.min(PITY_CAP, Math.pow(1 + Math.max(0, age) / s, PITY_POW));
  }

  // 0..1: how long ago the item was answered, relative to `ref` (the newest answer in the pool); 1 = never in this mode.
  function endlessStale(s, ref) {
    if (!s.seen) return 1;
    const last = Number(s.lastAt) || 0;
    if (!(last > 0) || !(ref > last)) return 0;
    return Math.min(1, Math.log(1 + (ref - last) / HOUR) / Math.log(1 + STALE_HOURS));
  }

  const upTo3 = (v) => Math.min(3, Math.max(0, Number(v) || 0));

  function uniqueKeys(pool) {
    const items = [];
    for (const k of pool || []) if (k != null && !items.includes(k)) items.push(k);
    return items;
  }

  // The last min(5, size − 1) asked keys: neither a fresh pick nor a retry may repeat one of them.
  function endlessWindow(run, size) {
    const m = Math.min(ENDLESS_WINDOW, size - 1);
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
    const stats = new Map(items.map((k) => [k, (statsOf && statsOf(k)) || {}]));
    let ref = 0;
    for (const s of stats.values()) if (Number(s.lastAt) > ref) ref = Number(s.lastAt);
    const weights = cands.map((k) => {
      const s = stats.get(k);
      const at = lastIdx.has(k) ? lastIdx.get(k) : -1;
      const age = at >= 0 ? n - 1 - at : n + size * (HEAD_MIN + (HEAD_MAX - HEAD_MIN) * endlessStale(s, ref));
      const base = 1 + 0.5 * upTo3(s.x) + 0.3 * upTo3(s.t);
      // a focused item's pity clock runs faster (it is due sooner), but it starts from 1 again once asked
      const mult = s.mult > 1 ? Math.min(FOCUS_MAX, s.mult) : 1;      // never slower than ×1: nothing starves
      let w = base * endlessPity(age * Math.pow(mult, FOCUS_POW), size);
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

  function nextEndless(run, pool, statsOf, rng, opts) {
    const r = rng || Math.random;
    const items = uniqueKeys(pool);
    if (!items.length) return null;
    const n = run.asked.length;
    let key = null, retry = false;
    if (run.retryStreak < RETRY_RUN) {
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
    return { key, retry };
  }

  function endlessRecord(run, key, mark, rng, poolSize) {
    const wrong = mark === 'x' || (mark === 't' && run.retryTri);
    const size = poolSize == null ? Infinity : poolSize;
    if (!wrong || size < 2) return run;
    const r = rng || Math.random;
    const at = run.asked.lastIndexOf(key);
    // at least as many others as the no-repeat window holds, so the retry never breaks that rule
    const lo = Math.max(RETRY_MIN, Math.min(ENDLESS_WINDOW, size - 1));
    let gap = lo + Math.floor(r() * (RETRY_MAX - lo + 1));
    gap = Math.max(1, Math.min(gap, size - 1));
    run.retries = run.retries.filter((x) => x.key !== key);
    run.retries.push({ key, due: (at >= 0 ? at : run.asked.length - 1) + 1 + gap });
    return run;
  }

  /* statsOf for kana in an endless run: recent ✕ / △ of the char in this mode (stats.chars[ch].recent), whether
   * it was ever answered in this mode, when it was last answered in any mode (stats.chars[ch].last), and the
   * focus multiplier: 헷갈리는 글자 위주 (×3 / ×1.75) times 틀린 글자 위주 (1 + 2 · wrongness). */
  function endlessStatsOf(stats, mode, settings, data, pool) {
    const available = new Set(pool || []);
    return (ch) => {
      const c = charStats(stats, ch);
      let x = 0, t = 0, seen = false, lastAt = 0;
      if (c) {
        for (const e of c.recent || []) {
          if (mode && e.m && e.m !== mode) continue;
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
      return { x, t, seen, lastAt, mult };
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
  };
});
