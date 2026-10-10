/* KanaStore — local-first persistence for 가나 연습장 (docs/SPEC-words.md §F, entry fields §I).
 *
 * Works everywhere with localStorage only (every access wrapped; in-memory fallback). Inside the claude.ai
 * artifact viewer it also mirrors the learner's data into the artifact's PRIVATE per-user db subtree, so
 * 내 단어장, settings and progress follow the learner across devices. No public method throws.
 *
 * ---------------------------------------------------------------------------------------------- API
 *   KanaStore.init({ key = 'kana-practice-v1' }) → { settings, stats, prefs, words }      (synchronous)
 *       settings: sanitized copy (Quiz.sanitizeSettings when loaded). stats: THIS DEVICE's stats — a LIVE
 *       object the store keeps (merges from other tabs / the cloud are applied to it in place). prefs: as stored
 *       (device-local UI prefs: shared by this browser's tabs, never sent to the cloud). words: words.list().
 *   KanaStore.saveState({ settings?, stats?, prefs? })   debounced local save (+ debounced cloud mirror).
 *       Settings that differ from what the app passed last time (and from the store's) count as a local edit
 *       (LWW timestamp bumped); re-saving an unchanged stale object never overrides adopted remote settings.
 *       A stats object becomes "this device's stats" (identity adopted). Passing an EMPTY stats object while
 *       the device has history = device-level reset (new epoch). For "기록 지우기" on all devices call resetStats().
 *   KanaStore.resetStats() → stats      clears records on every device (reset marker synced with settings).
 *   KanaStore.connectCloud() → Promise<void>   call once after first render; never rejects. Resolves when the
 *       first snapshots arrived, or when sync is unavailable (status().cloud tells which).
 *   KanaStore.status() → { local:'ok'|'memory', cloud:'off'|'connecting'|'on'|'error', message, quota, unstable, uid }
 *       uid = the claude.ai account this browser's data is bound to (string), null before any account connected.
 *       cloud is 'connecting' only once the host actually offered db + user (no "connecting…" flash elsewhere).
 *   KanaStore.onChange(fn) → unsubscribe. fn({ words?, stats?, settings?, deviceStats?, prefs?, status?, account? })
 *       after remote / other-tab merges and status changes (batched, async):
 *         words       = words.list()          stats       = allStats()
 *         settings    = new settings object → the app should adopt it (state.settings = change.settings)
 *         deviceStats = this device's stats object → adopt it (state.stats = change.deviceStats)
 *         prefs       = prefs saved by another tab of this browser (theme…), adopt if wanted
 *         status      = status()              account     = true when the signed-in account changed
 *   KanaStore.allStats() → this device's stats + other devices' (same shape as Quiz stats; when there are no
 *       other devices it IS the live device object). Use it for records / weighting, never pass it back.
 *   KanaStore.flush() → Promise   write everything now (also done on pagehide / tab hidden).
 *   KanaStore.words.list() / get(id) / validate(input) / add(input) / update(id, patch) / remove(id)
 *       / exportJSON() / importJSON(text) / recordResult(id, { mode, mark, cheat, overridden, meaning, part })
 *       add/update return the entry, or { error, field, message, bad } (no id) when the input is invalid.
 *       exportJSON words carry `stats` (totals) and `tally` (per device); importJSON joins tallies slot by slot
 *       (re-importing, or importing on a device that already synced part of them, never counts twice) and falls
 *       back to `stats` for files without a tally.
 *   KanaStore.create(env) → an independent store (tests; env can inject storage, claude, clock, timers, rng).
 *
 * Entry (as returned): { id, text, kanji, alts?, source?, meaning, reading, note, type:'word'|'sentence', tag, createdAt, updatedAt,
 *          stats: { read:{ok,ng}, write:{o,t,x}, kanji:{ reading:{o,t,x}, meaning:{ok,ng} }, meaning:{ok,ng},
 *                   cheat, overridden, recent:[{ m, g }] (last 8), last } }
 *   updatedAt = last CONTENT edit (add/update/remove). recordResult changes only stats, so practising a stale
 *   copy on another device can never resurrect a deleted word.
 *
 * ---------------------------------------------------------------------------------- counting model
 *   Practice counters are never merged with "max" between independent writers (that loses answers given at the
 *   same time on two tabs/devices). Instead:
 *   • per word, stats are kept per DEVICE (entry.tally[deviceId], stored sparsely; entry.stats = their sum).
 *     Only one device writes its own slot, so slot versions form a chain and max-join per slot is exact.
 *   • this device's kana stats live in its own cloud doc (written only by this device).
 *   • the tabs of ONE device share both (same device id). They never overwrite each other: every local write is
 *     merge-before-write (read the stored record, rebase, write), and each tab keeps the last shared version it
 *     merged (`base`): its own answers since then are a delta re-applied on top of whatever another tab or the
 *     cloud published (cur' = join(base, incoming) + (cur − base)). The cloud gets a version only after it was
 *     published locally (or, without localStorage, base := what is written), so this device's cloud copies stay
 *     a chain too. Without localStorage ('nolocal', see below) the cloud is the shared medium: only two writes
 *     racing within one round trip can still lose answers (merged by max).
 *   Every Quiz answer bumps exactly one graded counter per `recent` push (entries: same rule in recordResult), so a
 *   delta's new `recent` items are the last Σ(graded increments) items.
 *
 * ----------------------------------------------------------------------------------- local storage
 *   <key>          { v:1, settings, stats, prefs, settingsAt, settingsBase, statsAt, since, device, prefsAt, uid } —
 *                  superset of the old app.js record { v:1, settings, stats, prefs }, which is read as-is (migration).
 *   <key>:words    { v:1, uid, entries:[entry (tally packed) | tombstone (+ local `seen`)], synced:[ids seen in the cloud] }
 *   <key>:sync     { v:1, uid, device, statsResetAt, others:{ deviceId:{ since, updatedAt, stats } } }
 *   <key>:stash    data of other claude.ai accounts that used this browser (≤ 3), restored when they return;
 *                  dropped first when localStorage is full.
 *   The device id lives in <key> with the stats it owns and is mirrored in <key>:sync, so an old app.js tab that
 *   rewrites <key> without it cannot make this browser look like a new device (its stats would count twice).
 *   Records carry the bound account (uid): a tab never absorbs another account's records.
 *   Corrupted JSON / wrong shapes → sanitized or defaults. Storage that throws or is full → status().local =
 *   'memory' (each record is retried: a small one with the next successful save, a big one at most every 30 s).
 *   Readable-but-unwritable storage holding history and no device id: the throwaway id never uploads stats.
 *   'storage' events (and pageshow / tab visible again, for tabs that missed events) re-read the stored records
 *   and merge them like remote changes. Merges are joins, so tabs settle after one exchange.
 *
 * ------------------------------------------------------------------------------------ cloud design
 *   Docs (private subtree data/users/<uid>/…; settings = 4 segments → doc, profile/{stats,words}/<id> = 6 → doc):
 *     settings                     { settings, updatedAt, statsResetAt }        settings LWW by updatedAt;
 *                                                                              statsResetAt = max (reset marker)
 *     profile/stats/<deviceId>     { device, since, updatedAt, stats }          written only by that device
 *     profile/words/<wordId>       entry + tally | { id, deleted:true, updatedAt }   one doc per entry
 *   • Word content = LWW by (updatedAt, tombstone wins ties, then a stable content compare). New timestamps are
 *     max(now, previous + 1) per entry / settings doc, so an edit made after seeing a version from a device whose
 *     clock runs ahead still wins (only truly concurrent edits are decided by the clocks).
 *   • Writes: per document, debounced (settings/words 1.5 s, stats 3 s, a burst written after ≤ 4× that),
 *     never closer than 1.5 s, ONE in flight per document, at most 4 in flight overall, and only when the
 *     body differs from what the cloud is confirmed to hold (snapshots carrying this page's own pending writes do
 *     not count as confirmation). Snapshot callbacks never write; they only schedule. A change learned from another
 *     tab is that tab's to upload: this tab only schedules a late backup (3× the delay), which finds nothing to do
 *     once the other tab's write is seen. resource_exhausted / repeated unavailable pause ALL writes (global
 *     exponential backoff) instead of each doc retrying on its own.
 *   • Absence is judged only on definitive, complete snapshots (fromCache false and fewer than 1000 docs — a
 *     possibly capped result never deletes anything). A local word absent from the cloud is uploaded when it was
 *     never synced; when it WAS synced it was deleted and its tombstone purged → dropped (kept as a local tombstone
 *     of that version, so a stale copy another tab still holds can't bring it back), unless edited within the
 *     last 30 days (newer than any purgeable tombstone) → re-uploaded. A cloud with no word docs at all never
 *     wipes the local list (it is re-uploaded instead: losing a list is worse than restoring deleted words).
 *     Tombstones are uploaded only when the cloud has / had that doc, and purged (cloud ≤ 200 per session, and
 *     locally) when they are 30 days old AND this device has known them for 30 days by its own clock — a device
 *     whose clock runs ahead cannot purge fresh tombstones.
 *   • Device docs: created only once the device has history (a visit without practice creates nothing).
 *     Without any usable localStorage the device id is the fixed 'nolocal': every storage-less session of the
 *     learner shares ONE stats doc / word slot, rebases on it and keeps adding to it. Answers given before the
 *     cloud connects survive adopting the cloud's epoch (those recorded after it started).
 *     A device id generated this session is confirmed against localStorage before the first upload (two tabs
 *     that started at the same moment agree on one id instead of uploading the same history twice).
 *   • Account binding: local data is tied to the first uid that connects. Another account on the same
 *     browser gets its own data (the previous account's is stashed locally and restored when it returns),
 *     so nothing is ever uploaded into the wrong account.
 *   • Errors: verbs retry once after a short random delay on 'unavailable' (and unknown codes), then back
 *     off; 'resource_exhausted' backs off globally; 'quota_exceeded' → status message, creation of that doc paused;
 *     'invalid_argument' on our own subtree = this viewer may not write → stop syncing; 'revoked',
 *     'not_granted', 'capability_*' → stop syncing, status 'error' with a calm Korean message. A listener
 *     that dies with 'unavailable' / 'resource_exhausted' is re-subscribed (≤ 3 times unless it stayed healthy
 *     for a minute, then 'error').
 *
 * Validation uses KanaText.validate / validateKanji (js/romaji.js). If KanaText is not loaded a minimal
 * built-in check is used (KANA_DATA chars + space, or the Unicode kana blocks when even that is missing).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KanaStore = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const CAN_REQUIRE = typeof module === 'object' && module && module.exports && typeof require === 'function';

  // Sibling modules: the browser global, or (Node) require('./file') lazily.
  function sibling(name, file) {
    if (root && root[name]) return root[name];
    if (CAN_REQUIRE) {
      try { return require(file); } catch (e) { return null; }
    }
    return null;
  }

  /* ------------------------------------------------------------------ constants */

  const DAY = 864e5;
  const PURGE_MS = 30 * DAY;
  const LOCAL_DELAY = 250;
  const DOC_DELAY = { settings: 1500, stats: 3000, word: 1500 };
  const BACKUP_FACTOR = 3;
  const MIN_GAP = 1500;
  const MAX_WAIT = 4;
  const MAX_CONCURRENT = 4;
  const MAX_DOC_BYTES = 250 * 1024;
  const MAX_WORDS = 2000;
  const SNAPSHOT_CAP = 1000;
  const PURGE_PER_SESSION = 200;
  const RECENT_MAX = 8;
  const SESSIONS_MAX = 40;
  const STASH_MAX = 3;
  const CONNECT_TIMEOUT = 20000;
  const USE_TIMEOUT = 15000;
  const RESUB_HEALTHY = 60000;
  const COUNTER_MAX = 1e9;
  const RETRY_LOCAL = 30000;
  const LIMITS = { text: 120, kanji: 60, meaning: 200, reading: 200, note: 1000, tag: 30, source: 40, alts: 5 };
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  const SEG_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  const TERMINAL = ['revoked', 'not_granted', 'capability_disabled', 'capability_removed'];
  const KNOWN_CODES = TERMINAL.concat(['invalid_argument', 'transform_error', 'resource_exhausted', 'quota_exceeded', 'unavailable']);
  const MARKS = ['o', 't', 'x'];
  const ENTRY_MODES = ['read', 'write', 'kanji', 'meaning'];

  const MSG = {
    localOnly: '이 기기에만 저장돼요.',
    memory: '이 브라우저에서는 저장할 수 없어서, 페이지를 닫으면 기록이 사라져요.',
    localFull: '기기 저장 공간이 부족해서 최근 기록이 저장되지 않았어요.',
    connecting: 'claude.ai 계정과 연결하는 중…',
    on: 'claude.ai 계정으로 동기화 중',
    onMemory: 'claude.ai 계정으로 동기화 중 (이 브라우저에는 저장되지 않아요)',
    quota: '동기화 저장 공간이 가득 차서 새 항목은 이 기기에만 저장돼요.',
    unstable: '연결이 잠시 불안정해요. 곧 다시 저장할게요.',
    stopped: '지금은 동기화를 쓸 수 없어요. 이 기기에는 계속 저장돼요.',
    stoppedMemory: '지금은 동기화를 쓸 수 없어요. 페이지를 닫으면 기록이 사라져요.',
    readOnly: '이 계정으로는 동기화 저장을 할 수 없어서 이 기기에만 저장해요.',
    lost: '동기화 연결이 끊겼어요. 이 기기에는 계속 저장돼요.',
  };
  const ERR = {
    textEmpty: '가나를 입력해 주세요.',
    textBad: '한자·영문은 쓸 수 없어요. 히라가나/가타카나로 적어 주세요.',   // kanji among the rejected characters (spec copy)
    // the kana field's other rejections, by what was rejected (as the 단어장 form says them)
    textBadKind: {
      latin: '영문은 쓸 수 없어요. 히라가나/가타카나로 적어 주세요.',
      hangul: '한글은 쓸 수 없어요. 히라가나/가타카나로 적어 주세요.',
      digit: '숫자는 쓸 수 없어요. 가나로 적어 주세요 (1 → いち).',
      punct: '이 기호는 쓸 수 없어요. 문장 부호는 、 。 ー만 쓸 수 있어요.',
      other: '이 글자는 쓸 수 없어요 (ゐ·ゑ 같은 옛 글자나 특수한 가나). 지금 쓰는 히라가나/가타카나로 적어 주세요.',
      mixed: '가나(히라가나·가타카나)와 ー 、 。, 띄어쓰기만 쓸 수 있어요.',
    },
    textLong: '너무 길어요. ' + LIMITS.text + '자까지 쓸 수 있어요.',
    kanjiBad: '한자 칸에는 한자와 가나만 쓸 수 있어요.',
    kanjiNone: '한자 칸에는 한자가 하나 이상 들어가야 해요.',
    kanjiLong: '한자 표기가 너무 길어요. ' + LIMITS.kanji + '자까지 쓸 수 있어요.',
    tooLong: (subj, n) => subj + ' 너무 길어요. ' + n + '자까지 쓸 수 있어요.',
    altsMax: '다른 읽기는 ' + LIMITS.alts + '개까지 넣을 수 있어요.',
    altBad: (alt, msg) => '다른 읽기 「' + alt + '」: ' + msg,
    altLong: '다른 읽기가 너무 길어요. ' + LIMITS.text + '자까지 쓸 수 있어요.',
    limit: '단어는 ' + MAX_WORDS + '개까지 저장할 수 있어요.',
    notFound: '단어를 찾을 수 없어요.',
  };

  /* ------------------------------------------------------------------ small pure helpers */

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
  const nat = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0);   // counters are capped where they are summed
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const validSeg = (s) => typeof s === 'string' && SEG_RE.test(s) && s !== '.' && s !== '..';

  // Deterministic JSON (sorted keys) — used for change detection and for what goes into storage.
  function stable(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v !== 'object') return typeof v === 'function' ? 'null' : JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }

  // Serialized size as the db counts it (UTF-8 bytes; kana / Hangul are 3 bytes each).
  function utf8Len(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  function cleanStr(v, max) {
    if (typeof v === 'number' && isFinite(v)) v = String(v);
    if (typeof v !== 'string') return '';
    const s = v.normalize('NFC').trim();
    return s.length > max ? Array.from(s).slice(0, max).join('') : s;
  }

  const codeOf = (e) => (e && typeof e.code === 'string' ? e.code : (e && e.name === 'TypeError' ? 'invalid_argument' : 'unavailable'));

  /* ------------------------------------------------------------------ kana stats (Quiz shape) */

  function quiz() { return sibling('Quiz', './quiz.js'); }

  function emptyStats() { return { v: 1, chars: {}, confusions: {}, sessions: [] }; }

  function cleanRecent(arr, modes) {
    if (!Array.isArray(arr)) return [];
    return arr.filter((r) => isObj(r) && MARKS.includes(r.g)).slice(-RECENT_MAX)
      .map((r) => ({ m: modes.includes(r.m) ? r.m : modes[0], g: r.g }));
  }

  function fallbackStats(raw) {
    const s = emptyStats();
    if (!isObj(raw)) return s;
    if (isObj(raw.chars)) {
      for (const ch of Object.keys(raw.chars)) {
        const c = raw.chars[ch];
        if (!isObj(c) || ch.length > 2) continue;
        const r = isObj(c.read) ? c.read : {}, w = isObj(c.write) ? c.write : {};
        const e = { read: { ok: nat(r.ok), ng: nat(r.ng), cheat: nat(r.cheat) },
          write: { o: nat(w.o), t: nat(w.t), x: nat(w.x), cheat: nat(w.cheat) },
          recent: cleanRecent(c.recent, ['read', 'write']), last: nat(c.last) };
        if (nat(w.word)) e.write.word = nat(w.word);
        s.chars[ch] = e;
      }
    }
    if (isObj(raw.confusions)) {
      for (const k of Object.keys(raw.confusions)) if (/^.{1,2}>.{1,2}$/u.test(k)) s.confusions[k] = nat(raw.confusions[k]);
    }
    if (Array.isArray(raw.sessions)) {
      s.sessions = raw.sessions.filter(isObj).slice(-SESSIONS_MAX).map((x) => {
        const o = { t: nat(x.t), mode: x.mode === 'write' ? 'write' : 'read', script: ['hira', 'kata', 'mix'].includes(x.script) ? x.script : 'hira',
          n: nat(x.n), o: nat(x.o), tri: nat(x.tri), x: nat(x.x), cheat: nat(x.cheat), retry: !!x.retry };
        if (x.endless) o.endless = true;
        return o;
      });
    }
    return s;
  }

  function cleanStats(raw) {
    const Q = quiz();
    if (Q && typeof Q.sanitizeStats === 'function') {
      try { return Q.sanitizeStats(raw); } catch (e) { /* fall through */ }
    }
    return fallbackStats(raw);
  }

  function cleanSettings(raw) {
    const Q = quiz();
    if (Q && typeof Q.sanitizeSettings === 'function') {
      try { return Q.sanitizeSettings(raw); } catch (e) { /* fall through */ }
    }
    return isObj(raw) ? clone(raw) : {};
  }

  function hasHistory(s) {
    return isObj(s) && ((isObj(s.chars) && Object.keys(s.chars).length > 0) ||
      (Array.isArray(s.sessions) && s.sessions.length > 0) ||
      (isObj(s.confusions) && Object.keys(s.confusions).length > 0));
  }

  function numericKeys(a, b) {
    const keys = new Set();
    for (const o of [a, b]) if (isObj(o)) for (const k of Object.keys(o)) if (typeof o[k] === 'number') keys.add(k);
    return Array.from(keys).sort();
  }
  function maxFlat(a, b) {
    const o = {};
    for (const k of numericKeys(a, b)) o[k] = Math.max(nat(a && a[k]), nat(b && b[k]));
    return o;
  }
  function addFlat(into, b) {
    if (!isObj(b)) return;
    for (const k of Object.keys(b)) if (typeof b[k] === 'number' && nat(b[k]) > 0) into[k] = Math.min(COUNTER_MAX, nat(into[k]) + nat(b[k]));
  }
  // Positive differences a − b (keys of a), zeros omitted.
  function diffFlat(a, b) {
    const o = {};
    if (!isObj(a)) return o;
    for (const k of Object.keys(a)) {
      if (typeof a[k] !== 'number') continue;
      const v = nat(a[k]) - nat(isObj(b) ? b[k] : 0);
      if (v > 0) o[k] = v;
    }
    return o;
  }
  // Recent list of whichever side was practised last; on a timestamp tie (two tabs answering in the same ms) the
  // side with more graded answers — for two versions of one writer, the descendant. Deterministic.
  function pickRecent(a, b, graded) {
    const la = num(a && a.last), lb = num(b && b.last);
    const ra = (a && Array.isArray(a.recent)) ? a.recent : [], rb = (b && Array.isArray(b.recent)) ? b.recent : [];
    if (la !== lb) return clone(la > lb ? ra : rb);
    const ga = graded(a), gb = graded(b);
    if (ga !== gb) return clone(ga > gb ? ra : rb);
    return clone(stable(ra) >= stable(rb) ? ra : rb);
  }
  const quizGraded = (c) => (isObj(c) ? ['ok', 'ng'].reduce((n, k) => n + nat(isObj(c.read) ? c.read[k] : 0), 0) +
    ['o', 't', 'x'].reduce((n, k) => n + nat(isObj(c.write) ? c.write[k] : 0), 0) : 0);
  const sessionOrder = (p, q) => (nat(p[1].t) - nat(q[1].t)) || (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0);
  function unionSessions(lists) {
    const seen = new Map();
    for (const list of lists) for (const s of list || []) if (isObj(s)) seen.set(stable(s), s);
    return Array.from(seen.entries()).sort(sessionOrder).slice(-SESSIONS_MAX).map((p) => clone(p[1]));
  }

  // Two versions of ONE writer's stats where one descends from the other: counter-wise max = the later one.
  function joinStats(a, b) {
    const out = emptyStats();
    const ca = isObj(a && a.chars) ? a.chars : {}, cb = isObj(b && b.chars) ? b.chars : {};
    for (const ch of Array.from(new Set(Object.keys(ca).concat(Object.keys(cb)))).sort()) {
      const x = ca[ch], y = cb[ch];
      if (!isObj(x) || !isObj(y)) { out.chars[ch] = clone(isObj(x) ? x : y); continue; }
      out.chars[ch] = { read: maxFlat(x.read, y.read), write: maxFlat(x.write, y.write), recent: pickRecent(x, y, quizGraded), last: Math.max(nat(x.last), nat(y.last)) };
    }
    out.confusions = maxFlat(a && a.confusions, b && b.confusions);
    out.sessions = unionSessions([a && a.sessions, b && b.sessions]);
    return cleanStats(out);
  }

  // Different devices: counters add up.
  function sumStats(list) {
    const out = emptyStats();
    const recents = {};
    for (const s of list) {
      if (!isObj(s)) continue;
      for (const ch of Object.keys(isObj(s.chars) ? s.chars : {})) {
        const c = s.chars[ch];
        if (!isObj(c)) continue;
        const o = out.chars[ch] || (out.chars[ch] = { read: { ok: 0, ng: 0, cheat: 0 }, write: { o: 0, t: 0, x: 0, cheat: 0 }, recent: [], last: 0 });
        addFlat(o.read, c.read);
        addFlat(o.write, c.write);
        o.last = Math.max(o.last, nat(c.last));
        (recents[ch] || (recents[ch] = [])).push({ last: nat(c.last), recent: Array.isArray(c.recent) ? c.recent : [] });
      }
      addFlat(out.confusions, s.confusions);
      if (Array.isArray(s.sessions)) for (const x of s.sessions) if (isObj(x)) out.sessions.push(clone(x));
    }
    for (const ch of Object.keys(recents)) {
      out.chars[ch].recent = recents[ch].sort((p, q) => p.last - q.last).reduce((acc, r) => acc.concat(clone(r.recent)), []).slice(-RECENT_MAX);
    }
    out.sessions.sort((p, q) => nat(p.t) - nat(q.t));
    out.sessions = out.sessions.slice(-SESSIONS_MAX);
    return out;
  }

  // What `cur` holds beyond `base` (same writer, same epoch): counter increments, the answers pushed onto
  // `recent` since (one per graded increment: read ok/ng, write o/t/x), a newer `last`, sessions base lacks.
  function statsDelta(cur, base) {
    const d = { chars: {}, confusions: {}, sessions: [] };
    const cc = isObj(cur && cur.chars) ? cur.chars : {}, bc = isObj(base && base.chars) ? base.chars : {};
    for (const ch of Object.keys(cc)) {
      const c = cc[ch];
      if (!isObj(c)) continue;
      const b = isObj(bc[ch]) ? bc[ch] : {};
      const read = diffFlat(c.read, b.read), write = diffFlat(c.write, b.write);
      const n = nat(read.ok) + nat(read.ng) + nat(write.o) + nat(write.t) + nat(write.x);
      const recent = n > 0 && Array.isArray(c.recent) ? clone(c.recent.slice(-Math.min(n, RECENT_MAX))) : [];
      const last = nat(c.last) > nat(b.last) ? nat(c.last) : 0;
      if (Object.keys(read).length || Object.keys(write).length || recent.length || last) d.chars[ch] = { read, write, recent, last };
    }
    d.confusions = diffFlat(cur && cur.confusions, base && base.confusions);
    const have = new Set(((base && base.sessions) || []).filter(isObj).map(stable));
    for (const s of (cur && cur.sessions) || []) if (isObj(s) && !have.has(stable(s))) d.sessions.push(clone(s));
    return d;
  }
  const deltaEmpty = (d) => !Object.keys(d.chars).length && !Object.keys(d.confusions).length && !d.sessions.length;
  function statsAdd(S, d) {
    const out = cleanStats(S);
    for (const ch of Object.keys(d.chars)) {
      const x = d.chars[ch];
      const e = out.chars[ch] || (out.chars[ch] = { read: { ok: 0, ng: 0, cheat: 0 }, write: { o: 0, t: 0, x: 0, cheat: 0 }, recent: [], last: 0 });
      addFlat(e.read, x.read);
      addFlat(e.write, x.write);
      e.recent = e.recent.concat(clone(x.recent)).slice(-RECENT_MAX);
      e.last = Math.max(nat(e.last), nat(x.last));
    }
    addFlat(out.confusions, d.confusions);
    out.sessions = unionSessions([out.sessions, d.sessions]);
    return cleanStats(out);
  }
  // The part of a delta recorded at or after `since` (answers given after a reset the tab had not seen yet).
  function deltaSince(d, since) {
    const out = { chars: {}, confusions: {}, sessions: d.sessions.filter((s) => nat(s.t) >= since) };
    for (const ch of Object.keys(d.chars)) if (d.chars[ch].last >= since) out.chars[ch] = d.chars[ch];
    for (const k of Object.keys(d.confusions)) if (out.chars[k.split('>')[0]]) out.confusions[k] = d.confusions[k];
    return out;
  }

  /* ------------------------------------------------------------------ per-word stats (one slot per device) */

  const slotTpl = () => ({ read: { ok: 0, ng: 0 }, write: { o: 0, t: 0, x: 0 }, kanji: { reading: { o: 0, t: 0, x: 0 }, meaning: { ok: 0, ng: 0 } },
    meaning: { ok: 0, ng: 0 }, cheat: 0, overridden: 0 });
  const GRADED = [['read', 'ok'], ['read', 'ng'], ['write', 'o'], ['write', 't'], ['write', 'x'], ['kanji', 'reading', 'o'],
    ['kanji', 'reading', 't'], ['kanji', 'reading', 'x'], ['kanji', 'meaning', 'ok'], ['kanji', 'meaning', 'ng'], ['meaning', 'ok'], ['meaning', 'ng']];
  const pathOf = (o, p) => p.reduce((x, k) => (isObj(x) ? x[k] : 0), o);
  const slotGraded = (s) => GRADED.reduce((n, p) => n + nat(pathOf(s, p)), 0);

  // Walk the template: numbers ← f(a[k], b[k]); nested objects recurse.
  function fillNums(tpl, a, b, f) {
    for (const k of Object.keys(tpl)) {
      if (typeof tpl[k] === 'number') tpl[k] = Math.min(COUNTER_MAX, f(nat(isObj(a) ? a[k] : 0), nat(isObj(b) ? b[k] : 0)));
      else if (isObj(tpl[k])) fillNums(tpl[k], isObj(a) ? a[k] : null, isObj(b) ? b[k] : null, f);
    }
    return tpl;
  }
  function emptyEntryStats() { return Object.assign(slotTpl(), { recent: [], last: 0 }); }
  function cleanSlot(raw) {
    const s = fillNums(slotTpl(), raw, null, (x) => x);
    s.recent = cleanRecent(isObj(raw) ? raw.recent : null, ENTRY_MODES);
    s.last = num(isObj(raw) ? raw.last : 0);
    return s;
  }
  function slotEmpty(s) {
    if (!s) return true;
    let zero = true;
    fillNums(slotTpl(), s, null, (x) => { if (x) zero = false; return x; });
    return zero && !(s.recent && s.recent.length) && !num(s.last);
  }
  function joinSlot(a, b) {
    if (!a || !b) return cleanSlot(a || b);
    const s = fillNums(slotTpl(), a, b, Math.max);
    s.recent = cleanRecent(pickRecent(a, b, slotGraded), ENTRY_MODES);
    s.last = Math.max(num(a.last), num(b.last));
    return s;
  }
  function slotDelta(cur, base) {
    const d = fillNums(slotTpl(), cur, base, (c, b) => Math.max(0, c - b));
    let n = 0;
    for (const p of GRADED) n += pathOf(d, p);
    const r = cur && Array.isArray(cur.recent) ? cur.recent : [];
    d.recent = n > 0 ? clone(r.slice(-Math.min(n, RECENT_MAX))) : [];
    d.last = num(cur && cur.last) > num(base && base.last) ? num(cur.last) : 0;
    return d;
  }
  function slotAdd(S, d) {
    const s = fillNums(slotTpl(), S, d, (x, y) => x + y);
    s.recent = cleanRecent(((S && S.recent) || []).concat((d && d.recent) || []), ENTRY_MODES);
    s.last = Math.max(num(S && S.last), num(d && d.last));
    return s;
  }
  // Sparse form for storage / the cloud (an unpractised word stores no stats at all).
  function packSlot(s) {
    const pack = (tpl, src) => {
      const o = {};
      for (const k of Object.keys(tpl)) {
        if (typeof tpl[k] === 'number') { const v = nat(src && src[k]); if (v) o[k] = v; }
        else { const sub = pack(tpl[k], isObj(src) ? src[k] : null); if (Object.keys(sub).length) o[k] = sub; }
      }
      return o;
    };
    const o = pack(slotTpl(), s);
    if (s.recent && s.recent.length) o.recent = clone(s.recent);
    if (num(s.last)) o.last = s.last;
    return Object.keys(o).length ? o : null;
  }
  function cleanTally(raw) {
    const t = {};
    if (isObj(raw)) for (const k of Object.keys(raw)) if (ID_RE.test(k) && isObj(raw[k])) { const s = cleanSlot(raw[k]); if (!slotEmpty(s)) t[k] = s; }
    return t;
  }
  function sumSlots(tally) {
    const tot = slotTpl();
    const parts = [];
    let last = 0;
    for (const k of Object.keys(tally || {}).sort()) {
      const s = tally[k];
      if (!isObj(s)) continue;
      fillNums(tot, tot, s, (x, y) => x + y);
      last = Math.max(last, num(s.last));
      parts.push(s);
    }
    const recent = parts.sort((p, q) => num(p.last) - num(q.last)).reduce((acc, s) => acc.concat(s.recent || []), []).slice(-RECENT_MAX).map(clone);
    return Object.assign(tot, { recent, last });
  }

  /* ------------------------------------------------------------------ entries */

  function autoType(text) {
    const n = String(text || '');
    return /[、。 ]/.test(n) || Array.from(n).length > 10 ? 'sentence' : 'word';
  }

  const RESERVED = ['deleted', 'stats', 'tally', 'seen'];
  const OPTIONAL = ['alts', 'source'];     // content fields present only when non-empty
  // Stored / remote alts → clean list (strings, deduped, not the text itself, ≤ LIMITS.alts). Lenient like cleanEntry:
  // the strict kana check is checkInput's (add / update / import).
  function cleanAlts(v, text) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const a of v) {
      const s = cleanStr(a, 400);
      if (s && s !== text && !out.includes(s)) out.push(s);
      if (out.length >= LIMITS.alts) break;
    }
    return out;
  }
  // Stored / remote entry → internal entry (lenient: rules may evolve; unknown fields from newer versions kept).
  // legacySlot: where a pre-tally `stats` object is credited.
  function cleanEntry(raw, docId, legacySlot) {
    if (!isObj(raw)) return null;
    let id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
    if (docId !== undefined) id = typeof docId === 'string' && ID_RE.test(docId) ? docId : null;
    if (!id) return null;
    const updatedAt = num(raw.updatedAt);
    if (raw.deleted === true) {
      const t = { id, deleted: true, updatedAt };
      if (num(raw.seen)) t.seen = num(raw.seen);
      return t;
    }
    const text = cleanStr(raw.text, 400);
    if (!text) return null;
    const e = {
      id, text, kanji: cleanStr(raw.kanji, 200), meaning: cleanStr(raw.meaning, 1000), reading: cleanStr(raw.reading, 400),
      note: cleanStr(raw.note, 4000), type: raw.type === 'word' || raw.type === 'sentence' ? raw.type : autoType(text),
      tag: cleanStr(raw.tag, 100), createdAt: num(raw.createdAt) || updatedAt, updatedAt, tally: cleanTally(raw.tally),
    };
    // SPEC-words K: alternative readings (kana strings, ≤ 5) and where the entry came from
    const alts = cleanAlts(raw.alts, text);
    if (alts.length) e.alts = alts;
    const source = cleanStr(raw.source, 100);
    if (source) e.source = source;
    if (!isObj(raw.tally) && isObj(raw.stats) && legacySlot) {
      const s = cleanSlot(raw.stats);
      if (!slotEmpty(s)) e.tally[legacySlot] = s;
    }
    for (const k of Object.keys(raw)) {
      if (k in e || RESERVED.includes(k) || OPTIONAL.includes(k) || k.charAt(0) === '_') continue;
      const v = raw[k];
      if (v === undefined || typeof v === 'function') continue;
      try { e[k] = clone(v); } catch (err) { /* not JSON-safe: drop */ }
    }
    return e;
  }

  // Content for LWW (createdAt is merged separately by min, stats per device slot).
  const contentOf = (e) => { const c = Object.assign({}, e); delete c.tally; delete c.seen; delete c.stats; delete c.createdAt; return c; };

  function entryCmp(a, b) {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
    if (!!a.deleted !== !!b.deleted) return a.deleted ? 1 : -1;
    const sa = stable(contentOf(a)), sb = stable(contentOf(b));
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  // Serialized form: cloud body (local=false) or local record item (local=true keeps the tombstone's `seen`).
  function entryOut(e, local) {
    if (e.deleted) {
      const t = { id: e.id, deleted: true, updatedAt: e.updatedAt };
      if (local && num(e.seen)) t.seen = e.seen;
      return t;
    }
    const o = {};
    for (const k of Object.keys(e)) if (k !== 'tally' && k !== 'seen') o[k] = e[k];
    const tally = {};
    for (const k of Object.keys(e.tally || {}).sort()) { const p = packSlot(e.tally[k]); if (p) tally[k] = p; }
    if (Object.keys(tally).length) o.tally = tally;
    return o;
  }

  function viewOf(e) {
    const o = {};
    for (const k of Object.keys(e)) if (k !== 'tally' && k !== 'seen') o[k] = clone(e[k]);
    o.stats = sumSlots(e.tally);
    return o;
  }

  /* ------------------------------------------------------------------ the store */

  function createStore(envIn) {
    const env = envIn || {};
    const now = () => (env.now ? env.now() : Date.now());
    const setT = (fn, ms) => (env.setTimeout ? env.setTimeout(fn, ms) : setTimeout(fn, ms));
    const clearT = (id) => (env.clearTimeout ? env.clearTimeout(id) : clearTimeout(id));
    const rand = () => (env.random ? env.random() : Math.random());
    const sleep = (ms) => new Promise((r) => setT(r, ms));
    const warn = (where, e) => {
      if (typeof env.onError === 'function') { try { env.onError(where, e); } catch (x) { /* ignore */ } }
      else if (typeof console !== 'undefined' && console.warn) console.warn('[KanaStore] ' + where, e);
    };
    const kanaText = () => env.KanaText || sibling('KanaText', './romaji.js');
    const kanaData = () => env.KANA_DATA || sibling('KANA_DATA', './kana-data.js');

    function randomId(prefix) {
      let r = '';
      const c = !env.random && root && root.crypto && typeof root.crypto.getRandomValues === 'function' ? root.crypto : null;
      if (c) {
        const a = new Uint32Array(2);
        c.getRandomValues(a);
        r = a[0].toString(36) + a[1].toString(36);
      } else {
        for (let i = 0; i < 2; i++) r += Math.floor(rand() * 0x100000000).toString(36);
      }
      return prefix + now().toString(36) + r.slice(0, 12);
    }

    /* -------------------------------------------------------------- state */
    let K = null;            // storage keys
    let L = null;            // local storage wrapper
    let main = null;         // { settings, settingsAt, settingsBase, stats, statsAt, since, device, prefs, prefsAt }
    let own = null;          // === main.stats — live object shared with the app (cur)
    let ownBase = null;      // last shared version of this device's stats this tab merged (own − ownBase = pending)
    let meta = null;         // { uid, device, statsResetAt, others }
    const words = new Map(); // id → entry | tombstone
    const synced = new Set();// ids known to exist in the cloud of meta.uid
    const slotBase = new Map(); // id → last shared version of this device's slot (only while answers are pending)
    let deviceFresh = false; // device id generated in this session, not yet confirmed against localStorage
    let ephemeral = false;   // device id could not be persisted while local history exists → never upload stats
    let lastAppSettings = '', lastStatsJSON = '', lastPrefsJSON = '';
    const lastStored = {};   // key → the string localStorage holds as far as this tab knows
    const dirty = { main: false, words: false, meta: false };
    let localTimer = null;
    let retryAt = 0;
    const failedLen = {};
    const listeners = [];
    let pending = null, emitQueued = false;
    const sums = typeof WeakSet === 'function' ? new WeakSet() : null;
    let detachEvents = null;

    const cloud = { state: 'off', reason: null, gen: 0, active: false, connecting: false, uid: null, refs: null, unsubs: {}, resubs: {},
      first: {}, reconciled: {}, quota: false, unstable: false, promise: null, firstDone: null, purgeTimer: null, purged: 0,
      pauseUntil: 0, strikes: 0 };
    const known = new Map();     // doc key → comparison string of the body the cloud is confirmed to hold
    const seenDocs = new Map();  // doc key → last processed DocumentSnapshot (identity → unchanged)
    const writers = new Map();
    let slots = { used: 0, queue: [] };   // per connection: a write that never settles can't starve the next

    /* -------------------------------------------------------------- local storage */
    function openLocal(key) {
      const S = { ls: null, writable: false, bad: new Set(), mem: new Map() };
      let ls = null;
      try {
        ls = typeof env.storage === 'function' ? env.storage() : env.storage !== undefined ? env.storage : (root ? root.localStorage : null);
      } catch (e) { ls = null; }
      if (ls && typeof ls.getItem === 'function') {
        let readable = false;
        try { ls.getItem(key); readable = true; } catch (e) { readable = false; }
        if (readable) S.ls = ls;
      }
      return S;
    }
    function probe(key) {
      const p = () => { try { L.ls.setItem(key + ':probe', '1'); L.ls.removeItem(key + ':probe'); return true; } catch (e) { return false; } };
      L.writable = !!L.ls && (p() || (freeSpace() && p()));
      if (L.ls && !L.writable) L.bad.add(':probe');
    }
    function lget(k) {
      if (L.ls) {
        try { const v = L.ls.getItem(k); return typeof v === 'string' ? v : null; } catch (e) { return L.mem.has(k) ? L.mem.get(k) : null; }
      }
      return L.mem.has(k) ? L.mem.get(k) : null;
    }
    function rawSet(k, v) { try { L.ls.setItem(k, v); return true; } catch (e) { return false; } }
    // The stash (other accounts' local copies, mostly also in their cloud) is what we give up when storage is full.
    function freeSpace() {
      if (!K || !L.ls) return false;
      let had = false;
      try { had = L.ls.getItem(K.stash) != null; if (had) L.ls.removeItem(K.stash); } catch (e) { return false; }
      if (had) lastStored[K.stash] = null;
      return had;
    }
    function setBad(k, bad) {
      if (K && k === K.stash) return;           // other accounts' copies: not what status().local reports on
      const was = L.bad.size;
      if (bad) L.bad.add(k); else L.bad.delete(k);
      if (!!was !== !!L.bad.size) noteStatus();
    }
    function lset(k, v) {
      L.mem.set(k, v);
      if (!L.ls) return false;
      let ok = rawSet(k, v);
      if (!ok && k !== K.stash && freeSpace()) ok = rawSet(k, v);
      setBad(k, !ok);
      if (!ok) { failedLen[k] = v.length; retryAt = now() + RETRY_LOCAL; }
      else {
        delete failedLen[k];
        if (!L.writable) { L.writable = true; setBad(':probe', false); }
        // storage accepts writes again: retry what failed before (a big record at most every 30 s)
        const again = [];
        for (const [key, name] of [[K.main, 'main'], [K.words, 'words'], [K.meta, 'meta']]) {
          if (key !== k && L.bad.has(key) && (num(failedLen[key]) <= 65536 || now() >= retryAt)) again.push(name);
        }
        if (again.length) markDirty(again);
      }
      return ok;
    }
    function readJSON(k) {
      const s = lget(k);
      lastStored[k] = s;
      if (!s) return null;
      try { return JSON.parse(s); } catch (e) { return null; }
    }
    function writeKey(k, obj) {
      const s = stable(obj);
      if (s === lastStored[k]) { if (L.bad.has(k)) setBad(k, false); return true; }
      const ok = lset(k, s);
      if (ok) lastStored[k] = s;
      return ok;
    }

    /* -------------------------------------------------------------- records */
    function loadMain(raw) {
      const r = isObj(raw) ? raw : {};
      const stats = cleanStats(r.stats);
      const settings = cleanSettings(r.settings);
      // Old app.js records have no timestamps: settings the learner changed count as set at t=1 (any real
      // edit elsewhere wins); settings equal to the defaults count as never set (never uploaded).
      const legacyAt = isObj(r.settings) && stable(settings) !== stable(cleanSettings(null)) ? 1 : 0;
      return {
        settings,
        settingsAt: typeof r.settingsAt === 'number' ? num(r.settingsAt) : legacyAt,
        settingsBase: isObj(r.settingsBase) ? clone(r.settingsBase) : null,
        stats,
        statsAt: typeof r.statsAt === 'number' ? num(r.statsAt) : (hasHistory(stats) ? 1 : 0),
        since: num(r.since),
        device: typeof r.device === 'string' && ID_RE.test(r.device) ? r.device : null,
        prefs: isObj(r.prefs) ? clone(r.prefs) : {},
        prefsAt: num(r.prefsAt),
        uid: validSeg(r.uid) ? r.uid : null,
      };
    }
    function mainRecord() {
      return { v: 1, uid: meta.uid, settings: main.settings, stats: own, prefs: main.prefs, settingsAt: main.settingsAt, settingsBase: main.settingsBase,
        statsAt: main.statsAt, since: main.since, device: main.device, prefsAt: main.prefsAt };
    }
    function loadMeta(raw) {
      const r = isObj(raw) ? raw : {};
      const others = {};
      if (isObj(r.others)) {
        for (const id of Object.keys(r.others)) {
          const o = r.others[id];
          if (ID_RE.test(id) && isObj(o)) others[id] = { since: num(o.since), updatedAt: num(o.updatedAt), stats: cleanStats(o.stats) };
        }
      }
      return { uid: validSeg(r.uid) ? r.uid : null, device: typeof r.device === 'string' && ID_RE.test(r.device) ? r.device : null,
        statsResetAt: num(r.statsResetAt), others };
    }
    function metaRecord() {
      return { v: 1, uid: meta.uid, device: main.device === 'nolocal' ? null : main.device, statsResetAt: meta.statsResetAt, others: meta.others };
    }
    function parseWords(raw, legacySlot) {
      const r = Array.isArray(raw) ? { entries: raw } : isObj(raw) ? raw : {};
      const list = Array.isArray(r.entries) ? r.entries : isObj(r.entries) ? Object.values(r.entries) : [];
      const out = [];
      for (const x of list) { const e = cleanEntry(x, undefined, legacySlot); if (e) out.push(e); }
      return { uid: validSeg(r.uid) ? r.uid : null, entries: out, synced: Array.isArray(r.synced) ? r.synced.filter((id) => typeof id === 'string') : [] };
    }
    function wordsRecord() {
      const ids = Array.from(words.keys()).sort();
      return { v: 1, uid: meta.uid, entries: ids.map((id) => entryOut(words.get(id), true)), synced: Array.from(synced).filter((id) => words.has(id)).sort() };
    }
    const recordOf = (k) => (k === K.main ? mainRecord() : k === K.words ? wordsRecord() : metaRecord());

    function markDirty(which) {
      for (const w of which) dirty[w] = true;
      if (!localTimer) localTimer = setT(saveLocalNow, LOCAL_DELAY);
    }
    // Publish: merge-before-write for each record; a successful write makes this tab's pending answers shared.
    function saveLocalNow() {
      if (localTimer) { clearT(localTimer); localTimer = null; }
      if (!K || !main) return;
      // a record that failed to save (storage full) is retried with a later save, at most every 30 s
      if (L.bad.size && now() >= retryAt) {
        retryAt = now() + RETRY_LOCAL;
        if (L.bad.has(K.main)) dirty.main = true;
        if (L.bad.has(K.words)) dirty.words = true;
        if (L.bad.has(K.meta)) dirty.meta = true;
      }
      if (dirty.main) {
        absorbStored(K.main);
        dirty.main = false;
        if (writeKey(K.main, mainRecord())) commitOwn();
      }
      if (dirty.words) {
        absorbStored(K.words);
        dirty.words = false;
        if (writeKey(K.words, wordsRecord())) slotBase.clear();
      }
      if (dirty.meta) {
        absorbStored(K.meta);
        dirty.meta = false;
        writeKey(K.meta, metaRecord());
      }
      if (!dirty.main && !dirty.words && !dirty.meta && localTimer) { clearT(localTimer); localTimer = null; }
    }
    // Merge what another tab stored under k (when it changed since this tab last read or wrote it).
    function absorbStored(k) {
      if (!L || !L.ls) return;
      const raw = lget(k);
      if (raw == null || raw === lastStored[k]) return;
      let obj;
      try { obj = JSON.parse(raw); } catch (e) { return; }
      lastStored[k] = raw;
      if (k === K.main) absorbMain(obj);
      else if (k === K.words) absorbWords(obj);
      else if (k === K.meta) absorbMeta(obj);
      if (stable(recordOf(k)) !== lastStored[k]) markDirty([k === K.main ? 'main' : k === K.words ? 'words' : 'meta']);
    }

    /* -------------------------------------------------------------- change notification */
    function note(flags) {
      pending = Object.assign(pending || {}, flags);
      if (emitQueued) return;
      emitQueued = true;
      Promise.resolve().then(flushNotes);
    }
    function noteStatus() { note({ status: true }); }
    function flushNotes() {
      emitQueued = false;
      const p = pending;
      pending = null;
      if (!p || !main || !listeners.length) return;
      const change = {};
      if (p.words) change.words = listWords();
      if (p.stats || p.deviceStats) change.stats = allStats();
      if (p.deviceStats) change.deviceStats = own;
      if (p.settings) change.settings = clone(main.settings);
      if (p.prefs) change.prefs = clone(main.prefs);
      if (p.status) change.status = status();
      if (p.account) change.account = true;
      for (const fn of listeners.slice()) {
        try { fn(change); } catch (e) { warn('onChange listener', e); }
      }
    }

    /* -------------------------------------------------------------- this device's stats */
    function replaceOwn(next) {
      for (const k of Object.keys(own)) delete own[k];
      Object.assign(own, next);
      lastStatsJSON = stable(own);
    }
    function commitOwn() { ownBase = cleanStats(own); }
    function ownPending() { return stable(cleanStats(own)) !== stable(ownBase); }

    // Another version R = { since, stats, updatedAt } of THIS device's stats (another tab's record, or our cloud
    // doc): rebase this tab's pending answers on it. Older epochs are ignored (ours replaces them).
    function rebaseOwn(R, backup) {
      const since = num(R.since);
      if (since < main.since) return false;
      let delta = statsDelta(own, ownBase), nb;
      if (since > main.since) {
        nb = cleanStats(R.stats);
        delta = deltaSince(delta, since);
        main.since = since;
      } else {
        nb = joinStats(ownBase, R.stats);
        if (stable(nb) === stable(ownBase)) return false;
      }
      ownBase = nb;
      const next = deltaEmpty(delta) ? cleanStats(nb) : statsAdd(nb, delta);
      main.statsAt = Math.max(main.statsAt, num(R.updatedAt));
      if (stable(next) !== stable(own)) { replaceOwn(next); note({ deviceStats: true }); }
      markDirty(['main']);
      scheduleDoc('stats', null, backup ? 'backup' : null);
      return true;
    }

    // A reset marker R (from resetStats here, the settings doc, or another tab).
    function applyReset(R, fromRemote) {
      if (R > meta.statsResetAt) { meta.statsResetAt = R; markDirty(['meta']); }
      if (main.since < R) {
        const keep = fromRemote ? deltaSince(statsDelta(own, ownBase), R) : null;   // answers given after it
        ownBase = emptyStats();
        replaceOwn(keep && !deltaEmpty(keep) ? statsAdd(emptyStats(), keep) : emptyStats());
        main.since = R;
        main.statsAt = Math.max(main.statsAt, R);
        markDirty(['main']);
        if (fromRemote) note({ deviceStats: true });
        scheduleDoc('stats');
      }
      if (fromRemote) note({ stats: true });
    }

    // Two tabs created device ids at the same moment: the one localStorage holds wins; this tab's answers so far
    // move onto it (they were never uploaded under the losing id — see prepareWrite()).
    function adoptDevice(id) {
      const from = main.device;
      main.device = id;
      deviceFresh = false;
      delete meta.others[id];
      for (const e of words.values()) {
        if (e.deleted || !e.tally[from]) continue;
        const base = e.tally[id] || cleanSlot(null);
        e.tally[id] = slotAdd(base, slotDelta(e.tally[from], slotBase.get(e.id) || cleanSlot(null)));
        delete e.tally[from];
        slotBase.set(e.id, base);
      }
      markDirty(['main', 'words', 'meta']);
    }

    /* -------------------------------------------------------------- other tabs' records */
    const sameAccount = (uid) => !uid || !meta.uid || uid === meta.uid;

    function absorbMain(obj) {
      const o = loadMain(obj);
      if (o.device && o.device !== main.device) {
        if (deviceFresh && main.device !== 'nolocal') adoptDevice(o.device);
        else return;              // a record we lost a race to; ours overwrites it
      }
      // prefs are per browser (shared by its tabs, any account): LWW by prefsAt. lastPrefsJSON stays what this
      // tab's app last passed, so an app that keeps its own copy only overrides them by changing something.
      const op = stable(o.prefs), mp = stable(main.prefs);
      if (o.prefsAt > main.prefsAt || (o.prefsAt === main.prefsAt && op > mp)) {
        main.prefs = o.prefs;
        main.prefsAt = o.prefsAt;
        if (op !== mp) note({ prefs: true });
      }
      if (!sameAccount(o.uid)) return;
      const os = stable(o.settings), ms = stable(main.settings);
      if (o.settingsAt > main.settingsAt || (o.settingsAt === main.settingsAt && os > ms)) {
        main.settings = o.settings;
        main.settingsAt = o.settingsAt;
        main.settingsBase = o.settingsBase;
        if (os !== ms) note({ settings: true });
        scheduleDoc('settings', null, 'backup');
      }
      if (ephemeral) return;
      rebaseOwn({ since: o.since, stats: o.stats, updatedAt: o.statsAt }, true);
    }

    function absorbWords(obj) {
      const r = parseWords(obj, main.device);
      if (!sameAccount(r.uid)) return;
      let changed = false;
      for (const inc of r.entries) {
        const cur = words.get(inc.id);
        const m = mergeIn(cur, inc);
        if (cur && stable(entryOut(cur, true)) === stable(entryOut(m, true))) continue;
        words.set(inc.id, m);
        if (!(m.deleted && (!cur || cur.deleted))) changed = true;
        scheduleDoc('word', inc.id, 'backup');
      }
      for (const id of r.synced) if (words.has(id)) synced.add(id);
      if (changed) note({ words: true });
    }

    function absorbMeta(obj) {
      const o = loadMeta(obj);
      if (!sameAccount(o.uid)) return;
      if (o.uid && !meta.uid) meta.uid = o.uid;        // another tab bound this browser's data to its account
      let changed = false;
      for (const id of Object.keys(o.others)) {
        const x = o.others[id], cur = meta.others[id];
        if (id === main.device) continue;
        if (!cur || x.since > cur.since || (x.since === cur.since && (x.updatedAt > cur.updatedAt ||
            (x.updatedAt === cur.updatedAt && stable(x.stats) > stable(cur.stats))))) { meta.others[id] = x; changed = true; }
      }
      if (o.statsResetAt > meta.statsResetAt) applyReset(o.statsResetAt, true);
      if (changed) note({ stats: true });
    }

    /* -------------------------------------------------------------- words: merging */
    function tombstone(id, updatedAt, seenList) {
      const seen = seenList.map(num).filter((x) => x > 0);
      return { id, deleted: true, updatedAt, seen: seen.length ? Math.min.apply(null, seen) : now() };
    }
    const seenOf = (e) => num(e.seen) || e.updatedAt;
    const purgeable = (e) => e.deleted && e.updatedAt < now() - PURGE_MS && seenOf(e) < now() - PURGE_MS;

    // Merge a shared version (another tab's record or the cloud) into the local entry. Content: LWW. Stats: each
    // other device's slot by max (single writer → exact); this device's slot = join(base, incoming) + pending.
    function mergeIn(local, remote) {
      if (!remote) return local;
      if (!local) {
        if (remote.deleted && !remote.seen) return tombstone(remote.id, remote.updatedAt, []);
        return remote;
      }
      const id = local.id;
      const win = entryCmp(local, remote) >= 0 ? local : remote;
      if (win.deleted) {
        slotBase.delete(id);
        return tombstone(id, win.updatedAt, [local.deleted ? local.seen : 0, remote.deleted ? remote.seen : 0]);
      }
      const out = clone(contentOf(win));
      const ca = local.deleted ? 0 : num(local.createdAt), cb = remote.deleted ? 0 : num(remote.createdAt);
      out.createdAt = ca && cb ? Math.min(ca, cb) : (ca || cb || win.updatedAt);
      const lt = local.deleted ? {} : local.tally, rt = remote.deleted ? {} : remote.tally;
      const mine = main.device;
      out.tally = {};
      for (const k of Array.from(new Set(Object.keys(lt).concat(Object.keys(rt)))).sort()) {
        let s;
        if (k === mine && lt[k] && slotBase.has(id)) {
          const base = slotBase.get(id);
          const nb = joinSlot(base, rt[k]);
          s = slotAdd(nb, slotDelta(lt[k], base));
          slotBase.set(id, nb);
        } else s = joinSlot(lt[k], rt[k]);
        if (!slotEmpty(s)) out.tally[k] = s;
      }
      return out;
    }

    /* -------------------------------------------------------------- validation */
    function validateText(text) {
      const KT = kanaText();
      if (KT && typeof KT.validate === 'function') {
        try {
          const v = KT.validate(text);
          if (v && typeof v.normalized === 'string') return { ok: !!v.ok, normalized: v.normalized, bad: Array.isArray(v.bad) ? v.bad : [] };
        } catch (e) { /* fall back */ }
      }
      // Minimal fallback (KanaText missing): KANA_DATA chars + space, or the Unicode kana blocks.
      const s = String(text == null ? '' : text).normalize('NFC').replace(/[\s　]+/g, ' ').trim();
      const D = kanaData();
      const okCh = D && D.kana ? (ch) => ch === ' ' || !!D.kana[ch] || !!(D.extra && D.extra[ch])
        : (ch) => /^[ぁ-ゖァ-ヺー、。 ]$/.test(ch);
      const bad = [];
      for (const ch of s) if (!okCh(ch) && !bad.includes(ch)) bad.push(ch);
      return { ok: s.length > 0 && bad.length === 0, normalized: s, bad };
    }
    function validateKanji(str) {
      const KT = kanaText();
      if (KT && typeof KT.validateKanji === 'function') {
        try {
          const v = KT.validateKanji(str);
          if (v && typeof v.normalized === 'string') return { ok: !!v.ok, normalized: v.normalized, bad: Array.isArray(v.bad) ? v.bad : [], reason: v.reason || null };
        } catch (e) { /* fall back */ }
      }
      const s = String(str == null ? '' : str).normalize('NFC').replace(/\s+/g, '').trim();
      const bad = [];
      let ideo = 0;
      for (const ch of s) {
        if (/[一-鿿㐀-䶿々〆ヶ]/.test(ch)) { if (ch !== 'ヶ') ideo++; continue; }
        if (/[ぁ-ゖァ-ヺー]/.test(ch)) continue;
        if (!bad.includes(ch)) bad.push(ch);
      }
      const reason = !s ? 'empty' : bad.length ? 'bad' : ideo ? null : 'noKanji';
      return { ok: !s || reason === null, normalized: s, bad, reason };
    }

    // The kana field's message for the characters it rejected: kanji → the spec copy, else what kind they are.
    function textBadMessage(bad) {
      const kindOf = (ch) => {
        const f = String(ch).normalize('NFKC');
        if (/[一-鿿㐀-䶿豈-﫿々〆ヶ]|[\u{20000}-\u{3134F}]/u.test(ch)) return 'kanji';
        if (/[A-Za-z]/.test(f)) return 'latin';
        if (/[가-힣ㄱ-ㆎ]/.test(ch)) return 'hangul';
        if (/[0-9]/.test(f)) return 'digit';
        if (/[\p{P}\p{S}]/u.test(ch)) return 'punct';
        return 'other';
      };
      const kinds = Array.from(new Set((bad || []).map(kindOf)));
      if (!kinds.length || kinds.includes('kanji')) return ERR.textBad;
      return ERR.textBadKind[kinds.length === 1 ? kinds[0] : 'mixed'];
    }
    function fail(error, field, message, bad) { return { error, field, message, bad: bad || [] }; }
    // Only strings (and finite numbers) are field values; objects, arrays, booleans … count as empty.
    const fieldStr = (v) => (typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : '');

    // input → { value } (clean fields) or { error }. base = existing entry for update().
    function checkInput(input, base) {
      const src = Object.assign({}, base || {}, isObj(input) ? input : {});
      const tv = validateText(fieldStr(src.text));
      if (!tv.normalized) return fail('text', 'text', ERR.textEmpty);
      if (!tv.ok) return fail('text', 'text', textBadMessage(tv.bad), tv.bad);
      if (Array.from(tv.normalized).length > LIMITS.text) return fail('text', 'text', ERR.textLong);
      let kanji = '';
      const kin = fieldStr(src.kanji);
      if (kin.trim() !== '') {
        const kv = validateKanji(kin);
        if (kv.normalized) {
          if (kv.reason === 'noKanji') return fail('kanji', 'kanji', ERR.kanjiNone);
          if (!kv.ok) return fail('kanji', 'kanji', ERR.kanjiBad, kv.bad);
          if (Array.from(kv.normalized).length > LIMITS.kanji) return fail('kanji', 'kanji', ERR.kanjiLong);
          kanji = kv.normalized;
        }
      }
      const out = { text: tv.normalized, kanji };
      const labels = { meaning: '뜻이', reading: '읽기가', note: '메모가', tag: '태그가' };   // subject + josa
      for (const f of ['meaning', 'reading', 'note', 'tag']) {
        let v = fieldStr(src[f]).normalize('NFC').trim();
        if (f === 'tag' || f === 'reading') v = v.replace(/\s+/g, ' ');
        if (Array.from(v).length > LIMITS[f]) return fail('long', f, ERR.tooLong(labels[f], LIMITS[f]));
        out[f] = v;
      }
      out.type = src.type === 'word' || src.type === 'sentence' ? src.type : autoType(out.text);
      // alts: other readings of the same word (何 なに／なん) — kana only, each validated like the text, ≤ 5.
      // An array (or a string split at / ／ , ，); blanks, duplicates and the text itself are dropped.
      const ain = src.alts;
      const raw = Array.isArray(ain) ? ain.map(fieldStr) : typeof ain === 'string' ? ain.split(/[/／,，;；]/) : [];
      const alts = [];
      for (const a0 of raw) {
        const a = a0.trim();
        if (!a) continue;
        const av = validateText(a);
        if (!av.normalized) continue;
        if (!av.ok) return fail('alts', 'alts', ERR.altBad(a, textBadMessage(av.bad)), av.bad);
        if (Array.from(av.normalized).length > LIMITS.text) return fail('alts', 'alts', ERR.altLong);
        if (av.normalized !== out.text && !alts.includes(av.normalized)) alts.push(av.normalized);
      }
      if (alts.length > LIMITS.alts) return fail('alts', 'alts', ERR.altsMax);
      if (alts.length) out.alts = alts;
      const source = fieldStr(src.source).normalize('NFC').trim().replace(/\s+/g, ' ');
      if (Array.from(source).length > LIMITS.source) return fail('long', 'source', ERR.tooLong('출처가', LIMITS.source));
      if (source) out.source = source;
      return { value: out };
    }

    /* -------------------------------------------------------------- words API */
    function listWords() {
      const out = [];
      for (const e of words.values()) if (!e.deleted) out.push(e);
      out.sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      return out.map(viewOf);
    }
    function liveCount() { let n = 0; for (const e of words.values()) if (!e.deleted) n++; return n; }
    function newWordId() { let id; do { id = randomId('w'); } while (words.has(id)); return id; }
    function touchWord(id) {
      markDirty(['words']);
      scheduleDoc('word', id);
    }
    // About to change this device's slot of e: remember the shared version the change starts from.
    function notePendingSlot(e) {
      if (!slotBase.has(e.id)) slotBase.set(e.id, cleanSlot(e.tally[main.device] || null));
    }

    // cur with the checked content v: optional fields v leaves out (no alts, no source) are removed
    function withContent(cur, v) {
      const next = Object.assign({}, cur, v);
      for (const k of OPTIONAL) if (!(k in v)) delete next[k];
      return next;
    }

    function addWord(input) {
      const c = checkInput(input, null);
      if (c.error !== undefined || !c.value) return c;
      if (liveCount() >= MAX_WORDS) return fail('limit', null, ERR.limit);
      const t = now();
      const e = Object.assign({ id: newWordId() }, c.value, { createdAt: t, updatedAt: t, tally: {} });
      words.set(e.id, e);
      touchWord(e.id);
      return viewOf(e);
    }

    function updateWord(id, patch) {
      const e = words.get(id);
      if (!e || e.deleted) return fail('notfound', null, ERR.notFound);
      const p = isObj(patch) ? patch : {};
      const input = {};
      for (const f of ['text', 'kanji', 'alts', 'meaning', 'reading', 'note', 'tag', 'type', 'source']) if (f in p) input[f] = p[f];
      const base = { text: e.text, kanji: e.kanji, alts: e.alts || [], meaning: e.meaning, reading: e.reading, note: e.note, tag: e.tag, type: 'type' in p ? null : e.type, source: e.source || '' };
      const c = checkInput(input, base);
      if (c.error !== undefined || !c.value) return c;
      const next = withContent(e, c.value);
      if (stable(contentOf(next)) === stable(contentOf(e))) return viewOf(e);
      next.updatedAt = Math.max(now(), e.updatedAt + 1);
      words.set(id, next);
      touchWord(id);
      return viewOf(next);
    }

    function removeWord(id) {
      const e = words.get(id);
      if (!e || e.deleted) return false;
      slotBase.delete(id);
      words.set(id, { id, deleted: true, updatedAt: Math.max(now(), e.updatedAt + 1), seen: now() });
      touchWord(id);
      return true;
    }

    const isGood = (v) => v === true || v === 'o' || v === 'ok' || v === 'correct';
    // Every graded increment pushes exactly one `recent` item (the delta / rebase logic relies on it).
    function recordResult(id, r) {
      const e = words.get(id);
      if (!e || e.deleted) return null;
      const o = isObj(r) ? r : {};
      const mode = ENTRY_MODES.includes(o.mode) ? o.mode : o.mode === 'kanji-meaning' ? 'kanji' : 'read';
      const part = o.mode === 'kanji-meaning' || o.part === 'meaning' ? 'meaning' : 'reading';
      let g = o.mark === 'o' || o.mark === 't' || o.mark === 'x' ? o.mark : isGood(o.mark) ? 'o' : 'x';
      notePendingSlot(e);
      const s = e.tally[main.device] || (e.tally[main.device] = cleanSlot(null));
      if (o.overridden) { g = 'o'; s.overridden++; }
      const cheat = !!o.cheat && !o.overridden && (mode === 'read' || mode === 'write' || (mode === 'kanji' && part === 'reading'));
      if (cheat) s.cheat++;
      const counts = !(cheat && g === 'o');      // a 컨닝 ○ is not a success (as in Quiz)
      const push = (m, gg) => { s.recent.push({ m, g: gg }); if (s.recent.length > RECENT_MAX) s.recent.splice(0, s.recent.length - RECENT_MAX); };
      const okng = (x) => (x === 'o' ? 'ok' : 'ng');
      const ox = (x) => (x === 'o' ? 'o' : 'x');
      if (mode === 'read') { if (counts) { s.read[okng(g)]++; push('read', ox(g)); } }
      else if (mode === 'write') { if (counts) { s.write[g]++; push('write', g); } }
      else if (mode === 'meaning') { s.meaning[okng(g)]++; push('meaning', ox(g)); }
      else if (part === 'meaning') { s.kanji.meaning[okng(g)]++; push('meaning', ox(g)); }
      else {
        if (counts) { s.kanji.reading[g]++; push('kanji', g); }
        if (o.meaning !== undefined && o.meaning !== null) { const mg = isGood(o.meaning) ? 'o' : 'x'; s.kanji.meaning[okng(mg)]++; push('meaning', mg); }
      }
      s.last = Math.max(now(), s.last + 1);
      touchWord(id);
      return viewOf(e);
    }

    // Each word carries its summed `stats` (readable) and its per-device `tally` (so importing it anywhere — even
    // on a device that already synced part of it — joins slot by slot and never counts an answer twice).
    function exportWords() {
      const list = listWords().sort((a, b) => a.createdAt - b.createdAt).map((v) => {
        const t = entryOut(words.get(v.id), false).tally;
        return t ? Object.assign(v, { tally: t }) : v;
      });
      return JSON.stringify({ format: 'kana-practice-words', v: 1, exportedAt: new Date(now()).toISOString(), words: list }, null, 2);
    }

    function importWords(text) {
      const res = { added: 0, updated: 0, skipped: 0, errors: [] };
      let data;
      try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) {
        res.errors.push({ index: -1, message: 'JSON 형식이 아니에요. 내보내기로 만든 내용을 그대로 붙여 넣어 주세요.' });
        return res;
      }
      const list = Array.isArray(data) ? data : isObj(data) ? (Array.isArray(data.words) ? data.words : Array.isArray(data.entries) ? data.entries : null) : null;
      if (!list) {
        res.errors.push({ index: -1, message: '단어 목록을 찾지 못했어요.' });
        return res;
      }
      const dev = main.device;
      const keyOf = (t, k) => t + '\u0000' + (k || '');
      const byContent = new Map();
      for (const e of words.values()) if (!e.deleted) byContent.set(keyOf(e.text, e.kanji), e.id);
      list.forEach((item, index) => {
        if (!isObj(item)) { res.errors.push({ index, message: '항목 형식이 올바르지 않아요.' }); return; }
        const c = checkInput(item, null);
        if (c.error !== undefined || !c.value) { res.errors.push({ index, text: fieldStr(item.text), message: c.message }); return; }
        const v = c.value;
        const tally = isObj(item.tally) ? cleanTally(item.tally) : null;   // per-device slots (our own exports)
        const stats = cleanSlot(item.stats);          // the exporting learner's totals (hand-made / older files)
        const at = Math.min(num(item.updatedAt), now());
        let targetId = typeof item.id === 'string' && words.has(item.id) && !words.get(item.id).deleted ? item.id : null;
        if (!targetId) targetId = byContent.get(keyOf(v.text, v.kanji)) || null;
        if (targetId) {
          const cur = words.get(targetId);
          const next = Object.assign({}, cur, { tally: Object.assign({}, cur.tally) });
          const newerContent = at > cur.updatedAt && stable(contentOf(withContent(cur, v))) !== stable(contentOf(cur));
          if (newerContent) {
            Object.assign(next, v, { updatedAt: Math.max(now(), cur.updatedAt + 1) });
            for (const k of OPTIONAL) if (!(k in v)) delete next[k];
          }
          if (tally) {                                // slot-wise join: exact and idempotent
            for (const k of Object.keys(tally)) {
              if (k === dev) notePendingSlot(cur);
              next.tally[k] = joinSlot(cur.tally[k] || null, tally[k]);
            }
          } else {
            // only totals: stats never decrease and a re-import never counts twice — this device's slot is raised
            // by whatever the file has beyond the current total.
            const extra = slotDelta(stats, sumSlots(cur.tally));
            if (!slotEmpty(extra)) {
              notePendingSlot(cur);
              next.tally[dev] = slotAdd(cur.tally[dev] || null, extra);
            }
          }
          if (stable(entryOut(next, true)) === stable(entryOut(cur, true))) { res.skipped++; return; }
          words.set(targetId, next);
          touchWord(targetId);
          res.updated++;
          return;
        }
        if (liveCount() >= MAX_WORDS) { res.errors.push({ index, text: v.text, message: ERR.limit }); return; }
        const id = typeof item.id === 'string' && ID_RE.test(item.id) && !words.has(item.id) ? item.id : newWordId();
        const t = now();
        const created = Math.min(num(item.createdAt) || t, t);
        const e = Object.assign({ id }, v, { createdAt: created, updatedAt: t, tally: {} });
        if (tally) { e.tally = tally; if (tally[dev]) slotBase.set(id, cleanSlot(null)); }
        else if (!slotEmpty(stats)) { slotBase.set(id, cleanSlot(null)); e.tally[dev] = stats; }
        words.set(id, e);
        byContent.set(keyOf(v.text, v.kanji), id);
        touchWord(id);
        res.added++;
      });
      return res;
    }

    /* -------------------------------------------------------------- state API */
    function init(opts) {
      teardown();
      const key = isObj(opts) && typeof opts.key === 'string' && opts.key ? opts.key : 'kana-practice-v1';
      K = { main: key, words: key + ':words', meta: key + ':sync', stash: key + ':stash' };
      for (const k of Object.keys(lastStored)) delete lastStored[k];
      L = openLocal(key);
      probe(key);
      main = loadMain(readJSON(K.main));
      meta = loadMeta(readJSON(K.meta));
      own = main.stats;
      ownBase = cleanStats(own);
      deviceFresh = false;
      ephemeral = false;
      // The id lives in the main record; the copy in :sync survives an old app.js tab rewriting the main record.
      if (!main.device && meta.device) { main.device = meta.device; dirty.main = true; }
      if (!main.device) {
        if (!L.ls) main.device = 'nolocal';           // nothing persists: share one stats doc / slot
        else {
          main.device = randomId('d');
          deviceFresh = true;
          if (!writeKey(K.main, mainRecord())) {
            if (hasHistory(own)) ephemeral = true;     // can't persist the id: uploading would count history twice later
            else { main.device = 'nolocal'; deviceFresh = false; }
          }
        }
      }
      if (main.device !== 'nolocal' && meta.device !== main.device) { meta.device = main.device; dirty.meta = true; }
      words.clear();
      synced.clear();
      slotBase.clear();
      const w = parseWords(readJSON(K.words), main.device);
      for (const e of w.entries) words.set(e.id, mergeIn(words.get(e.id), e));
      for (const id of w.synced) if (words.has(id)) synced.add(id);
      if (!meta.uid) {
        // never synced: tombstones only matter locally — purge the old ones
        for (const [id, e] of Array.from(words.entries())) if (purgeable(e)) { words.delete(id); dirty.words = true; }
      }
      lastAppSettings = stable(main.settings);
      lastStatsJSON = stable(own);
      lastPrefsJSON = stable(main.prefs);
      if (dirty.main || dirty.words || dirty.meta) markDirty([]);
      attachEvents();
      return { settings: clone(main.settings), stats: own, prefs: clone(main.prefs), words: listWords() };
    }

    function ensureInit() { if (!main) init({}); }

    function saveState(snap) {
      ensureInit();
      const s = isObj(snap) ? snap : {};
      if (isObj(s.settings)) {
        // A local edit = differs from what the app passed last time AND from the store's current settings.
        // (Remote settings adopted meanwhile don't touch lastAppSettings, so an app that has not adopted
        // change.settings yet and re-saves its unchanged object does not overwrite them.)
        const j = stable(s.settings);
        if (j !== lastAppSettings) {
          lastAppSettings = j;
          if (j !== stable(main.settings)) {
            main.settings = clone(s.settings);
            main.settingsAt = Math.max(now(), main.settingsAt + 1);
            markDirty(['main']);
            scheduleDoc('settings');
          }
        }
      }
      if (isObj(s.stats) && !(sums && sums.has(s.stats))) {
        if (s.stats !== own) {
          const reset = !hasHistory(s.stats) && (hasHistory(own) || hasHistory(ownBase));
          if (reset) {                                    // device-level reset → new epoch
            main.since = Math.max(now(), main.since + 1);
            ownBase = emptyStats();
          }
          own = s.stats;
          main.stats = own;
          if (!reset) {
            // Another object (e.g. a copy the app kept instead of adopting deviceStats): its answers count on top
            // of the shared version, but what it lacks never regresses this device (or its cloud doc).
            const healed = statsAdd(ownBase, statsDelta(own, ownBase));
            if (stable(healed) !== stable(cleanStats(own))) { replaceOwn(healed); lastStatsJSON = ''; note({ deviceStats: true }); }
          }
        }
        const j = stable(own);
        if (j !== lastStatsJSON) {
          lastStatsJSON = j;
          main.statsAt = Math.max(now(), main.statsAt + 1);
          markDirty(['main']);
          scheduleDoc('stats');
        }
      }
      if (isObj(s.prefs)) {
        const j = stable(s.prefs);
        if (j !== lastPrefsJSON) {
          lastPrefsJSON = j;
          if (j !== stable(main.prefs)) {
            main.prefs = clone(s.prefs);
            main.prefsAt = Math.max(now(), main.prefsAt + 1);
            markDirty(['main']);
          }
        }
      }
    }

    function resetStats() {
      ensureInit();
      const R = Math.max(now(), meta.statsResetAt + 1, main.since + 1);
      applyReset(R, false);
      scheduleDoc('settings');
      return own;
    }

    function allStats() {
      ensureInit();
      const list = [own];
      for (const id of Object.keys(meta.others).sort()) {
        if (id === main.device) continue;
        const o = meta.others[id];
        if (o.since < meta.statsResetAt || !hasHistory(o.stats)) continue;
        list.push(o.stats);
      }
      if (list.length === 1) return own;
      const sum = sumStats(list);
      if (sums) sums.add(sum);
      return sum;
    }

    function status() {
      const localOk = !!(L && L.ls && L.writable && !L.bad.size);
      // uid: the claude.ai account this browser's data is bound to (null before any account connected)
      return { local: localOk ? 'ok' : 'memory', cloud: cloud.state, message: statusMessage(localOk), quota: cloud.quota, unstable: cloud.unstable, uid: (meta && meta.uid) || null };
    }
    function statusMessage(localOk) {
      if (cloud.state === 'on') {
        let m = localOk ? MSG.on : MSG.onMemory;
        if (cloud.quota) m += ' · ' + MSG.quota;
        else if (cloud.unstable) m += ' · ' + MSG.unstable;
        return m;
      }
      if (cloud.state === 'connecting') return MSG.connecting;
      if (cloud.state === 'error') return cloud.reason === 'readOnly' ? MSG.readOnly : cloud.reason === 'lost' ? MSG.lost : localOk ? MSG.stopped : MSG.stoppedMemory;
      if (localOk) return MSG.localOnly;
      return L && L.ls ? MSG.localFull : MSG.memory;
    }

    /* -------------------------------------------------------------- other tabs, page lifecycle */
    function attachEvents() {
      const target = env.events !== undefined ? env.events : (root && typeof root.addEventListener === 'function' ? root : null);
      const doc = env.document !== undefined ? env.document : (root && root.document ? root.document : null);
      const offs = [];
      const on = (t, type, fn) => {
        if (!t || typeof t.addEventListener !== 'function') return;
        try { t.addEventListener(type, fn); offs.push(() => { try { t.removeEventListener(type, fn); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
      };
      const onStorage = (e) => { try { onStorageEvent(e); } catch (err) { warn('storage event', err); } };
      const onHide = () => { try { flush(); } catch (err) { warn('flush', err); } };
      // A page restored from the back/forward cache (or a frozen tab) missed storage events: re-read.
      const onBack = () => { try { resyncLocal(); } catch (err) { warn('resync', err); } };
      const onVis = () => { if (!doc) return; if (doc.visibilityState === 'hidden') onHide(); else if (doc.visibilityState === 'visible') onBack(); };
      on(target, 'storage', onStorage);
      on(target, 'pagehide', onHide);
      on(target, 'pageshow', (e) => { if (e && e.persisted) onBack(); });
      on(doc, 'visibilitychange', onVis);
      detachEvents = () => offs.forEach((f) => f());
    }

    function onStorageEvent(e) {
      if (!e || !K || typeof e.key !== 'string') return;
      if (e.storageArea && L.ls && e.storageArea !== L.ls) return;
      if (e.key !== K.main && e.key !== K.words && e.key !== K.meta) return;
      absorbStored(e.key);       // the CURRENT value: an event's newValue can be older than what is stored now
    }
    function resyncLocal() {
      if (!K || !main) return;
      absorbStored(K.main);
      absorbStored(K.meta);
      absorbStored(K.words);
    }

    /* -------------------------------------------------------------- cloud: writes */
    function docRef(kind, id) {
      const r = cloud.refs;
      if (kind === 'settings') return r.settings;
      if (kind === 'stats') return r.statsCol.doc(id);
      return r.wordsCol.doc(id);
    }
    const settingsCmp = (doc) => stable({ s: cleanSettings(doc.settings), r: num(doc.statsResetAt) });
    const statsCmp = (doc) => stable({ since: num(doc.since), stats: cleanStats(doc.stats) });

    function planDoc(w) {
      if (w.kind === 'settings') {
        if (!(main.settingsAt > 0 || meta.statsResetAt > 0)) return null;
        const body = { settings: Object.assign({}, main.settingsBase || {}, main.settings), updatedAt: main.settingsAt, statsResetAt: meta.statsResetAt };
        const cmp = settingsCmp(body);
        if (cmp === known.get('settings')) return null;
        return { op: 'set', key: 'settings', body: clone(body), cmp };
      }
      if (w.kind === 'stats') {
        const k = 'stats:' + main.device;
        if (w.id !== main.device || ephemeral) return null;
        if (!hasHistory(own) && !known.has(k)) return null;   // never create an empty device doc
        const body = { device: main.device, since: main.since, updatedAt: main.statsAt, stats: cleanStats(own) };
        const cmp = statsCmp(body);
        if (cmp === known.get(k)) return null;
        const json = JSON.stringify(body);
        if (utf8Len(json) > MAX_DOC_BYTES) return null;
        return { op: 'set', key: k, body: JSON.parse(json), cmp };
      }
      const e = words.get(w.id), k = 'word:' + w.id;
      if (!e) return null;
      if (purgeable(e)) return known.has(k) ? { op: 'delete', key: k } : null;
      if (e.deleted && !known.has(k) && !synced.has(w.id)) return null;   // the cloud never had it / no longer has it
      const out = entryOut(e, false);
      const cmp = stable(out);
      if (cmp === known.get(k)) return null;
      if (w.blocked && !known.has(k)) return null;                 // quota: creating this doc failed
      if (utf8Len(cmp) > MAX_DOC_BYTES) return null;
      return { op: 'set', key: k, body: clone(out), cmp };
    }

    // mode: null = own change (debounced), 'backup' = learned from another tab (that tab writes it; we only make
    // sure it gets written), or a number = explicit delay (retries / purge).
    function scheduleDoc(kind, id, mode) {
      if (!cloud.active || !main) return;
      const docId = kind === 'stats' ? main.device : kind === 'settings' ? '' : id;
      const wk = kind + ':' + docId;
      let w = writers.get(wk);
      if (!w) writers.set(wk, w = { kind, id: docId, timer: null, first: 0, due: 0, inFlight: false, again: false, lastStart: -Infinity, failures: 0, blocked: false, promise: null });
      if (w.inFlight) { w.again = true; return; }
      if (mode === 'backup' && w.timer) return;      // never postpone a write already planned
      const t = now();
      const d = typeof mode === 'number' ? mode : mode === 'backup' ? DOC_DELAY[kind] * BACKUP_FACTOR + Math.floor(rand() * DOC_DELAY[kind]) : DOC_DELAY[kind];
      if (!w.timer) w.first = t;
      let due = Math.min(t + d, w.first + Math.max(d, DOC_DELAY[kind] * MAX_WAIT));
      due = Math.max(due, w.lastStart + MIN_GAP, cloud.pauseUntil);
      if (w.timer) clearT(w.timer);
      w.due = due;
      const gen = cloud.gen;
      w.timer = setT(() => { w.timer = null; if (gen === cloud.gen) w.promise = fireDoc(w, gen); }, Math.max(0, due - t));
    }

    function acquireSlot(S) {
      if (S.used < MAX_CONCURRENT) { S.used++; return Promise.resolve(); }
      return new Promise((r) => S.queue.push(r));
    }
    function releaseSlot(S) {
      const next = S.queue.shift();
      if (next) next(); else S.used = Math.max(0, S.used - 1);
    }

    // Before a cloud write: a freshly generated device id must be the one localStorage holds (two tabs started
    // together), and this tab's pending answers are published locally first, so that what the cloud gets is a
    // version every tab of this device can rebase on.
    function prepareWrite(w) {
      if (deviceFresh && L.ls) {
        absorbStored(K.main);
        if (deviceFresh) deviceFresh = false;   // storage still holds our id (or we just adopted the stored one)
      }
      if ((w.kind === 'stats' && ownPending()) || (w.kind === 'word' && slotBase.has(w.id))) saveLocalNow();
    }

    async function fireDoc(w, gen) {
      if (!cloud.active || gen !== cloud.gen) return;
      if (w.inFlight) { w.again = true; return; }
      if (!planDoc(w)) return;
      w.inFlight = true;
      const S = slots;
      await acquireSlot(S);
      try {
        if (!cloud.active || gen !== cloud.gen) return;
        if (now() < cloud.pauseUntil) { w.again = true; return; }   // paused: rescheduled after the pause
        prepareWrite(w);
        const plan = planDoc(w);              // state may have moved while waiting for a slot
        if (!plan) return;
        // What we write becomes this device's shared version (its echo must not count our answers twice).
        if (w.kind === 'stats') commitOwn();
        else if (w.kind === 'word') slotBase.delete(w.id);
        const ref = docRef(w.kind, w.id);
        await withRetry(() => {
          w.lastStart = now();
          return plan.op === 'delete' ? ref.delete() : ref.set(plan.body);
        }, gen);
        if (gen !== cloud.gen) return;
        writeOk(w, plan);
      } catch (e) {
        if (gen === cloud.gen) writeFailed(w, e);
      } finally {
        releaseSlot(S);
        w.inFlight = false;
        if (w.again && cloud.active && gen === cloud.gen) { w.again = false; scheduleDoc(w.kind, w.id); }
        else w.again = false;
      }
    }

    async function withRetry(op, gen) {
      try { return await op(); } catch (e) {
        const code = codeOf(e);
        if (code !== 'unavailable' && KNOWN_CODES.includes(code)) throw e;
        await sleep(200 + Math.floor(rand() * 1000));
        if (gen !== cloud.gen) throw e;        // sync stopped / account switched meanwhile: don't write
        return op();
      }
    }

    function writeOk(w, plan) {
      w.failures = 0;
      cloud.strikes = 0;
      if (plan.op === 'delete') {
        known.delete(plan.key);
        seenDocs.delete(plan.key);
        if (words.has(w.id) && words.get(w.id).deleted) { words.delete(w.id); synced.delete(w.id); markDirty(['words']); }
      } else {
        known.set(plan.key, plan.cmp);
        if (w.kind === 'word' && !synced.has(w.id)) { synced.add(w.id); markDirty(['words']); }
      }
      if (cloud.unstable) { cloud.unstable = false; noteStatus(); }
    }

    function writeFailed(w, e) {
      const code = codeOf(e);
      if (TERMINAL.includes(code)) return stopCloud('error', 'stopped');
      if (code === 'invalid_argument' || code === 'transform_error') return stopCloud('error', 'readOnly');
      if (code === 'quota_exceeded') {
        w.blocked = true;
        if (!cloud.quota) { cloud.quota = true; noteStatus(); }
        return;
      }
      // resource_exhausted / unavailable (after its retry) / unknown: pause ALL writes, exponentially, so a
      // thousand pending docs back off together instead of each hammering on its own; this doc follows after.
      cloud.strikes = Math.min(cloud.strikes + 1, 8);
      const base = code === 'resource_exhausted' ? 5000 : 3000;
      cloud.pauseUntil = Math.max(cloud.pauseUntil, now() + Math.min(120000, base * Math.pow(2, cloud.strikes - 1)) + Math.floor(rand() * 2000));
      if (code !== 'resource_exhausted' && !cloud.unstable) { cloud.unstable = true; noteStatus(); }
      w.failures++;
      scheduleDoc(w.kind, w.id, 0);
    }

    /* -------------------------------------------------------------- cloud: connection */
    function setCloud(state, reason) {
      if (cloud.state === state && cloud.reason === (reason || null)) return;
      cloud.state = state;
      cloud.reason = reason || null;
      noteStatus();
    }

    function stopCloud(state, reason) {
      cloud.gen++;
      cloud.active = false;
      for (const k of Object.keys(cloud.unsubs)) { try { cloud.unsubs[k](); } catch (e) { /* ignore */ } }
      cloud.unsubs = {};
      for (const w of writers.values()) if (w.timer) { clearT(w.timer); w.timer = null; }
      writers.clear();
      const dead = slots;
      slots = { used: 0, queue: [] };
      dead.queue.splice(0).forEach((r) => r());
      if (cloud.purgeTimer) { clearT(cloud.purgeTimer); cloud.purgeTimer = null; }
      if (cloud.firstDone) { const f = cloud.firstDone; cloud.firstDone = null; f(); }
      setCloud(state, reason);
    }

    function withTimeout(p, ms) {
      return new Promise((resolve, reject) => {
        const t = setT(() => reject({ code: 'timeout' }), ms);
        Promise.resolve(p).then((v) => { clearT(t); resolve(v); }, (e) => { clearT(t); reject(e); });
      });
    }

    function connectCloud() {
      try {
        ensureInit();
        if (cloud.promise && (cloud.connecting || cloud.active)) return cloud.promise;
        cloud.connecting = true;
        const p = doConnect().catch((e) => { warn('connect', e); }).then(() => { if (cloud.promise === p) cloud.connecting = false; });
        cloud.promise = p;
        return p;
      } catch (e) {
        warn('connectCloud', e);
        return Promise.resolve();
      }
    }

    async function doConnect() {
      if (cloud.active) stopCloud('off');
      const gen = ++cloud.gen;
      let claude = null;
      try { claude = typeof env.claude === 'function' ? env.claude() : env.claude !== undefined ? env.claude : (root ? root.claude : null); } catch (e) { claude = null; }
      if (!claude || typeof claude.use !== 'function') { setCloud('off'); return; }
      // status stays 'off' (local message) until the host actually offers db + user: a host that never answers
      // (use() resolves null after 10 s) or a page without sync shows no "connecting…" at all.
      let db = null, user = null, uid = null;
      try {
        const both = await withTimeout(Promise.all([claude.use('db'), claude.use('user')]), USE_TIMEOUT);
        db = both[0]; user = both[1];
      } catch (e) { db = null; }
      if (gen !== cloud.gen) return;
      if (!db || typeof db.doc !== 'function' || !user || typeof user.id !== 'function') { setCloud('off'); return; }
      setCloud('connecting');
      try { uid = await withTimeout(user.id(), USE_TIMEOUT); } catch (e) { uid = null; }
      if (gen !== cloud.gen) return;
      if (!validSeg(uid)) { setCloud('off'); return; }
      let refs;
      try {
        // data/users/<uid>/settings (4 segments: doc) · …/profile (doc) /stats|words (5: collections) /<id> (6: docs)
        const profile = db.doc('data/users/' + uid + '/profile');
        refs = { settings: db.doc('data/users/' + uid + '/settings'), statsCol: profile.collection('stats'), wordsCol: profile.collection('words') };
      } catch (e) { setCloud('off'); return; }
      bindAccount(uid);
      Object.assign(cloud, { active: true, uid, refs, unsubs: {}, resubs: {}, first: {}, reconciled: {}, quota: false, unstable: false, purged: 0, pauseUntil: 0, strikes: 0 });
      known.clear();
      seenDocs.clear();
      writers.clear();
      slots = { used: 0, queue: [] };
      const firstDone = new Promise((r) => { cloud.firstDone = r; });
      subscribe('settings', gen);
      subscribe('stats', gen);
      subscribe('words', gen);
      const t = setT(() => { if (cloud.firstDone) { const f = cloud.firstDone; cloud.firstDone = null; f(); } }, CONNECT_TIMEOUT);
      await firstDone;
      clearT(t);
    }

    function subscribe(name, gen) {
      if (!cloud.active || gen !== cloud.gen) return;
      const ref = name === 'settings' ? cloud.refs.settings : name === 'stats' ? cloud.refs.statsCol : cloud.refs.wordsCol;
      const handler = name === 'settings' ? onSettingsSnap : name === 'stats' ? onStatsSnap : onWordsSnap;
      const startedAt = now();
      try {
        cloud.unsubs[name] = ref.onSnapshot((snap) => {
          if (gen !== cloud.gen || !cloud.active) return;
          try { handler(snap); } catch (e) { warn('snapshot ' + name, e); }
          if (!cloud.first[name]) {
            cloud.first[name] = true;
            if (cloud.first.settings && cloud.first.stats && cloud.first.words) {
              setCloud('on');
              if (cloud.firstDone) { const f = cloud.firstDone; cloud.firstDone = null; f(); }
            }
          }
        }, (err) => subscriptionFailed(name, err, gen, startedAt));
      } catch (e) { subscriptionFailed(name, e, gen, startedAt); }
    }

    function subscriptionFailed(name, err, gen, startedAt) {
      if (gen !== cloud.gen || !cloud.active) return;
      delete cloud.unsubs[name];
      const code = codeOf(err);
      if (TERMINAL.includes(code)) return stopCloud('error', 'stopped');
      if (code === 'invalid_argument' || code === 'transform_error') return stopCloud('error', 'stopped');
      // the retry budget recovers only after a listener stayed healthy for a while (no endless flapping)
      if (now() - startedAt >= RESUB_HEALTHY) cloud.resubs[name] = 0;
      const n = (cloud.resubs[name] || 0) + 1;
      cloud.resubs[name] = n;
      if (n > 3) return stopCloud('error', 'lost');
      const base = code === 'resource_exhausted' ? 10000 : 600;
      setT(() => subscribe(name, gen), base * n + Math.floor(rand() * 1000));
    }

    function bindAccount(uid) {
      if (meta.uid && meta.uid !== uid) switchAccount(meta.uid, uid);
      if (meta.uid !== uid) { meta.uid = uid; markDirty(['main', 'words', 'meta']); }   // tag every record
    }

    // Another claude.ai account on this browser: stash the previous account's local data, restore this one's.
    function switchAccount(oldUid, newUid) {
      saveLocalNow();
      let stash = readJSON(K.stash);
      if (!isObj(stash)) stash = {};
      stash[oldUid] = { at: now(), main: JSON.parse(stable(mainRecord())), words: JSON.parse(stable(wordsRecord())), meta: JSON.parse(stable(metaRecord())) };
      const back = isObj(stash[newUid]) ? stash[newUid] : null;
      delete stash[newUid];
      const ids = Object.keys(stash).sort((a, b) => num(stash[b] && stash[b].at) - num(stash[a] && stash[a].at));
      for (const id of ids.slice(STASH_MAX)) delete stash[id];
      writeKey(K.stash, stash);
      const device = main.device, prefs = main.prefs, prefsAt = main.prefsAt;
      const m = loadMain(back && back.main);
      replaceOwn(m.stats);
      ownBase = cleanStats(own);
      main = Object.assign(m, { stats: own, device, prefs, prefsAt });
      meta = loadMeta(back && back.meta);
      meta.uid = newUid;
      words.clear();
      synced.clear();
      slotBase.clear();
      const w = parseWords(back && back.words, device);
      for (const e of w.entries) words.set(e.id, mergeIn(words.get(e.id), e));
      for (const id of w.synced) if (words.has(id)) synced.add(id);
      // what storage holds now is the previous account's (stashed above): never absorb it into this one
      for (const k of [K.main, K.words, K.meta]) lastStored[k] = lget(k);
      markDirty(['main', 'words', 'meta']);
      note({ settings: true, deviceStats: true, stats: true, words: true, account: true });
    }

    const isDefinitive = (snap) => !(snap && snap.metadata && snap.metadata.fromCache);
    // A snapshot that includes this page's own unconfirmed write is not proof of what the cloud holds.
    const isPendingWrite = (d, snap) => !!((d && d.metadata && d.metadata.hasPendingWrites) || (!d.metadata && snap && snap.metadata && snap.metadata.hasPendingWrites));

    function onSettingsSnap(snap) {
      const definitive = isDefinitive(snap);
      if (!snap || snap.exists === false || typeof snap.data !== 'function') {
        if (definitive) {
          known.delete('settings');
          seenDocs.delete('settings');
          scheduleDoc('settings');
        }
        return;
      }
      if (seenDocs.get('settings') === snap) return;
      seenDocs.set('settings', snap);
      const raw = snap.data();
      const doc = { settings: isObj(raw && raw.settings) ? raw.settings : {}, updatedAt: num(raw && raw.updatedAt), statsResetAt: num(raw && raw.statsResetAt) };
      if (!isPendingWrite(snap, null)) known.set('settings', settingsCmp(doc));
      if (doc.statsResetAt > meta.statsResetAt) applyReset(doc.statsResetAt, true);
      const remoteClean = cleanSettings(doc.settings);
      const rj = stable(remoteClean), lj = stable(main.settings);
      if (rj !== lj && (doc.updatedAt > main.settingsAt || (doc.updatedAt === main.settingsAt && rj > lj))) {
        main.settingsBase = clone(doc.settings);
        main.settings = remoteClean;
        main.settingsAt = doc.updatedAt;
        markDirty(['main']);
        note({ settings: true });
      } else if (rj === lj && doc.updatedAt > main.settingsAt) {
        main.settingsAt = doc.updatedAt;
        markDirty(['main']);
      }
      scheduleDoc('settings');   // planDoc decides: only when local holds something the cloud lacks
    }

    function onStatsSnap(snap) {
      const definitive = isDefinitive(snap);
      const docs = (snap && snap.docs) || [];
      const complete = definitive && (typeof snap.size === 'number' ? snap.size : docs.length) < SNAPSHOT_CAP;
      const present = new Set();
      let othersChanged = false;
      for (const d of docs) {
        if (!d || d.exists === false || typeof d.data !== 'function' || !ID_RE.test(d.id)) continue;
        present.add(d.id);
        const k = 'stats:' + d.id;
        if (seenDocs.get(k) === d) continue;
        seenDocs.set(k, d);
        const raw = d.data();
        const doc = { since: num(raw && raw.since), updatedAt: num(raw && raw.updatedAt), stats: cleanStats(raw && raw.stats) };
        const cmp = statsCmp(doc);
        if (known.get(k) === cmp) continue;
        if (!isPendingWrite(d, snap)) known.set(k, cmp);
        if (d.id === main.device) {
          if (!ephemeral && !rebaseOwn(doc, false)) scheduleDoc('stats');   // older epoch / less in the cloud → ours
        } else {
          meta.others[d.id] = doc;
          othersChanged = true;
        }
      }
      if (complete) {
        for (const id of Object.keys(meta.others)) if (!present.has(id)) { delete meta.others[id]; othersChanged = true; }
        for (const k of Array.from(known.keys())) {
          if (k.startsWith('stats:') && !present.has(k.slice(6))) { known.delete(k); seenDocs.delete(k); }
        }
        if (!present.has(main.device)) scheduleDoc('stats');   // first connect: upload this device's history
        cloud.reconciled.stats = true;
      }
      if (othersChanged) { markDirty(['meta']); note({ stats: true }); }
    }

    function onWordsSnap(snap) {
      const definitive = isDefinitive(snap);
      const docs = (snap && snap.docs) || [];
      const size = typeof snap.size === 'number' ? snap.size : docs.length;
      const complete = definitive && size < SNAPSHOT_CAP;      // a result that may be capped proves no absence
      const present = new Set();
      let changed = false, localDirty = false;
      for (const d of docs) {
        if (!d || d.exists === false || typeof d.data !== 'function' || !ID_RE.test(d.id)) continue;
        present.add(d.id);
        const k = 'word:' + d.id;
        if (seenDocs.get(k) === d) continue;
        seenDocs.set(k, d);
        const remote = cleanEntry(d.data(), d.id, 'legacy');
        if (!remote) continue;
        const rcmp = stable(entryOut(remote, false));
        if (!isPendingWrite(d, snap)) known.set(k, rcmp);
        if (!synced.has(d.id)) { synced.add(d.id); localDirty = true; }
        const local = words.get(d.id);
        const merged = mergeIn(local, remote);
        if (!local || stable(entryOut(local, true)) !== stable(entryOut(merged, true))) {
          words.set(d.id, merged);
          localDirty = true;
          if (!(merged.deleted && (!local || local.deleted))) changed = true;
        }
        if (stable(entryOut(merged, false)) !== rcmp) scheduleDoc('word', d.id);
      }
      if (definitive) {
        const cut = now() - PURGE_MS;
        const emptyCloud = present.size === 0 && size === 0;
        for (const [id, e] of Array.from(words.entries())) {
          if (present.has(id)) continue;
          if (!complete) {                                              // can't tell absent from not delivered
            if (!e.deleted && !synced.has(id)) scheduleDoc('word', id);
            continue;
          }
          const k = 'word:' + id;
          known.delete(k);
          seenDocs.delete(k);
          if (e.deleted) {                                              // the cloud doesn't need this tombstone
            if (synced.delete(id)) localDirty = true;
            if (purgeable(e)) { words.delete(id); localDirty = true; }   // kept a while: it stops stale copies (other tabs)
          } else if (!synced.has(id) || emptyCloud || e.updatedAt >= cut) {   // local-only, a wiped cloud, or edited recently → upload
            if (synced.delete(id)) localDirty = true;
            scheduleDoc('word', id);
          } else {                                                      // deleted elsewhere, tombstone purged:
            // a local tombstone of the same version (tombstones win ties), so a stale live copy another tab still
            // publishes can't come back through this tab; only a newer edit would.
            words.set(id, tombstone(id, e.updatedAt, []));
            synced.delete(id); slotBase.delete(id); localDirty = true; changed = true;
          }
        }
        if (!cloud.reconciled.words) {
          cloud.reconciled.words = true;
          const gen = cloud.gen;
          cloud.purgeTimer = setT(() => { cloud.purgeTimer = null; if (gen === cloud.gen) purgeTombstones(); }, 4000 + Math.floor(rand() * 4000));
        }
      }
      if (localDirty) markDirty(['words']);
      if (changed) note({ words: true });
    }

    function purgeTombstones() {
      for (const [id, e] of Array.from(words.entries())) {
        if (!purgeable(e)) continue;
        if (!known.has('word:' + id)) { words.delete(id); synced.delete(id); markDirty(['words']); continue; }
        if (cloud.purged >= PURGE_PER_SESSION) continue;
        cloud.purged++;
        scheduleDoc('word', id, 0);
      }
    }

    function teardown() {
      stopCloud('off');                         // also invalidates a connectCloud() still waiting for use()
      cloud.promise = null;
      cloud.connecting = false;
      if (localTimer) { saveLocalNow(); }
      if (detachEvents) { detachEvents(); detachEvents = null; }
    }

    function flush() {
      try {
        if (!main) return Promise.resolve();
        saveLocalNow();
        const waits = [];
        for (const w of writers.values()) {
          if (w.timer) {
            const wait = Math.max(w.lastStart + MIN_GAP, cloud.pauseUntil) - now();
            clearT(w.timer);
            const gen = cloud.gen;
            if (wait <= 0) {
              w.timer = null;
              w.promise = fireDoc(w, gen);
            } else {                                   // written < 1.5 s ago / paused: as soon as allowed
              w.timer = setT(() => { w.timer = null; if (gen === cloud.gen) w.promise = fireDoc(w, gen); }, wait);
            }
          }
          if (w.promise) waits.push(w.promise);
        }
        return Promise.all(waits).then(() => undefined, () => undefined);
      } catch (e) {
        warn('flush', e);
        return Promise.resolve();
      }
    }

    function onChange(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.push(fn);
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    }

    /* -------------------------------------------------------------- public surface (never throws) */
    function guard(name, fn, fallback) {
      return function () {
        try { return fn.apply(null, arguments); } catch (e) {
          warn(name, e);
          return typeof fallback === 'function' ? fallback() : fallback;
        }
      };
    }
    const errResult = () => fail('internal', null, '저장하지 못했어요. 잠시 후 다시 해 주세요.');

    const api = {
      init: guard('init', init, () => ({ settings: cleanSettings(null), stats: own || emptyStats(), prefs: {}, words: [] })),
      saveState: guard('saveState', saveState, undefined),
      connectCloud,
      status: guard('status', () => { ensureInit(); return status(); }, () => ({ local: 'memory', cloud: 'off', message: MSG.memory, quota: false, unstable: false, uid: null })),
      onChange: guard('onChange', onChange, () => () => {}),
      allStats: guard('allStats', allStats, () => own || emptyStats()),
      resetStats: guard('resetStats', resetStats, () => own || emptyStats()),
      flush,
      deviceId: guard('deviceId', () => { ensureInit(); return main.device; }, null),
      words: {
        list: guard('words.list', () => { ensureInit(); return listWords(); }, () => []),
        get: guard('words.get', (id) => { ensureInit(); const e = words.get(id); return e && !e.deleted ? viewOf(e) : null; }, null),
        validate: guard('words.validate', (input) => { const c = checkInput(input, null); return c.value ? { ok: true, value: c.value } : Object.assign({ ok: false }, c); }, () => Object.assign({ ok: false }, errResult())),
        add: guard('words.add', (input) => { ensureInit(); return addWord(input); }, errResult),
        update: guard('words.update', (id, patch) => { ensureInit(); return updateWord(id, patch); }, errResult),
        remove: guard('words.remove', (id) => { ensureInit(); return removeWord(id); }, false),
        exportJSON: guard('words.exportJSON', () => { ensureInit(); return exportWords(); }, '{"format":"kana-practice-words","v":1,"words":[]}'),
        importJSON: guard('words.importJSON', (text) => { ensureInit(); return importWords(text); }, () => ({ added: 0, updated: 0, skipped: 0, errors: [{ index: -1, message: '가져오지 못했어요.' }] })),
        recordResult: guard('words.recordResult', (id, r) => { ensureInit(); return recordResult(id, r); }, null),
      },
      PURGE_MS,
      LIMITS: Object.assign({ words: MAX_WORDS }, LIMITS),
    };
    return api;
  }

  const def = createStore({});
  def.create = createStore;
  def._internals = { stable, joinStats, sumStats, statsDelta, statsAdd, joinSlot, slotDelta, slotAdd, sumSlots, cleanEntry, entryOut, autoType };
  return def;
});
