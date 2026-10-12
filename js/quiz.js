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

  /* focusLess (학습 덜 한 글자 위주) is off unless the key is present and true: it is left out of the defaults so a
   * record saved before it existed reads back unchanged (and an old app version keeps reading ours). */
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
    if (raw.focusLess === true) out.focusLess = true;
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

  // Questions in a test: 전체 / 무한 → every selected char (무한 keeps going); 10 / 20 / 30 → that many, even over a
  // smaller selection (30 questions over 10 chars asks each about 3 times, balanced within the test — buildPool).
  function questionCount(settings, available) {
    if (!(available > 0)) return 0;
    if (settings.count === 'all' || settings.count === 'endless') return available;
    return Math.max(0, Math.floor(Number(settings.count) || 10));
  }

  function charStats(stats, ch) {
    return (stats && stats.chars && stats.chars[ch]) || null;
  }

  // A counter of a stats record that may not have been through sanitizeStats (bad / missing values count as 0).
  const cnt = (o, k) => (o && typeof o === 'object' ? nat(o[k]) : 0);

  // 0..1: how badly this char has gone so far (overall rate blended with the most recent answers).
  function wrongness(stats, ch, mode) {
    const s = charStats(stats, ch);
    if (!s || typeof s !== 'object') return 0;
    let bad = 0, total = 0;
    if (mode !== 'write') { bad += cnt(s.read, 'ng'); total += cnt(s.read, 'ok') + cnt(s.read, 'ng'); }
    if (mode !== 'read') {
      bad += cnt(s.write, 'x') + 0.5 * cnt(s.write, 't');
      total += cnt(s.write, 'o') + cnt(s.write, 't') + cnt(s.write, 'x');
    }
    if (!total) return 0;
    const overall = bad / (total + 1);
    const recent = (Array.isArray(s.recent) ? s.recent : []).filter((r) => r && typeof r === 'object' && (!mode || r.m === mode || !r.m));
    let rec = 0;
    if (recent.length) rec = recent.reduce((acc, r) => acc + (r.g === 'x' ? 1 : r.g === 't' ? 0.5 : 0), 0) / recent.length;
    return Math.min(1, 0.5 * overall + 0.5 * rec);
  }

  /* Build the question list for a test (pickFinite, SPEC-words A).
   *   settings: { script, rows, count, focusConfusable, focusWrong, focusLess }
   *   stats / mode ('read' | 'write') / now (default Date.now()): read only for the '…위주' options that are on —
   *   with all of them off the test is a plain random draw whatever the history.
   * Returns [{ ch, script }] in a random order: count ≤ the selection → that many distinct chars (mixed mode takes
   * both scripts, half each); 전체 → every char once; count > the selection → every char at least once and
   * count / selection times each (± 1) with every option off, in the balancing order (the other-script twin rarely
   * right after its pair). */
  function buildPool(settings, data, stats, rng, mode, now) {
    const r = rng || Math.random;
    const chars = charsFor(settings, data);
    if (!chars.length) return [];
    const n = questionCount(settings, chars.length);
    const statsOf = endlessStatsOf(stats, mode, settings, data, chars, now);
    let picked;
    if (n > chars.length) {
      picked = pickFinite(chars, n, statsOf, r, { pairOf: (c) => (data.kana[c] ? data.kana[c].pair : null) });
    } else {
      if (settings.script === 'mix' && n < chars.length) {
        const hira = chars.filter((c) => data.kana[c].script === 'hira');
        const kata = chars.filter((c) => data.kana[c].script === 'kata');
        let nh = Math.floor(n / 2), nk = n - nh;
        if (n % 2 && r() < 0.5) { nh++; nk--; }
        if (n >= 2) { nh = Math.max(1, nh); nk = Math.max(1, nk); }
        if (nh > hira.length) { nk += nh - hira.length; nh = hira.length; }
        if (nk > kata.length) { nh += nk - kata.length; nk = kata.length; }
        picked = shuffle(pickFinite(hira, nh, statsOf, r).concat(pickFinite(kata, nk, statsOf, r)), r);
      } else {
        picked = pickFinite(chars, n, statsOf, r);
      }
      spreadPairs(picked, data);
    }
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
   * correct answer is not a success, so it is also kept out of `recent` (the 틀린 글자 위주 weight). */
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

  // Most-confused pairs (direction-merged): [{ a, b, count, ab, ba }] sorted by count. With data (KANA_DATA), pairs that are
  // drawn the same (data.sameShape: へ/ヘ, り/リ) are left out — counts recorded before り/リ became twins are no mix-up.
  function topConfusions(stats, n, data) {
    const pairs = new Map();
    const same = (a, b) => !!data && (data.sameShape || []).some((p) => p.includes(a) && p.includes(b));
    for (const key of Object.keys((stats && stats.confusions) || {})) {
      const [a, b] = Array.from(key.split('>'));
      const cnt = stats.confusions[key];
      if (!a || !b || !cnt || same(a, b)) continue;
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
   * Shared by the finite tests (10/20/30/전체) and 무한 모드, for kana and 단어장 entries alike. Keys are any strings
   * (kana, or word ids). Pure and deterministic given the injected rng; run state is plain JSON.
   *
   * Each test is independent: what a test asks depends on that test alone (and the rng) — how earlier tests went
   * plays no part (no head start for unpractised items, no nudge for past mistakes) unless the learner turns on a
   * '…위주' option. Those options only change weights: they never narrow the range, never force an item in, never
   * order the questions. statsOf(key) → { mult } (or a plain { key: mult } table, focusTable) is the product of the
   * multipliers of the options that are on — 1 for every item when all are off — made a multiplier for the pool by
   * focusScale (as it is up to ×6; past that the pool's spread is scaled to ×6 in log space, order kept), 1..6 (bad
   * values → 1), so a favoured item comes up a few times as often while every other item keeps coming up.
   *
   * Within one run (무한 모드, or a finite test with more questions than items) — balancing: an item's weight rises
   * while it waits and drops when it is asked, so over a long run every item comes up about equally often (in
   * proportion to its mult), in a random order — no deck, no fixed rotation.
   *   weight = share · e^(α · deficit) · e^(2 · max(0, wait − 1))
   *     share   = mult / (Σ mult over the pool) — the item's fair share of the questions (1 / poolSize when all are 1),
   *               at most 1 / (1.25 · (window + 1)) (shareCap; the excess goes to the others by their mult): the
   *               window lets an item come every window + 1 questions at most, and a share near that made a
   *               favoured item in a small pool a clock (×2 among 10: back exactly 6 questions later 97 % of the time)
   *     deficit = questions so far · share − times the item was asked in this run (spaced retries included): every
   *               question that goes by raises it by share, every ask lowers it by 1 — an item asked more than its
   *               share is held back, one asked less is pulled in. An item that joins the pool mid-run (or comes
   *               back after it was left out) counts both from the question it joined at (run.since), so it comes
   *               up soon but owes nothing for the questions before — no catch-up burst
   *     α       = 0.5 + 0.75 · ln(poolSize): one ask over the share costs ×9 at 10 items, ×29 at 46, ×78 at 172
   *     wait    = (questions since the item was last asked in this run) · share, in fair periods (an item not asked
   *               yet counts from just before the run began); once it has waited a full period it gains a further
   *               ×7.4 per period, so nothing is left out for long
   *   drawn among the pool minus the last min(5, ⌊poolSize / 2⌋) asked items (at least half of a small pool stays
   *   drawable), × 0.2 for the other-script twin of the previous item (か → カ). Weights are kept as logarithms (no
   *   overflow however long the run).
   *   Simulated, all ○, 6 pools of questions (pools 10 / 46 / 142 / 172; targets in brackets): per-item count CV
   *   0.03–0.05 [≤ 0.12], fewest asks 5 of 6 [≥ 0.75 · mean]; every item asked after a median of 1.0–1.09 pools
   *   [≤ 1.35]; longest gap of a run, p99 1.9–2.3 pools [≤ 2.5]; some item back before every item came up in 100 %
   *   of runs for P ≥ 46 [≥ 50 %]; first-appearance orders of two runs uncorrelated (Spearman ≈ 0.01); where an item
   *   comes in one pool-length round vs the next ρ ≈ 0.1 (P ≥ 46; 0.36 at 10, where the window alone forces some).
   *   With 25–40 % ✕ (retries 11–14 % of the questions) the per-item count CV stays 0.04–0.07 [≤ 0.2]. ×m comes up
   *   ≈ m× as often as ×1 (×2 → 1.99, ×3 → 3.02, ×6 → 5.84 among 46), every other item still in every run; in a
   *   small pool the cap holds a favoured item to ≈ 1.4× (10 items) with its gaps still varied (CV ≈ 0.2).
   *
   * Finite tests — pickFinite(pool, n, statsOf, rng, opts): n ≤ poolSize → n distinct items, a uniform random sample
   *   when every mult is 1 (else a weighted sample by mult, Efraimidis–Spirakis); n = poolSize (전체) → every item
   *   once; n > poolSize → every item at least once, the other n − poolSize by the fair shares (finiteTargets: with
   *   every mult 1, n / poolSize each rounded up or down), ordered by the balancing draw above over the items with
   *   asks left, an ask that cannot wait first (dueFirst: the rest still fit outside the window); no retries.
   *   Always in a random order.
   *
   * 무한 모드 — a run keeps asking from `pool` until the learner stops:
   *   run  = endlessStart({ retryTri, live? })            → { asked, retries, retryStreak, retryTri, retried, retryCount }
   *          (+ since: { key: question it joined the pool at }, added by the first nextEndless; + live, fair with
   *          틀린 것 위주 on — its factor follows the run's answers, see liveFocus below)
   *   pick = nextEndless(run, pool, statsOf, rng, opts)   → { key, retry } (key is appended to run.asked)
   *   endlessRecord(run, key, mark, rng, poolSize, miss?) after the answer is graded ('o' | 't' | 'x'; miss: a hinted
   *                                                       answer's miss value, null = not one the history counts)
   * opts.pairOf(key) → key that should not come right after it (か then カ).
   *  - fresh pick: the balancing draw above;
   *  - spaced retry: an item answered ✕ (or △ when retryTri — kana writing; 단어장 never retries △) is re-asked
   *    once, after gap = max(5, min(20, round(poolSize / 3))) ± 30 % other questions, but at least
   *    min(5, poolSize − 1) (never inside the no-repeat window; exactly poolSize − 1 in pools of 2–6, where a fresh
   *    draw often brings the item back sooner and settles the retry). At most once per item per run: a miss on the
   *    retry, or a later miss of an item already retried, schedules nothing. A due retry is asked before fresh
   *    picks, oldest first, never more than two in a row, and only while retries stay within 15 % of the questions
   *    asked (counting the one about to be asked); a retry still waiting 3 questions after it fell due is dropped
   *    (so the excess goes oldest first). A retry counts as an appearance like any question (it raises the item's
   *    count and resets its wait), so the balancing evens it out afterwards. */
  const ENDLESS_WINDOW = 5;
  const RETRY_GAP_MIN = 5, RETRY_GAP_MAX = 20, RETRY_GAP_DIV = 3, RETRY_JITTER = 0.3;
  const RETRY_RUN = 2, RETRY_SHARE = 0.15, RETRY_GRACE = 3;
  const BAL_BASE = 0.5, BAL_PER_LOG = 0.75;  // α = 0.5 + 0.75 · ln(poolSize)
  const OVERDUE_GAIN = 2;                    // × e^(2 · max(0, wait − 1)), wait in fair periods
  const TWIN_DAMP = 0.2;                     // the other-script twin right after its pair
  const FOCUS_MAX = 6;                       // the '…위주' multipliers of a pool span at most ×6 (focusScale)
  const WRONG_SPAN = 2;                      // 틀린 것 위주: × (1 + 2 · miss), 1..3
  const DUE_ROOM = 1;                        // dueFirst: a finite test's asks fit before the end, outside the window
  const SHARE_ROOM = 1.25;                   // an item's share ≤ 1 / (1.25 · (window + 1)) (shareCap)

  // α of a pool: how much one ask over (or under) the fair share weighs.
  function balanceAlpha(size) {
    return BAL_BASE + BAL_PER_LOG * Math.log(Math.max(1, size || 1));
  }

  // A '…위주' multiplier clamped to 1..6 (bad values and values below 1 count as ×1: nothing is ever held back).
  function focusMult(v) {
    const m = Number(v);
    return m > 1 ? Math.min(FOCUS_MAX, m) : 1;
  }

  /* The products of the '…위주' options that are on, made multipliers for one pool (products: the pool's, any order).
   * While the largest is at most ×6 a product is its multiplier as it is. Past that, every product is divided by the
   * pool's smallest and, when the spread is still over ×6, raised to the same power γ = ln 6 / ln(largest / smallest):
   * the spread becomes exactly ×6, the order is kept and every option keeps its say. (A plain clamp at 6 flattened
   * most of a pool with all three kana options on — turning 틀린 글자 위주 on next to the other two then changed the
   * missed chars' odds by ×1.01–1.13.) → product → mult (1..6; bad values ×1) */
  function focusScale(products) {
    let lo = Infinity, hi = 0;
    for (const v of products || []) {
      const p = Number(v);
      if (p >= 1 && p < Infinity) { if (p < lo) lo = p; if (p > hi) hi = p; }
    }
    if (!(hi > FOCUS_MAX)) return focusMult;
    const g = hi / lo > FOCUS_MAX ? Math.log(FOCUS_MAX) / Math.log(hi / lo) : 1;
    return (v) => { const p = Number(v); return p >= 1 ? focusMult(Math.pow(p / lo, g)) : 1; };
  }

  // statsOf → key → mult (1..6). statsOf: a function (key → { mult } or a number), a plain { key: mult } table
  // (focusTable; missing keys are ×1), or null (every item ×1).
  function multGetter(statsOf) {
    if (typeof statsOf === 'function') {
      return (k) => { const s = statsOf(k); return focusMult(s && typeof s === 'object' ? s.mult : s); };
    }
    if (statsOf && typeof statsOf === 'object') {
      return (k) => focusMult(Object.prototype.hasOwnProperty.call(statsOf, k) ? statsOf[k] : 1);
    }
    return () => 1;
  }

  /* The multipliers of a pool as a plain JSON table { key: mult } (1..6) — taken once at the start of a 무한 run so
   * the run weighs its items by the history from before it, and kept with the run state. With 틀린 것 위주 on the run
   * carries them live instead (endlessStart({ live: liveFocus(…) }), below): its own answers move that factor. */
  function focusTable(pool, statsOf) {
    const multOf = multGetter(statsOf);
    const out = {};
    for (const k of uniqueKeys(pool)) out[k] = multOf(k);
    return out;
  }

  function uniqueKeys(pool) {
    const items = [];
    const seen = new Set();
    for (const k of pool || []) if (k != null && !seen.has(k)) { seen.add(k); items.push(k); }
    return items;
  }

  /* A finite test's keys (see above): n of the pool in a random order. n ≤ poolSize: distinct items — a uniform
   * random sample with every mult 1, else weighted by mult; n = poolSize or n missing / not finite (전체): every
   * item once; n > poolSize: every item at least once, the rest by the fair shares, in the balancing order
   * (opts.pairOf as in nextEndless). */
  function pickFinite(pool, n, statsOf, rng, opts) {
    const r = rng || Math.random;
    const items = uniqueKeys(pool);
    const size = items.length;
    const num = Number(n);
    const want = n == null || !Number.isFinite(num) ? size : Math.max(0, Math.floor(num));
    if (!size || !want) return [];
    if (want === size) return shuffle(items, r);
    const multOf = multGetter(statsOf);
    if (want > size) {
      // every item at least once, the rest by the fair shares — then the order by the balancing draw over the items
      // with asks left (the share of each is its own count over n)
      const left = finiteTargets(items, want, fairShares(items, multOf), r);
      const shares = new Map(items.map((k) => [k, left.get(k) / want]));
      const run = endlessStart();
      for (let i = 0; i < want; i++) {
        const k = drawFresh(run, items, shares, r, opts || {}, dueFirst(items, left, i, want, windowSize(size)));
        left.set(k, left.get(k) - 1);
        run.asked.push(k);
      }
      return run.asked;
    }
    if (items.every((k) => multOf(k) === 1)) return shuffle(items, r).slice(0, want);
    return shuffle(weightedSample(items, want, multOf, r), r);
  }

  /* How often each item comes up in a finite test of n > poolSize questions: once each, and the n − poolSize others
   * shared out by the fair shares — each item ⌊e⌋ or ⌈e⌉ of its expected e = (n − poolSize) · share, by systematic
   * sampling over a shuffled order (the total is exactly n). Every mult 1: n / poolSize each, rounded up or down at
   * random. (Drawing every question afresh missed an item in 56 % of 20-question tests over 19 words — and asked
   * another three times; with a ×1 item among ×6 ones, 30 over 10 left it out a third of the time.) → Map key → count */
  function finiteTargets(items, n, shares, r) {
    const out = spreadExtra(items, n - items.length, shares, r);
    for (const k of items) out.set(k, 1 + out.get(k));
    return out;
  }

  // `extra` questions shared out by `weights` (Map key → weight, Σ = 1): each item ⌊e⌋ or ⌈e⌉ of e = extra · weight,
  // by systematic sampling over a shuffled order; the total is exactly extra. → Map key → count
  function spreadExtra(items, extra, weights, r) {
    let u = r();
    if (!(u > 0 && u < 1)) u = 0.5;
    const below = (x) => Math.min(extra, Math.max(0, Math.ceil(x - u - 1e-9)));   // points u, u + 1, … under x
    const order = shuffle(items.slice(), r);
    const out = new Map();
    let cum = 0;
    order.forEach((k, i) => {
      const next = i === order.length - 1 ? extra : cum + extra * weights.get(k);
      out.set(k, below(next) - below(cum));
      cum = next;
    });
    return out;
  }

  /* The items a finite test may draw at question i (0-based) of n: those with asks left — or, when the test runs
   * short of room, only the ones whose next ask cannot wait. An item with r asks left must have its next one by
   * n − 1 − (r − 1) · (window + 1) to fit the rest outside the no-repeat window; when, for the j earliest of those
   * deadlines, fewer than j + DUE_ROOM questions remain before the j-th, the draw is among those items (earliest
   * deadlines first, the balancing weights still deciding between them). */
  function dueFirst(items, left, i, n, win) {
    const open = items.filter((k) => left.get(k) > 0);
    const by = open.map((k) => ({ k, d: n - 1 - (left.get(k) - 1) * (win + 1) })).sort((a, b) => a.d - b.d);
    for (let j = 0; j < by.length; j++) {
      if (by[j].d - i < j + DUE_ROOM) return by.slice(0, j + 1).map((x) => x.k);
    }
    return open;
  }

  // opts: { retryTri, live } — live: liveFocus(pool, statsOf) when 틀린 것 위주 is on (the multipliers then follow the
  // run's answers; nextEndless ignores its statsOf), else left out (the run's multipliers are the caller's statsOf).
  function endlessStart(opts) {
    const run = { asked: [], retries: [], retryStreak: 0, retryTri: !!(opts && opts.retryTri), retried: [], retryCount: 0 };
    if (opts && opts.live && typeof opts.live === 'object') { run.live = opts.live; run.fair = {}; }
    return run;
  }

  /* The last min(5, ⌊size / 2⌋) asked keys: neither a fresh pick nor a retry may repeat one of them. At least half
   * of a small pool stays drawable — with size − 1 a pool of 3–6 (one kana row, a 5-word selection) was a fixed
   * rotation, the first round's order repeated forever. */
  const windowSize = (size) => Math.max(0, Math.min(ENDLESS_WINDOW, Math.floor(size / 2)));
  function endlessWindow(run, size) {
    const m = windowSize(size);
    return m > 0 ? run.asked.slice(Math.max(0, run.asked.length - m)) : [];
  }

  // run.since: key → the question (run.asked.length) at which the item joined the pool, for a pool that changes
  // mid-run (nextEndless keeps it). Without it (a run from endlessStart before its first pick, pickFinite) every
  // item counts from the start; an item not in it yet joins now.
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function joinedAt(run, k, n) {
    const s = run.since;
    if (!s || typeof s !== 'object') return 0;
    return hasOwn(s, k) && s[k] >= 0 && s[k] <= n ? s[k] : n;
  }

  /* The largest share of the questions one item may have: 1 / (1.25 · (window + 1)), never below 1 / size. The
   * no-repeat window lets an item come at most every (window + 1) questions; a share near that made a favoured
   * item a clock — in a 10-item pool a ×2 item came back exactly 6 questions later 97 % of the time (its debt grew
   * without end), three favoured items took turns like a rotation. With the room left, its gaps still vary. */
  const shareCap = (size) => Math.max(1 / size, 1 / (SHARE_ROOM * (windowSize(size) + 1)));

  /* Fair shares of the pool from the multipliers: mult / Σ mult, an item over the cap held at the cap and the rest
   * shared out over the others in proportion to theirs (repeated until none is over). → Map key → share (Σ = 1) */
  function fairShares(items, multOf) {
    const cap = shareCap(items.length);
    const mult = new Map();
    let restM = 0;
    for (const k of items) { const m = multOf(k); mult.set(k, m); restM += m; }
    const out = new Map();
    let rest = 1, more = true;
    while (more) {
      more = false;
      for (const k of items) {
        if (out.has(k) || !(mult.get(k) * rest > cap * restM)) continue;
        out.set(k, cap); rest -= cap; restM -= mult.get(k); more = true;
      }
    }
    for (const k of items) if (!out.has(k)) out.set(k, restM > 0 ? Math.max(0, rest) * mult.get(k) / restM : 0);
    return out;
  }

  /* Candidates and log-weights of the next fresh pick (the balancing rules above). shares: Map key → fair share
   * (fairShares); allowed: the keys that may be drawn (a finite test: those with asks left; default all). */
  function freshWeights(run, items, shares, o, allowed) {
    const n = run.asked.length;
    const size = items.length;
    const recent = new Set(endlessWindow(run, size));
    const pool = allowed || items;
    let cands = pool.filter((k) => !recent.has(k));
    if (!cands.length) cands = pool;
    const from = new Map(items.map((k) => [k, joinedAt(run, k, n)]));
    // asks since the item joined (an item added mid-run owes nothing for the questions before it: no catch-up burst)
    const count = new Map(), last = new Map();
    run.asked.forEach((k, i) => { if (i >= (from.get(k) || 0)) count.set(k, (count.get(k) || 0) + 1); last.set(k, i); });
    const alpha = balanceAlpha(size);
    const twin = n > 0 && o.pairOf ? o.pairOf(run.asked[n - 1]) : null;
    // a live run: the fair amounts accrued question by question (run.fair, accrueFair); else the closed forms
    const fair = isLive(run) && run.fair && typeof run.fair === 'object' ? run.fair : null;
    const logw = cands.map((k) => {
      const share = shares.get(k);
      const acc = fair && hasOwn(fair, k) && fair[k] && Number.isFinite(fair[k].o) && Number.isFinite(fair[k].w) ? fair[k] : null;
      const deficit = (acc ? acc.o : (n - from.get(k)) * share) - (count.get(k) || 0);
      const wait = acc ? acc.w : (n - 1 - (last.has(k) ? last.get(k) : -1)) * share;
      let v = Math.log(share) + alpha * deficit + OVERDUE_GAIN * Math.max(0, wait - 1);
      if (twin != null && k === twin && cands.length > 1) v += Math.log(TWIN_DAMP);
      return v;
    });
    return { cands, logw };
  }

  // Relative weights from log-weights (the largest is 1).
  function fromLog(logw) {
    let mx = -Infinity;
    for (const v of logw) if (v > mx) mx = v;
    return logw.map((v) => Math.exp(v - mx));
  }

  // One fresh balancing draw (no retries): the key.
  function drawFresh(run, items, shares, r, o, allowed) {
    const { cands, logw } = freshWeights(run, items, shares, o, allowed);
    const w = fromLog(logw);
    let u = r() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < cands.length; i++) {
      u -= w[i];
      if (u < 0) return cands[i];
    }
    return cands[cands.length - 1];
  }

  // { key: probability } of the next fresh pick (due retries aside) — for tests and tuning.
  function endlessOdds(run, pool, statsOf, opts) {
    const items = uniqueKeys(pool);
    if (!items.length) return {};
    const multOf = isLive(run) ? liveGetter(run.live, items) : multGetter(statsOf);
    const { cands, logw } = freshWeights(run, items, fairShares(items, multOf), opts || {});
    const w = fromLog(logw);
    const total = w.reduce((a, b) => a + b, 0);
    const out = {};
    cands.forEach((k, i) => { out[k] = w[i] / total; });
    return out;
  }

  // State saved by an older version (before the retry limits) gets the new fields.
  function runState(run) {
    if (!Array.isArray(run.asked)) run.asked = [];
    if (!Array.isArray(run.retries)) run.retries = [];
    if (!Array.isArray(run.retried)) run.retried = [];
    if (!(run.retryCount >= 0)) run.retryCount = 0;
    if (!(run.retryStreak >= 0)) run.retryStreak = 0;
    return run;
  }

  const isLive = (run) => !!run && !!run.live && typeof run.live === 'object' && !Array.isArray(run.live);

  function nextEndless(run, pool, statsOf, rng, opts) {
    const r = rng || Math.random;
    const items = uniqueKeys(pool);
    if (!items.length) return null;
    runState(run);
    const n = run.asked.length;
    // who is in the pool since when: a new (or returning) item joins at n, one left out is forgotten (a run state
    // without it — before the first pick, or saved by an older version — counts the current pool from the start)
    const fresh = !run.since || typeof run.since !== 'object' || Array.isArray(run.since);
    if (fresh) run.since = {};
    const inPool = new Set(items.map(String));
    for (const k of Object.keys(run.since)) if (!inPool.has(k)) delete run.since[k];
    for (const k of items) if (!hasOwn(run.since, k)) run.since[k] = fresh ? 0 : n;
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
    // 틀린 것 위주 live (run.live): the multipliers follow the run's own answers, and the balancing counts each item's
    // fair share question by question (run.fair) — a share that rose is owed from now on, not for the questions before
    const live = isLive(run);
    const shares = live ? fairShares(items, liveGetter(run.live, items)) : null;
    if (key == null) key = drawFresh(run, items, shares || fairShares(items, multGetter(statsOf)), r, opts || {});
    if (live) accrueFair(run, items, shares, key, n);
    run.asked.push(key);
    run.retries = run.retries.filter((x) => x.key !== key);
    run.retryStreak = retry ? run.retryStreak + 1 : 0;
    if (retry) {
      run.retryCount++;
      if (!run.retried.includes(key)) run.retried.push(key);
    }
    return { key, retry };
  }

  /* A live run, after question n (`key` asked): every item of the pool accrues its share of that question — o: its
   * fair amount since it joined (the deficit's first term), w: since it was last asked (the wait, in fair periods).
   * With constant shares these are the closed forms (n − joined) · share and (n − 1 − last) · share; with live shares a
   * share that rose counts from the question it rose at (no catch-up burst for the questions before). An item new to
   * run.fair starts from the closed forms at n. */
  function accrueFair(run, items, shares, key, n) {
    if (!run.fair || typeof run.fair !== 'object' || Array.isArray(run.fair)) run.fair = {};
    const fair = run.fair;
    const inPool = new Set(items.map(String));
    for (const k of Object.keys(fair)) if (!inPool.has(k)) delete fair[k];
    for (const k of items) {
      const s = shares.get(k);
      let a = hasOwn(fair, k) && fair[k] && typeof fair[k] === 'object' ? fair[k] : null;
      if (!a || !Number.isFinite(a.o) || !Number.isFinite(a.w)) {
        a = fair[k] = { o: (n - joinedAt(run, k, n)) * s, w: (n - 1 - run.asked.lastIndexOf(k)) * s };
      }
      a.o += s;
      a.w = k === key ? 0 : a.w + s;
    }
  }

  // Questions between a miss and its retry: max(5, min(20, round(size / 3))) ± 30 %, never inside the no-repeat window.
  function retryGap(size, r) {
    const mid = Math.max(RETRY_GAP_MIN, Math.min(RETRY_GAP_MAX, Math.round(size / RETRY_GAP_DIV)));
    const gap = Math.round(mid * (1 - RETRY_JITTER + 2 * RETRY_JITTER * r()));
    return Math.max(1, Math.min(size - 1, Math.max(Math.min(ENDLESS_WINDOW, size - 1), gap)));
  }

  /* After the answer: the spaced retry (✕, or △ with retryTri) and, in a live run (run.live: 틀린 것 위주 on), the item's
   * miss estimate. miss: the answer's miss value 0..1 (a hinted answer's — answerMiss); undefined → from the mark
   * (○ 0, △ ½, ✕ 1); null → the estimate is left as it is (an answer the history does not count: 컨닝 ○). */
  function endlessRecord(run, key, mark, rng, poolSize, miss) {
    if (isLive(run)) liveRecord(run.live, key, miss === undefined ? answerMiss(mark, 0) : miss);
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

  /* ---------------------------------------------------------------- the '…위주' multipliers (history, opt-in)
   * 학습 덜 한 것 위주 (focusLess) — lessMultipliers(pool, infoOf, now) → Map key → 1..4. infoOf(key) → { n, lastAt }:
   * the item's answers in this practice mode and its last answer in any mode (ms; 0 = never / unknown). Relative to
   * the pool, so the same history reads the same after a break:
   *   fewer = 1 − ln(1 + n) / ln(1 + the most answers of any item in the pool)   (0 when nothing has answers)
   *   stale = ln(1 + hours from lastAt to the newest lastAt in the pool) / ln(1 + 14 · 24), capped at 1; 1 when
   *           there is no lastAt (never practised, or practised before it was kept); ½ when lastAt is more than a
   *           day ahead of the clock (another device's fast clock: unknown) — such a stamp is not the pool's newest
   *   mult  = 1 + 3 · (0.6 · fewer + 0.4 · stale)   (never practised ×4; the most practised, just now ×1) */
  const LESS_MAX = 4, LESS_FEWER = 0.6, STALE_HOURS = 14 * 24;
  const HOUR = 3600000, SKEW_MS = 24 * HOUR;
  function lessMultipliers(pool, infoOf, now) {
    const limit = (Number.isFinite(now) ? now : Date.now()) + SKEW_MS;
    const info = uniqueKeys(pool).map((k) => {
      const s = (infoOf && infoOf(k)) || {};
      const n = Number(s.n) > 0 ? Number(s.n) : 0;
      const at = Number(s.lastAt) > 0 ? Number(s.lastAt) : 0;
      return { k, n, at, future: at > limit };
    });
    let most = 0, ref = 0;
    for (const x of info) {
      if (x.n > most) most = x.n;
      if (!x.future && x.at > ref) ref = x.at;
    }
    const out = new Map();
    for (const x of info) {
      const fewer = most > 0 ? 1 - Math.log1p(x.n) / Math.log1p(most) : 0;
      const stale = x.future ? 0.5 : !(x.at > 0) ? 1
        : ref > x.at ? Math.min(1, Math.log1p((ref - x.at) / HOUR) / Math.log1p(STALE_HOURS)) : 0;
      out.set(x.k, 1 + (LESS_MAX - 1) * (LESS_FEWER * fewer + (1 - LESS_FEWER) * stale));
    }
    return out;
  }

  // A char's answers in this mode (컨닝 answers included: practised all the same).
  function charAnswers(stats, ch, mode) {
    const c = charStats(stats, ch);
    if (!c || typeof c !== 'object') return 0;
    const r = cnt(c.read, 'ok') + cnt(c.read, 'ng') + cnt(c.read, 'cheat');
    const w = cnt(c.write, 'o') + cnt(c.write, 't') + cnt(c.write, 'x') + cnt(c.write, 'cheat');
    return mode === 'read' ? r : mode === 'write' ? w : r + w;
  }

  /* statsOf for kana (finite tests and 무한 runs): the char's '…위주' multipliers from the history before the test —
   * the history is not even looked at for an option that is off (all off: { mult: 1 } for every char).
   *   focusLess       학습 덜 한 글자 위주  lessMultipliers over the pool (answers in this mode, stats.chars[ch].last), 1..4
   *   focusWrong      틀린 글자 위주       1 + 2 · wrongness (overall rate blended with the recent answers), 1..3
   *   focusConfusable 헷갈리는 글자 위주   ×3 with a look-alike in the pool, ×1.75 with look-alikes elsewhere only
   * → { mult, less, wrong, look }: mult = their product made a multiplier for the pool by focusScale (as it is while
   * no char's is over ×6; else the pool's spread scaled to ×6 in log space). now: the clock (lastAt check). */
  function endlessStatsOf(stats, mode, settings, data, pool, now) {
    const st = settings || {};
    const keys = uniqueKeys(pool);
    const available = new Set(keys);
    const less = st.focusLess
      ? lessMultipliers(keys, (ch) => { const c = charStats(stats, ch); return { n: charAnswers(stats, ch, mode), lastAt: c ? nat(c.last) : 0 }; }, now)
      : null;
    const memo = new Map();
    const factors = (ch) => {
      if (memo.has(ch)) return memo.get(ch);
      const l = (less && less.get(ch)) || 1;
      const miss = st.focusWrong ? wrongness(stats, ch, mode) : 0;
      const wrong = st.focusWrong ? 1 + WRONG_SPAN * miss : 1;
      let look = 1;
      const k = data && data.kana && data.kana[ch];
      if (st.focusConfusable && k && k.confusables && k.confusables.length) {
        look = k.confusables.some((p) => available.has(p)) ? 3 : 1.75;
      }
      const f = { less: l, wrong, look, miss, p: l * wrong * look };
      memo.set(ch, f);
      return f;
    };
    const scale = st.focusLess || st.focusWrong || st.focusConfusable ? focusScale(keys.map((ch) => factors(ch).p)) : focusMult;
    return (ch) => {
      const f = factors(ch);
      const out = { mult: scale(f.p), less: f.less, wrong: f.wrong, look: f.look };
      if (st.focusWrong) out.miss = f.miss;     // the estimate a live run starts from (liveFocus)
      return out;
    };
  }

  /* ---------------------------------------------------------------- 틀린 것 위주, live within a run (SPEC-words A)
   * With 틀린 것 위주 on, the run's own answers move the weights too (user request: "무한으로 돌릴 때 틀린 것 위주 하면
   * 그때 틀린 것들도 잘 반영되면서"). Each item keeps a miss estimate 0..1 that starts at its value from the history
   * (kana wrongness / 단어장 wrongScore) and after each of its answers moves a quarter of the way to the answer's miss
   * value (an exponential moving average, LIVE_RATE): ○ 0, △ ½, ✕ 1, a hinted answer in between (answerMiss); an
   * answer the history does not count (컨닝 ○, an ungraded '-') leaves it as it is. Its 틀린 것 위주 factor is
   * 1 + 2 · estimate as before (1..3), multiplied with the other options' factors (kept from the start of the run)
   * and made the pool's multiplier by focusScale — at the start exactly the frozen table (focusTable) of before.
   * One answer moves the factor by at most ×1.5 up (a miss at estimate 0) and ×1.2 down (a ○ at estimate 1); a word
   * missed every time approaches ×3, one answered right again falls back answer by answer (½ of the way in 2.4).
   *   live = liveFocus(pool, statsOf)  { key: { less, look, miss } } (plain JSON) — statsOf(key) → { less, look, miss }
   *                                    (endlessStatsOf / 단어장 endlessStatsFor with 틀린 것 위주 on; missing ×1 / ×1 /
   *                                    (wrong − 1) / 2)
   *   liveRecord(live, key, miss)      → whether the estimate moved
   *   liveMults(live, pool?)           → { key: mult } (1..6), a focusTable-like table
   * A 무한 run takes `live` in endlessStart({ live }) (nextEndless then ignores its statsOf; endlessRecord updates it);
   * a finite test with more questions than items keeps it beside its question list (finiteLiveStart) and re-plans the
   * questions not asked yet after each answer (finiteLiveRecord → finiteReplan). */
  const LIVE_RATE = 0.25;
  const unit = (v) => (Number(v) > 0 ? Math.min(1, Number(v)) : 0);
  const factorOf = (v) => (Number.isFinite(v) && v > 0 ? v : 1);

  // The miss share of a hinted answer (user request: "틀린 거 쪽으로 가중치가 힌트 개수만큼, 로그 함수 느낌으로 초반에
  // 많이"): ln(1 + used) / ln(1 + of) — of = the hint steps the question's mode has (쓰기 2: 0.63 / 1; 한자 읽기 3:
  // 0.50 / 0.79 / 1), used = the steps the learner opened (a step the question shows up front — 한국어 + 발음 — is
  // neither used nor taken off `of`). 0 without hints.
  function hintShare(used, of) {
    const H = Math.floor(Number(of)), u = Math.floor(Number(used));
    if (!(H >= 1) || !(u >= 1)) return 0;
    return Math.log1p(Math.min(u, H)) / Math.log1p(H);
  }

  // An answer's miss value 0..1: 1 − (1 − base) · (1 − share) with base ○ 0 · △ ½ · ✕ 1 and share the hint share
  // (0 without hints) — a hinted ○ is `share` of a miss, a hinted △ that far from ½ towards 1, a ✕ is 1 whatever the
  // hints. Marks other than ○ △ ✕ → null (not graded).
  function answerMiss(mark, share) {
    const base = mark === 'o' ? 0 : mark === 't' ? 0.5 : mark === 'x' ? 1 : null;
    if (base == null) return null;
    return 1 - (1 - base) * (1 - unit(share));
  }

  function liveFocus(pool, statsOf) {
    const get = typeof statsOf === 'function' ? statsOf
      : statsOf && typeof statsOf === 'object' ? (k) => (hasOwn(statsOf, k) ? statsOf[k] : null) : () => null;
    const out = {};
    for (const k of uniqueKeys(pool)) {
      const s = get(k);
      const o = s && typeof s === 'object' ? s : {};
      const miss = Number.isFinite(o.miss) ? o.miss : Number.isFinite(o.wrong) ? (o.wrong - 1) / WRONG_SPAN : 0;
      out[k] = { less: factorOf(o.less), look: factorOf(o.look), miss: unit(miss) };
    }
    return out;
  }

  function liveRecord(live, key, miss) {
    if (!live || typeof live !== 'object' || miss == null || !hasOwn(live, key)) return false;
    const e = live[key];
    const v = Number(miss);
    if (!e || typeof e !== 'object' || !Number.isFinite(v)) return false;
    const m = unit(e.miss);
    const next = m + LIVE_RATE * (unit(v) - m);
    e.miss = next;
    return next !== m;
  }

  // key → mult of the live table over `items` (an item missing from it: ×1 and no misses): the products
  // less · (1 + 2 · miss) · look made multipliers for the pool by focusScale, as endlessStatsOf / endlessStatsFor do.
  function liveGetter(live, items) {
    const prod = new Map();
    for (const k of items) {
      const e = live && hasOwn(live, k) && live[k] && typeof live[k] === 'object' ? live[k] : {};
      prod.set(k, factorOf(e.less) * (1 + WRONG_SPAN * unit(e.miss)) * factorOf(e.look));
    }
    const scale = focusScale(Array.from(prod.values()));
    return (k) => focusMult(scale(prod.has(k) ? prod.get(k) : 1));
  }

  function liveMults(live, pool) {
    const items = uniqueKeys(pool || Object.keys(live || {}));
    const multOf = liveGetter(live, items);
    const out = {};
    for (const k of items) out[k] = multOf(k);
    return out;
  }

  /* A finite test of n > poolSize questions with 틀린 것 위주 on: its live state (plain JSON) — the test's question list
   * is pickFinite's as before; after each answer finiteLiveRecord moves the item's estimate and, when it moved,
   * returns the questions not asked yet re-planned (finiteReplan) → [key] (the list's tail), else null (keep it). */
  function finiteLiveStart(pool, n, statsOf) {
    const keys = uniqueKeys(pool);
    return { n: Math.max(0, Math.floor(Number(n) || 0)), pool: keys, live: liveFocus(keys, statsOf) };
  }
  function finiteLiveRecord(state, asked, key, mark, rng, opts, miss) {
    if (!state || typeof state !== 'object' || !state.live) return null;
    if (!liveRecord(state.live, key, miss === undefined ? answerMiss(mark, 0) : miss)) return null;
    return finiteReplan(asked, state.pool, state.n, liveMults(state.live, state.pool), rng, opts);
  }

  /* The rest of a finite test (n questions, `asked` so far) re-planned for the current multipliers → [key]
   * (n − asked.length keys). Every item not asked yet still comes once; the other questions go to the items short of
   * their fair amount of the whole test — n · share − asked so far, ≥ 0 — shared out like finiteTargets (each ⌊e⌋ or
   * ⌈e⌉), ordered by the balancing draw continuing after `asked` (dueFirst, the window, opts.pairOf). */
  function finiteReplan(asked, pool, n, statsOf, rng, opts) {
    const r = rng || Math.random;
    const items = uniqueKeys(pool);
    const done = Array.isArray(asked) ? asked.slice() : [];
    const total = Math.floor(Number(n));
    const rest = total - done.length;
    if (!items.length || !(rest > 0)) return [];
    const count = new Map(items.map((k) => [k, 0]));
    for (const k of done) if (count.has(k)) count.set(k, count.get(k) + 1);
    let unasked = items.filter((k) => !count.get(k));
    if (unasked.length > rest) unasked = shuffle(unasked, r).slice(0, rest);
    const base = new Set(unasked);
    const shares = fairShares(items, multGetter(statsOf));
    const want = new Map(items.map((k) => [k, Math.max(0, total * shares.get(k) - count.get(k) - (base.has(k) ? 1 : 0))]));
    let sum = 0;
    for (const v of want.values()) sum += v;
    const weights = new Map(items.map((k) => [k, sum > 0 ? want.get(k) / sum : shares.get(k)]));
    const left = spreadExtra(items, rest - base.size, weights, r);
    for (const k of base) left.set(k, left.get(k) + 1);
    const plan = new Map(items.map((k) => [k, Math.max(1, count.get(k) + left.get(k)) / total]));
    const run = endlessStart();
    run.asked = done.slice();
    const win = windowSize(items.length);
    for (let i = done.length; i < total; i++) {
      const k = drawFresh(run, items, plan, r, opts || {}, dueFirst(items, left, i, total, win));
      left.set(k, left.get(k) - 1);
      run.asked.push(k);
    }
    return run.asked.slice(done.length);
  }

  /* Kana: the live state of a finite test with 틀린 글자 위주 on and more questions than chars (buildPool's
   * pickFinite plan), else null. */
  function finiteLiveFor(settings, data, stats, mode, now) {
    const st = settings || {};
    if (!st.focusWrong || st.count === 'endless') return null;
    const chars = charsFor(st, data);
    const n = questionCount(st, chars.length);
    if (!(n > chars.length)) return null;
    return finiteLiveStart(chars, n, endlessStatsOf(stats, mode, st, data, chars, now));
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
    endlessStart, nextEndless, endlessRecord, endlessStatsOf, endlessOdds,
    pickFinite, focusTable, focusMult, focusScale, lessMultipliers, balanceAlpha,
    hintShare, answerMiss, liveFocus, liveRecord, liveMults, finiteLiveStart, finiteLiveRecord, finiteReplan, finiteLiveFor,
    LIVE_RATE,
  };
});
