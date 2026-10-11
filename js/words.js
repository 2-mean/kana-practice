/* 내 단어장 — the learner's own words & sentences (docs/SPEC-words.md H, I, J, K, L). Classic script, loaded after
 * js/app.js; it plugs into the app ONLY through window.KanaApp (registerScreen 'words' → nav tab 단어장, #words).
 *
 * Uses (globals): KanaApp, KanaStore (words list + per-entry stats), KanaText (validation, readings, answer
 * checks), Quiz (weighted sampling, 무한 모드 scheduling), KanaRecognizer (kana / extra cells, box mode),
 * KanjiJudge (kanji cells; KanjiJudge.load() pulls js/kanji-data.js in on first need), GridPad (원고지 pad),
 * KANA_DATA, KANA_WORD_PRESETS (js/word-presets.js: the learner's word list, one-tap 불러오기 — optional).
 * Styles: css/words.css (tokens of css/app.css only) plus app.css / gridpad.css classes.
 *
 * Views (KanaApp.go('words', { view })): list (default, #words) · edit ({ id? }) · io (가져오기·내보내기) ·
 *   setup (연습 설정) · practice (a running practice, module state S.run) · result (S.lastRun).
 * Practice modes:
 *   read  — 단어 읽기: kana shown → reading typed (romaji / 한글) → KanaText.checkReading, per-segment marks;
 *           optional 뜻도 맞히기 step (직접 입력 + 「맞은 걸로 할게요」 / 4지선다).
 *   write — 쓰기 (한국어 → 일본어, SPEC-words J, L, M): Korean meaning shown, written by hand on an open-length GridPad
 *           (open: true — the run of cells never tells the answer's length; there is always an empty cell after the
 *           last one written, and the learner presses 채점 when done) or typed. The written cells are aligned to every
 *           accepted spelling at once by KanaAlign.grade (js/align.js): hiragana (テスト → てすと), as written, the kanji
 *           form, for every reading in [text, ...alts] (SPEC-words K: 何 なに／なん) — no 답안 형태 / 읽기 선택 to pick. Each
 *           matched cell is judged against its character (kana / extras by KanaRecognizer with { box }, kanji by KanjiJudge;
 *           no stroke data → neutral '–', not graded); missing and extra characters are named (촉음 っ, 장음, 요음 …).
 *           An answer with no gradable cell is '–' (not recorded, not ✕ in the run). When js/kanji-data.js cannot
 *           be loaded and the writing reads as the kanji form, nothing is graded: a notice offers 다시 불러와서 채점 /
 *           지우고 가나로 쓰기.
 *   kanji — 한자 읽기 (SPEC-words I): the kanji form shown → the reading written (open-length pad) or typed → 뜻 step.
 * Hints (user request): a ladder, one step per press of 힌트 — 1 뜻, 2 글자 수 (the cells are tinted too), 3 로마자 발음;
 *   a step already on screen is skipped (쓰기 shows the meaning: 글자 수 → 로마자; 문제 보기 한국어 + 발음 shows the
 *   reading). The answer's length is shown only by 힌트 2. 한자 읽기 after the 뜻 hint skips its 뜻 맞히기 step (not
 *   recorded). A hint tags the answer like 컨닝 does in the kana tests (the run keeps the highest step reached).
 * Recording: per entry KanaStore.words.recordResult (read / write / meaning / kanji reading + meaning parts);
 *   per kana cell KanaApp.recordWriting(ch, mark, { source: 'word' }) (records screen; extras / kanji are not).
 * UI decisions (beyond the spec text):
 *   - 단어 읽기 answered with the same kana (Japanese IME on) is not graded: a nudge asks for romaji / 한글,
 *     as the single-kana reading test does (copying the shown kana proves nothing).
 *   - 쓰기 / 한자 읽기 타자 start in 로마자 → 가나 (remembered); romaji typed with the keyboard mode is converted with
 *     KanaText.romajiToKana when graded. A writing test grades the kana it spells (tokyo → ときょ ≠ とうきょう).
 *   - Per-char writing stats are recorded only for kana matched to a written cell of a graded answer (not when the
 *     writing is another word altogether); 모르겠어요 is the same everywhere: the entry ✕ (its 뜻 part too when there is
 *     one and its 뜻 hint was not seen), no per-char results, the whole answer shown (every accepted reading and form),
 *     다시 써보기 with the model glyphs (the reading as written; 한자 읽기: in hiragana) when written by hand.
 *   - 힌트 numbers are the step's own (쓰기 starts at 「힌트 2: 글자 수」: step 1, the meaning, is the question); on a narrow
 *     act row the button is its icon plus the number.
 *   - A question stopped after its first part was graded (reading done, 뜻 not yet) counts in 결과 with 뜻 '—'.
 *   - Practice sessions are not added to 기록's 최근 테스트 (Quiz's session schema has no words kind); the
 *     per-entry ○/△/✕ in the list and the per-char stats are the record.
 *   - 한자 읽기 타자 starts in 로마자 → 가나: the kana it produced is also graded as the romaji typed (checkTypedReading),
 *     so particle / long-vowel leniency applies (watashi wa → わたし わ is right for わたしは).
 *   - 모르겠어요 in 손글씨 still offers 다시 써보기 (practice only), with the model glyphs (보고 쓰기) on.
 *   - Placeholders / help examples never come from the question's entry (no answer in an empty box).
 *   - Typed vs handwritten answers: a typed answer's kana script is never graded (テスト ← てすと / テスト, アメリカ人 ←
 *     あめりか人); handwriting is graded against the closest accepted spelling (KanaAlign), whose script then counts:
 *     てスと for テスト is graded as てすと with a ✕ cell 'す 자리에 가타카나 ス를 썼어요'. The result names the form it matched.
 *   - 단어 선택 (list): 전체 선택 / 지금 목록 선택 (while a search · 보기 · 태그 filter is on) / 태그로 선택 chips (☐ none ·
 *     ⊟ some '6/21' · ☑ all, aria-pressed false | mixed | true) add to the selection and never replace it; a group already
 *     wholly selected is taken out instead (전체 해제 / 지금 목록 해제 / the chip again). The 태그 <select> only filters
 *     (「태그로 거르기」). 지금 목록 shows only while the filter leaves some words out; 선택 해제 hides while 전체 해제 shows.
 *     The selection is remembered in this browser (prefs 'words-sel', unknown ids dropped on load, words added later
 *     never come back selected); 연습 설정 names the tags it spans. Tags sort with numbers in order (1과 · 2과 · 10과).
 *
 * Node: require('./js/words.js')._pure — the DOM-free logic, tested by tools/test-words.js. */
(function (root, factory) {
  const isNode = typeof module === 'object' && !!module.exports;
  const api = factory(root, isNode);
  if (isNode) module.exports = api;
  else {
    root.Words = api;
    api.start();
  }
})(typeof self !== 'undefined' ? self : this, function (root, isNode) {
  'use strict';

  /* =================================================================== dependencies (looked up lazily) */
  const req = (p) => { if (!isNode) return null; try { return require(p); } catch (e) { return null; } };
  let txN = null, qzN = null, kdN = null, kaN = null;
  const TX = () => root.KanaText || txN || (txN = req('./romaji.js'));
  const QZ = () => root.Quiz || qzN || (qzN = req('./quiz.js'));
  const KD = () => root.KANA_DATA || kdN || (kdN = req('./kana-data.js'));
  const KA = () => root.KanaAlign || kaN || (kaN = req('./align.js'));

  /* =================================================================== pure logic (Words._pure) */

  const NO_TAG = '\u0000none';
  const LIST_PAGE = 100;
  const MODES = ['read', 'write', 'kanji'];
  const COUNTS = [10, 20, 30, 'all', 'endless'];
  const MODE_KEYS = { read: ['read', 'meaning'], write: ['write'], kanji: ['kanji', 'meaning'] };

  // 예시 넣기: 8 words (4 with a kanji form) + 3 sentences, all tagged 예시.
  const EXAMPLES = [
    { text: 'がくせい', kanji: '学生', meaning: '학생' },
    { text: 'みず', kanji: '水', meaning: '물' },
    { text: 'たべる', kanji: '食べる', meaning: '먹다' },
    { text: 'にほん', kanji: '日本', meaning: '일본' },
    { text: 'ねこ', meaning: '고양이' },
    { text: 'ありがとう', meaning: '고마워요, 고맙습니다', note: '정중하게는 ありがとうございます' },
    { text: 'コーヒー', meaning: '커피', note: 'ー는 앞 모음을 길게 늘여요. 한글 읽기 「코히」에는 장음 표시가 없지만 코-히-처럼 길게 읽어요.' },
    { text: 'がっこう', meaning: '학교', note: '작은 っ는 다음 자음을 한 번 더 읽어요 (갓코-)' },
    { text: 'わたしは がくせいです。', kanji: '私は学生です。', meaning: '나는 학생입니다, 저는 학생입니다', type: 'sentence' },
    { text: 'おはよう ございます。', meaning: '안녕하세요 (아침 인사), 좋은 아침입니다', type: 'sentence' },
    { text: 'みずを ください。', kanji: '水をください。', meaning: '물 주세요, 물을 주세요', type: 'sentence' },
  ].map((e) => Object.assign({ tag: '예시' }, e));

  /* Answer forms (SPEC-words L, M) — the accepted spellings of an answer:
   *   hira  — the reading in hiragana (KanaText.toHiragana; テスト → てすと, ー kept)
   *   text  — the kana text as written (テスト stays katakana)
   *   kanji — the kanji form (only when the entry has one; never in 한자 읽기, which asks for the reading)
   * Every form is accepted, typed or written by hand (handwriting: KanaAlign picks the one the cells match); there
   * is no form to choose any more (the old answerForm / readForm prefs are dropped). 문제 보기 (쓰기): 'ko' 한국어만
   * (default; the old 'auto' that showed words' readings reads as 'ko') · 'ko+read' 한국어 + 발음 (the reading up front,
   * the 로마자 hint pre-revealed). */
  const FORMS = ['hira', 'text', 'kanji'];
  const DEFAULT_PREFS = {
    mode: 'read', kinds: 'both', count: 10, focusWrong: false,
    withMeaning: false, meaningMode: 'type', answerInput: 'pen', promptView: 'ko', source: 'auto',
    inputMode: 'ime', inputScript: 'hira',      // the add/edit form's kana input method (remembered)
    typedMode: 'romaji', typedScript: 'hira',   // the typed answer box of 쓰기 / 한자 읽기 (remembered)
    padView: 'auto',                            // the 원고지 view the learner last chose: 모든 칸 'grid' / 한 칸씩 'single'
  };

  function normalizePrefs(raw) {
    const o = Object.assign({}, DEFAULT_PREFS);
    const r = raw && typeof raw === 'object' ? raw : {};
    if (MODES.includes(r.mode)) o.mode = r.mode;
    if (['both', 'word', 'sentence'].includes(r.kinds)) o.kinds = r.kinds;
    if (COUNTS.includes(r.count)) o.count = r.count;
    o.focusWrong = !!r.focusWrong;
    o.withMeaning = !!r.withMeaning;
    if (['type', 'choice'].includes(r.meaningMode)) o.meaningMode = r.meaningMode;
    if (['pen', 'type'].includes(r.answerInput)) o.answerInput = r.answerInput;
    if (['ko', 'ko+read'].includes(r.promptView)) o.promptView = r.promptView;     // 'auto' (before the hint ladder) → 'ko'
    if (['auto', 'selected', 'list'].includes(r.source)) o.source = r.source;
    if (['ime', 'romaji', 'pad'].includes(r.inputMode)) o.inputMode = r.inputMode;
    if (['hira', 'kata'].includes(r.inputScript)) o.inputScript = r.inputScript;
    if (['ime', 'romaji', 'pad'].includes(r.typedMode)) o.typedMode = r.typedMode;
    if (['hira', 'kata'].includes(r.typedScript)) o.typedScript = r.typedScript;
    if (['auto', 'grid', 'single'].includes(r.padView)) o.padView = r.padView;
    return o;
  }

  const n0 = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);

  // Per-entry stats with every counter present (tolerates entries from older / foreign exports).
  function statsOf(e) {
    const s = (e && e.stats) || {};
    const g = (o, k) => n0(o && o[k]);
    const kj = s.kanji || {};
    return {
      read: { ok: g(s.read, 'ok'), ng: g(s.read, 'ng') },
      write: { o: g(s.write, 'o'), t: g(s.write, 't'), x: g(s.write, 'x') },
      kanji: { reading: { o: g(kj.reading, 'o'), t: g(kj.reading, 't'), x: g(kj.reading, 'x') }, meaning: { ok: g(kj.meaning, 'ok'), ng: g(kj.meaning, 'ng') } },
      meaning: { ok: g(s.meaning, 'ok'), ng: g(s.meaning, 'ng') },
      cheat: n0(s.cheat), overridden: n0(s.overridden),
      recent: Array.isArray(s.recent) ? s.recent.filter((r) => r && typeof r === 'object') : [],
      last: n0(s.last),
    };
  }

  // The list row's ○/△/✕ summary over every practice kind.
  function entrySummary(e) {
    const s = statsOf(e);
    const o = s.read.ok + s.write.o + s.kanji.reading.o + s.kanji.meaning.ok + s.meaning.ok;
    const t = s.write.t + s.kanji.reading.t;
    const x = s.read.ng + s.write.x + s.kanji.reading.x + s.kanji.meaning.ng + s.meaning.ng;
    return {
      o, t, x, n: o + t + x, cheat: s.cheat, last: s.last,
      parts: {
        read: { o: s.read.ok, x: s.read.ng },
        write: { o: s.write.o, t: s.write.t, x: s.write.x },
        kanji: { o: s.kanji.reading.o, t: s.kanji.reading.t, x: s.kanji.reading.x },
        meaning: { o: s.meaning.ok + s.kanji.meaning.ok, x: s.meaning.ng + s.kanji.meaning.ng },
      },
    };
  }

  function hasKanji(e) {
    const T = TX();
    return !!(e && e.kanji && T && T.isKanjiForm(e.kanji));
  }

  function meaningsOf(m) {
    const T = TX();
    const s = String(m == null ? '' : m);
    return T ? T.splitMeanings(s) : s.split(/[,/;·]/).map((x) => x.trim()).filter(Boolean);
  }
  function displayMeaning(e) {
    const l = meaningsOf(e && e.meaning);
    return l[0] || String((e && e.meaning) || '').trim();
  }

  function foldSearch(s) {
    let t = String(s == null ? '' : s).normalize('NFKC').toLowerCase();
    const T = TX();
    if (T && T.toHiragana) t = T.toHiragana(t);
    return t.replace(/[\s'’`\-ー・·.,、。()（）\[\]]/g, '');
  }

  const searchCache = new Map();
  function searchText(e) {
    const alts = Array.isArray(e.alts) ? e.alts : [];
    const key = e.id + '|' + (e.updatedAt || 0) + '|' + e.text + '|' + alts.join('/') + '|' + (e.kanji || '') + '|' + (e.meaning || '') + '|' + (e.tag || '');
    const hit = searchCache.get(e.id);
    if (hit && hit.key === key) return hit.v;
    const T = TX();
    const sentence = e.type === 'sentence';
    let romaji = '', hangul = '';
    try {
      romaji = T ? [e.text].concat(alts).map((r) => T.toRomaji(r, { sentence })).join('|') : '';
      hangul = T ? [e.text].concat(alts).map((r) => T.toHangul(r, { sentence })).join('|') : '';
    } catch (err) { /* ignore */ }
    const v = foldSearch([e.text].concat(alts, [e.kanji, e.meaning, e.reading, e.note, e.tag, romaji, hangul]).filter(Boolean).join('|'));
    searchCache.set(e.id, { key, v });
    return v;
  }

  /* f = { query, kind: 'all'|'word'|'sentence'|'kanji', tag: '' | tag | NO_TAG } */
  function filterEntries(list, f, keyFn) {
    const o = f || {};
    const q = foldSearch(o.query || '');
    const key = keyFn || searchText;
    return (list || []).filter((e) => {
      if (!e || e.deleted) return false;
      if (o.kind === 'word' && e.type !== 'word') return false;
      if (o.kind === 'sentence' && e.type !== 'sentence') return false;
      if (o.kind === 'kanji' && !hasKanji(e)) return false;
      if (o.tag === NO_TAG && e.tag) return false;
      if (o.tag && o.tag !== NO_TAG && (e.tag || '') !== o.tag) return false;
      if (q && key(e).indexOf(q) < 0) return false;
      return true;
    });
  }

  function tagsOf(list) {
    const m = new Map();
    let none = 0;
    for (const e of list || []) {
      if (!e) continue;
      if (e.tag) m.set(e.tag, (m.get(e.tag) || 0) + 1); else none++;
    }
    // numbers in their own order: 1과 · 2과 · … · 10과 (not 10과 before 2과)
    const tags = Array.from(m, ([tag, n]) => ({ tag, n })).sort((a, b) => a.tag.localeCompare(b.tag, 'ko', { numeric: true }));
    return { tags, none };
  }

  // Question mark from its parts: reading ○/△/✕ (+ meaning true/false/null when there was a 뜻 step).
  function overallMark(reading, meaning) {
    const r = reading === 'o' || reading === 't' ? reading : 'x';
    if (meaning === false) return 'x';
    return r;
  }

  /* A finished question's { reading, mark } for the run (tally, 결과, retries, 무한 모드). An answer with no gradable
   * cell (neutral: every cell '–') is '-' in both: not recorded on the entry, so not ✕ in the run either.
   * partial = stopped after the first part (the 뜻 step not answered): the mark is the reading's. */
  function answerMarks(readingMark, neutral, meaningOk, partial) {
    if (neutral) return { reading: '-', mark: '-' };
    const reading = readingMark || 'x';
    return { reading, mark: partial ? reading : overallMark(reading, meaningOk == null ? null : meaningOk) };
  }

  /* Headline of the pen result panel. o = { skipped, practice, g ('o'|'t'|'x'|null), kanjiMode, missing, wrong, extra,
   * swapped, different, mixed } — KanaAlign counts: characters missing, matched cells ✕ (swapped pairs among them), cells
   * not needed; different = another word altogether; mixed = kanji and kana of the two forms mixed (or, 한자 읽기, the kanji
   * copied). After 모르겠어요 the skip headline shows until a 다시 써보기 is graded. */
  function penHeadline(o) {
    const p = o || {};
    if (p.skipped && !p.practice) return '모르겠어요 — 정답을 보고 따라 써 보세요';
    if (!p.g) return '채점할 수 있는 칸이 없어요';
    if (p.g === 'o') return p.kanjiMode ? '읽기를 바르게 썼어요' : '모두 바르게 썼어요';
    if (p.g === 't') return '모양은 맞았어요 — 획순·방향·획수를 확인할 칸이 있어요';
    if (p.different) return '정답과 많이 달라요';
    if (p.mixed) return p.kanjiMode ? '한자가 아니라 읽기를 가나로 써요' : '한자와 가나를 섞은 표기는 정답이 아니에요';
    const parts = [];
    const wrong = (p.wrong || 0) - 2 * (p.swapped || 0);
    if (p.missing) parts.push(`빠진 글자 ${p.missing}개`);
    if (p.swapped) parts.push(`순서가 바뀐 글자 ${p.swapped}쌍`);
    if (wrong > 0) parts.push(`틀린 글자 ${wrong}개`);
    if (p.extra) parts.push(`필요 없는 칸 ${p.extra}개`);
    if (!parts.length) return '틀린 칸이 있어요';
    const last = parts[parts.length - 1], code = last.charCodeAt(last.length - 1) - 0xac00;
    return parts.join(' · ') + (code >= 0 && code < 11172 && code % 28 ? '이' : '가') + ' 있어요';
  }

  function recentOf(e, mode) {
    const keys = MODE_KEYS[mode] || MODE_KEYS.read;
    let x = 0, t = 0, n = 0;
    for (const r of statsOf(e).recent) {
      if (!keys.includes(r.m)) continue;
      n++;
      if (r.g === 'x') x++;
      else if (r.g === 't') t++;
    }
    return { x, t, n };
  }

  function practiceTotals(e, mode) {
    const s = statsOf(e);
    if (mode === 'write') return { good: s.write.o, tri: s.write.t, bad: s.write.x };
    if (mode === 'kanji') return { good: s.kanji.reading.o + s.kanji.meaning.ok, tri: s.kanji.reading.t, bad: s.kanji.reading.x + s.kanji.meaning.ng };
    return { good: s.read.ok + s.meaning.ok, tri: 0, bad: s.read.ng + s.meaning.ng };
  }

  // Lifetime "how often wrong" in 0..1 (△ counts half).
  function wrongRate(e, mode) {
    const p = practiceTotals(e, mode);
    const n = p.good + p.tri + p.bad;
    return n ? (p.bad + 0.5 * p.tri) / n : 0;
  }
  const seenIn = (e, mode) => { const p = practiceTotals(e, mode); return p.good + p.tri + p.bad > 0; };

  // 틀린 것 위주 multiplier (1 when off): 1 + 2 · lifetime wrong rate of this practice kind (≤ 3×). It speeds up the
  // entry's pity clock in Quiz's selection (SPEC-words A) — mistakes come round sooner, they never take over.
  function weightOf(e, mode, focusWrong) {
    return focusWrong ? 1 + 2 * wrongRate(e, mode) : 1;
  }

  // The recent marks of this practice kind, oldest first (both parts count for read+뜻 / 한자 읽기 — MODE_KEYS).
  function recentMarks(e, mode) {
    const keys = MODE_KEYS[mode] || MODE_KEYS.read;
    return statsOf(e).recent.filter((r) => keys.includes(r.m)).map((r) => r.g);
  }

  // Quiz statsOf for entry ids — finite runs (Quiz.pickFinite) and 무한 모드 (Quiz.nextEndless) alike: recent ✕ / △
  // and their decayed miss score, practised in this kind or not, lastAt = the entry's last answer in any practice
  // kind (stats.last; the rank / head start of the "not practised for a while" weight), 틀린 것 위주 multiplier.
  // seen also counts 컨닝 / 힌트 answers (stats.cheat, any kind — the store keeps no per-kind count): a ○ with a hint
  // is not a success, yet the word was practised — as "never practised" it would get the new-word boost and come
  // back in every run for as long as the learner keeps taking the hint.
  function endlessStatsFor(byId, mode, focusWrong) {
    const Q = QZ();
    return (id) => {
      const e = byId.get(id);
      if (!e) return { x: 0, t: 0, miss: 0, seen: false, lastAt: 0, mult: 1 };
      const r = recentOf(e, mode);
      const s = statsOf(e);
      return { x: r.x, t: r.t, miss: Q.missScore(recentMarks(e, mode)), seen: seenIn(e, mode) || s.cheat > 0, lastAt: s.last, mult: weightOf(e, mode, focusWrong) };
    };
  }

  // A 무한 run of 단어장: only ✕ is re-asked (△ — stroke order / direction — is not; SPEC-words A).
  function endlessStartFor() {
    return QZ().endlessStart({ retryTri: false });
  }

  function practicePool(entries, o) {
    const opt = o || {};
    return (entries || []).filter((e) => e && !e.deleted
      && (opt.kinds === 'word' ? e.type === 'word' : opt.kinds === 'sentence' ? e.type === 'sentence' : true)
      && (opt.mode !== 'kanji' || hasKanji(e)));
  }

  function questionCount(count, available) {
    if (count === 'endless') return Infinity;
    if (count === 'all') return available;
    return Math.min(available, Math.max(0, Number(count) || 0));
  }

  /* Finite run: entry ids, no repeats, drawn by Quiz.pickFinite (the "rigged random" across runs, SPEC-words A):
   * never-practised entries first, then the ones practised longest ago (rank by stats.last), the last runs' entries
   * rarely; mistakes nudge (≤ 1.5×), 틀린 것 위주 speeds their clock (≤ 3×). Always shuffled (전체: every entry).
   * opts.now: the clock (default Date.now()) — a stats.last over a day ahead of it counts as unknown. */
  function buildQueue(entries, opts, rng) {
    const Q = QZ();
    const o = opts || {};
    const byId = new Map();
    for (const e of entries || []) if (e && e.id != null && !byId.has(e.id)) byId.set(e.id, e);
    const ids = Array.from(byId.keys());
    const n = o.count === 'endless' ? ids.length : questionCount(o.count, ids.length);
    return Q.pickFinite(ids, n, endlessStatsFor(byId, o.mode, !!o.focusWrong), rng || Math.random, { focusWrong: !!o.focusWrong, now: o.now });
  }

  const foldMeaning = (s) => String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\s.,!?~〜()（）\[\]]/g, '');

  // 4지선다: the display meaning + 3 distractors (other entries' display meanings; same type first; distinct;
  // never one the entry itself would accept). null when fewer than 4 distinct meanings exist.
  function meaningChoices(entry, pool, rng) {
    const Q = QZ();
    const T = TX();
    const r = rng || Math.random;
    const correct = displayMeaning(entry);
    if (!correct) return null;
    const seen = new Set(meaningsOf(entry.meaning).map(foldMeaning));
    seen.add(foldMeaning(correct));
    const same = [], other = [];
    for (const e of pool || []) {
      if (!e || e.id === entry.id) continue;
      const m = displayMeaning(e);
      const k = foldMeaning(m);
      if (!m || !k || seen.has(k)) continue;
      if (T && T.checkMeaning(m, entry.meaning).correct) continue;
      seen.add(k);
      (e.type === entry.type ? same : other).push(m);
    }
    const picks = Q.shuffle(same, r).concat(Q.shuffle(other, r)).slice(0, 3);
    if (picks.length < 3) return null;
    const options = Q.shuffle([correct].concat(picks), r);
    return { options, answer: options.indexOf(correct) };
  }

  const PUNCT_SPACE = /[\s、。，．,.!?！？「」『』・･]/g;
  const compactText = (s) => String(s == null ? '' : s).replace(PUNCT_SPACE, '');

  // Kana compared without caring about the script (SPEC-words L: the 히라가나 form accepts テスト typed as てすと and back).
  const foldKana = (s) => compactText(TX().toHiragana(TX().validate(String(s == null ? '' : s)).normalized));
  // Romaji runs of a typed answer → kana (the IME-like KanaText.romajiToKana, final: a trailing n is ん).
  const LATIN_RE = /[A-Za-zＡ-Ｚａ-ｚ]/;
  function romajiToKanaAll(value) {
    const v = String(value == null ? '' : value).replace(/[Ａ-Ｚａ-ｚ]/g, (c) => c.normalize('NFKC'));
    return liveRomaji(v, v.length, 'hira', true).value;
  }

  /* 쓰기 typed answer (SPEC-words J, K, L): any accepted reading ([text, ...alts]) in hiragana or as written, or the kanji
   * form (spaces / 、。 ignored). The kana script of a typed answer is never graded (テスト ← てすと, ガクセイ; the kanji
   * form's kana parts too: アメリカ人 ← あめりか人), the kanji must be the right ones. Handwriting differs on purpose: it is
   * graded against the closest accepted spelling, each cell against that spelling's character (KanaAlign; てスと for テスト
   * → 'す 자리에 가타카나 ス를 썼어요'). Romaji is converted with KanaText.romajiToKana and graded as the kana it spells (a
   * writing test: the spelling must be right).
   * → { correct, empty, form: 'hira'|'text'|'kanji'|null, reading (the matched reading, as written) | null,
   *     romaji (romaji was converted), converted (the kana graded) | null, nudge: 'hangul'|null (not graded) } */
  function checkTypedWrite(input, entry) {
    const T = TX();
    const raw = String(input == null ? '' : input);
    const v = T.normalize(raw);
    const base = { correct: false, empty: false, form: null, reading: null, romaji: false, converted: null, nudge: null };
    if (!compactText(v)) return Object.assign(base, { empty: true });
    if (/[가-힣ㄱ-ㆎ]/.test(v)) return Object.assign(base, { nudge: 'hangul' });
    let kana = v;
    if (LATIN_RE.test(v)) {
      kana = T.normalize(romajiToKanaAll(v));
      base.romaji = true;
      base.converted = kana;
      if (LATIN_RE.test(kana)) return base;            // letters that spell no kana: wrong, not a nudge
    }
    const given = compactText(T.validate(kana).normalized);
    const rs = readingsOf(entry);
    const hiraSame = rs.every((r) => hiraganaOf(r) === r);
    for (const r of rs) {
      if (given === compactText(r)) return Object.assign(base, { correct: true, form: hiraSame ? 'hira' : 'text', reading: r });
    }
    const g = foldKana(kana);
    for (const r of rs) {
      if (g && g === foldKana(r)) return Object.assign(base, { correct: true, form: 'hira', reading: r });
    }
    // the kanji form: its kana parts are compared script-insensitively too, like every typed kana (あめりか人 for
    // アメリカ人 — the learner's document writes katakana words in hiragana); romaji typed beside the kanji is converted
    const anyIdeo = Array.from(kana).some((ch) => T.isKanjiForm(ch));
    const foldK = (s) => compactText(T.toHiragana(T.validateKanji(String(s == null ? '' : s)).normalized));
    if (anyIdeo && hasKanji(entry) && foldK(kana) && foldK(kana) === foldK(kanjiOf(entry))) {
      return Object.assign(base, { correct: true, form: 'kanji', reading: entry.text });
    }
    return Object.assign(base, { form: anyIdeo ? 'kanji' : 'hira' });
  }

  /* 한자 읽기 typed answer → KanaText.checkReading result (+ reading: the matched reading | null), against every
   * accepted reading ([text, ...alts]: 何 → nani or nan). Kana is compared script-insensitively (アメリカじん written
   * あめりかじん). In 로마자 → 가나 mode the box turns the romaji into kana as it is typed (watashi wa → わたし わ), which
   * the exact kana check would reject; so kana that fails is checked again as the romaji it was typed from, with
   * checkReading's particle / long-vowel leniency (wa / o / tokyo). Wrong → the first reading's result (segments). */
  function checkTypedReading(value, entry, romajiTyped) {
    const T = TX();
    const rs = readingsOf(entry);
    let first = null;
    for (let i = 0; i < rs.length; i++) {
      const ent = { text: rs[i], reading: i === 0 ? entry.reading || '' : '', type: entry.type };
      let res = T.checkReading(value, ent);
      if (!res.correct && !res.empty && res.kind === 'kana' && foldKana(value) && foldKana(value) === foldKana(rs[i])) {
        res = Object.assign(res, { correct: true, exact: false });
        res.segments.forEach((s) => { if (s.kind !== 'space' && s.kind !== 'punct') s.ok = true; });
      }
      if (!res.correct && !res.empty && romajiTyped && res.kind === 'kana') {
        let alt = null;
        try {
          const sentence = (entry.type || T.autoType(T.normalize(rs[i]))) === 'sentence';
          alt = T.checkReading(T.toRomaji(value, { sentence }), ent);
        } catch (e) { alt = null; }
        if (alt && alt.correct) res = alt;
      }
      if (res.correct) return Object.assign(res, { reading: rs[i] });
      if (!first) first = res;
      if (res.empty) break;
    }
    return Object.assign(first, { reading: null });
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // One character of a kanji form that belongs to a kanji run (々 〆 ヶ count with the ideographs).
  const isIdeoChar = (ch) => /[々〆ヶ]/.test(ch) || !!(TX() && TX().isKanjiForm(ch));

  /* Furigana for a kanji form: [{ base, rt|null }] — okurigana / kana runs matched literally against the
   * reading (hiragana/katakana-insensitive, spaces ignored), each kanji run gets the reading between them.
   * No consistent split → the whole form with the whole reading. */
  function furigana(kanji, text) {
    const T = TX();
    const base = String(kanji || '');
    const reading = String(text || '').replace(/\s+/g, '');
    if (!base) return [{ base: String(text || ''), rt: null }];
    if (!T || !T.isKanjiForm(base)) return [{ base, rt: null }];
    const runs = [];
    for (const ch of Array.from(base)) {
      const k = isIdeoChar(ch);
      const last = runs[runs.length - 1];
      if (last && last.k === k) last.s += ch; else runs.push({ k, s: ch });
    }
    const fold = (s) => (T.toHiragana ? T.toHiragana(s) : s);
    const lit = (s) => fold(s).replace(/\s+/g, '');
    const pattern = '^' + runs.map((r) => (r.k ? '(.+?)' : escapeRe(lit(r.s)))).join('') + '$';
    let m = null;
    try { m = new RegExp(pattern, 'u').exec(fold(reading)); } catch (e) { m = null; }
    if (!m) return [{ base, rt: reading }];
    const out = [];
    let gi = 1, pos = 0;
    for (const r of runs) {
      if (r.k) {
        const len = m[gi++].length;
        out.push({ base: r.s, rt: reading.slice(pos, pos + len) });
        pos += len;
      } else {
        out.push({ base: r.s, rt: null });
        pos += lit(r.s).length;
      }
    }
    return out;
  }

  /* Furigana over every accepted reading: [{ base, rt|null }] where a kanji run's rt lists the readings' parts
   * (何 → なに／なん, 四 → よん／し). Readings that split the form differently fall back to the first one's furigana. */
  function furiganaAll(kanji, readings) {
    const list = (readings || []).filter(Boolean);
    const first = furigana(kanji, list[0] || '');
    if (list.length < 2) return first;
    const all = list.map((r) => furigana(kanji, r));
    const same = all.every((f) => f.length === first.length && f.every((x, i) => x.base === first[i].base && !!x.rt === !!first[i].rt));
    if (!same) return first;
    return first.map((x, i) => (x.rt ? { base: x.base, rt: uniq(all.map((f) => f[i].rt)).join('／') } : x));
  }

  // The reading line of an entry over every accepted reading: { romaji: 'nani / nan', hangul: '나니 / 난' }. The text's
  // part honours the 읽기 고치기 override (KanaText.checkReading's expected reading).
  function readingsLine(entry) {
    const T = TX();
    const sentence = entry && entry.type === 'sentence';
    const rom = [], ko = [];
    readingsOf(entry).forEach((r, i) => {
      try {
        if (i === 0) {
          const ex = T.checkReading('', { text: r, reading: entry.reading || '', type: entry.type }).expected;
          rom.push(ex.romaji); ko.push(ex.hangul);
        } else { rom.push(T.toRomaji(r, { sentence })); ko.push(T.toHangul(r, { sentence })); }
      } catch (e) { /* skip */ }
    });
    return { romaji: uniq(rom).join(' / '), hangul: uniq(ko).join(' / ') };
  }

  /* 로마자 → 가나 live conversion of an input: every romaji run before the caret is converted; the run that ends at
   * the caret keeps its unconvertible tail ('k', 'ky', a single 'n') as typed letters so the next key completes
   * it. A trailing 'nn' also waits for the next key: Hepburn minna / konnichiwa (ん + な / に) and IME-style
   * honn / minnna (nn = ん) then both come out as KanaText.romajiToKana reads the whole word. → { value, caret } */
  const ROMAJI_RUN = /[A-Za-zÀ-ɏ'’‘`´\-‐–—―−,.]+/g;
  function liveRomaji(value, caret, script, final) {
    const T = TX();
    const v = String(value == null ? '' : value);
    const c = caret == null ? v.length : Math.max(0, Math.min(v.length, caret));
    const before = final ? v : v.slice(0, c), after = final ? '' : v.slice(c);
    let out = '', last = 0, m;
    ROMAJI_RUN.lastIndex = 0;
    while ((m = ROMAJI_RUN.exec(before))) {
      out += before.slice(last, m.index);
      const atEnd = !final && m.index + m[0].length === before.length;
      let run = m[0], tail = '';
      if (atEnd && /nn$/i.test(run)) { tail = run.slice(-2); run = run.slice(0, -2); }
      const r = run ? T.romajiToKana(run, { script: script === 'kata' ? 'kata' : 'hira', final: !atEnd }) : { kana: '', pending: '' };
      out += r.kana + (r.pending || '') + tail;
      last = m.index + m[0].length;
    }
    out += before.slice(last);
    return { value: out + after, caret: final ? out.length : out.length };
  }

  /* On-screen keypad helpers. */
  const DAKU = '゙', HANDAKU = '゚';
  // ゛ / ゜ on the character before the caret: か → が → か, は → ぱ, ば → ぱ … (null = nothing to do)
  function toggleMark(ch, mark) {
    if (!ch) return null;
    const comb = mark === '゜' ? HANDAKU : DAKU;
    const nfd = ch.normalize('NFD');
    const base = nfd.replace(/[゙゚]/g, '');
    if (nfd.includes(comb)) {
      const b = base.normalize('NFC');
      return b !== ch ? b : null;
    }
    const c = (base + comb).normalize('NFC');
    return Array.from(c).length === 1 && c !== ch ? c : null;
  }
  let smallMap = null;
  // 小: つ ↔ っ, や ↔ ゃ, あ ↔ ぁ … (both scripts)
  function toggleSmall(ch) {
    if (!smallMap) {
      smallMap = new Map();
      const D = KD();
      for (const x of Object.values((D && D.extra) || {})) {
        if (x.kind === 'small' && x.big) { smallMap.set(x.big, x.ch); smallMap.set(x.ch, x.big); }
      }
    }
    return smallMap.get(ch) || null;
  }
  // Insert / delete at a selection (code-point aware). → { value, caret }
  function insertText(value, start, end, str) {
    const v = String(value || '');
    const a = Math.max(0, Math.min(v.length, start == null ? v.length : start));
    const b = Math.max(a, Math.min(v.length, end == null ? a : end));
    const nv = v.slice(0, a) + str + v.slice(b);
    return { value: nv, caret: a + str.length };
  }
  function backspaceText(value, start, end) {
    const v = String(value || '');
    const a = Math.max(0, Math.min(v.length, start == null ? v.length : start));
    const b = Math.max(a, Math.min(v.length, end == null ? a : end));
    if (b > a) return { value: v.slice(0, a) + v.slice(b), caret: a };
    if (!a) return { value: v, caret: 0 };
    const lo = v.charCodeAt(a - 1);
    const n = lo >= 0xdc00 && lo <= 0xdfff && a >= 2 ? 2 : 1;
    return { value: v.slice(0, a - n) + v.slice(a), caret: a - n };
  }
  // Replace the code point just before the caret with fn(it) (keypad ゛ ゜ 小). → { value, caret } | null
  function modifyBefore(value, caret, fn) {
    const v = String(value || '');
    const c = Math.max(0, Math.min(v.length, caret == null ? v.length : caret));
    const head = Array.from(v.slice(0, c));
    if (!head.length) return null;
    const prev = head[head.length - 1];
    const next = fn(prev);
    if (!next) return null;
    head[head.length - 1] = next;
    const h2 = head.join('');
    return { value: h2 + v.slice(c), caret: h2.length };
  }

  // 문제 보기 (쓰기): the reading is shown up front only with 한국어 + 발음 (words and sentences alike: the reading is
  // 힌트 3 otherwise; the old 자동 showed words' readings — it reads as 한국어만 now).
  function showsReading(view) {
    return view === 'ko+read';
  }

  /* ------------------------------------------------------------------ readings & answer forms (SPEC-words K, L) */

  // The accepted readings of an entry: [text, ...alts] (normalized, no duplicates, invalid alts left out).
  function readingsOf(entry) {
    const T = TX();
    const out = [];
    const push = (s, check) => {
      const v = check ? T.validate(String(s == null ? '' : s)) : null;
      const n = check ? (v.ok ? v.normalized : '') : T.normalize(String(s == null ? '' : s)).trim();
      if (n && !out.includes(n)) out.push(n);
    };
    push(entry && entry.text, false);
    for (const a of (entry && Array.isArray(entry.alts) ? entry.alts : [])) push(a, true);
    return out;
  }

  // A kana text in hiragana (テスト → てすと, アメリカじん → あめりかじん, ノート → のーと). ー, 、。 and katakana without a
  // hiragana that has stroke data (ヴ, ヵ, ヶ) stay as they are.
  function hiraganaOf(text) {
    const T = TX();
    const D = KD();
    return Array.from(String(text == null ? '' : text), (ch) => {
      const hc = T.toHiragana(ch);
      if (hc === ch) return ch;
      return D && ((D.kana && D.kana[hc]) || (D.extra && D.extra[hc])) ? hc : ch;
    }).join('');
  }

  const uniq = (list) => list.filter((x, i) => list.indexOf(x) === i);
  const kanjiOf = (entry) => TX().validateKanji(entry.kanji).normalized;

  /* The answer forms an entry offers, each with its accepted strings: [{ form, readings }]. 'text' is left out when it
   * is the same as 'hira' (the word is all hiragana), 'kanji' without a kanji form and in 한자 읽기 (kanjiMode). */
  function answerForms(entry, o) {
    const rs = readingsOf(entry);
    const hira = uniq(rs.map(hiraganaOf));
    const forms = [{ form: 'hira', readings: hira }];
    if (rs.join('\u0000') !== hira.join('\u0000')) forms.push({ form: 'text', readings: rs });
    if (!(o && o.kanjiMode) && hasKanji(entry)) forms.push({ form: 'kanji', readings: [kanjiOf(entry)] });
    return forms;
  }

  const defaultForm = (entry) => (entry && entry.type === 'sentence' ? 'text' : 'hira');

  // The form an answer is shown in (typed results, the 결과 list): the wanted form when the entry offers it, else the
  // default of its type, else hiragana ('text' of an all-hiragana word is its hiragana form).
  function resolveForm(entry, pref, o) {
    const have = answerForms(entry, o).map((f) => f.form);
    const p = pref === 'kana' ? 'hira' : pref;
    if (have.includes(p)) return p;
    const d = defaultForm(entry);
    return have.includes(d) ? d : 'hira';
  }

  // The accepted strings of one form ([] when the entry does not offer it).
  function formReadings(entry, form, o) {
    const f = answerForms(entry, o).find((x) => x.form === form);
    return f ? f.readings : [];
  }

  /* ------------------------------------------------------------------ hints (user request: a ladder of three steps) */

  /* 힌트: one step per press — 1 뜻, 2 글자 수, 3 로마자 발음 — skipping a step whose information is already on screen:
   * 쓰기 asks with the Korean meaning (its ladder is 글자 수 → 로마자, only 글자 수 when the reading is up front: 문제 보기
   * 한국어 + 발음, or a word without a meaning); 한자 읽기 asks with the kanji (all three; no 뜻 step without a meaning).
   * A step keeps its number wherever it is offered (쓰기 starts at 「힌트 2」). o = { kanjiMode, readingShown, hasMeaning } */
  const HINTS = { meaning: { n: 1, name: '뜻' }, count: { n: 2, name: '글자 수' }, romaji: { n: 3, name: '로마자' } };
  function hintLadder(o) {
    const p = o || {};
    return ['meaning', 'count', 'romaji'].filter((s) => (s === 'meaning' ? !!(p.kanjiMode && p.hasMeaning) : s === 'romaji' ? !p.readingShown : true));
  }
  // The hint button's words for the step it will show: '힌트 2: 글자 수'.
  const hintLabel = (step) => (HINTS[step] ? `힌트 ${HINTS[step].n}: ${HINTS[step].name}` : '');
  // The highest step reached after `used` presses (its number; 0 = no hint) — what the run keeps with the answer.
  const hintLevel = (ladder, used) => (ladder || []).slice(0, used).reduce((m, s) => Math.max(m, HINTS[s] ? HINTS[s].n : 0), 0);

  /* 힌트 2 (글자 수): { n — the cells GridPad.setCountHint tints, text } for the form the learner most likely writes: the
   * kana reading (every reading's length, the main reading first; hiragana and as written are as long) — 한자 읽기 '히라가나로
   * 4글자'; 쓰기 '4글자', with the kanji form beside it when there is one ('가나로 4글자 · 한자로 쓰면 2글자'). 、。 take a cell
   * each and are named. Counts come from KanaAlign.answers (spaces are not cells). */
  function countHint(entry, o) {
    const kanjiMode = !!(o && o.kanjiMode);
    const list = KA().answers(entry, { kanjiMode });
    const kana = list.filter((a) => a.form !== 'kanji');
    const kanji = list.find((a) => a.form === 'kanji' && !a.kana);
    const lens = uniq(kana.map((a) => a.chars.length));
    const marks = ['、', '。'].filter((m) => kana.some((a) => a.chars.includes(m)));
    const punct = marks.length ? ` (${marks.join('')} 포함)` : '';
    const count = lens.map((x) => `${x}글자`).join(' 또는 ') + punct;
    const text = kanjiMode ? `히라가나로 ${count}` : kanji ? `가나로 ${count} · 한자로 쓰면 ${kanji.chars.length}글자` : count;
    return { n: lens[0] || 0, text };
  }

  /* ------------------------------------------------------------------ open-length writing results (SPEC-words M) */

  const CELL_BOX = { x: 0, y: 0, w: 100, h: 100 };

  /* The result strip: KanaAlign.grade's steps as slots in answer order, each with the learner's ink for the detail view —
   * match (the expected char, its ○ △ ✕ – mark), missing (the expected char: '빠짐'), extra (the cell's char as read, or
   * null: '필요 없음'). written = the graded cells [{ index, strokes, box }] (GridPad.getWrittenCells). key: 'c' + grid
   * index for a written cell, 'm' + answer position for a missing char.
   * → [{ key, type, cell, ch, expected, written, mark, note, kind, result, strokes, box, neutral, error, pos? }] */
  function alignSlots(res, written) {
    const ink = new Map((written || []).map((c) => [c.index, c]));
    return ((res && res.steps) || []).map((st) => {
      const c = st.type !== 'missing' ? ink.get(st.cell) : null;
      const base = {
        type: st.type, cell: st.type === 'missing' ? null : st.cell, kind: st.kind || null, note: st.note || null,
        result: st.result || null, strokes: c ? c.strokes : [], box: (c && c.box) || CELL_BOX, neutral: !!st.neutral, error: !!st.error,
      };
      if (st.type === 'match') return Object.assign(base, { key: 'c' + st.cell, ch: st.expected, expected: st.expected, written: st.written || null, mark: st.mark });
      if (st.type === 'extra') return Object.assign(base, { key: 'c' + st.cell, ch: st.written || null, expected: null, written: st.written || null, mark: 'x' });
      return Object.assign(base, { key: 'm' + st.pos, ch: st.expected, expected: st.expected, written: null, mark: 'x', pos: st.pos, after: st.after });
    });
  }

  // 모르겠어요: the answer's characters as slots to look at (no ink, no grade). answer = a KanaAlign answer ({ chars }).
  function skipSlots(answer) {
    return ((answer && answer.chars) || []).map((ch, k) => ({
      key: 's' + k, type: 'skip', cell: null, ch, expected: ch, written: null, mark: 'x', note: null, kind: null,
      result: null, strokes: [], box: CELL_BOX, neutral: false, error: false, pos: k,
    }));
  }

  // Korean particle after a Japanese word, by its 한글 reading's last syllable (なん → なん으로, なに → なに로).
  function josaKo(word, withFinal, noFinal) {
    let ko = '';
    try { ko = TX().toHangul(String(word == null ? '' : word)).trim(); } catch (e) { ko = ''; }
    const code = ko ? ko.charCodeAt(ko.length - 1) - 0xac00 : -1;
    const fin = code >= 0 && code < 11172 ? code % 28 : 0;
    return String(word) + (fin && !(withFinal === '으로' && fin === 8) ? withFinal : noFinal);
  }

  /* Which accepted spelling the writing was graded as — '히라가나로 썼어요' · '가타카나로 썼어요' / '표기대로 썼어요' · '한자 섞어
   * 썼어요' · '다른 읽기 なん으로 썼어요'; null when the question has a single spelling (nothing to tell apart).
   * best = KanaAlign result.best, list = the question's KanaAlign.answers. */
  function formNote(best, list, res) {
    // another word altogether, or the two forms mixed (学せい): it was not written in any one form — nothing to name
    if (res && (res.issues || []).some((i) => i && (i.type === 'different' || i.type === 'mixed'))) return null;
    if (!best || !list || list.length < 2) return null;
    if (best.form === 'kanji') return best.kana === 'hira' ? '한자 섞어 썼어요 (가나는 히라가나로)' : '한자 섞어 썼어요';
    if (best.reading > 0) return `다른 읽기 ${josaKo(best.text, '으로', '로')} 썼어요`;
    if (best.form === 'text') return scriptOf(best.text) === 'kata' ? '가타카나로 썼어요' : '표기대로 썼어요';
    return '히라가나로 썼어요';
  }

  /* The 정답 line of a written answer: the spelling it was graded as (or shown for 모르겠어요) first, then the other accepted
   * spellings — without the kanji form's copy with hiragana kana (アメリカ人 → あめりか人), which only repeats the two
   * forms beside it. The kanji form as written is shown with furigana over every reading, so nothing follows it.
   * → { main, mainKanji, others: [text] } */
  function answerTexts(best, list) {
    const main = best ? best.text : '';
    const key = best ? best.key : null;
    const mainKanji = key === 'kanji';
    const others = mainKanji ? [] : uniq((list || []).filter((a) => a.key !== key && a.text !== main && !(a.kana === 'hira')).map((a) => a.text));
    return { main, mainKanji, others };
  }

  /* Per-character writing stats of a graded answer (KanaApp.recordWriting): the kana matched to a written cell, ○ △ ✕ — not
   * extras (ー っ …), kanji or neutral cells, nothing for a missing or an extra cell, and nothing at all when the writing is
   * another word altogether (its cells were not trying to be these kana), and not for swapped cells or a kanji written in a
   * kana spelling (KanaAlign swap / mixed). → [{ ch, mark, result }] */
  function recordableChars(res) {
    if (!res || !Array.isArray(res.steps) || (res.issues || []).some((i) => i && i.type === 'different')) return [];
    const D = KD();
    // a cell written in another cell's place (swap) or holding the other form's character (mixed) was not an attempt at
    // the char it is aligned to: no stats for it
    return res.steps.filter((s) => s.type === 'match' && (s.mark === 'o' || s.mark === 't' || s.mark === 'x') && D.kana[s.expected] && !s.swap && !s.mixed)
      .map((s) => ({ ch: s.expected, mark: s.mark, result: s.result || null }));
  }

  /* js/kanji-data.js could not be loaded (kanjiOk false: kanji were judged null) and the writing reads as the kanji form,
   * with kanji cells left neutral: grading it would be a guess, so nothing is graded (SPEC-words §J notice). */
  function kanjiDataMissing(res, kanjiOk) {
    return !kanjiOk && !!res && !!res.best && res.best.form === 'kanji'
      && (res.steps || []).some((s) => s.type === 'match' && s.neutral && s.kind === 'kanji');
  }


  // Which judge a cell needs: 'kana' | 'extra' (KanaRecognizer, box mode) | 'kanji' (KanjiJudge) | 'other'.
  function cellTarget(ch) {
    const D = KD();
    if (D && D.kana && D.kana[ch]) return 'kana';
    if (D && D.extra && D.extra[ch]) return 'extra';
    if (isIdeoChar(ch)) return 'kanji';
    return 'other';
  }

  // Script of a kana text for the 컨닝 chart view: 'hira' | 'kata' | 'mix'.
  function scriptOf(text) {
    const D = KD();
    let hira = false, kata = false;
    for (const ch of Array.from(String(text || ''))) {
      const k = D && ((D.kana && D.kana[ch]) || (D.extra && D.extra[ch]));
      if (!k) continue;
      if (k.script === 'hira') hira = true;
      else if (k.script === 'kata' && ch !== 'ー') kata = true;
    }
    return hira && kata ? 'mix' : kata ? 'kata' : 'hira';
  }

  // Run tally. na = answers with no gradable cell ('-'): neither right nor wrong, never offered for a retry.
  function summarize(answers) {
    const s = { total: 0, o: 0, t: 0, x: 0, na: 0, cheat: 0 };
    for (const a of answers || []) {
      s.total++;
      if (a.mark === 'o') s.o++; else if (a.mark === 't') s.t++; else if (a.mark === '-') s.na++; else s.x++;
      if (a.cheat || a.hint) s.cheat++;
    }
    return s;
  }

  // Ids to practise again from a finished run (unique, in answer order).
  function retryIds(answers, marks) {
    const out = [];
    for (const a of answers || []) if (marks.includes(a.mark) && !out.includes(a.id)) out.push(a.id);
    return out;
  }

  // What kind of character the kana field cannot take: 'kanji' | 'latin' | 'hangul' | 'digit' | 'punct' | 'other'
  // (other = kana-like characters without stroke data: ゐ ゑ ゝ ゟ …).
  function badCharKind(ch) {
    const s = String(ch == null ? '' : ch);
    const f = s.normalize('NFKC');
    if (isIdeoChar(s)) return 'kanji';
    if (/[A-Za-z]/.test(f)) return 'latin';
    if (/[가-힣ㄱ-ㆎ]/.test(s)) return 'hangul';
    if (/[0-9]/.test(f)) return 'digit';
    if (/[\p{P}\p{S}]/u.test(s)) return 'punct';
    return 'other';
  }
  const BAD_MESSAGE = {
    kanji: '한자·영문은 쓸 수 없어요. 히라가나/가타카나로 적어 주세요.',      // the spec copy (SPEC-words H)
    latin: '영문은 쓸 수 없어요. 로마자로 치려면 「로마자 → 가나」를 켜 주세요.',
    hangul: '한글은 쓸 수 없어요. 히라가나/가타카나로 적어 주세요. 뜻은 아래 「뜻」 칸에 적어요.',
    digit: '숫자는 쓸 수 없어요. 가나로 적어 주세요 (1 → いち).',
    punct: '이 기호는 쓸 수 없어요. 문장 부호는 、 。 ー만 쓸 수 있어요.',
    other: '이 글자는 쓸 수 없어요 (ゐ·ゑ 같은 옛 글자나 특수한 가나). 지금 쓰는 히라가나/가타카나로 적어 주세요.',
    mixed: '가나(히라가나·가타카나)와 ー 、 。, 띄어쓰기만 쓸 수 있어요.',
  };

  // Validation message of the kana field (live). pendingTail = trailing romaji letters still being typed.
  // The message names what was rejected (kanji → also kanjiHint: put it in 「한자 표기」).
  function kanaFieldError(value, pendingTail) {
    const T = TX();
    let v = String(value || '');
    if (pendingTail) v = v.replace(/[A-Za-z]+$/, '');
    const r = T.validate(v);
    if (r.reason === 'empty' || !r.normalized) return { ok: false, empty: true, message: '', bad: [] };
    if (!r.ok) {
      const kinds = Array.from(new Set(r.bad.map(badCharKind)));
      const kind = kinds.includes('kanji') ? 'kanji' : kinds.length === 1 ? kinds[0] : 'mixed';
      return {
        ok: false, empty: false, bad: r.bad, kind,
        message: BAD_MESSAGE[kind],
        kanjiHint: kind === 'kanji',
      };
    }
    if (Array.from(r.normalized).length > 120) return { ok: false, empty: false, bad: [], message: '너무 길어요. 120자까지 쓸 수 있어요.' };
    return { ok: true, empty: false, normalized: r.normalized, message: '', bad: [] };
  }

  function kanjiFieldError(value) {
    const T = TX();
    const r = T.validateKanji(String(value || ''));
    if (r.reason === 'empty' || !r.normalized) return { ok: true, empty: true, message: '', bad: [] };
    if (r.reason === 'noKanji') return { ok: false, empty: false, message: '한자 칸에는 한자가 하나 이상 들어가야 해요.', bad: [] };
    if (!r.ok) return { ok: false, empty: false, message: '한자 칸에는 한자와 가나만 쓸 수 있어요.', bad: r.bad };
    if (Array.from(r.normalized).length > 60) return { ok: false, empty: false, message: '한자 표기가 너무 길어요. 60자까지 쓸 수 있어요.', bad: [] };
    return { ok: true, empty: false, normalized: r.normalized, message: '', bad: [] };
  }

  // The example word of the 단어 읽기 help / nudge: never one the question's own text contains (it would give the
  // answer away).
  const READ_SAMPLES = [
    { kana: 'さくら', romaji: 'sakura', hangul: '사쿠라' },
    { kana: 'やま', romaji: 'yama', hangul: '야마' },
    { kana: 'うみ', romaji: 'umi', hangul: '우미' },
  ];
  function readingSample(entry) {
    const t = foldSearch(entry && entry.text);
    return READ_SAMPLES.find((s) => t.indexOf(s.kana) < 0) || READ_SAMPLES[0];
  }
  // The romaji typing example of the kana input's help (gakusei → がくせい): never a word the question's answer contains or
  // is part of — in 쓰기 / 한자 읽기 typed, がくせい (学生) must not be printed under its own question. avoid = text | [text].
  const TYPE_SAMPLES = [{ kana: 'がくせい', romaji: 'gakusei' }].concat(READ_SAMPLES);
  function typingSample(avoid) {
    const xs = (Array.isArray(avoid) ? avoid : [avoid]).map((t) => foldSearch(t)).filter(Boolean);
    return TYPE_SAMPLES.find((s) => xs.every((t) => t.indexOf(s.kana) < 0 && s.kana.indexOf(t) < 0)) || TYPE_SAMPLES[TYPE_SAMPLES.length - 1];
  }

  // Korean copy with Japanese inside → [{ ja, text }]: kana / kanji runs (with ー 々 〆 ヶ ゛ ゜ 、 。) are marked so the
  // page can set them in the textbook face with lang="ja" (rich() in the browser).
  const JA_RUN = /[、。々〆ぁ-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿]+/g;
  function splitJa(text) {
    const str = String(text == null ? '' : text);
    const out = [];
    let last = 0, m;
    JA_RUN.lastIndex = 0;
    while ((m = JA_RUN.exec(str))) {
      if (m.index > last) out.push({ ja: false, text: str.slice(last, m.index) });
      out.push({ ja: true, text: m[0] });
      last = m.index + m[0].length;
    }
    if (last < str.length) out.push({ ja: false, text: str.slice(last) });
    return out;
  }

  // The list's tag filter after the list changed: a tag (or 태그 없음) nobody has any more falls back to 모든 태그.
  function effectiveTag(tag, t) {
    if (!tag) return '';
    if (!t || !t.tags.length) return '';
    if (tag === NO_TAG) return t.none ? tag : '';
    return t.tags.some((x) => x.tag === tag) ? tag : '';
  }

  /* ------------------------------------------------------------------ 단어 선택 (전체 · 지금 목록 · 태그로 선택) */

  const liveEntries = (list) => (list || []).filter((e) => e && !e.deleted);
  const tagKeyOf = (e) => (e && e.tag) || NO_TAG;

  // How much of a group of ids is selected: 'none' | 'some' | 'all' (an empty group is 'none').
  function groupState(ids, selected) {
    const l = ids || [];
    let n = 0;
    for (const id of l) if (selected && selected.has(id)) n++;
    return !l.length || !n ? 'none' : n === l.length ? 'all' : 'some';
  }
  // A copy of the selection with every id added / removed (the selection is never replaced).
  function selectIds(selected, ids) { const s = new Set(selected || []); for (const id of ids || []) s.add(id); return s; }
  function deselectIds(selected, ids) { const s = new Set(selected || []); for (const id of ids || []) s.delete(id); return s; }
  // 전체 선택 · 지금 목록 선택 · a tag chip: the whole group selected → it leaves the selection, else all of it joins.
  function toggleIds(selected, ids) { return groupState(ids, selected) === 'all' ? deselectIds(selected, ids) : selectIds(selected, ids); }
  // The ids of a tag's words (NO_TAG or '': the untagged ones).
  const idsOfTag = (list, tag) => liveEntries(list).filter((e) => tagKeyOf(e) === (tag || NO_TAG)).map((e) => e.id);
  const toggleTag = (list, selected, tag) => toggleIds(selected, idsOfTag(list, tag));
  // The selection without ids the word book no longer has (deleted words, another device's removals).
  function pruneSelection(selected, list) {
    return new Set(liveEntries(list).map((e) => e.id).filter((id) => selected && selected.has(id)));
  }

  /* 태그로 선택 chips: one per tag (tagsOf order), then 태그 없음 when some words have no tag; none at all when no word
   * has a tag (a lone 태그 없음 chip would only repeat 전체 선택). → [{ tag (NO_TAG = 태그 없음), name, n, sel, state }] */
  function tagSelection(list, selected) {
    const l = liveEntries(list);
    const t = tagsOf(l);
    if (!t.tags.length) return [];
    const selN = new Map();
    for (const e of l) {
      if (!selected || !selected.has(e.id)) continue;
      const k = tagKeyOf(e);
      selN.set(k, (selN.get(k) || 0) + 1);
    }
    const out = t.tags.map((x) => ({ tag: x.tag, name: x.tag, n: x.n }));
    if (t.none) out.push({ tag: NO_TAG, name: '태그 없음', n: t.none });
    return out.map((c) => {
      const sel = selN.get(c.tag) || 0;
      return Object.assign(c, { sel, state: !sel ? 'none' : sel === c.n ? 'all' : 'some' });
    });
  }

  // A chip's count ('21', partly selected '6/21') and accessible name ('지시어 21개 중 6개 선택됨').
  function tagChipText(c) {
    const count = c.state === 'some' ? `${c.sel}/${c.n}` : String(c.n);
    const aria = c.state === 'all' ? `${c.name} ${c.n}개 모두 선택됨`
      : c.state === 'some' ? `${c.name} ${c.n}개 중 ${c.sel}개 선택됨` : `${c.name} ${c.n}개, 선택 안 됨`;
    return { count, aria };
  }

  // 연습 설정: the tags the selection spans, most selected first — '시간·숫자 40 · 지시어 21' (a tag only partly selected:
  // '지시어 6/21'; untagged words: '태그 없음 3'); past max tags ' 외 3개 태그'. '' when nothing is selected or no word
  // has a tag.
  function selectionTagsLine(list, selected, max) {
    const chips = tagSelection(list, selected).filter((c) => c.sel);
    if (!chips.length) return '';
    chips.sort((a, b) => b.sel - a.sel || (a.tag === NO_TAG) - (b.tag === NO_TAG) || a.name.localeCompare(b.name, 'ko', { numeric: true }));
    const m = max || 4;
    const shown = chips.slice(0, m).map((c) => `${c.name} ${tagChipText(c).count}`).join(' · ');
    return shown + (chips.length > m ? ` 외 ${chips.length - m}개 태그` : '');
  }

  /* The selection as remembered in this browser (KanaApp.setPrefs('words-sel'); the app keeps ≤ 8 KB of JSON per name):
   * the selected ids space-separated in list order { ids } (every word selected too: words added later must not come
   * back selected). A big selection that does not fit: { all: true } or the words left out { except }, both with the
   * newest createdAt then { at } — a word created after that was not in the selection. Nothing fits (thousands of
   * words, about half selected) → { ids: '', over: true }: the selection then lasts for this visit only. */
  const SEL_BUDGET = 7000;
  const createdOf = (e) => (typeof e.createdAt === 'number' && isFinite(e.createdAt) ? e.createdAt : 0);
  function selectionPref(selected, list, budget) {
    const b = budget || SEL_BUDGET;
    const live = liveEntries(list).filter((e) => typeof e.id === 'string' && /^\S+$/.test(e.id));
    const ids = live.map((e) => e.id);
    const inc = ids.filter((id) => selected && selected.has(id));
    const s = inc.join(' ');
    if (s.length <= b) return { v: 1, ids: s };
    const at = live.reduce((m, e) => Math.max(m, createdOf(e)), 0);
    if (inc.length === ids.length) return { v: 1, all: true, at };
    const exc = ids.filter((id) => !selected.has(id)).join(' ');
    if (exc.length <= b) return { v: 1, except: exc, at };
    return { v: 1, ids: '', over: true };
  }
  // The remembered selection against the word book now (ids it no longer has are dropped; with { all } / { except },
  // words created after { at } are not selected). → Set
  function selectionFromPref(pref, list) {
    const p = pref && typeof pref === 'object' ? pref : {};
    const live = liveEntries(list);
    const ids = live.map((e) => e.id);
    const split = (v) => (typeof v === 'string' ? v.split(/\s+/) : Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x);
    const known = typeof p.at === 'number' && isFinite(p.at) ? live.filter((e) => createdOf(e) <= p.at).map((e) => e.id) : ids;
    if (p.all === true) return new Set(known);
    if (typeof p.except === 'string' || Array.isArray(p.except)) {
      const ex = new Set(split(p.except));
      return new Set(known.filter((id) => !ex.has(id)));
    }
    const want = new Set(split(p.ids));
    return new Set(ids.filter((id) => want.has(id)));
  }

  /* ------------------------------------------------------------------ presets (KANA_WORD_PRESETS, SPEC-words K) */

  // How many of a preset's words the list already has (same id, or same kana + kanji — what importJSON matches).
  function presetStatus(preset, list) {
    const ids = new Set(), keys = new Set();
    for (const e of list || []) { if (!e || e.deleted) continue; ids.add(e.id); keys.add(e.text + '\u0000' + (e.kanji || '')); }
    const words = (preset && Array.isArray(preset.words)) ? preset.words : [];
    const present = words.filter((w) => ids.has(w.id) || keys.has(w.text + '\u0000' + (w.kanji || ''))).length;
    return { total: words.length, present, all: words.length > 0 && present === words.length };
  }

  // The preset's words for KanaStore.words.importJSON: createdAt one ms apart (the list is newest first, so the
  // document's first word comes out on top) — a copy, the preset itself is not touched.
  function importPresetWords(preset, now) {
    const t = typeof now === 'number' ? now : Date.now();
    const words = (preset && Array.isArray(preset.words)) ? preset.words : [];
    return words.map((w, i) => Object.assign({}, w, { createdAt: t - i }));
  }

  // The 불러오기 result in Korean: '172개를 추가했어요' / '이미 모두 들어 있어요' (+ what was already there / failed).
  function presetMessage(r) {
    const res = r || {};
    const added = res.added || 0, had = (res.skipped || 0) + (res.updated || 0), bad = (res.errors || []).length;
    const failed = bad ? ` ${bad}개는 넣지 못했어요.` : '';
    if (!added && !bad) return { ok: true, text: '이미 모두 들어 있어요.' };
    if (!added) return { ok: false, text: '넣은 단어가 없어요.' + failed };
    return { ok: true, text: `${added}개를 추가했어요.` + (had ? ` (${had}개는 이미 있어요)` : '') + failed };
  }

  // 다른 읽기 field of the edit form: readings split at / ／ , ， ; ； and, for a word, 、 (a sentence's 、 is part of the
  // reading: はい、そうです。); romaji in each is converted to hiragana. o = { sentence }.
  // → { alts: [normalized kana], bad: [chars], message }
  function altsFieldParse(value, text, o) {
    const T = TX();
    const sep = o && o.sentence ? /[/／,，;；]+/ : /[/／,，、;；]+/;
    const parts = String(value == null ? '' : value).split(sep).map((x) => x.trim()).filter(Boolean);
    const alts = [], bad = [];
    for (const p of parts) {
      const v = T.validate(LATIN_RE.test(p) ? romajiToKanaAll(p) : p);
      if (!v.ok) { v.bad.forEach((ch) => { if (!bad.includes(ch)) bad.push(ch); }); continue; }
      if (v.normalized !== text && !alts.includes(v.normalized)) alts.push(v.normalized);
    }
    let message = '';
    if (bad.length) message = '다른 읽기에는 히라가나/가타카나만 쓸 수 있어요.';
    else if (alts.length > 5) message = '다른 읽기는 5개까지 넣을 수 있어요.';
    return { alts, bad, message };
  }

  const pure = {
    EXAMPLES, DEFAULT_PREFS, NO_TAG, normalizePrefs, statsOf, entrySummary, hasKanji, meaningsOf, displayMeaning,
    foldSearch, searchText, filterEntries, tagsOf, overallMark, answerMarks, penHeadline, recentOf,
    wrongRate, weightOf, recentMarks, endlessStatsFor, endlessStartFor, practicePool, questionCount, buildQueue, meaningChoices, checkTypedWrite,
    checkTypedReading, furigana, liveRomaji, toggleMark, toggleSmall, insertText, backspaceText, modifyBefore,
    showsReading, cellTarget, scriptOf, summarize, retryIds, badCharKind, kanaFieldError, kanjiFieldError,
    compactText, readingSample, typingSample, splitJa, effectiveTag,
    groupState, selectIds, deselectIds, toggleIds, idsOfTag, toggleTag, pruneSelection, tagSelection, tagChipText,
    selectionTagsLine, selectionPref, selectionFromPref,
    FORMS, readingsOf, hiraganaOf, answerForms, defaultForm, resolveForm, formReadings,
    furiganaAll, readingsLine, foldKana, romajiToKanaAll, presetStatus, importPresetWords, presetMessage, altsFieldParse,
    HINTS, hintLadder, hintLabel, hintLevel, countHint, alignSlots, skipSlots, josaKo, formNote, answerTexts, recordableChars,
    kanjiDataMissing,
  };

  if (isNode) return { _pure: pure, start() {} };

  /* =================================================================== browser: DOM helpers */

  const SVGNS = 'http://www.w3.org/2000/svg';
  function setProps(el, props) {
    if (!props) return;
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]);
      else if (k === 'style') el.setAttribute('style', v);
      else if (k === 'value' && 'value' in el) el.value = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach((x) => add(el, x)); return; }
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function h(tag, props) {
    const el = document.createElement(tag);
    setProps(el, props);
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function sv(tag, props) {
    const el = document.createElementNS(SVGNS, tag);
    setProps(el, props);
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  const jp = (text, cls) => h('span', { class: 'jp ' + (cls || ''), lang: 'ja' }, text);
  // Korean copy with Japanese inside: the Japanese runs in the textbook face (lang="ja"), the rest as text.
  const rich = (text) => splitJa(text).map((p) => (p.ja ? jp(p.text, 'inline-kana') : p.text));
  const srOnly = (text) => h('span', { class: 'sr-only' }, text);
  const uid = (p) => (p || 'w') + '-' + Math.random().toString(36).slice(2, 8);

  const ICONS = {
    plus: 'M12 5v14M5 12h14',
    pen: 'M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5zM13.5 7l3 3',
    grid: 'M4 4h16v16H4zM4 12h16M12 4v16',
    arrow: 'M5 12h13M13 6.5 18.5 12 13 17.5',
    undo: 'M9 7 4 12l5 5M4.5 12H14a5.5 5.5 0 0 1 0 11h-3',
    clear: 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13',
    stop: 'M7.5 7.5h9v9h-9z',
    edit: 'M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5z',
    trash: 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13M10 11v6M14 11v6',
    copy: 'M9 9h10v11H9zM5 15V4h10',
    io: 'M7 4v12M3.5 12.5 7 16l3.5-3.5M17 20V8M13.5 11.5 17 8l3.5 3.5',
    bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
    back: 'M15 5.5 8.5 12l6.5 6.5',
    keypad: 'M4 6h16v12H4zM7 9h1M10.5 9h1M14 9h1M17 9h0M7 12h1M10.5 12h1M14 12h1M8 15h8',
    play: 'M8 5.5v13l10.5-6.5z',
    chev: 'M6.5 9.5 12 15l5.5-5.5',
  };
  function icon(name) {
    const svg = sv('svg', { class: 'ic', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(sv('path', { d: ICONS[name] || '', class: name === 'play' || name === 'stop' ? 'ic-fill' : null }));
    return svg;
  }

  const MARK_SYM = { o: '○', t: '△', x: '✕', '-': '–' };
  const MARK_LABEL = { o: '정답', t: '획순 오류', x: '오답', '-': '채점 안 함' };
  function markChip(mark, n, cls) {
    const m = MARK_SYM[mark] ? mark : 'x';
    return h('span', { class: 'mchip ' + (m === '-' ? 'mchip-na' : 'mchip-' + m) + ' ' + (cls || '') },
      h('span', { class: 'mchip-sym', 'aria-hidden': 'true' }, MARK_SYM[m]), srOnly(MARK_LABEL[m] + ' '),
      n != null ? h('span', { class: 'mchip-n' }, n) : null);
  }
  function okChip(ok) {
    return h('span', { class: 'mchip ' + (ok === true ? 'mchip-o' : ok === false ? 'mchip-x' : 'mchip-na') },
      h('span', { class: 'mchip-sym', 'aria-hidden': 'true' }, ok === true ? '✓' : ok === false ? '✗' : '–'),
      srOnly(ok === true ? '맞음' : ok === false ? '틀림' : '안 함'));
  }

  // label: the visible legend, or { sr: text } for a group whose heading is already on screen (screen readers only).
  function segmented(name, label, options, value, onChange, cls) {
    const id = uid('seg-' + name);
    const visible = typeof label === 'string' && label;
    return h('fieldset', { class: 'seg-field ' + (cls || '') },
      h('legend', { class: visible ? 'field-label' : 'sr-only', id }, visible ? label : (label && label.sr) || ''),
      h('div', { class: 'seg' }, options.map((o) => h('label', { class: 'seg-opt' + (o.disabled ? ' is-disabled' : '') },
        h('input', {
          type: 'radio', name: id, value: String(o.value), checked: String(o.value) === String(value) ? true : null,
          disabled: o.disabled ? true : null, 'aria-label': o.aria || null, 'data-k': name,
          on: { change: (e) => { if (e.target.checked) onChange(o.value); } },
        }),
        h('span', { class: 'seg-face' }, o.glyph ? jp(o.glyph, 'seg-glyph') : null, o.label)))));
  }

  function toggleRow(label, hint, value, onChange, key) {
    const id = uid('tg');
    return h('div', { class: 'toggle-row' },
      h('input', { type: 'checkbox', class: 'switch', id, role: 'switch', checked: value ? true : null, 'aria-describedby': hint ? id + '-d' : null, 'data-k': key || null, on: { change: (e) => onChange(e.target.checked) } }),
      h('label', { for: id, class: 'toggle-label' }, label),
      hint ? h('p', { class: 'toggle-hint', id: id + '-d' }, hint) : null);
  }

  function typeBadge(type) {
    return h('span', { class: 'wtype wtype-' + (type === 'sentence' ? 'sentence' : 'word') }, type === 'sentence' ? '문장' : '단어');
  }

  // Kanji form with the readings as furigana (<ruby>; 何 → なに／なん), or the kana text (+ its other readings).
  function wordFace(e, cls) {
    const rs = readingsOf(e);
    if (!hasKanji(e)) {
      if (rs.length < 2) return jp(e.text, 'wface ' + (cls || ''));
      return h('span', { class: 'wface-alts ' + (cls || '') }, rs.map((r, i) => [i ? h('span', { class: 'wface-sep', 'aria-hidden': 'true' }, ' / ') : null, i ? srOnly(' 또는 ') : null, jp(r, 'wface')]));
    }
    const el = h('span', { class: 'jp wface wface-kanji ' + (cls || ''), lang: 'ja' });
    for (const seg of furiganaAll(e.kanji, rs.length ? rs : [e.text])) {
      if (seg.rt) el.appendChild(h('ruby', null, seg.base, h('rp', null, '('), h('rt', null, seg.rt), h('rp', null, ')')));
      else el.appendChild(document.createTextNode(seg.base));
    }
    return el;
  }

  // romaji · 한글 of every accepted reading ('nani / nan' · '나니 / 난').
  function readingOf(e) {
    try { return readingsLine(e); } catch (err) { return { romaji: '', hangul: '' }; }
  }

  function focusEl(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }

  function reduceMotion() {
    try { return root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  // The app's post-answer scroll (KanaApp.ui.revealBelow): the result comes into view, keep (다음 문제 / the next
  // step) stays on screen.
  function revealBelow(anchor, keep, opts) {
    try { if (App && App.ui && App.ui.revealBelow) App.ui.revealBelow(anchor, keep, opts); } catch (e) { console.error(e); }
  }
  const phone = () => { try { return root.matchMedia('(max-width: 599px)').matches; } catch (e) { return false; } };

  /* =================================================================== module state */

  let App = null, Store = null;
  const S = {
    view: 'list', mounted: false, main: null,
    query: '', kind: 'all', tag: '', limit: LIST_PAGE,
    selected: new Set(),
    selLoaded: false,     // S.selected restored from this browser's prefs (words-sel)
    tagsOpen: null,       // 태그로 선택 shown (null = by screen width: closed on phones)
    run: null, lastRun: null,
    cleanups: [],
    syncLine: null, renderList: null,
    editDirty: false,
    kanjiReady: null,
  };
  const onCleanup = (fn) => S.cleanups.push(fn);
  function runCleanups() { while (S.cleanups.length) { try { S.cleanups.pop()(); } catch (e) { console.error(e); } } }

  const words = () => (Store ? Store.words.list() : []);
  const prefs = () => normalizePrefs(App.getPrefs ? App.getPrefs('words') : null);
  function savePrefs(p) { if (App.setPrefs) App.setPrefs('words', normalizePrefs(p)); }
  const toast = (m) => { if (App && App.toast) App.toast(m); };

  /* The word selection (S.selected) is remembered in this browser under its own prefs name (selectionPref: it can grow
   * past what the practice prefs should risk) with the 태그로 선택 open state. Restored once there are words to match
   * the ids against (a first cloud snapshot may come later); nothing is saved before that, so the stored selection is
   * not overwritten by an empty one. */
  const SEL_PREF = 'words-sel';
  function loadSel() {
    if (S.selLoaded || !Store) return;
    const list = words();
    if (!list.length) return;
    let p = null;
    try { p = App.getPrefs ? App.getPrefs(SEL_PREF) : null; } catch (e) { p = null; }
    S.selected = selectionFromPref(p, list);
    if (p && typeof p.open === 'boolean') S.tagsOpen = p.open;
    S.selLoaded = true;
  }
  function saveSel() {
    if (!S.selLoaded || !App || !App.setPrefs) return;
    const v = selectionPref(S.selected, words());
    if (typeof S.tagsOpen === 'boolean') v.open = S.tagsOpen;
    try { App.setPrefs(SEL_PREF, v); } catch (e) { /* not saved: kept for this visit */ }
  }
  function setSelected(next) { S.selected = next; saveSel(); }

  // js/kanji-data.js on first need (StrokeView / GridPad guides / ui.judgeDetail pick KANJI_DATA up once loaded).
  function ensureKanji() {
    const KJ = root.KanjiJudge;
    if (!KJ || typeof KJ.load !== 'function') return Promise.resolve(false);
    if (!S.kanjiReady) {
      S.kanjiReady = KJ.load().then((ok) => { if (!ok) S.kanjiReady = null; return !!ok; }, () => { S.kanjiReady = null; return false; });
    }
    return S.kanjiReady;
  }

  /* =================================================================== registration */

  function start() {
    App = root.KanaApp;
    if (!App || typeof App.registerScreen !== 'function') { console.warn('words.js: window.KanaApp is missing'); return; }
    Store = root.KanaStore || App.store || null;
    App.registerScreen('words', { navLabel: '단어장', render, onLeave, confirmLeave, chartNav });
    if (Store && typeof Store.onChange === 'function') Store.onChange(onStoreChange);
  }

  const VIEWS = {};

  function render(main, params) {
    const p = params || {};
    const view = VIEWS[p.view] ? p.view : 'list';
    if (view !== 'practice' && S.run && S.run.active) abandonRun();
    S.main = main;
    S.mounted = true;
    S.view = view;
    S.syncLine = null;
    S.renderList = null;
    S.updateSel = null;
    if (view !== 'edit') S.editDirty = false;
    loadSel();
    if (!Store) {
      main.appendChild(h('div', { class: 'wl-page' }, h('h1', { class: 'page-title' }, '단어장'),
        h('p', { class: 'note-warn' }, '단어장 저장소(js/store.js)를 불러오지 못했어요. 페이지를 새로 고쳐 주세요.')));
      return;
    }
    VIEWS[view](main, p);
  }

  // Torn down (another screen, or another 단어장 view). Leaving a running practice ends it here, so a 뜻 still waiting
  // for 「맞은 걸로 할게요」 is recorded now, not only when 단어장 is opened again. Only from the practice view: startRun
  // sets S.run before it leaves the setup / result view.
  function onLeave() {
    S.mounted = false;
    runCleanups();
    if (S.view === 'practice' && S.run && S.run.active) abandonRun();
  }

  function confirmLeave() {
    if (S.view === 'practice' && S.run && S.run.active) {
      const c = S.run.cur;
      const n = S.run.answers.length + (c && c.readingDone && !c.final ? 1 : 0);   // a half-answered question counts
      return {
        title: '연습을 그만둘까요?',
        body: n ? `지금까지 푼 ${n}문제는 단어장 기록에 남아요.` : '아직 푼 문제가 없어요.',
        ok: '그만두기', cancel: '계속하기', danger: true,
      };
    }
    if (S.view === 'edit' && S.editDirty) {
      return { title: '작성 중인 내용을 버릴까요?', body: '저장하지 않은 내용은 사라져요.', ok: '버리기', cancel: '계속 쓰기', danger: true };
    }
    return null;
  }

  // 글자표 tab / #chart during a practice: the chart overlay, tagging the current question as 컨닝.
  function chartNav() {
    if (S.view !== 'practice' || !S.run || !S.run.active) return false;
    if (S.run.openCheat) S.run.openCheat();
    return true;
  }

  function onStoreChange(c) {
    if (!c || !S.mounted) return;
    if (c.status) updateSync();
    if (c.words && S.view === 'list') {
      if (S.renderList) S.renderList();
      else if (words().length) go('list');     // the empty state when words arrive (another tab, a first cloud snapshot)
    }
  }

  function updateSync() {
    const el = S.syncLine;
    if (!el || !Store) return;
    let st = null;
    try { st = Store.status(); } catch (e) { st = null; }
    const state = st ? st.cloud === 'on' ? 'on' : st.cloud === 'connecting' ? 'connecting' : st.cloud === 'error' ? 'error' : st.local === 'ok' ? 'local' : 'memory' : 'local';
    el.dataset.state = state;
    el.textContent = '';
    el.appendChild(h('span', { class: 'w-sync-dot', 'aria-hidden': 'true' }));
    el.appendChild(document.createTextNode((st && st.message) || '이 기기에만 저장돼요.'));
  }

  /* =================================================================== 단어장 list */

  VIEWS.list = function (main) {
    const all = words();
    const syncLine = h('p', { class: 'w-sync', role: 'status' });
    S.syncLine = syncLine;
    updateSync();
    const page = h('div', { class: 'wl-page' });
    const head = h('header', { class: 'page-head wl-head' },
      h('div', { class: 'wl-head-text' },
        h('h1', { class: 'page-title' }, '단어장'),
        h('p', { class: 'page-sub' }, '내가 모은 일본어 단어와 문장을 읽고, 직접 써 보세요.'),
        syncLine),
      h('div', { class: 'wl-head-acts' },
        h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => App.go('words', { view: 'edit' }) } }, icon('plus'), '단어 추가'),
        all.length ? h('button', { type: 'button', class: 'btn', on: { click: () => App.go('words', { view: 'setup' }) } }, icon('pen'), '연습하기') : null,
        h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => App.go('words', { view: 'io' }) } }, icon('io'), '가져오기·내보내기')));
    page.appendChild(head);
    main.appendChild(page);

    if (!all.length) {
      page.appendChild(emptyState());
      return;
    }

    // ---- toolbar: search, kind filter, tag
    const search = h('input', {
      type: 'search', class: 'w-input wl-search-input', id: 'wl-search', value: S.query, placeholder: '찾기: 가나 · 한자 · 뜻 · 로마자 · 한글',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search',
    });
    let searchTimer = 0;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { S.query = search.value; S.limit = LIST_PAGE; renderList(); }, 120);
    });
    onCleanup(() => clearTimeout(searchTimer));
    const kindSeg = segmented('wkind', '보기', [
      { value: 'all', label: '전체' }, { value: 'word', label: '단어' }, { value: 'sentence', label: '문장' }, { value: 'kanji', label: '한자 있음' },
    ], S.kind, (v) => { S.kind = v; S.limit = LIST_PAGE; renderList(); }, 'wl-kind');
    const tagBox = h('div', { class: 'wl-tagbox' });
    const toolbar = h('div', { class: 'wl-tools card' },
      h('div', { class: 'wl-search' }, h('label', { for: 'wl-search', class: 'sr-only' }, '단어 찾기'), search),
      h('div', { class: 'wl-filters' }, kindSeg, tagBox));
    // 단어 선택: the count (+ 선택한 것만 연습 · 선택 해제), 전체 / 지금 목록 선택, 태그로 선택 chips. The count line stays in
    // place (a live region); the controls around it are rebuilt on every change.
    const selStatus = h('p', { class: 'wl-selstatus', 'aria-live': 'polite' });
    const selActs = h('div', { class: 'wl-selacts' });
    const selBulk = h('div', { class: 'wl-selbulk' });
    const tagSelId = uid('wl-tagsel');
    const tagSel = h('div', { class: 'wl-tagsel', id: tagSelId, role: 'group', 'aria-label': '태그로 선택', hidden: true });
    const selBar = h('div', { class: 'wl-selbar', role: 'region', 'aria-label': '단어 선택' },
      h('div', { class: 'wl-selhead' }, selStatus, selActs), selBulk, tagSel);
    const count = h('p', { class: 'wl-count', 'aria-live': 'polite' });
    const listEl = h('ul', { class: 'wl-list' });
    const more = h('div', { class: 'wl-more' });
    // shown when a listed reading has a long-vowel mark in its 한글 (가쿠세(이), 갓코(우))
    const legend = h('p', { class: 'wl-legend', hidden: true }, '한글 읽기에서 괄호 속 모음 (이)·(우)는 앞소리를 길게 읽는다는 표시예요. 예: 가쿠세(이) ≈ 가쿠세-');
    page.appendChild(toolbar);
    page.appendChild(selBar);
    page.appendChild(count);
    page.appendChild(listEl);
    page.appendChild(more);
    page.appendChild(legend);

    let tagKey = null;
    function renderTags(list) {
      const t = tagsOf(list);
      S.tag = effectiveTag(S.tag, t);       // e.g. 태그 없음 after the last untagged word got a tag
      const key = JSON.stringify(t);
      if (key === tagKey) return;           // unchanged: keep the <select> (and its focus)
      tagKey = key;
      tagBox.textContent = '';
      if (!t.tags.length) return;
      const id = uid('wl-tag');
      const sel = h('select', { class: 'w-select', id, on: { change: (e) => { S.tag = e.target.value; S.limit = LIST_PAGE; renderList(); } } },
        h('option', { value: '' }, '모든 태그'),
        t.tags.map((x) => h('option', { value: x.tag }, `${x.tag} (${x.n})`)),
        t.none ? h('option', { value: NO_TAG }, `태그 없음 (${t.none})`) : null);
      sel.value = S.tag;
      tagBox.appendChild(h('label', { for: id, class: 'field-label' }, '태그로 거르기'));
      tagBox.appendChild(sel);
    }

    // ☐ / ⊟ / ☑ — a tag chip's state in form, not only in colour
    function tickBox(state) {
      const svg = sv('svg', { class: 'ic wl-tick', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
      svg.appendChild(sv('rect', { x: 4, y: 4, width: 16, height: 16, rx: 3.5, class: 'wl-tick-box' }));
      if (state === 'some') svg.appendChild(sv('path', { d: 'M8.5 12h7', class: 'wl-tick-mark' }));
      if (state === 'all') svg.appendChild(sv('path', { d: 'M8 12.4l2.8 2.8L16.2 9.2', class: 'wl-tick-mark' }));
      return svg;
    }

    let lastVisible = [], lastFiltered = false, statusKey = '';
    function renderSelBar(visible, filtered) {
      lastVisible = visible;
      lastFiltered = filtered;
      const list = words();
      // drop selections of deleted words
      const kept = pruneSelection(S.selected, list);
      if (kept.size !== S.selected.size) setSelected(kept);
      const n = S.selected.size;
      // the bar is rebuilt: the keyboard focus comes back to the same control (or 전체 선택 when it is gone)
      const a = document.activeElement;
      const fk = a && selBar.contains(a) ? a.getAttribute('data-k') : null;
      const sb = (k, cls, label, onClick, extra) => h('button', Object.assign({ type: 'button', class: 'btn btn-sm ' + (cls || ''), 'data-k': k, on: { click: onClick } }, extra || {}), label);
      const change = (next) => { setSelected(next); renderList(); };

      selBar.classList.toggle('has-sel', n > 0);
      const key = n ? 'n' + n : 'none';
      if (key !== statusKey) {         // same text: leave the live region alone (no repeated announcement)
        statusKey = key;
        selStatus.textContent = '';
        if (n) add(selStatus, [h('b', null, String(n)), '개 선택했어요']);
        else add(selStatus, h('span', { class: 'wl-selhint' }, '체크한 단어만 골라서 연습할 수도 있어요.'));
      }
      const allIds = list.map((e) => e.id);
      const allSel = groupState(allIds, S.selected) === 'all';
      selActs.textContent = '';
      if (n) {
        selActs.appendChild(sb('sel-practice', 'btn-primary', [icon('pen'), '선택한 것만 연습'], () => App.go('words', { view: 'setup', source: 'selected' })));
        // everything selected: 전체 해제 below does the same, no second button for it
        if (!allSel) selActs.appendChild(sb('sel-clear', 'btn-quiet', '선택 해제', () => change(new Set())));
      }

      selBulk.textContent = '';
      selBulk.appendChild(allSel
        ? sb('sel-all', '', '전체 해제', () => change(new Set()))
        : sb('sel-all', '', `전체 선택 (${allIds.length})`, () => change(selectIds(S.selected, allIds))));
      // 지금 목록 only when it is not the whole word book (then it would repeat 전체 선택)
      if (filtered && visible.length && visible.length < allIds.length) {
        const visIds = visible.map((e) => e.id);
        selBulk.appendChild(groupState(visIds, S.selected) === 'all'
          ? sb('sel-visible', '', '지금 목록 해제', () => change(deselectIds(S.selected, visIds)))
          : sb('sel-visible', '', `지금 목록 선택 (${visIds.length})`, () => change(selectIds(S.selected, visIds))));
      }

      const chips = tagSelection(list, S.selected);
      tagSel.textContent = '';
      const open = chips.length > 0 && (typeof S.tagsOpen === 'boolean' ? S.tagsOpen : !phone());
      tagSel.hidden = !open;
      if (chips.length) {
        selBulk.appendChild(sb('sel-tags', 'btn-quiet wl-tagsel-toggle', ['태그로 선택', icon('chev')], () => {
          S.tagsOpen = !open;
          saveSel();
          renderSelBar(lastVisible, lastFiltered);
        }, { 'aria-expanded': open ? 'true' : 'false', 'aria-controls': tagSelId }));
      }
      if (open) {
        tagSel.appendChild(h('p', { class: 'wl-tagsel-hint' }, '태그를 누르면 그 단어들이 선택에 더해져요. 모두 선택된 태그를 다시 누르면 빠져요.'));
        tagSel.appendChild(h('div', { class: 'wl-tchips' }, chips.map((c) => {
          const tx = tagChipText(c);
          return h('button', {
            type: 'button', class: 'chip wl-tchip is-' + c.state, 'data-k': c.tag === NO_TAG ? 'tag-none' : 'tag:' + c.tag,
            'aria-pressed': c.state === 'all' ? 'true' : c.state === 'some' ? 'mixed' : 'false', 'aria-label': tx.aria,
            on: { click: () => change(toggleTag(words(), S.selected, c.tag)) },
          }, tickBox(c.state), h('span', { class: 'wl-tchip-name' }, c.name), h('span', { class: 'wl-tchip-n' }, tx.count));
        })));
      }
      if (fk) {
        const all = Array.from(selBar.querySelectorAll('[data-k]'));
        const byK = (k) => all.find((el) => el.getAttribute('data-k') === k);
        focusEl(byK(fk) || byK('sel-all') || all[0]);
      }
    }

    function renderList() {
      const list = words();
      if (!list.length) { go('list'); return; }
      renderTags(list);
      const visible = filterEntries(list, { query: S.query, kind: S.kind, tag: S.tag });
      const filtered = !!(S.query || S.kind !== 'all' || S.tag);
      renderSelBar(visible, filtered);
      // a live region: written only when the text changes (a tag chip re-renders the list, not this count)
      const countText = filtered ? `${list.length}개 중 ${visible.length}개` : `모두 ${list.length}개`;
      if (count.textContent !== countText) count.textContent = countText;
      listEl.textContent = '';
      let paren = false;
      visible.slice(0, S.limit).forEach((e) => {
        const li = row(e);
        if (li.getAttribute('data-paren')) paren = true;
        listEl.appendChild(li);
      });
      legend.hidden = !paren;
      if (!visible.length) listEl.appendChild(h('li', { class: 'wl-none' }, '찾는 단어가 없어요. 검색어나 보기를 바꿔 보세요.'));
      more.textContent = '';
      if (visible.length > S.limit) {
        more.appendChild(h('button', { type: 'button', class: 'btn', on: { click: () => { S.limit += LIST_PAGE; renderList(); } } }, `더 보기 (${visible.length - S.limit}개 남음)`));
      }
    }
    S.renderList = renderList;
    S.updateSel = () => renderSelBar(lastVisible, lastFiltered);
    renderList();
  };

  function emptyState() {
    const presets = presetBox('empty');
    return h('section', { class: 'card wl-empty', 'aria-labelledby': 'wl-empty-h' },
      h('div', { class: 'wl-empty-glyph jp', lang: 'ja', 'aria-hidden': 'true' }, 'ことば'),
      h('h2', { class: 'card-h', id: 'wl-empty-h' }, '아직 단어가 없어요'),
      presets,
      presets ? h('h3', { class: 'wl-empty-sub' }, '직접 넣기') : null,
      h('p', null, rich('「단어 추가」를 눌러 외우고 싶은 단어나 문장을 히라가나·가타카나로 적어 보세요. 일본어 키보드, 로마자 입력(gakusei → がくせい), 화면의 가나 키패드 중 편한 방법으로 쓸 수 있어요.')),
      h('p', null, rich('한자 표기(学生)와 뜻(학생)도 함께 적어 두면 읽기 · 쓰기(한국어 → 일본어) · 한자 읽기 연습에 쓰여요.')),
      h('div', { class: 'wl-empty-acts' },
        h('button', { type: 'button', class: presets ? 'btn' : 'btn btn-primary', 'data-autofocus': presets ? null : true, on: { click: insertExamples } }, '예시 넣기 (단어 8개 · 문장 3개)'),
        h('button', { type: 'button', class: 'btn', on: { click: () => App.go('words', { view: 'edit' }) } }, icon('plus'), '단어 추가'),
        h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => App.go('words', { view: 'io' }) } }, '가져오기')),
      h('p', { class: 'wl-empty-note' }, '예시에는 「예시」 태그가 붙어 있어요. 태그로 골라 볼 수 있고, 필요 없으면 하나씩 지우면 돼요.'));
  }

  /* 단어 목록 불러오기 (SPEC-words K): the presets of js/word-presets.js (window.KANA_WORD_PRESETS) with a one-tap
   * 불러오기 — KanaStore.words.importJSON, so a second tap adds nothing ('이미 모두 들어 있어요'). where = 'empty' (the
   * empty list: goes to the list after importing) | 'io' (가져오기·내보내기: stays, onDone refreshes the export). */
  function presetList() {
    const P = root.KANA_WORD_PRESETS;
    return Array.isArray(P) ? P.filter((x) => x && Array.isArray(x.words) && x.words.length) : [];
  }
  function presetBox(where, onDone) {
    const list = presetList();
    if (!list.length) return null;
    const box = h('div', { class: 'wpre' + (where === 'empty' ? ' is-empty' : '') });
    box.appendChild(h('p', { class: 'wpre-lead' }, where === 'empty' ? '정리해 둔 단어 목록을 한 번에 넣을 수 있어요.' : '정리해 둔 단어 목록을 한 번에 넣어요. 이미 있는 단어는 건너뛰어요.'));
    const ul = h('ul', { class: 'wpre-list' });
    list.forEach((preset, k) => {
      const hid = uid('wpre-h');
      const msg = h('p', { class: 'wpre-msg', 'aria-live': 'polite' });
      const st = presetStatus(preset, words());
      const status = h('span', { class: 'wpre-status' }, st.all ? '모두 들어 있어요' : st.present ? `${st.present}개는 이미 있어요` : '');
      const btn = h('button', { type: 'button', class: 'btn ' + (st.all ? '' : 'btn-primary'), 'aria-describedby': hid, 'data-preset': preset.id || '', 'data-autofocus': where === 'empty' && !k ? true : null, on: { click: () => {
        const r = Store.words.importJSON({ format: 'kana-practice-words', v: 1, words: importPresetWords(preset, Date.now()) });
        const m = presetMessage(r);
        toast(m.text);
        if (where === 'empty' && r.added) { go('list'); return; }
        msg.textContent = m.text;
        msg.classList.toggle('is-ok', m.ok);
        const s2 = presetStatus(preset, words());
        status.textContent = s2.all ? '모두 들어 있어요' : s2.present ? `${s2.present}개는 이미 있어요` : '';
        btn.classList.toggle('btn-primary', !s2.all);
        if (onDone) onDone(r);
      } } }, icon('io'), '불러오기');
      ul.appendChild(h('li', { class: 'wpre-item' },
        h('div', { class: 'wpre-text' },
          h('p', { class: 'wpre-title', id: hid }, h('b', null, preset.title || '단어 목록'), h('span', { class: 'wpre-count' }, ` · ${preset.words.length}개`)),
          preset.description ? h('p', { class: 'wpre-desc' }, preset.description) : null,
          status),
        h('div', { class: 'wpre-acts' }, btn),
        msg));
    });
    box.appendChild(ul);
    return box;
  }

  function insertExamples() {
    let added = 0;
    // newest first in the list: add in reverse, one per millisecond so the order is the EXAMPLES order (≤ ~11 ms)
    for (const ex of EXAMPLES.slice().reverse()) {
      const t0 = Date.now();
      const r = Store.words.add(ex);
      if (r && r.id) added++;
      while (Date.now() === t0) { /* next ms */ }
    }
    toast(added ? `예시 ${added}개를 넣었어요.` : '예시를 넣지 못했어요.');
    go('list');
  }

  function go(view, params) { App.go('words', Object.assign({ view }, params || {})); }

  function row(e) {
    const sum = entrySummary(e);
    const r = readingOf(e);
    const cbId = 'wl-cb-' + e.id;
    const checked = S.selected.has(e.id);
    const cb = h('input', {
      type: 'checkbox', class: 'wl-cb', id: cbId, checked: checked ? true : null,
      on: { change: (ev) => {
        if (ev.target.checked) S.selected.add(e.id); else S.selected.delete(e.id);
        saveSel();
        const li = ev.target.closest('.wl-row');
        if (li) li.classList.toggle('is-sel', ev.target.checked);
        if (S.updateSel) S.updateSel();
      } },
    });
    const cheatTagN = sum.cheat ? h('span', { class: 'cheat-tag' }, `컨닝 ${sum.cheat}`) : null;
    const marks = sum.n
      ? h('span', { class: 'wl-marks', title: `읽기 ○${sum.parts.read.o} ✕${sum.parts.read.x} · 쓰기 ○${sum.parts.write.o} △${sum.parts.write.t} ✕${sum.parts.write.x} · 한자 ○${sum.parts.kanji.o} △${sum.parts.kanji.t} ✕${sum.parts.kanji.x} · 뜻 ○${sum.parts.meaning.o} ✕${sum.parts.meaning.x}` },
        markChip('o', sum.o), sum.t ? markChip('t', sum.t) : null, markChip('x', sum.x), cheatTagN)
      // practised only with 컨닝 (a cheat ○ is not counted as ○): show that, not '연습 전'
      : cheatTagN ? h('span', { class: 'wl-marks' }, cheatTagN)
        : h('span', { class: 'wl-marks wl-marks-none' }, '연습 전');
    const label = (hasKanji(e) ? e.kanji + ' (' + e.text + ')' : e.text);
    return h('li', { class: 'wl-row' + (checked ? ' is-sel' : ''), 'data-paren': /\(/.test(r.hangul) ? '1' : null },
      h('label', { class: 'wl-check', for: cbId }, cb, srOnly(label + ' 연습에 넣기')),
      h('div', { class: 'wl-main' },
        h('div', { class: 'wl-word' }, wordFace(e, e.type === 'sentence' ? 'is-sentence' : ''), e.type === 'sentence' ? typeBadge('sentence') : null),
        h('p', { class: 'wl-read' }, h('span', { class: 'wl-romaji', lang: 'en' }, r.romaji), h('span', { class: 'wl-ko' }, r.hangul)),
        e.meaning ? h('p', { class: 'wl-mean' }, e.meaning) : h('p', { class: 'wl-mean is-empty' }, '뜻 없음'),
        e.tag || e.note ? h('p', { class: 'wl-meta' }, e.tag ? h('span', { class: 'wl-tag' }, '#' + e.tag) : null, e.note ? h('span', { class: 'wl-note' }, rich(e.note)) : null) : null),
      h('div', { class: 'wl-side' },
        marks,
        h('div', { class: 'wl-acts' },
          h('button', { type: 'button', class: 'btn btn-sm btn-quiet', 'aria-label': label + ' 고치기', on: { click: () => go('edit', { id: e.id }) } }, icon('edit'), h('span', { class: 'wl-act-text' }, '고치기')),
          h('button', { type: 'button', class: 'btn btn-sm btn-quiet wl-del', 'aria-label': label + ' 지우기', on: { click: () => deleteEntry(e) } }, icon('trash'), h('span', { class: 'wl-act-text' }, '지우기')))));
  }

  function deleteEntry(e, after) {
    const name = hasKanji(e) ? `${e.kanji}(${e.text})` : e.text;
    const sentence = e.type === 'sentence';
    App.confirm({
      title: sentence ? '문장을 지울까요?' : '단어를 지울까요?',
      // App.confirm puts the body into a <p> (nodes allowed): the Japanese in the textbook face
      body: rich(`「${name}」${e.meaning ? ' (' + displayMeaning(e) + ')' : ''} — ${sentence ? '이 문장과' : '이 단어와'} 연습 기록이 단어장에서 사라져요. 되돌릴 수 없어요.`),
      ok: '지우기', cancel: '취소', danger: true,
    }).then((yes) => {
      if (!yes) return;
      Store.words.remove(e.id);
      if (S.selected.delete(e.id)) saveSel();
      toast('지웠어요.');
      if (after) after(); else if (S.renderList) S.renderList();
    });
  }

  /* =================================================================== kana input (IME · 로마자 → 가나 · 키패드) */

  const PAD_ROWS = [
    ['あ', 'い', 'う', 'え', 'お'], ['か', 'き', 'く', 'け', 'こ'], ['さ', 'し', 'す', 'せ', 'そ'], ['た', 'ち', 'つ', 'て', 'と'], ['な', 'に', 'ぬ', 'ね', 'の'],
    ['は', 'ひ', 'ふ', 'へ', 'ほ'], ['ま', 'み', 'む', 'め', 'も'], ['や', null, 'ゆ', null, 'よ'], ['ら', 'り', 'る', 'れ', 'ろ'], ['わ', null, 'を', null, 'ん'],
  ];
  const PAD_SMALL = ['ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'っ', 'ゃ', 'ゅ', 'ょ'];

  /* opts: { id, value, label, describedBy, placeholder, mode: 'ime'|'romaji'|'pad', script, onInput(value), onMode(mode, script),
   *         compact (typed answers: smaller pad), enterKeyHint, onEnter() } */
  function kanaInput(opts) {
    const o = opts || {};
    const T = TX();
    const sample = typingSample(o.avoid);         // the help's example (o.avoid: the answer, in a question)
    let mode = ['ime', 'romaji', 'pad'].includes(o.mode) ? o.mode : 'ime';
    let script = o.script === 'kata' ? 'kata' : 'hira';
    let sel = { start: (o.value || '').length, end: (o.value || '').length };
    const input = h('input', {
      type: 'text', id: o.id, class: 'w-input ki-input jp', lang: 'ja', value: o.value || '', placeholder: o.placeholder || null,
      autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: o.enterKeyHint || null,
      'aria-describedby': o.describedBy || null,
    });
    const remember = () => { sel = { start: input.selectionStart == null ? input.value.length : input.selectionStart, end: input.selectionEnd == null ? input.value.length : input.selectionEnd }; };
    ['keyup', 'click', 'select', 'focus'].forEach((ev) => input.addEventListener(ev, remember));
    const emit = () => { remember(); if (o.onInput) o.onInput(input.value); };
    input.addEventListener('input', (e) => {
      if (mode === 'romaji' && !e.isComposing) {
        const caret = input.selectionStart == null ? input.value.length : input.selectionStart;
        const r = liveRomaji(input.value, caret, script);
        if (r.value !== input.value) {
          input.value = r.value;
          try { input.setSelectionRange(r.caret, r.caret); } catch (err) { /* ignore */ }
        }
      }
      emit();
    });
    input.addEventListener('compositionend', () => emit());
    input.addEventListener('blur', () => { remember(); if (mode === 'romaji') finalizeRomaji(); });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      if (o.onEnter) { e.preventDefault(); if (mode === 'romaji') finalizeRomaji(); o.onEnter(); }
    });

    function finalizeRomaji() {
      const r = liveRomaji(input.value, input.value.length, script, true);
      if (r.value !== input.value) { input.value = r.value; emit(); }
    }

    const modeBtns = {};
    const modeBar = h('div', { class: 'ki-modes', role: 'group', 'aria-label': '입력 방법' },
      [['ime', '키보드'], ['romaji', '로마자 → 가나'], ['pad', '가나 키패드']].map(([m, label]) => {
        const b = h('button', { type: 'button', class: 'chip ki-mode', 'aria-pressed': 'false', on: { click: () => { setMode(m); notifyMode(); } } }, label);
        modeBtns[m] = b;
        return b;
      }));
    const scriptBtns = {};
    const scriptBar = h('div', { class: 'ki-script', role: 'group', 'aria-label': '문자' },
      [['hira', 'ひらがな'], ['kata', 'カタカナ']].map(([s, label]) => {
        const b = h('button', { type: 'button', class: 'chip ki-scr', lang: 'ja', 'aria-pressed': 'false', on: { click: () => { setScript(s); notifyMode(); } } }, jp(label));
        scriptBtns[s] = b;
        return b;
      }));
    const help = h('p', { class: 'ki-help' });
    const pad = h('div', { class: 'ki-pad' + (o.compact ? ' is-compact' : ''), role: 'group', 'aria-label': '가나 키패드' });
    const el = h('div', { class: 'ki' }, input, o.after || null, h('div', { class: 'ki-bar' }, modeBar, scriptBar), help, pad);

    function key(label, act, cls, aria) {
      return h('button', { type: 'button', class: 'ki-key ' + (cls || ''), 'data-act': act, 'aria-label': aria || null, lang: /^[぀-ヿ]/.test(label) ? 'ja' : null }, label);
    }
    function buildPad() {
      pad.textContent = '';
      const conv = (ch) => (script === 'kata' && T.toKatakana ? T.toKatakana(ch) : ch);
      const blocks = [PAD_ROWS.slice(0, 5), PAD_ROWS.slice(5)].map((rows) => h('div', { class: 'ki-block' },
        rows.map((r) => r.map((ch) => (ch ? key(conv(ch), 'ins:' + conv(ch), 'is-kana') : h('span', { class: 'ki-gap', 'aria-hidden': 'true' }))))));
      pad.appendChild(h('div', { class: 'ki-blocks' }, blocks));
      pad.appendChild(h('div', { class: 'ki-row ki-small' }, PAD_SMALL.map((ch) => key(conv(ch), 'ins:' + conv(ch), 'is-kana is-small', '작은 ' + conv(ch)))));
      pad.appendChild(h('div', { class: 'ki-row ki-mods' },
        key('゛', 'daku', 'is-mod', '탁점 ゛ (앞 글자에 붙이기)'),
        key('゜', 'handaku', 'is-mod', '반탁점 ゜ (앞 글자에 붙이기)'),
        key('小', 'small', 'is-mod', '작은 글자로 바꾸기'),
        key('ー', 'ins:ー', 'is-kana', '장음 ー'),
        key('、', 'ins:、', 'is-kana', '쉼표 、'),
        key('。', 'ins:。', 'is-kana', '마침표 。'),
        key('띄어쓰기', 'ins: ', 'is-space'),
        key('⌫', 'back', 'is-back', '한 글자 지우기')));
    }
    // keep the input's focus / caret while tapping keys
    pad.addEventListener('mousedown', (e) => { if (e.target.closest('.ki-key')) e.preventDefault(); });
    pad.addEventListener('click', (e) => {
      const b = e.target.closest('.ki-key');
      if (!b) return;
      const act = b.dataset.act;
      const focused = document.activeElement === input;
      const a = focused ? input.selectionStart : sel.start, z = focused ? input.selectionEnd : sel.end;
      let r = null;
      if (act.startsWith('ins:')) r = insertText(input.value, a, z, act.slice(4));
      else if (act === 'back') r = backspaceText(input.value, a, z);
      else if (act === 'daku') r = modifyBefore(input.value, a, (ch) => toggleMark(ch, '゛'));
      else if (act === 'handaku') r = modifyBefore(input.value, a, (ch) => toggleMark(ch, '゜'));
      else if (act === 'small') r = modifyBefore(input.value, a, toggleSmall);
      if (!r) return;
      input.value = r.value;
      sel = { start: r.caret, end: r.caret };
      if (focused) { try { input.setSelectionRange(r.caret, r.caret); } catch (err) { /* ignore */ } }
      if (o.onInput) o.onInput(input.value);
    });

    function setMode(m) {
      if (mode === 'romaji' && m !== 'romaji') finalizeRomaji();
      mode = m;
      Object.keys(modeBtns).forEach((k) => modeBtns[k].setAttribute('aria-pressed', k === mode ? 'true' : 'false'));
      // the on-screen pad suppresses the device keyboard (inputmode none) but keeps the caret
      if (mode === 'pad') input.setAttribute('inputmode', 'none'); else input.removeAttribute('inputmode');
      input.setAttribute('lang', mode === 'romaji' ? 'en' : 'ja');
      pad.hidden = mode !== 'pad';
      scriptBar.hidden = mode === 'ime';
      help.textContent = '';
      add(help, rich(mode === 'romaji' ? `로마자로 치면 바로 가나로 바뀌어요: ${sample.romaji} → ${sample.kana}, kko → っこ, nn → ん (다음 글자를 칠 때 바뀌어요), - → ー, . → 。`
        : mode === 'pad' ? '키패드를 눌러 입력해요. ゛゜小는 바로 앞 글자를 바꿔요 (か → が, つ → っ).'
          : '기기의 일본어 키보드(IME)로 입력하거나 붙여 넣어요.'));
      if (mode === 'pad') buildPad();
    }
    function setScript(s) {
      script = s === 'kata' ? 'kata' : 'hira';
      Object.keys(scriptBtns).forEach((k) => scriptBtns[k].setAttribute('aria-pressed', k === script ? 'true' : 'false'));
      if (mode === 'pad') buildPad();
    }
    function notifyMode() { if (o.onMode) o.onMode(mode, script); }
    setScript(script);
    setMode(mode);

    return {
      el, input,
      getValue() { if (mode === 'romaji') finalizeRomaji(); return input.value; },
      peekValue: () => input.value,
      setValue(v) { input.value = v || ''; sel = { start: input.value.length, end: input.value.length }; },
      pendingTail: () => mode === 'romaji' && /[A-Za-z]$/.test(input.value.slice(0, input.selectionStart == null ? input.value.length : input.selectionStart)),
      focus: () => focusEl(input),
      setReadOnly(v) { input.readOnly = !!v; pad.classList.toggle('is-off', !!v); Array.from(pad.querySelectorAll('button')).forEach((b) => { b.disabled = !!v; }); },
      getMode: () => mode,
    };
  }

  /* =================================================================== add / edit form */

  VIEWS.edit = function (main, p) {
    const T = TX();
    const editing = p.id ? Store.words.get(p.id) : null;
    if (p.id && !editing) {
      main.appendChild(h('div', { class: 'wf-page' }, h('h1', { class: 'page-title' }, '단어를 찾을 수 없어요'),
        h('p', { class: 'page-sub' }, '다른 기기에서 지워졌을 수 있어요.'),
        h('button', { type: 'button', class: 'btn', on: { click: () => go('list') } }, icon('back'), '단어장으로')));
      return;
    }
    const e0 = editing || {};
    const pr = prefs();
    S.editDirty = false;
    const dirty = () => { S.editDirty = true; };

    // ---- 가나 (required)
    const kanaErr = h('p', { class: 'wf-err', id: 'wf-kana-err', 'aria-live': 'polite' });
    const kanaPreview = h('p', { class: 'wf-preview', id: 'wf-kana-prev', 'aria-live': 'polite' });
    const dupNote = h('p', { class: 'wf-note-warn', 'aria-live': 'polite' });
    const ki = kanaInput({
      id: 'wf-kana', value: e0.text || '', mode: pr.inputMode || 'ime', script: pr.inputScript || 'hira',
      describedBy: 'wf-kana-err wf-kana-prev', placeholder: '예: がくせい', after: [kanaErr, kanaPreview, dupNote],
      onInput: () => { dirty(); liveKanji(); },
      onMode: (m, sc) => savePrefs(Object.assign(prefs(), { inputMode: m, inputScript: sc })),
    });

    // ---- 한자 표기 (optional)
    const kanjiIn = h('input', { type: 'text', id: 'wf-kanji', class: 'w-input jp', lang: 'ja', value: e0.kanji || '', placeholder: '예: 学生 (없으면 비워 두세요)', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'wf-kanji-err wf-kanji-prev' });
    const kanjiErr = h('p', { class: 'wf-err', id: 'wf-kanji-err', 'aria-live': 'polite' });
    const kanjiPreview = h('div', { class: 'wf-preview', id: 'wf-kanji-prev' });
    kanjiIn.addEventListener('input', () => { dirty(); liveKanji(); });

    // ---- 뜻
    const meaningIn = h('input', { type: 'text', id: 'wf-meaning', class: 'w-input', value: e0.meaning || '', placeholder: '예: 학생', autocomplete: 'off', 'aria-describedby': 'wf-meaning-help wf-meaning-err' });
    const meaningErr = h('p', { class: 'wf-err', id: 'wf-meaning-err', 'aria-live': 'polite' });
    const meaningChips = h('p', { class: 'wf-chips', 'aria-live': 'polite' });
    meaningIn.addEventListener('input', () => { dirty(); liveMeaning(); });

    // ---- 읽기 고치기 / 메모 / 태그 / 종류
    const readingIn = h('input', { type: 'text', id: 'wf-reading', class: 'w-input', value: e0.reading || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-describedby': 'wf-reading-help wf-reading-err' });
    const readingErr = h('p', { class: 'wf-err', id: 'wf-reading-err', 'aria-live': 'polite' });
    readingIn.addEventListener('input', () => { dirty(); liveKana(); });
    // 다른 읽기 (SPEC-words K: 何 なに／なん) — kana, split at / or , ; romaji is turned into hiragana
    const altsIn = h('input', { type: 'text', id: 'wf-alts', class: 'w-input jp', lang: 'ja', value: (e0.alts || []).join(' / '), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: '예: なん', 'aria-describedby': 'wf-alts-help wf-alts-err' });
    const altsErr = h('p', { class: 'wf-err', id: 'wf-alts-err', 'aria-live': 'polite' });
    const altsPreview = h('p', { class: 'wf-chips', 'aria-live': 'polite' });
    altsIn.addEventListener('input', () => { dirty(); liveAlts(); });
    altsIn.addEventListener('blur', () => {
      const parsed = altsFieldParse(altsIn.value, curText(), altsOpt());
      if (!parsed.bad.length && parsed.alts.length && LATIN_RE.test(altsIn.value)) { altsIn.value = parsed.alts.join(' / '); liveAlts(); }
    });
    const noteIn = h('textarea', { id: 'wf-note', class: 'w-input w-textarea', rows: 2, 'aria-describedby': 'wf-note-err' });
    noteIn.value = e0.note || '';
    noteIn.addEventListener('input', dirty);
    const noteErr = h('p', { class: 'wf-err', id: 'wf-note-err', 'aria-live': 'polite' });
    const tagList = uid('wf-tags');
    const tagIn = h('input', { type: 'text', id: 'wf-tag', class: 'w-input', value: e0.tag || '', placeholder: '예: 1과, 음식', maxlength: 30, list: tagList, autocomplete: 'off', 'aria-describedby': 'wf-tag-err' });
    tagIn.addEventListener('input', dirty);
    const tagErr = h('p', { class: 'wf-err', id: 'wf-tag-err', 'aria-live': 'polite' });
    const tagData = h('datalist', { id: tagList }, tagsOf(words()).tags.map((t) => h('option', { value: t.tag })));
    let type = editing ? (editing.type === T.autoType(editing.text) ? 'auto' : editing.type) : 'auto';
    const typeBox = h('div', { class: 'wf-type' });
    function renderType() {
      typeBox.textContent = '';
      const auto = T.autoType(T.normalize(ki.peekValue())) === 'sentence' ? '문장' : '단어';
      typeBox.appendChild(segmented('wftype', '종류', [
        { value: 'auto', label: `자동 (${auto})` }, { value: 'word', label: '단어' }, { value: 'sentence', label: '문장' },
      ], type, (v) => { type = v; dirty(); liveKana(); }));
    }

    const errs = { text: kanaErr, kanji: kanjiErr, meaning: meaningErr, reading: readingErr, note: noteErr, tag: tagErr, alts: altsErr };
    const inputs = { text: ki.input, kanji: kanjiIn, meaning: meaningIn, reading: readingIn, note: noteIn, tag: tagIn, alts: altsIn };

    function curType() {
      return type === 'auto' ? T.autoType(T.normalize(ki.peekValue())) : type;
    }
    const altsOpt = () => ({ sentence: curType() === 'sentence' });

    function liveKana() {
      const v = ki.peekValue();
      const r = kanaFieldError(v, ki.pendingTail());
      showKanaError(r);
      kanaPreview.textContent = '';
      if (r.ok) {
        const entry = { text: r.normalized, reading: readingIn.value.trim(), type: curType() };
        const ex = readingOf(entry);
        kanaPreview.appendChild(h('span', { class: 'wf-prev-label' }, readingIn.value.trim() ? '읽기 (고친 읽기): ' : '읽기: '));
        kanaPreview.appendChild(h('span', { class: 'wf-romaji', lang: 'en' }, ex.romaji));
        kanaPreview.appendChild(document.createTextNode(' · '));
        kanaPreview.appendChild(h('span', { class: 'wf-ko' }, ex.hangul));
        kanaPreview.appendChild(h('span', { class: 'wf-cells' }, ` · ${T.cells(r.normalized).filter((c) => c.kind === 'write').length}칸`));
        readingIn.placeholder = '자동: ' + T.toRomaji(r.normalized, { sentence: curType() === 'sentence' });
        // same word already in the list?
        const k = kanjiIn.value.trim();
        const dup = words().find((w) => w.id !== e0.id && w.text === r.normalized && (w.kanji || '') === (T.validateKanji(k).normalized || ''));
        dupNote.textContent = dup ? `이미 단어장에 있는 단어예요${dup.meaning ? ' (' + displayMeaning(dup) + ')' : ''}. 그래도 저장할 수 있어요.` : '';
      } else {
        readingIn.placeholder = '자동 읽기와 다를 때만 적어요';
        dupNote.textContent = '';
      }
      renderTypeLabel();
      liveAlts();
    }
    // The kana field's error: what kind of character was rejected, which ones, and where kanji go instead.
    function showKanaError(r) {
      kanaErr.textContent = '';
      ki.input.classList.toggle('is-bad', !r.ok && !r.empty);
      ki.input.setAttribute('aria-invalid', !r.ok && !r.empty ? 'true' : 'false');
      if (r.ok || r.empty) return;
      add(kanaErr, rich(r.message));
      if (r.bad && r.bad.length) kanaErr.appendChild(h('span', { class: 'wf-bad' }, ' 쓸 수 없는 글자: ', r.bad.slice(0, 8).map((ch) => h('b', null, ch === ' ' ? '␣' : ch)).reduce((acc, x, i) => acc.concat(i ? [' ', x] : [x]), [])));
      if (r.kanjiHint) kanaErr.appendChild(h('span', { class: 'wf-hint' }, ' 한자는 아래 「한자 표기」 칸에 적어 주세요.'));
    }
    let lastAuto = null;
    function renderTypeLabel() {
      const auto = T.autoType(T.normalize(ki.peekValue()));
      if (auto !== lastAuto) { lastAuto = auto; renderType(); }
    }

    let kanjiTok = 0;
    function liveKanji() {
      const r = kanjiFieldError(kanjiIn.value);
      kanjiErr.textContent = '';
      kanjiIn.classList.toggle('is-bad', !r.ok);
      kanjiIn.setAttribute('aria-invalid', !r.ok ? 'true' : 'false');
      if (!r.ok) {
        kanjiErr.appendChild(document.createTextNode(r.message));
        if (r.bad && r.bad.length) kanjiErr.appendChild(h('span', { class: 'wf-bad' }, ' 쓸 수 없는 글자: ', r.bad.slice(0, 8).join(' ')));
      }
      liveKana();                  // → liveAlts → renderKanjiPreview
    }
    // 「목록에서는 이렇게 보여요」: the kanji form with every accepted reading as furigana (何 なに／なん), as the list shows it
    function renderKanjiPreview() {
      const tok = ++kanjiTok;
      const r = kanjiFieldError(kanjiIn.value);
      kanjiPreview.textContent = '';
      const kr = kanaFieldError(ki.peekValue(), ki.pendingTail());
      if (r.ok && !r.empty) {
        const entry = { text: kr.ok ? kr.normalized : '', kanji: r.normalized, alts: kr.ok ? altsFieldParse(altsIn.value, kr.normalized, altsOpt()).alts : [] };
        kanjiPreview.appendChild(h('span', { class: 'wf-prev-label' }, '목록에서는 이렇게 보여요: '));
        kanjiPreview.appendChild(kr.ok ? wordFace(entry, 'wf-ruby') : jp(r.normalized, 'wface'));
        const chars = Array.from(r.normalized).filter((ch) => T.isKanjiForm(ch));
        ensureKanji().then((ok) => {
          if (!ok || tok !== kanjiTok || !kanjiPreview.isConnected) return;
          const KJ = root.KanjiJudge;
          const missing = chars.filter((ch) => !KJ.has(ch));
          if (missing.length) kanjiPreview.appendChild(h('span', { class: 'wf-hint' }, rich(` 획 데이터가 없는 한자(${missing.join(' ')})는 손글씨 채점에서 빼요.`)));
        });
      }
    }

    function curText() {
      const kr = kanaFieldError(ki.peekValue(), ki.pendingTail());
      return kr.ok ? kr.normalized : '';
    }
    // 다른 읽기: its message, the chips of every accepted reading (the kana text first), and the kanji preview's furigana.
    // Run again whenever the kana text changes too (an alt equal to the new text is no longer an alt).
    function liveAlts() {
      const t = curText();
      const r = altsFieldParse(altsIn.value, t, altsOpt());
      altsErr.textContent = '';
      altsPreview.textContent = '';
      altsIn.classList.toggle('is-bad', !!r.message);
      altsIn.setAttribute('aria-invalid', r.message ? 'true' : 'false');
      if (r.message) {
        altsErr.appendChild(document.createTextNode(r.message));
        if (r.bad.length) altsErr.appendChild(h('span', { class: 'wf-bad' }, ' 쓸 수 없는 글자: ', r.bad.slice(0, 8).join(' ')));
      } else if (r.alts.length) {
        altsPreview.appendChild(h('span', { class: 'wf-prev-label' }, '정답으로 인정하는 읽기: '));
        [t].concat(r.alts).filter(Boolean).forEach((x, i) => altsPreview.appendChild(h('span', { class: 'wf-chip' + (i === 0 ? ' is-main' : ''), lang: 'ja' }, x)));
      }
      renderKanjiPreview();
    }

    function liveMeaning() {
      meaningChips.textContent = '';
      const list = meaningsOf(meaningIn.value);
      if (list.length > 1) {
        meaningChips.appendChild(h('span', { class: 'wf-prev-label' }, '정답으로 인정: '));
        list.forEach((m, i) => meaningChips.appendChild(h('span', { class: 'wf-chip' + (i === 0 ? ' is-main' : '') }, m)));
        meaningChips.appendChild(h('span', { class: 'wf-hint' }, ' (첫 번째가 대표 뜻)'));
      }
    }

    function collect() {
      return {
        text: ki.getValue(), kanji: kanjiIn.value, meaning: meaningIn.value, reading: readingIn.value,
        note: noteIn.value, tag: tagIn.value, type: type === 'auto' ? null : type,
        alts: altsFieldParse(altsIn.value, '', altsOpt()).alts,
      };
    }

    function showError(r) {
      const f = r.field && errs[r.field] ? r.field : 'text';
      errs[f].textContent = r.message || '저장하지 못했어요.';
      if (inputs[f]) { inputs[f].setAttribute('aria-invalid', 'true'); focusEl(inputs[f]); }
      if (f === 'reading' || f === 'note' || f === 'alts') details.open = true;
    }

    function save(again) {
      Object.values(errs).forEach((x) => { x.textContent = ''; });
      const input = collect();
      const kr = kanaFieldError(input.text, false);
      if (kr.empty) { showError({ field: 'text', message: '가나를 입력해 주세요.' }); return; }
      // the field's own message (names Hangul / 영문 / 기호 …) rather than the store's generic one
      if (!kr.ok) { showKanaError(kr); focusEl(ki.input); return; }
      const ar = altsFieldParse(altsIn.value, kr.normalized, altsOpt());
      if (ar.message) { showError({ field: 'alts', message: ar.message }); liveAlts(); return; }
      const res = editing ? Store.words.update(editing.id, input) : Store.words.add(input);
      if (!res || res.error !== undefined || !res.id) { showError(res || {}); return; }
      S.editDirty = false;
      toast(editing ? '고쳤어요.' : `단어장에 넣었어요: ${res.kanji || res.text}`);
      if (again) go('edit', {}); else go('list');
    }

    const details = h('details', { class: 'more wf-more', open: e0.reading || e0.note || (e0.alts && e0.alts.length) ? true : null },
      h('summary', null, '다른 읽기 · 읽기 고치기 · 메모'),
      field('wf-alts', '다른 읽기 (선택)', altsIn, h('p', { class: 'field-help', id: 'wf-alts-help' }, rich('같은 단어를 다르게 읽을 수도 있을 때 적어요 (何 → なに / なん). 여러 개는 / 로 나누고, 5개까지 돼요. 쓰기·한자 읽기에서 모두 정답으로 인정해요.')), altsErr, altsPreview),
      field('wf-reading', '읽기 고치기 (선택)', readingIn, h('p', { class: 'field-help', id: 'wf-reading-help' }, rich('자동 읽기와 다를 때만 적어요. 예: わたしは를 단어로 넣었을 때 「watashi wa」. 로마자·가나·한글 모두 돼요.')), readingErr),
      field('wf-note', '메모 (선택)', noteIn, null, noteErr));

    const form = h('form', { class: 'card wf', novalidate: true, on: { submit: (ev) => { ev.preventDefault(); save(false); } } },
      field('wf-kana', h('span', null, '가나 ', h('span', { class: 'wf-req' }, '(필수)')), ki.el, null),
      field('wf-kanji', '한자 표기 (선택)', kanjiIn, h('p', { class: 'field-help' }, rich('한자가 섞인 표기예요 (学生, 食べる). 일본어 키보드로 치거나 붙여 넣으세요. 한자 읽기 연습과 「한자 섞어 쓰기」에 쓰여요.')), kanjiErr, kanjiPreview),
      field('wf-meaning', '뜻 (한국어)', meaningIn, h('p', { class: 'field-help', id: 'wf-meaning-help' }, '여러 뜻은 쉼표(,) · 빗금(/) · 세미콜론(;) · 가운뎃점(·)으로 나눠요. 쓰기 연습에서는 이 뜻을 보고 일본어로 써요.'), meaningErr, meaningChips),
      h('div', { class: 'wf-row2' },
        field('wf-tag', '태그 (선택)', tagIn, null, tagErr, tagData),
        typeBox),
      details,
      h('div', { class: 'wf-actions' },
        editing ? h('button', { type: 'button', class: 'btn btn-danger-quiet', on: { click: () => deleteEntry(editing, () => { S.editDirty = false; go('list'); }) } }, icon('trash'), '지우기') : null,
        h('span', { class: 'wf-gap' }),
        h('button', { type: 'button', class: 'btn btn-quiet', on: { click: cancel } }, '취소'),
        editing ? null : h('button', { type: 'button', class: 'btn', on: { click: () => save(true) } }, '저장하고 하나 더'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, '저장')));

    function cancel() {
      if (!S.editDirty) { go('list'); return; }
      App.confirm({ title: '작성 중인 내용을 버릴까요?', body: '저장하지 않은 내용은 사라져요.', ok: '버리기', cancel: '계속 쓰기', danger: true })
        .then((yes) => { if (yes) { S.editDirty = false; go('list'); } });
    }

    main.appendChild(h('div', { class: 'wf-page' },
      h('header', { class: 'page-head' },
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet wf-back', on: { click: cancel } }, icon('back'), '단어장'),
        h('h1', { class: 'page-title' }, editing ? '단어 고치기' : '단어 추가'),
        h('p', { class: 'page-sub' }, '가나는 꼭 적어야 하고, 나머지는 선택이에요.')),
      form));
    ki.input.setAttribute('data-autofocus', '');
    renderType();
    liveKana();
    liveKanji();
    liveMeaning();
    liveAlts();
    S.editDirty = false;
  };

  function field(id, label, control, help, ...rest) {
    return h('div', { class: 'wf-field' },
      h('label', { class: 'wf-label', for: id }, label),
      help, control, rest);
  }

  /* =================================================================== 가져오기 · 내보내기 */

  VIEWS.io = function (main) {
    const exportTa = h('textarea', { class: 'w-input w-textarea wio-ta', id: 'wio-export', rows: 8, readonly: true, spellcheck: 'false', 'aria-describedby': 'wio-export-help' });
    exportTa.value = Store.words.exportJSON();
    const copyMsg = h('p', { class: 'wio-msg', 'aria-live': 'polite' });
    const copyBtn = h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => {
      const text = exportTa.value;
      const fallback = () => {
        exportTa.focus();
        exportTa.select();
        let ok = false;
        try { ok = !!(document.execCommand && document.execCommand('copy')); } catch (e) { ok = false; }
        copyMsg.textContent = ok ? '복사했어요.' : '내용을 모두 선택해 두었어요. 복사(Ctrl+C, 또는 길게 눌러 복사)해 주세요.';
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => { copyMsg.textContent = '복사했어요. 다른 기기의 「가져오기」에 붙여 넣으세요.'; }, fallback);
        } else fallback();
      } catch (e) { fallback(); }
    } } }, icon('copy'), '복사하기');

    const importTa = h('textarea', { class: 'w-input w-textarea wio-ta', id: 'wio-import', rows: 6, spellcheck: 'false', placeholder: '내보내기로 만든 내용을 여기에 붙여 넣으세요.', 'aria-describedby': 'wio-import-help' });
    const importMsg = h('div', { class: 'wio-msg', 'aria-live': 'polite' });
    const importBtn = h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => {
      importMsg.textContent = '';
      if (!importTa.value.trim()) { importMsg.textContent = '붙여 넣은 내용이 없어요.'; return; }
      const r = Store.words.importJSON(importTa.value);
      const parts = [];
      if (r.added) parts.push(`${r.added}개를 새로 넣었어요`);
      if (r.updated) parts.push(`${r.updated}개를 최신 내용으로 맞췄어요`);
      if (r.skipped) parts.push(`${r.skipped}개는 이미 있어서 건너뛰었어요`);
      const fatal = r.errors && r.errors.length && r.errors[0].index < 0;
      if (parts.length || !fatal) importMsg.appendChild(h('p', { class: r.added || r.updated ? 'is-ok' : '' }, parts.length ? parts.join(' · ') + '.' : '가져온 단어가 없어요.'));
      if (r.errors && r.errors.length) {
        importMsg.appendChild(h('ul', { class: 'wio-errs' }, r.errors.slice(0, 8).map((er) => h('li', null, (er.index >= 0 ? `${er.index + 1}번째` + (er.text ? ` (${er.text})` : '') + ': ' : '') + er.message))));
        if (r.errors.length > 8) importMsg.appendChild(h('p', null, `그 밖에 ${r.errors.length - 8}개 오류`));
      }
      if (r.added || r.updated) {
        importTa.value = '';
        exportTa.value = Store.words.exportJSON();
        exportH.textContent = `내보내기 (${words().length}개)`;
      }
    } } }, '가져오기');

    const exportH = h('h2', { class: 'card-h', id: 'wio-ex-h' }, `내보내기 (${words().length}개)`);
    main.appendChild(h('div', { class: 'wio-page' },
      h('header', { class: 'page-head' },
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet wf-back', on: { click: () => go('list') } }, icon('back'), '단어장'),
        h('h1', { class: 'page-title' }, '가져오기 · 내보내기'),
        h('p', { class: 'page-sub' }, '파일 없이 글(JSON)로 옮겨요. 다른 기기나 브라우저로 단어장을 옮길 때 써요.')),
      presetList().length ? h('section', { class: 'card wio-sec wio-presets', 'aria-labelledby': 'wio-pre-h' },
        h('h2', { class: 'card-h', id: 'wio-pre-h' }, '단어 목록 불러오기'),
        presetBox('io', (r) => {
          if (!r.added && !r.updated) return;
          exportTa.value = Store.words.exportJSON();
          exportH.textContent = `내보내기 (${words().length}개)`;
        })) : null,
      h('div', { class: 'wio-grid' },
        h('section', { class: 'card wio-sec', 'aria-labelledby': 'wio-ex-h' },
          exportH,
          h('p', { class: 'sec-note', id: 'wio-export-help' }, '아래 내용을 복사해서 다른 곳의 「가져오기」에 붙여 넣으세요. 단어마다 연습 기록도 함께 옮겨져요.'),
          h('label', { for: 'wio-export', class: 'sr-only' }, '내보낸 단어장 (JSON)'),
          exportTa,
          h('div', { class: 'wio-acts' }, copyBtn), copyMsg),
        h('section', { class: 'card wio-sec', 'aria-labelledby': 'wio-im-h' },
          h('h2', { class: 'card-h', id: 'wio-im-h' }, '가져오기'),
          h('p', { class: 'sec-note', id: 'wio-import-help' }, '같은 단어(같은 id)는 더 최근에 고친 쪽으로 맞추고, 연습 기록은 두 번 세지 않아요.'),
          h('label', { for: 'wio-import', class: 'sr-only' }, '가져올 단어장 (JSON)'),
          importTa,
          h('div', { class: 'wio-acts' }, importBtn), importMsg))));
  };

  /* =================================================================== 연습 설정 */

  function sourceEntries(pr, p) {
    const all = words();
    const selected = all.filter((e) => S.selected.has(e.id));
    const listed = filterEntries(all, { query: S.query, kind: S.kind, tag: S.tag });
    const want = (p && p.source) || pr.source;
    const useSel = selected.length > 0 && want !== 'list';
    return { all, selected, listed, useSel, base: useSel ? selected : listed, filtered: !!(S.query || S.kind !== 'all' || S.tag) };
  }

  VIEWS.setup = function (main, p) {
    let pr = prefs();
    if (p && p.source) pr.source = p.source;
    const box = h('div', { class: 'ws-body' });
    const page = h('div', { class: 'ws-page' },
      h('header', { class: 'page-head' },
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet wf-back', on: { click: () => go('list') } }, icon('back'), '단어장'),
        h('h1', { class: 'page-title' }, '단어 연습'),
        h('p', { class: 'page-sub' }, '읽기, 한국어 보고 쓰기, 한자 읽기 중에서 골라요.')),
      box);
    main.appendChild(page);

    function set(k, v) { pr[k] = v; savePrefs(pr); draw(); }

    function draw() {
      const src = sourceEntries(pr, null);
      const pool = practicePool(src.base, pr);
      const kanjiCount = practicePool(src.base, Object.assign({}, pr, { mode: 'kanji' })).length;
      // the whole body is rebuilt on every change: put the keyboard focus back on the same control
      const a = document.activeElement;
      const fk = a && box.contains(a) && a.getAttribute('data-k') ? { k: a.getAttribute('data-k'), v: a.type === 'radio' ? a.value : null } : null;
      box.textContent = '';
      if (!src.all.length) {
        box.appendChild(h('div', { class: 'card' }, h('p', null, '단어장이 비어 있어요. 먼저 단어를 넣어 주세요.'),
          h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => go('list') } }, '단어장으로')));
        return;
      }
      const modeBtn = (m, title, desc, glyph, disabled, hint) => h('button', {
        type: 'button', class: 'ws-mode' + (pr.mode === m ? ' is-on' : ''), 'aria-pressed': pr.mode === m ? 'true' : 'false', 'data-k': 'mode-' + m,
        disabled: disabled ? true : null, on: { click: () => set('mode', m) },
      }, h('span', { class: 'ws-mode-glyph jp', lang: 'ja', 'aria-hidden': 'true' }, glyph),
      h('span', { class: 'ws-mode-text' }, h('span', { class: 'ws-mode-title' }, title), h('span', { class: 'ws-mode-desc' }, disabled && hint ? hint : desc)));

      // which tags the selection spans: '시간·숫자 40 · 지시어 21'
      const selTags = src.selected.length ? selectionTagsLine(src.all, new Set(src.selected.map((e) => e.id))) : '';
      const target = h('section', { class: 'card ws-sec', 'aria-labelledby': 'ws-src-h' },
        h('h2', { class: 'card-h', id: 'ws-src-h' }, '연습할 단어'),
        src.selected.length ? segmented('wsrc', { sr: '연습할 단어 범위' }, [
          { value: 'selected', label: `선택한 단어 (${src.selected.length})` },
          { value: 'list', label: (src.filtered ? '지금 목록' : '단어장 전체') + ` (${src.listed.length})` },
        ], src.useSel ? 'selected' : 'list', (v) => set('source', v)) : h('p', { class: 'sec-note' }, src.filtered ? `단어장에서 지금 보이는 목록 (${src.listed.length}개)` : `단어장 전체 (${src.listed.length}개)`),
        selTags ? h('p', { class: 'ws-seltags' }, h('span', { class: 'ws-seltags-k' }, '선택한 단어의 태그:'), ' ', selTags) : null,
        segmented('wkinds', '종류', [{ value: 'both', label: '둘 다' }, { value: 'word', label: '단어만' }, { value: 'sentence', label: '문장만' }], pr.kinds, (v) => set('kinds', v)));

      const modes = h('section', { class: 'card ws-sec', 'aria-labelledby': 'ws-mode-h' },
        h('h2', { class: 'card-h', id: 'ws-mode-h' }, '연습 방법'),
        h('div', { class: 'ws-modes' },
          modeBtn('read', '단어 읽기', '가나를 보고 발음 입력 (로마자·한글)', 'あ'),
          modeBtn('write', '쓰기', '한국어 뜻을 보고 일본어로 쓰기 (원고지)', '書'),
          modeBtn('kanji', '한자 읽기', '한자를 보고 읽는 법을 히라가나로 쓰기 + 뜻 맞히기', '漢', !kanjiCount, '한자 표기가 있는 단어가 없어요. 단어를 고쳐서 한자 표기를 넣어 보세요.')));

      const opts = h('section', { class: 'card ws-sec', 'aria-labelledby': 'ws-opt-h' }, h('h2', { class: 'card-h', id: 'ws-opt-h' }, '설정'));
      opts.appendChild(segmented('wcount', '문제 수', [
        { value: 10, label: '10' }, { value: 20, label: '20' }, { value: 30, label: '30' }, { value: 'all', label: '전체' },
        { value: 'endless', label: '∞ 무한', aria: '무한 — 그만할 때까지' },
      ], pr.count, (v) => set('count', v), 'seg-count'));
      opts.appendChild(toggleRow('틀린 것 위주', '자주 틀린 단어를 더 자주 내요.', pr.focusWrong, (v) => set('focusWrong', v), 'focusWrong'));
      if (pr.mode === 'read') {
        opts.appendChild(toggleRow('뜻도 맞히기', '발음을 맞힌 다음 한국어 뜻도 물어봐요.', pr.withMeaning, (v) => set('withMeaning', v), 'withMeaning'));
        if (pr.withMeaning) opts.appendChild(meaningModeSeg());
      } else if (pr.mode === 'write') {
        opts.appendChild(segmented('wans', '답 입력', [{ value: 'pen', label: '손글씨 (원고지)' }, { value: 'type', label: '타자' }], pr.answerInput, (v) => set('answerInput', v)));
        opts.appendChild(h('p', { class: 'seg-hint ws-hint' }, rich(pr.answerInput === 'pen'
          ? '히라가나 · 가타카나 · 한자 섞인 표기 모두 정답이에요. 원고지 칸은 답의 글자 수와 상관없이 계속 생겨요 — 다 쓰면 「채점」을 누르세요.'
          : '히라가나 · 가타카나 · 한자 섞인 표기 모두 정답이에요. 로마자로 치면 가나로 바뀌어요 (tesuto → てすと).')));
        opts.appendChild(segmented('wview', '문제 보기', [{ value: 'ko', label: '한국어만' }, { value: 'ko+read', label: '한국어 + 발음' }], pr.promptView, (v) => set('promptView', v)));
        opts.appendChild(h('p', { class: 'seg-hint ws-hint' }, pr.promptView === 'ko+read'
          ? '발음(로마자)을 처음부터 보여 줘요. 「힌트」로는 글자 수를 볼 수 있어요.'
          : '「힌트」를 누를 때마다 하나씩 더 보여 줘요: 글자 수 → 발음(로마자).'));
      } else {
        opts.appendChild(segmented('wans', '읽기 답 입력', [{ value: 'pen', label: '손글씨 (원고지)' }, { value: 'type', label: '타자' }], pr.answerInput, (v) => set('answerInput', v)));
        opts.appendChild(h('p', { class: 'seg-hint ws-hint' }, '「힌트」를 누를 때마다 하나씩 더 보여 줘요: 뜻 → 글자 수 → 발음(로마자). 뜻 힌트를 보면 뜻 맞히기는 건너뛰어요.'));
        opts.appendChild(meaningModeSeg());
      }
      opts.appendChild(h('p', { class: 'seg-hint ws-hint' }, '손글씨 채점의 깐깐함과 펜 전용 모드는 「연습」 탭의 세부 설정을 따라요.'));

      const n = pool.length;
      const qn = pr.count === 'endless' ? '무한 모드 (그만할 때까지)' : `${questionCount(pr.count, n)}문제`;
      const startBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg ws-start', 'data-k': 'start', disabled: n ? null : true, on: { click: () => startRun(pool, pr) } },
        icon('play'), '연습 시작');
      const emptyFilter = !n && !src.useSel && src.filtered && !src.base.length;
      const summary = h('p', { class: 'ws-summary', 'aria-live': 'polite' }, n ? `대상 ${n}개 → ${qn}`
        : emptyFilter ? '단어장 목록의 검색·보기 조건에 맞는 단어가 없어요.'
          : pr.mode === 'kanji' ? '한자 표기가 있는 단어가 없어요.' : '조건에 맞는 단어가 없어요.');
      const clearBtn = emptyFilter ? h('button', { type: 'button', class: 'btn btn-sm', 'data-k': 'clearfilter', on: { click: () => { S.query = ''; S.kind = 'all'; S.tag = ''; draw(); } } }, '조건 없이 단어장 전체로') : null;
      box.appendChild(h('div', { class: 'ws-grid' }, h('div', { class: 'ws-col' }, target, modes), h('div', { class: 'ws-col' }, opts,
        h('div', { class: 'card ws-go' }, summary, clearBtn, startBtn))));
      if (fk) {
        const same = Array.from(box.querySelectorAll('[data-k]')).filter((el) => el.getAttribute('data-k') === fk.k);
        focusEl(same.find((el) => fk.v == null || el.value === fk.v) || same[0]);
      }
    }
    function meaningModeSeg() {
      return segmented('wmean', '뜻 맞히기 방식', [{ value: 'type', label: '직접 입력' }, { value: 'choice', label: '4지선다' }], pr.meaningMode, (v) => set('meaningMode', v));
    }
    draw();
  };

  /* =================================================================== practice run */

  /* S.run = { mode, prefs (the 원고지 view chosen during the run updates it), active, endless: null | { run, pool },
   *           questions: [{ id, retry }], index, answers, cur, entries: Map id → entry snapshot, pool: [entry] (4지선다) } */
  function startRun(pool, pr, opts) {
    const o = opts || {};
    if (!pool.length) { toast('연습할 단어가 없어요.'); return; }
    const entries = new Map(pool.map((e) => [e.id, e]));
    const endless = !o.ids && pr.count === 'endless';
    const run = {
      mode: pr.mode, prefs: Object.assign({}, pr), active: true, label: o.label || null,
      endless: endless ? { run: endlessStartFor(), pool: pool.map((e) => e.id) } : null,
      questions: [], index: 0, answers: [], cur: null, entries, pool: words(), openCheat: null,
    };
    if (endless) run.questions.push(pickEndless(run));
    else {
      const ids = o.ids ? o.ids.filter((id) => entries.has(id)) : buildQueue(pool, pr, Math.random);
      run.questions = ids.map((id) => ({ id, retry: false }));
    }
    if (!run.questions.length) { toast('연습할 단어가 없어요.'); return; }
    S.run = run;
    // prefetch js/kanji-data.js (≈1.4 MB) only where kanji strokes are judged: 쓰기 by hand, where any word with a
    // kanji form may be written in kanji (단어 읽기 / 한자 읽기 / 타자 never judge kanji cells)
    if (pr.mode === 'write' && pr.answerInput !== 'type' && pool.some(hasKanji)) ensureKanji();
    go('practice');
  }

  function pickEndless(run) {
    const Q = QZ();
    // weights from the entries' live stats (answers of this run included), not the snapshots taken at the start
    const live = { get: (id) => (Store && Store.words.get(id)) || run.entries.get(id) };
    const statsOf = endlessStatsFor(live, run.mode, run.prefs.focusWrong);
    const pick = Q.nextEndless(run.endless.run, run.endless.pool, statsOf, Math.random);
    return { id: pick.key, retry: pick.retry };
  }

  function addAnswer(run, a) {
    run.answers.push(a);
    if (run.endless) QZ().endlessRecord(run.endless.run, a.id, a.mark, Math.random, run.endless.pool.length);
  }

  // A question whose second part (뜻) was answered wrong but not yet confirmed: record it as wrong now.
  function flushPending(run) {
    const c = run && run.cur;
    if (!c || !c.pendingMeaning) return;
    c.pendingMeaning = false;
    recordMeaning(run, c, false, false);
    finalizeAnswer(run, c, false);
  }

  // Leaving the practice through the nav / another view: what was graded stays recorded.
  function abandonRun() {
    const run = S.run;
    if (!run) return;
    flushPending(run);
    countPartial(run);
    run.active = false;
    if (run.answers.length) S.lastRun = run;
    S.run = null;
  }

  // 그만하기 / last question: a question whose first part was graded counts (its 뜻 shown as '—').
  function countPartial(run) {
    const c = run.cur;
    if (c && c.readingDone && !c.final) {
      finalizeAnswer(run, c, null, true);
    }
  }

  function finishRun() {
    const run = S.run;
    if (!run) return;
    flushPending(run);
    countPartial(run);
    run.active = false;
    S.run = null;
    S.lastRun = run;
    go(run.answers.length ? 'result' : 'list');
  }

  // Store the question's answer (once). meaningOk: true/false, or null when there was no 뜻 step.
  function finalizeAnswer(run, c, meaningOk, partial) {
    if (c.final) return;
    c.final = true;
    const { reading, mark } = answerMarks(c.readingMark, c.neutral, meaningOk, partial);
    addAnswer(run, {
      id: c.entry.id, entry: c.entry, mode: run.mode, mark, reading, meaning: c.meaningAsked ? (partial ? null : meaningOk) : undefined,
      meaningInput: c.meaningInput || '', overridden: !!c.overridden, cheat: !!c.cheat, skipped: !!c.skipped,
      // hint: the highest hint step reached (1 뜻 · 2 글자 수 · 3 로마자; 0 none); meaningHint: 한자 읽기's 뜻 step skipped
      hint: c.hintCounts ? c.hintLevel || 1 : 0, meaningHint: !!c.meaningHint,
      typed: c.typed || null, check: c.check || null, slots: c.slots || null, issues: c.issues || null, formNote: c.formNote || null,
      form: c.form || null, partial: !!partial, neutral: !!c.neutral, answerText: c.answerText || null, converted: c.converted || null,
    });
  }

  function recordMeaning(run, c, ok, overridden) {
    if (c.meaningRecorded) return;
    c.meaningRecorded = true;
    try {
      if (run.mode === 'kanji') Store.words.recordResult(c.entry.id, { mode: 'kanji', part: 'meaning', mark: ok ? 'o' : 'x', overridden: !!overridden });
      else Store.words.recordResult(c.entry.id, { mode: 'meaning', mark: ok ? 'o' : 'x', overridden: !!overridden });
    } catch (e) { console.error(e); }
  }

  VIEWS.practice = function (main) {
    const run = S.run;
    if (!run || !run.active) { go(S.lastRun ? 'result' : 'list'); return; }
    const bar = practiceBar(run);
    const body = h('div', { class: 'wp-body' });
    main.appendChild(h('section', { class: 'test wp wp-mode-' + run.mode, 'aria-label': modeName(run.mode) + ' 연습' }, bar.el, body));
    run.updateBar = bar.update;

    // keyboard: Enter = 채점 / 다음 (outside text fields), Ctrl+Z = 되돌리기
    const onKey = (e) => {
      if (!S.mounted || S.view !== 'practice' || document.documentElement.classList.contains('modal-open')) return;
      const api = run.keys;
      if (!api) return;
      const tag = e.target && e.target.tagName;
      const interactive = /^(BUTTON|INPUT|TEXTAREA|SELECT|A|SUMMARY)$/.test(tag || '');
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (api.undo) { e.preventDefault(); api.undo(); }
        return;
      }
      if (e.key === 'Enter' && !interactive && !e.isComposing && e.keyCode !== 229 && api.enter) {
        e.preventDefault();
        api.enter();
      }
    };
    document.addEventListener('keydown', onKey);
    onCleanup(() => document.removeEventListener('keydown', onKey));
    onCleanup(() => { if (run.destroyQuestion) run.destroyQuestion(); run.destroyQuestion = null; run.keys = null; run.openCheat = null; });
    showQuestion(run, body, main);
  };

  function modeName(m) { return m === 'write' ? '쓰기' : m === 'kanji' ? '한자 읽기' : '단어 읽기'; }

  function practiceBar(run) {
    const endless = !!run.endless;
    const label = h('span', { class: 'tb-n' });
    const fill = h('span', { class: 'tb-fill' });
    const total = run.questions.length;
    const barEl = endless ? null : h('div', { class: 'tb-bar', role: 'progressbar', 'aria-label': '진행', 'aria-valuemin': 0, 'aria-valuemax': total }, fill);
    const tally = h('div', { class: 'tally', role: 'group', 'aria-label': '지금까지 결과' });
    const quit = endless
      ? h('button', { type: 'button', class: 'btn btn-sm tb-stop', on: { click: () => finishRun() } }, icon('stop'), '그만하기')
      : h('button', { type: 'button', class: 'btn btn-sm btn-quiet tb-quit', on: { click: () => {
        const n = run.answers.length + (run.cur && run.cur.readingDone && !run.cur.final ? 1 : 0);
        App.confirm({ title: '연습을 그만둘까요?', body: n ? `지금까지 푼 ${n}문제는 단어장 기록에 남고, 결과 화면으로 가요.` : '아직 푼 문제가 없어요.', ok: '그만두기', cancel: '계속 풀기', danger: true })
          .then((yes) => { if (yes) finishRun(); });
      } } }, '그만두기');
    const el = h('div', { class: 'test-bar' + (endless ? ' is-endless' : '') },
      quit,
      h('div', { class: 'tb-mid' },
        h('span', { class: 'tb-kind' }, '단어장 · ' + modeName(run.mode) + (run.label ? ' · ' + run.label : '') + (endless ? ' · 무한 모드' : '')),
        h('div', { class: 'tb-progress' }, barEl, label)),
      tally);
    function update() {
      if (endless) label.textContent = `∞ · ${run.index + 1}문제째`;
      else {
        label.textContent = `${Math.min(run.index + 1, total)} / ${total}`;
        fill.style.width = (100 * run.answers.length / total).toFixed(1) + '%';
        barEl.setAttribute('aria-valuenow', run.answers.length);
      }
      const s = summarize(run.answers);
      tally.textContent = '';
      tally.appendChild(markChip('o', s.o));
      if (run.mode !== 'read') tally.appendChild(markChip('t', s.t));
      tally.appendChild(markChip('x', s.x));
      if (s.na) tally.appendChild(markChip('-', s.na));
    }
    update();
    return { el, update };
  }

  function nextQuestion(run, body, main) {
    if (run.cur && !run.cur.final) {
      if (run.cur.pendingMeaning) flushPending(run);
      else if (run.cur.readingDone) countPartial(run);
    }
    run.index++;
    if (run.endless && run.index >= run.questions.length) run.questions.push(pickEndless(run));
    if (run.index >= run.questions.length) { finishRun(); return; }
    showQuestion(run, body, main);
    try { root.scrollTo({ top: 0, behavior: 'auto' }); } catch (e) { root.scrollTo(0, 0); }
  }

  const isLast = (run) => !run.endless && run.index + 1 >= run.questions.length;

  function showQuestion(run, body, main) {
    if (run.destroyQuestion) { run.destroyQuestion(); run.destroyQuestion = null; }
    const q = run.questions[run.index];
    const entry = run.entries.get(q.id);
    run.cur = {
      entry, retry: q.retry, cheat: false, hint: 0, hintLevel: 0, hintCounts: false, meaningHint: false, graded: false, readingDone: false,
      readingMark: null, meaningAsked: false, final: false, practice: false, form: null,
    };
    body.textContent = '';
    if (run.updateBar) run.updateBar();
    const ctx = { run, body, main, entry, cur: run.cur, next: () => nextQuestion(run, body, main) };
    if (run.mode === 'read') questionRead(ctx);
    else questionWrite(ctx);
  }

  function cheatTag() { return h('span', { class: 'cheat-tag', hidden: true }, h('span', { 'aria-hidden': 'true' }, '컨닝'), srOnly('컨닝한 문제')); }
  function hintTag() { return h('span', { class: 'cheat-tag wp-hint-tag', hidden: true }, h('span', { 'aria-hidden': 'true' }, '힌트'), srOnly('힌트를 본 문제')); }
  function retryTag(on) { return h('span', { class: 'retry-tag', hidden: !on }, '다시 나온 문제'); }

  // 컨닝 (chart overlay) for the current question: flags it before its (first) grading.
  function cheatOpener(ctx, tag) {
    return () => {
      const c = ctx.cur;
      const flag = !c.graded && !c.readingDone && !c.submitting;     // not once the answer went to 채점
      if (flag) { c.cheat = true; if (tag) tag.hidden = false; }
      const note = flag || (c.cheat && !c.readingDone) ? '이 문제는 컨닝으로 표시돼요. 글자를 누르면 획순을 볼 수 있어요.'
        : c.cheat ? '이 문제는 채점 전에 컨닝한 문제로 기록됐어요.'
          : c.submitting ? '채점 중인 문제라 컨닝으로 기록되지 않아요. 글자를 누르면 획순을 볼 수 있어요.'
            : '이미 채점한 문제라 컨닝으로 기록되지 않아요. 글자를 누르면 획순을 볼 수 있어요.';
      App.openCheat(scriptOf(ctx.chartText ? ctx.chartText() : ctx.entry.text), { inTest: true, note });
    };
  }

  /* ------------------------------------------------------------------ 단어 읽기 */

  function questionRead(ctx) {
    const { run, body, entry, cur } = ctx;
    const pr = run.prefs;
    const T = TX();
    const tag = cheatTag();
    const isSentence = entry.type === 'sentence';
    // examples never taken from the entry (nor one it contains): the box must not show the answer
    const sample = readingSample(entry);
    const input = h('input', {
      id: 'wp-answer', type: 'text', class: 'answer-input', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
      enterkeyhint: 'done', placeholder: '로마자 또는 한글로 입력', 'aria-describedby': 'wp-answer-help', 'data-autofocus': true,
    });
    const submitBtn = h('button', { type: 'button', class: 'btn btn-primary answer-go', on: { click: () => submit() } }, '확인');
    const feedback = h('div', { class: 'feedback', 'aria-live': 'polite' });
    const meaningBox = h('div', { class: 'wp-meaning-step' });
    const reveal = h('div', { class: 'wp-reveal', hidden: true });
    const nextBtn = h('button', { type: 'button', class: 'btn btn-primary btn-next', hidden: true, on: { click: () => goNext() } }, isLast(run) ? '결과 보기' : '다음', h('kbd', null, 'Enter'), icon('arrow'));
    const skipBtn = h('button', { type: 'button', class: 'btn', on: { click: () => skip() } }, '모르겠어요');
    const openCheat = cheatOpener(ctx, tag);
    run.openCheat = openCheat;
    const cheatBtn = h('button', { type: 'button', class: 'btn', on: { click: openCheat } }, icon('grid'), '컨닝 (글자표)');
    const wantMeaning = pr.withMeaning && !!displayMeaning(entry);

    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (cur.readingDone) { if (!nextBtn.hidden) goNext(); } else submit();
    });

    body.appendChild(h('div', { class: 'read-layout wp-read' },
      h('div', { class: 'q-card card wp-qcard' },
        h('div', { class: 'q-card-top' }, h('span', { class: 'q-kind' }, isSentence ? '이 문장을 읽어 보세요' : '이 단어를 읽어 보세요'), typeBadge(entry.type), retryTag(cur.retry), tag),
        h('div', { class: 'wp-text-box' }, jp(entry.text, 'wp-text' + (isSentence ? ' is-sentence' : '') + (Array.from(entry.text).length > 6 ? ' is-long' : ''))),
        reveal),
      h('div', { class: 'answer card' },
        h('label', { for: 'wp-answer', class: 'answer-label' }, '발음을 입력하세요'),
        h('p', { class: 'answer-help', id: 'wp-answer-help' }, `로마자(예: ${sample.romaji}) 또는 한글(예: ${sample.hangul}) 모두 정답으로 인정해요. 띄어쓰기는 상관없어요.`),
        h('div', { class: 'answer-row' }, input, submitBtn),
        feedback,
        meaningBox,
        h('div', { class: 'test-actions' }, skipBtn, cheatBtn, nextBtn))));
    focusEl(input);

    run.keys = { enter: () => { if (!nextBtn.hidden) goNext(); } };

    function nudge(text) {
      feedback.textContent = '';
      feedback.appendChild(h('p', { class: 'fb-nudge' }, text));
      focusEl(input);
    }

    function submit() {
      if (cur.readingDone) return;
      const res = T.checkReading(input.value, { text: entry.text, reading: entry.reading || '', type: entry.type });
      if (res.empty) { nudge('답을 입력해 주세요. 모르겠으면 「모르겠어요」를 누르세요.'); return; }
      if (res.kind === 'kana') { nudge(`가나 대신 로마자(예: ${sample.romaji})나 한글(예: ${sample.hangul})로 입력해 주세요. 일본어 키보드가 켜져 있으면 바꿔 주세요.`); return; }
      grade(res.correct, res, input.value);
    }

    function skip() {
      if (cur.readingDone) return;
      grade(false, null, '', true);
    }

    function grade(correct, res, given, skipped) {
      cur.readingDone = true;
      cur.graded = true;
      cur.skipped = !!skipped;
      cur.readingMark = correct ? 'o' : 'x';
      cur.check = res;
      cur.typed = given;
      try { Store.words.recordResult(entry.id, { mode: 'read', mark: cur.readingMark, cheat: cur.cheat }); } catch (e) { console.error(e); }
      input.readOnly = true;
      input.classList.add(correct ? 'is-right' : 'is-wrong');
      submitBtn.hidden = true;
      skipBtn.hidden = true;
      feedback.textContent = '';
      feedback.appendChild(readingFeedback(entry, cur.readingMark, res, given, skipped, cur.cheat));
      if (wantMeaning) {
        cur.meaningAsked = true;
        if (skipped) {
          // 모르겠어요 → both parts ✕
          recordMeaning(run, cur, false, false);
          cur.meaningInput = '';
          showReveal();
          finalizeAnswer(run, cur, false);
          done();
        } else {
          meaningBox.appendChild(meaningStep(ctx, {
            onAnswered: (ok, pending) => { showReveal(); if (!pending) finalizeAnswer(run, cur, ok); done(); },
            onOverride: () => { finalizeAnswer(run, cur, true); if (run.updateBar) run.updateBar(); },
          }));
          revealBelow(feedback, meaningBox);
        }
      } else {
        showReveal();
        finalizeAnswer(run, cur, null);
        done();
      }
      if (run.updateBar) run.updateBar();
    }

    function showReveal() {
      reveal.hidden = false;
      reveal.textContent = '';
      reveal.appendChild(entryReveal(entry, { kanji: true }));
    }

    function done() {
      nextBtn.hidden = false;
      cheatBtn.hidden = true;
      if (run.updateBar) run.updateBar();
      // the feedback (and the 뜻 step) in view, 다음 on screen — the revealed entry above may have pushed them down;
      // on a screen too short for the answered 뜻 step and 다음 together, 다음 and the step's end (its verdict) win
      revealBelow(feedback, [meaningBox, nextBtn], { keepEnd: true });
      focusEl(nextBtn);
    }

    function goNext() { ctx.next(); }
  }

  // Reading feedback: mark, per-segment marks (each mora with its romaji), expected romaji · 한글, the given answer.
  function readingFeedback(entry, mark, res, given, skipped, cheat) {
    const T = TX();
    const ex = res ? res.expected : readingOf(entry);
    const segs = res && res.segments ? res.segments : (T.segment(entry.text, { sentence: entry.type === 'sentence' }) || []);
    const correct = mark === 'o';
    return h('div', { class: 'fb fb-' + mark },
      h('div', { class: 'fb-head' },
        App.ui.resultMark(mark, { size: 'md' }),
        h('div', { class: 'fb-text' },
          h('p', { class: 'fb-title' }, correct ? (res && res.exact === false ? '정답! (조금 다르게 써도 인정)' : '정답!') : skipped ? '정답을 확인하세요' : '아쉬워요'),
          h('p', { class: 'fb-reading' }, h('b', { lang: 'en' }, ex.romaji), ' · ', h('b', null, ex.hangul)),
          !correct && given ? h('p', { class: 'fb-given' }, '입력한 답: ', h('span', { class: 'given' }, given)) : null,
          cheat ? h('p', { class: 'fb-cheat' }, '컨닝한 문제로 기록돼요.') : null)),
      segmentsView(segs, !correct && !skipped));
  }

  function segmentsView(segs, showMarks) {
    const wrap = h('p', { class: 'wseg', role: 'group', 'aria-label': '글자별 읽기' });
    for (const sg of segs || []) {
      if (sg.kind === 'space') { wrap.appendChild(h('span', { class: 'wseg-gap', 'aria-hidden': 'true' })); continue; }
      const st = showMarks && sg.ok === false ? ' is-ng' : showMarks && sg.ok === true ? ' is-ok' : '';
      wrap.appendChild(h('span', { class: 'wseg-s' + st },
        jp(sg.text, 'wseg-k'),
        h('span', { class: 'wseg-r', lang: 'en' }, sg.kind === 'punct' ? '' : (sg.romaji || '').trim() || ' '),
        st === ' is-ng' ? srOnly(' (틀림)') : null));
    }
    return wrap;
  }

  // The entry revealed after answering: face (with furigana), reading, meaning, note.
  function entryReveal(entry, o) {
    const r = readingOf(entry);
    return h('div', { class: 'wp-entry' },
      // wordFace: the kanji with furigana, or the kana text with its other readings (かお / がん) — like the list row
      h('p', { class: 'wp-entry-face' }, (o && o.kanji) || !hasKanji(entry) ? wordFace(entry) : jp(entry.text, 'wface')),
      h('p', { class: 'wp-entry-read' }, h('span', { lang: 'en' }, r.romaji), ' · ', r.hangul),
      entry.meaning ? h('p', { class: 'wp-entry-mean' }, h('span', { class: 'wp-k' }, '뜻'), entry.meaning) : null,
      entry.note ? h('p', { class: 'wp-entry-note' }, h('span', { class: 'wp-k' }, '메모'), h('span', null, rich(entry.note))) : null);
  }

  /* ------------------------------------------------------------------ 뜻 맞히기 step (단어 읽기 + 뜻 / 한자 읽기) */

  /* o.onAnswered(ok, pending) — the 뜻 part is answered. pending = a typed answer judged wrong that the learner may
   *   still self-grade (「맞은 걸로 할게요」): it is recorded as wrong when they move on (flushPending), or …
   * o.onOverride() — … as right (overridden) when they press it. */
  function meaningStep(ctx, o) {
    const { run, entry, cur } = ctx;
    const T = TX();
    cur.meaningAsked = true;
    const box = h('div', { class: 'wm' });
    const choices = run.prefs.meaningMode === 'choice' ? meaningChoices(entry, run.pool, Math.random) : null;
    box.appendChild(h('p', { class: 'wm-q' }, h('b', null, '뜻도 맞혀 보세요'), choices ? ' — 알맞은 뜻을 고르세요.' : ' — 한국어로 입력하세요.'));
    const out = h('div', { class: 'wm-out', 'aria-live': 'polite' });
    let answered = false;

    if (choices) {
      const btns = choices.options.map((m, i) => h('button', { type: 'button', class: 'btn wm-choice', 'data-i': i, on: { click: () => pick(i) } }, h('span', { class: 'wm-n', 'aria-hidden': 'true' }, String(i + 1)), m));
      box.appendChild(h('div', { class: 'wm-choices' }, btns));
      box.appendChild(h('p', { class: 'wm-help' }, '숫자 키 1–4로도 고를 수 있어요.'));
      box.appendChild(out);
      const keys = (e) => {
        if (answered || document.documentElement.classList.contains('modal-open')) return;
        const n = Number(e.key);
        if (n >= 1 && n <= 4 && !/^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) { e.preventDefault(); pick(n - 1); }
      };
      document.addEventListener('keydown', keys);
      const off = () => document.removeEventListener('keydown', keys);
      // removed with the question (run.destroyQuestion runs on the next question and when the practice is left)
      const prevDestroy = run.destroyQuestion;
      run.destroyQuestion = () => { off(); if (prevDestroy) prevDestroy(); };
      setTimeout(() => focusEl(btns[0]), 0);
      function pick(i) {
        if (answered) return;
        answered = true;
        off();
        const ok = i === choices.answer;
        cur.meaningInput = choices.options[i];
        btns.forEach((b, j) => {
          b.disabled = true;
          if (j === choices.answer) b.classList.add('is-right');
          else if (j === i) b.classList.add('is-wrong');
        });
        out.textContent = '';
        out.appendChild(h('p', { class: ok ? 'wm-ok' : 'wm-ng' }, okChip(ok), ok ? ' 뜻도 맞았어요.' : [' 정답: ', h('b', null, choices.options[choices.answer])]));
        recordMeaning(run, cur, ok, false);
        o.onAnswered(ok, false);
      }
      return box;
    }

    const mid = uid('wm-in');
    const input = h('input', { type: 'text', id: mid, class: 'answer-input wm-input', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done', placeholder: '한국어로 입력' });
    const okBtn = h('button', { type: 'button', class: 'btn btn-primary answer-go', on: { click: () => check() } }, '확인');
    const dunno = h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => giveUp() } }, '뜻을 모르겠어요');
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (!answered) check();
      else if (run.keys && run.keys.enter) run.keys.enter();
    });
    box.appendChild(h('label', { for: mid, class: 'sr-only' }, '뜻 (한국어)'));
    box.appendChild(h('div', { class: 'answer-row' }, input, okBtn));
    box.appendChild(h('div', { class: 'wm-acts' }, dunno));
    box.appendChild(out);
    setTimeout(() => focusEl(input), 0);

    function check() {
      if (answered) return;
      const r = T.checkMeaning(input.value, entry.meaning);
      if (r.empty) { out.textContent = ''; out.appendChild(h('p', { class: 'fb-nudge' }, '뜻을 입력해 주세요. 모르겠으면 「뜻을 모르겠어요」를 누르세요.')); focusEl(input); return; }
      settle(r.correct, input.value.trim());
    }
    function giveUp() { if (!answered) settle(false, ''); }
    function settle(ok, given) {
      answered = true;
      cur.meaningInput = given;
      input.readOnly = true;
      input.classList.add(ok ? 'is-right' : 'is-wrong');
      okBtn.hidden = true;
      dunno.hidden = true;
      out.textContent = '';
      const accepted = meaningsOf(entry.meaning);
      if (ok) {
        out.appendChild(h('p', { class: 'wm-ok' }, okChip(true), ' 뜻도 맞았어요.', accepted.length > 1 ? h('span', { class: 'wm-also' }, ` (모두 정답: ${accepted.join(', ')})`) : null));
        recordMeaning(run, cur, true, false);
        o.onAnswered(true, false);
        return;
      }
      out.appendChild(h('p', { class: 'wm-ng' }, okChip(false), ' 정답: ', h('b', null, accepted.join(', ') || entry.meaning), given ? [' · 내 답: ', h('span', { class: 'given' }, given)] : ' · 모르겠어요'));
      if (!given) {
        recordMeaning(run, cur, false, false);
        o.onAnswered(false, false);
        return;
      }
      // a miss may be a synonym the list doesn't hold: the learner can self-grade until they move on
      cur.pendingMeaning = true;
      const overrideBtn = h('button', { type: 'button', class: 'btn btn-sm wm-override', on: { click: () => {
        if (!cur.pendingMeaning) return;
        cur.pendingMeaning = false;
        cur.overridden = true;
        recordMeaning(run, cur, true, true);
        overrideBtn.disabled = true;
        out.appendChild(h('p', { class: 'wm-ok' }, okChip(true), ' 맞은 걸로 기록했어요.'));
        input.classList.remove('is-wrong');
        input.classList.add('is-right');
        o.onOverride();
      } } }, '맞은 걸로 할게요');
      out.appendChild(h('div', { class: 'wm-acts' }, overrideBtn, h('span', { class: 'wm-help' }, '같은 뜻을 다른 말로 썼다면 눌러 주세요.')));
      o.onAnswered(false, true);
    }
    return box;
  }

  /* ------------------------------------------------------------------ 쓰기 / 한자 읽기 */

  function questionWrite(ctx) {
    const { run, body, entry, cur } = ctx;
    const pr = run.prefs;
    const kanjiMode = run.mode === 'kanji';
    const typed = pr.answerInput === 'type';
    const tag = cheatTag();
    const htag = hintTag();
    // every accepted spelling (SPEC-words M): hiragana, as written, the kanji form (쓰기), for every reading — handwriting
    // is graded against whichever of them the cells match, so there is nothing to pick before writing
    const accepted = KA().answers(entry, { kanjiMode });
    // the spelling shown after 모르겠어요 and traced in 다시 써보기: the reading as written (한자 읽기: in hiragana)
    const model = accepted.find((a) => a.key === (kanjiMode ? 'hira:0' : 'text:0')) || accepted.find((a) => a.key === 'hira:0') || accepted[0];
    ctx.chartText = () => entry.text;
    const meanings = meaningsOf(entry.meaning);
    // 문제 보기 한국어 + 발음, or a word without a meaning (nothing else to ask with): the reading up front
    const showRead = !kanjiMode && (showsReading(pr.promptView) || !meanings[0]);
    // 힌트: 1 뜻 (한자 읽기) → 2 글자 수 → 3 로마자 (unless the reading is up front)
    const ladder = hintLadder({ kanjiMode, readingShown: showRead, hasMeaning: !!displayMeaning(entry) });
    let gp = null, ki = null, busy = false;

    // ---- prompt card: compact, so the 원고지 and its tools stay on the first screen — a small line (what to write ·
    //   단어/문장 · tags), the question (뜻 + 발음, or the kanji), the hints seen so far (one short line each) and, with a
    //   pen, 채점 · 모르겠어요 · 힌트 · 컨닝 at the card's foot (actRow below; beside the question on a wide card). Nothing
    //   on it tells the answer's length (no 'N칸'): only 힌트 2 does.
    const prompt = h('div', { class: 'card wp-prompt' + (kanjiMode ? ' is-kanji' : '') });
    const readLine = h('p', { class: 'wp-say', hidden: true });
    // the hint button names the step it shows next ('힌트 2: 글자 수'); in the act row (pen) it is its icon plus the step's
    // number where the row is narrow (css .act-text, .wp-hint-n) — the words stay its accessible name and title
    const hintNum = h('span', { class: 'wp-hint-n', 'aria-hidden': 'true' });
    const hintText = h('span', { class: 'act-text' });
    const hintBtn = h('button', { type: 'button', class: 'btn btn-sm wp-hint', on: { click: () => useHint() } }, icon('bulb'), hintNum, hintText);
    const hintsBox = h('div', { class: 'wp-hints', role: 'group', 'aria-label': '본 힌트', 'aria-live': 'polite' });
    const promptLabel = h('p', { class: 'prompt-label' });
    const pmain = h('div', { class: 'prompt-main wp-prompt-main' });
    prompt.appendChild(pmain);
    pmain.appendChild(h('div', { class: 'prompt-top wp-meta' }, promptLabel, typeBadge(entry.type),
      h('span', { class: 'prompt-tags' }, retryTag(cur.retry), htag, tag)));
    let subEl = null;
    if (kanjiMode) {
      const kn = Array.from(entry.kanji).length;
      subEl = h('p', { class: 'wp-sub' });
      pmain.appendChild(h('div', { class: 'wp-q wp-kanji-box' },
        jp(entry.kanji, 'wp-kanji' + (kn > 8 ? ' is-xlong' : kn > 4 ? ' is-long' : '')), subEl));
      updateSub();
    } else {
      pmain.appendChild(h('div', { class: 'wp-q' },
        h('p', { class: 'wp-meaning' + (meanings[0] && meanings[0].length > 12 ? ' is-long' : '') }, meanings[0] || h('span', { class: 'wp-nomean' }, '(뜻이 없는 단어예요 — 발음을 보고 쓰세요)')),
        meanings.length > 1 ? h('p', { class: 'wp-meaning-alt' }, '또는 ' + meanings.slice(1).join(', ')) : null,
        readLine));
    }
    pmain.appendChild(hintsBox);
    if (typed && ladder.length) pmain.appendChild(h('div', { class: 'wp-ctl' }, hintBtn));
    // what to write — never how much: '일본어로 쓰세요 · 히라가나·가타카나·한자 모두 돼요' / '읽기를 히라가나로 쓰세요'
    // (one span: .prompt-label is a flex box; the part after '·' drops on a narrow card — css .wp-label-more)
    if (kanjiMode) promptLabel.appendChild(typed ? h('span', null, '읽기를 쓰세요') : h('span', null, '읽기를 ', h('b', null, '히라가나'), '로 쓰세요'));
    else promptLabel.appendChild(h('span', null, '일본어로 쓰세요', typed ? null : h('span', { class: 'wp-label-more' }, ' · 히라가나·가타카나·한자 모두 돼요')));
    if (showRead) showReading();

    // 한자 읽기: the instruction beside the kanji (typed: how to type it; the 뜻 step that follows, or that it is skipped)
    function updateSub() {
      if (!subEl) return;
      const then = !displayMeaning(entry) ? '' : cur.meaningHint ? ' 뜻 힌트를 봐서 뜻 맞히기는 건너뛰어요.' : ' 그다음 뜻도 물어봐요.';
      const sub = (typed ? '읽기를 히라가나·로마자·한글 중 편한 것으로 입력하세요.' + then : then).trim();
      subEl.textContent = sub;
      subEl.hidden = !sub;
    }
    function showReading() {
      const r = readingOf(entry);
      readLine.hidden = false;
      readLine.textContent = '';
      readLine.appendChild(h('span', { class: 'wp-say-romaji', lang: 'en' }, r.romaji));
      readLine.appendChild(h('span', { class: 'wp-say-ko' }, r.hangul));
    }
    function updateHintBtn() {
      const next = ladder[cur.hint];
      const label = next ? hintLabel(next) : '힌트를 다 봤어요';
      hintText.textContent = label;
      hintNum.textContent = next ? String(HINTS[next].n) : '';
      hintBtn.title = label;
      hintBtn.disabled = !next || busy;
    }
    const HINT_TAG = { meaning: '뜻', count: '글자 수', romaji: '발음' };
    function revealHint(step) {
      let content = null;
      if (step === 'meaning') content = h('span', { class: 'wp-hint-mean' }, meanings.join(', ') || entry.meaning);
      else if (step === 'count') {
        const c = countHint(entry, { kanjiMode });
        content = h('span', null, rich(c.text));
        if (gp && c.n) gp.setCountHint(c.n);       // the first n cells tinted (the run grows to n + 1)
      } else {
        const r = readingOf(entry);
        content = [h('span', { class: 'wp-say-romaji', lang: 'en' }, r.romaji), ' ', h('span', { class: 'wp-say-ko' }, r.hangul)];
      }
      hintsBox.appendChild(h('p', { class: 'wp-hint-line', 'data-step': step }, h('span', { class: 'wp-k' }, HINT_TAG[step]), content));
    }
    function useHint() {
      if (cur.graded || busy || cur.hint >= ladder.length) return;
      const step = ladder[cur.hint++];
      cur.hintCounts = true;
      cur.hintLevel = hintLevel(ladder, cur.hint);
      if (step === 'meaning') { cur.meaningHint = true; updateSub(); }
      revealHint(step);
      htag.hidden = false;
      htag.firstChild.textContent = '힌트 ' + cur.hintLevel;
      updateHintBtn();
      toast(step === 'meaning' ? '뜻을 보여 드려요. 힌트를 본 문제로 기록되고, 뜻 맞히기는 건너뛰어요.'
        : step === 'count' ? (typed ? '글자 수를 보여 드려요. 힌트를 본 문제로 기록돼요.' : '글자 수만큼 칸에 색을 칠했어요. 힌트를 본 문제로 기록돼요.')
          : '발음을 보여 드려요. 힌트를 본 문제로 기록돼요.');
    }

    // ---- answer area
    const pad = h('div', { class: 'wp-pad' });
    const resultBox = h('section', { class: 'w-result wp-result', 'aria-live': 'polite', 'aria-label': '채점 결과' });
    const meaningBox = h('div', { class: 'wp-meaning-step' });
    const nextWrap = h('div', { class: 'wp-next', hidden: true });
    const gradeBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg grade-btn', on: { click: () => grade() } }, '채점', h('kbd', null, 'Enter'));
    const skipBtn = h('button', { type: 'button', class: 'btn wp-skip' + (typed ? ' btn-sm' : ''), on: { click: () => skip() } }, '모르겠어요');
    const openCheat = cheatOpener(ctx, tag);
    run.openCheat = openCheat;
    const cheatBtn = typed
      ? h('button', { type: 'button', class: 'btn btn-sm', on: { click: openCheat } }, icon('grid'), '컨닝 (글자표)')
      : h('button', { type: 'button', class: 'btn', 'aria-label': '컨닝 (글자표)', title: '컨닝 (글자표)', on: { click: openCheat } }, icon('grid'), h('span', { class: 'act-text' }, '컨닝'));
    const practiceNote = h('p', { class: 'practice-note', hidden: true }, '연습 중이에요 — 다시 채점해도 이 문제의 기록은 바뀌지 않아요.');
    const counter = h('span', { class: 'stroke-count', 'aria-live': 'polite' });
    const tools = h('div', { class: 'pad-tools wp-tools pad-tools-top' });
    updateHintBtn();

    // With a pen, 채점 / 모르겠어요 / 힌트 / 컨닝 sit at the foot of the prompt card and the tools (되돌리기 · 칸 지우기 · 모두
    // 지우기) right above the 원고지 — with a clear band before its first row (css .pad-tools-top) — so they are on
    // screen without scrolling however many rows the 원고지 grows to. The result panel is tall (alignment strip and
    // detail), so the 뜻 step and 다음 문제 come right under the 원고지, above it: they stay on screen while the result comes
    // up below them (reveal). Typed: the buttons follow the input, and the short result card comes first, as in 단어 읽기.
    const actRow = typed ? null : h('div', { class: 'act-row' }, gradeBtn, skipBtn, ladder.length ? hintBtn : null, cheatBtn);
    if (actRow) prompt.appendChild(actRow);
    else tools.classList.remove('pad-tools-top');
    body.appendChild(h('div', { class: 'wp-layout' },
      prompt,
      typed
        ? h('div', { class: 'wp-answer' }, practiceNote, pad, tools,
          h('div', { class: 'wp-go' }, gradeBtn),
          h('div', { class: 'w-actions' }, skipBtn, cheatBtn))
        : h('div', { class: 'wp-answer' }, practiceNote, tools, pad),
      typed ? [resultBox, meaningBox, nextWrap] : [meaningBox, nextWrap, resultBox]));

    // ---- pen: GridPad in open mode (SPEC-words M) — a run of cells that never tells how long the answer is: it starts at
    //   one row on this width (6 cells at least) and keeps an empty cell after the last one written
    function buildPad() {
      if (gp) { gp.destroy(); gp = null; }
      pad.textContent = '';
      tools.textContent = '';
      const settings = App.getSettings();
      gp = root.GridPad.create(pad, {
        open: true, penOnly: settings.penOnly,
        label: kanjiMode ? '읽기를 쓰는 원고지 — 한 칸에 한 글자씩, 다 쓰면 채점' : '원고지 — 한 칸에 한 글자씩, 다 쓰면 채점',
        // the view the learner last chose (모든 칸 / 한 칸씩) stays for the next questions and practices
        mode: pr.padView,
        // 한 칸씩: the big cell ends on the first screen however tall the question above it is
        fitScreen: true,
        onChange: (info) => {
          updateCounter();
          if (info && info.reason === 'stroke') pullFocus();
          if (info && info.reason === 'mode' && info.manual && gp) {
            const v = gp.getMode();
            if (pr.padView !== v) { pr.padView = v; savePrefs(Object.assign(prefs(), { padView: v })); }
          }
        },
        onCellClick: (i) => showCellAt(i),
      });
      tools.appendChild(h('button', { type: 'button', class: 'btn btn-sm tool-btn', title: '되돌리기 (Ctrl+Z)', on: { click: (e) => { if (gp && gp.isEnabled()) gp.undo(); if (e.detail > 0) pullFocus(); } } }, icon('undo'), h('span', { class: 'tool-text' }, '되돌리기')));
      tools.appendChild(h('button', { type: 'button', class: 'btn btn-sm tool-btn', title: '지금 칸 지우기', on: { click: (e) => { if (gp && gp.isEnabled() && gp.getFocus() >= 0) gp.clearCell(gp.getFocus()); if (e.detail > 0) pullFocus(); } } }, icon('clear'), h('span', { class: 'tool-text' }, '칸 지우기')));
      // no icon: the label stays visible on narrow screens too (a .tool-btn hides its text below 560 px)
      tools.appendChild(h('button', { type: 'button', class: 'btn btn-sm', title: '모든 칸 지우기', on: { click: () => {
        if (!gp || !gp.isEnabled() || !gp.getStrokeCount()) return;
        App.confirm({ title: '모든 칸을 지울까요?', body: '쓴 글씨가 모두 지워져요.', ok: '모두 지우기', cancel: '취소' }).then((yes) => { if (yes && gp) gp.clearAll(); });
      } } }, h('span', { class: 'tool-text' }, '모두 지우기')));
      tools.appendChild(counter);
      updateCounter();
    }
    // how many cells have ink — never out of how many ('3칸 썼어요')
    function updateCounter() {
      if (!gp) return;
      let k = 0;
      for (let i = 0; i < gp.cellCount; i++) if (gp.getCellStrokeCount(i)) k++;
      counter.textContent = '';
      if (!k) return;
      counter.appendChild(h('b', null, String(k)));
      counter.appendChild(document.createTextNode('칸 썼어요'));
    }
    function pullFocus() {
      const main = ctx.main;
      if (document.documentElement.classList.contains('modal-open') || document.activeElement === main) return;
      const a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return;
      focusEl(main);
    }

    // ---- typed (every form and reading is accepted; romaji is turned into kana as it is typed)
    function buildTyped() {
      pad.textContent = '';
      const canKanji = !kanjiMode && hasKanji(entry);
      ki = kanaInput({
        id: 'wp-typed', mode: pr.typedMode || 'romaji', script: pr.typedScript || 'hira', compact: true, enterKeyHint: 'done',
        avoid: [entry.text].concat(entry.alts || []),
        // never built from the entry: an empty box must not show the answer (its kanji form)
        placeholder: kanjiMode ? '히라가나·로마자·한글로 입력' : canKanji ? '가나(로마자) 또는 한자 섞인 표기로 입력' : '가나로 입력 (로마자로 쳐도 돼요)',
        onEnter: () => { if (!cur.graded) grade(); else if (run.keys && run.keys.enter) run.keys.enter(); },
        onMode: (m, sc) => { pr.typedMode = m; pr.typedScript = sc; savePrefs(Object.assign(prefs(), { typedMode: m, typedScript: sc })); },
      });
      pad.appendChild(h('label', { class: 'answer-label wp-typed-label', for: 'wp-typed' }, kanjiMode ? '읽기를 입력하세요' : '일본어로 입력하세요'));
      pad.appendChild(h('p', { class: 'answer-help' }, kanjiMode ? '히라가나, 로마자, 한글 모두 돼요.'
        : canKanji ? '히라가나·가타카나로 쓰거나 한자 섞인 표기로 써도 돼요. 로마자로 치면 가나로 바뀌어요.'
          : '히라가나·가타카나 모두 돼요. 로마자로 치면 가나로 바뀌어요.'));
      pad.appendChild(ki.el);
      setTimeout(() => ki.focus(), 0);
    }

    if (typed) buildTyped(); else buildPad();
    // With a pen the tools stick under the top bar while a long 원고지 is scrolled (css .wp-tools.pad-tools-top), so
    // 되돌리기 · 모두 지우기 stay on screen with the rows being written; stuck, the strip behind them is solid (.is-stuck).
    let stuckRaf = 0;
    const syncStuck = () => {
      stuckRaf = 0;
      if (!tools.isConnected || tools.hidden || typed) return;
      const top = parseFloat(getComputedStyle(tools).top) || 0;
      tools.classList.toggle('is-stuck', window.scrollY > 0 && tools.getBoundingClientRect().top <= top + 0.5);
    };
    const onStuckScroll = () => { if (!stuckRaf) stuckRaf = requestAnimationFrame(syncStuck); };
    if (!typed) window.addEventListener('scroll', onStuckScroll, { passive: true });
    run.destroyQuestion = () => {
      window.removeEventListener('scroll', onStuckScroll, { passive: true });
      if (stuckRaf) cancelAnimationFrame(stuckRaf);
      if (gp) { gp.destroy(); gp = null; }
    };

    run.keys = {
      enter: () => { if (!gradeBtn.hidden) grade(); else if (!nextWrap.hidden) ctx.next(); },
      undo: () => { if (gp && gp.isEnabled()) gp.undo(); },
    };

    function setAsking(on) {
      gradeBtn.hidden = !on;
      skipBtn.hidden = !on;
      cheatBtn.hidden = !on;
      hintBtn.hidden = !on;
      tools.hidden = !on;
    }

    // ---- grading
    // While 채점 waits (KanjiJudge.load() of a slow js/kanji-data.js), the pad and the question's other controls are
    // off: the answer that went to 채점 is the one graded and recorded (no 모르겠어요 / 컨닝 / hint / new strokes in between).
    function setBusy(on) {
      busy = on;
      cur.submitting = on;
      gradeBtn.disabled = on;
      gradeBtn.firstChild.textContent = on ? '채점 중…' : '채점';
      skipBtn.disabled = on;
      cheatBtn.disabled = on;
      updateHintBtn();
      Array.from(tools.querySelectorAll('button')).forEach((b) => { b.disabled = on; });
      if (gp) gp.setEnabled(!on);
    }

    async function grade() {
      if (busy) return;
      if (cur.graded && !cur.practice) return;
      if (typed) { gradeTyped(); return; }
      if (!gp) return;
      const gp0 = gp;
      // the ink is read before anything is awaited: what went to 채점 is what is judged (skipped / trailing empty cells
      // are not part of the answer)
      const written = gp0.getWrittenCells();
      if (!written.length) { toast('칸 안에 먼저 써 주세요. 모르겠으면 「모르겠어요」를 누르세요.'); return; }
      setBusy(true);
      let res = null, kanjiOk = true;
      const live = () => run.cur === cur && gp === gp0;
      const align = () => KA().grade(written, entry, alignJudge(kanjiOk), { answers: accepted, kanjiMode });
      try {
        // kanji are judged only when the answer has a kanji form (쓰기). js/kanji-data.js (prefetched at the start) may
        // still be loading: a writing that is right in kana needs no kanji judge (a tie goes to the kana spelling), so it
        // is graded at once; anything else waits for the data and is graded with it.
        const kanjiForm = accepted.some((a) => a.form === 'kanji');
        kanjiOk = !kanjiForm || (root.KANJI_DATA ? await ensureKanji() : false);
        await nextPaint();              // 채점 중… on screen before the alignment runs (tens of ms for a sentence)
        if (live()) res = align();
        if (res && kanjiForm && !kanjiOk && !(res.grade === 'o' && res.best && res.best.form !== 'kanji')) {
          kanjiOk = await ensureKanji();
          if (kanjiOk && live()) res = align();
        }
      } catch (e) {
        console.error(e);
        res = null;
      } finally { setBusy(false); }
      // the question was left, or its pad replaced, while judging: this result belongs to nothing on screen
      if (!gp || gp !== gp0 || run.cur !== cur || (cur.graded && !cur.practice)) return;
      if (!res) { toast('채점하지 못했어요. 다시 눌러 주세요.'); return; }
      if (kanjiDataMissing(res, kanjiOk)) { showUnloaded(); return; }
      const slots = alignSlots(res, written);
      const g = res.grade === '-' ? null : res.grade;
      gp.setMarks(res.marks);
      gp.setEnabled(false);
      if (!cur.graded) {
        cur.graded = true;
        cur.readingDone = true;
        cur.slots = slots;
        cur.issues = res.issues.map((i) => i.message);
        cur.formNote = formNote(res.best, accepted, res);
        cur.form = res.best ? res.best.form : null;
        cur.answerText = res.best ? res.best.text : null;
        cur.readingMark = g || '-';
        cur.neutral = !g;            // nothing gradable: not recorded, '–' in the run (not ✕)
        recordGrade(res);
      }
      setAsking(false);
      practiceNote.hidden = true;
      renderResult(res, slots);
      afterReading();
    }

    // js/kanji-data.js could not be loaded (offline, file missing, load timeout) and the writing reads as the kanji form:
    // its kanji cannot be judged, so nothing is graded or recorded. The learner can load it again, or write in kana.
    function showUnloaded() {
      resultBox.textContent = '';
      resultBox.classList.remove('is-stale');
      const note = h('p', { class: 'wr-note' }, '인터넷 연결을 확인하고 다시 불러오거나, 지우고 가나로 써 주세요. ',
        cur.practice ? '연습 채점이라 기록은 그대로예요.' : '이 문제는 아직 채점하지도, 기록하지도 않았어요.');
      const retry = h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => {
        if (busy) return;
        note.textContent = '한자 획 데이터를 다시 불러오는 중이에요…';
        grade();                     // ensureKanji() tries the load again
      } } }, '다시 불러와서 채점');
      const toKana = h('button', { type: 'button', class: 'btn', on: { click: () => {
        if (busy || !gp) return;
        gp.clearAll();
        resultBox.textContent = '';
        revealBelow(actRow || practiceNote, [pad, gradeBtn], { instant: true });
      } } }, '지우고 가나로 쓰기');
      resultBox.appendChild(h('div', { class: 'wr card wr-unloaded' },
        h('div', { class: 'wr-head' },
          h('span', { class: 'wr-na', 'aria-hidden': 'true' }, '–'),
          h('div', { class: 'wr-headtext' },
            h('p', { class: 'wr-verdict wr--' }, '한자 획 데이터를 불러오지 못해서 한자로 쓴 칸을 채점할 수 없어요.'),
            note)),
        h('div', { class: 'wr-acts' }, retry, toKana)));
      revealBelow(resultBox, resultBox.querySelector('.wr-acts'));
    }

    function recordGrade(res) {
      const cheat = !!(cur.cheat || cur.hintCounts);
      if (res.grade === 'o' || res.grade === 't' || res.grade === 'x') {
        try { Store.words.recordResult(entry.id, { mode: kanjiMode ? 'kanji' : 'write', mark: res.grade, cheat }); } catch (e) { console.error(e); }
      }
      for (const c of recordableChars(res)) {
        try { App.recordWriting(c.ch, c.mark, { cheat, source: 'word', result: c.result }); } catch (e) { console.error(e); }
      }
    }

    function gradeTyped() {
      if (cur.graded) return;
      const v = ki.getValue();
      let correct, info;
      if (kanjiMode) {
        // romaji typed in 로마자 → 가나 mode reaches here as kana: graded as the romaji it was (particles, long vowels)
        const res = checkTypedReading(v, entry, ki.getMode() === 'romaji');
        if (res.empty) { toast('읽기를 입력해 주세요. 모르겠으면 「모르겠어요」를 누르세요.'); ki.focus(); return; }
        correct = res.correct;
        info = { kind: 'reading', res };
        cur.answerText = res.reading || null;
      } else {
        const res = checkTypedWrite(v, entry);
        if (res.empty) { toast('답을 입력해 주세요. 모르겠으면 「모르겠어요」를 누르세요.'); ki.focus(); return; }
        if (res.nudge === 'hangul') { toast('한글이 아니라 일본어(가나나 한자)로 입력해 주세요. 로마자로 쳐도 가나로 바뀌어요.'); ki.focus(); return; }
        correct = res.correct;
        info = { kind: 'write', res };
        if (res.correct) cur.form = res.form;
        cur.answerText = !res.correct ? null : res.form === 'kanji' ? kanjiOf(entry) : res.form === 'hira' ? hiraganaOf(res.reading) : res.reading;
        cur.converted = res.romaji ? res.converted : null;
      }
      cur.graded = true;
      cur.readingDone = true;
      cur.typed = v;
      cur.check = info.res;
      cur.readingMark = correct ? 'o' : 'x';
      ki.setReadOnly(true);
      ki.input.classList.add(correct ? 'is-right' : 'is-wrong');
      const cheat = !!(cur.cheat || cur.hintCounts);
      try { Store.words.recordResult(entry.id, { mode: kanjiMode ? 'kanji' : 'write', mark: cur.readingMark, cheat }); } catch (e) { console.error(e); }
      setAsking(false);
      resultBox.textContent = '';
      resultBox.appendChild(typedResult(entry, cur, info, kanjiMode));
      afterReading();
    }

    // 모르겠어요 — the same in every practice kind and answer path: the question is ✕ (with its 뜻 part when it has one
    // and its 뜻 hint was not seen), no per-character result is recorded, the whole answer is shown (every accepted
    // reading and form), and with a pen 다시 써보기 traces it (보고 쓰기).
    function skip() {
      if (cur.graded || busy) return;
      cur.graded = true;
      cur.readingDone = true;
      cur.skipped = true;
      cur.readingMark = 'x';
      cur.answerText = typed ? null : model.text;
      cur.form = typed ? null : model.form;
      try { Store.words.recordResult(entry.id, { mode: kanjiMode ? 'kanji' : 'write', mark: 'x', cheat: !!(cur.cheat || cur.hintCounts) }); } catch (e) { console.error(e); }
      if (gp) { gp.setEnabled(false); }
      if (ki) ki.setReadOnly(true);
      setAsking(false);
      cur.slots = typed ? null : skipSlots(model);
      resultBox.textContent = '';
      if (typed) resultBox.appendChild(typedResult(entry, cur, null, kanjiMode));
      else renderResult(null, cur.slots);
      if (kanjiMode) {
        if (displayMeaning(entry) && !cur.meaningHint) {
          cur.meaningAsked = true;
          recordMeaning(run, cur, false, false);
          finalizeAnswer(run, cur, false);
        } else {
          if (cur.meaningHint) cur.meaningAsked = true;      // 뜻 shown by the hint: not asked, not recorded
          finalizeAnswer(run, cur, null);
        }
        showNext();
        return;
      }
      afterReading();
    }

    // After the reading / writing part: 한자 읽기 asks the meaning (unless its 뜻 hint showed it), everything else is done.
    function afterReading() {
      if (run.updateBar) run.updateBar();
      if (cur.practice) { showNext(); return; }
      if (kanjiMode && !cur.meaningAsked && displayMeaning(entry)) {
        meaningBox.textContent = '';
        if (cur.meaningHint) {
          // the 뜻 hint showed the meaning: 뜻 맞히기 is skipped — not recorded as right, shown as 힌트 in 결과
          cur.meaningAsked = true;
          meaningBox.appendChild(h('p', { class: 'wm-skipped' }, okChip(null), ' 뜻 힌트를 봐서 뜻 맞히기는 건너뛰었어요.'));
          finalizeAnswer(run, cur, null);
          showNext();
          return;
        }
        meaningBox.appendChild(meaningStep(ctx, {
          onAnswered: (ok, pending) => { if (!pending) finalizeAnswer(run, cur, ok); showNext(); },
          onOverride: () => { finalizeAnswer(run, cur, true); if (run.updateBar) run.updateBar(); },
        }));
        revealBelow(resultBox, meaningBox);       // the 뜻 step (its input) on screen, the reading's result in view
        return;
      }
      if (!cur.final) finalizeAnswer(run, cur, null);
      showNext();
    }

    function showNext() {
      if (run.updateBar) run.updateBar();
      nextWrap.textContent = '';
      nextWrap.hidden = false;
      const nextLabel = isLast(run) ? '결과 보기' : '다음 문제';
      const nextBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg btn-next', 'data-next': true, on: { click: () => ctx.next() } }, nextLabel, h('kbd', null, 'Enter'), icon('arrow'));
      // 다시 써보기 (practice only, the recorded grade stays) — after 모르겠어요 too, with the model glyphs shown
      const again = !typed ? h('button', { type: 'button', class: 'btn', on: { click: practiceAgain } }, icon('pen'), '다시 써보기') : null;
      nextWrap.appendChild(h('div', { class: 'wp-next-row' }, again, nextBtn));
      // the result in view, 다음 문제 (and the answered 뜻 step) on screen; on a screen too short for both, 다음 문제
      // and the step's end (its verdict) win
      revealBelow(resultBox, [meaningBox, nextWrap], { keepEnd: true });
      const inMeaning = meaningBox.querySelector('input:not([readonly])');
      if (!inMeaning) focusEl(nextBtn);
    }

    function practiceAgain() {
      if (!gp) return;
      cur.practice = true;
      gp.clearAll();
      gp.setMarks(null);
      if (cur.skipped) gp.setGuideText(model.text);   // 모르겠어요 → trace the answer (보고 쓰기; a space is a blank cell)
      gp.setEnabled(true);
      gradeBtn.hidden = false;
      tools.hidden = false;
      practiceNote.hidden = false;
      resultBox.classList.add('is-stale');
      nextWrap.hidden = true;
      updateCounter();
      // back to the 원고지: all of it on screen, then 채점 above it, as far as they fit (instant: a stroke begun while
      // the page glides would be bent by it)
      revealBelow(actRow || practiceNote, [pad, gradeBtn], { instant: true });
      focusEl(gradeBtn);
    }

    // ---- result panel (pen): the grade and what it was graded as, the answer, the alignment issues, the alignment strip
    //   (the answer's characters lined up with the written cells: ○ △ ✕ –, 빠짐, 필요 없음) and the tapped slot's detail
    let detailBox = null, strip = null, shownSlots = null;
    function renderResult(res, slots) {
      resultBox.textContent = '';
      resultBox.classList.remove('is-stale');
      shownSlots = slots;
      const g = res ? (res.grade === '-' ? null : res.grade) : 'x';
      const c = res ? res.counts : {};
      const different = !!res && res.issues.some((i) => i.type === 'different');
      const mixed = !!res && res.issues.some((i) => i.type === 'mixed');
      const headline = penHeadline({ skipped: cur.skipped, practice: cur.practice, g, kanjiMode, missing: c.missing, wrong: c.x, extra: c.extra, swapped: c.swapped, different, mixed });
      const r = readingOf(entry);
      const fnote = res ? formNote(res.best, accepted, res) : null;
      // neutral cells: kanji that have no stroke data (loaded, but not in KANJI_DATA) vs. cells the judge failed on
      const neutral = res ? res.steps.filter((s) => s.type === 'match' && s.neutral) : [];
      const noData = neutral.filter((s) => s.kind === 'kanji' && !s.error).length;
      const failed = neutral.length - noData;
      // 'different': the headline says so and the 정답 line shows the answer (the one issue would only repeat them)
      const issues = res && !different ? res.issues : [];
      strip = h('div', { class: 'wc-strip wa-strip', role: 'group', 'aria-label': res ? '정답에 맞춰 본 칸 — 누르면 자세히' : '정답 — 누르면 획순' },
        slots.map((s) => slotButton(s, () => showSlot(s))));
      detailBox = h('div', { class: 'wc-detail', 'aria-live': 'polite' });
      resultBox.appendChild(h('div', { class: 'wr card' },
        h('div', { class: 'wr-head' },
          g ? App.ui.resultMark(g, { size: 'lg' }) : h('span', { class: 'wr-na', 'aria-hidden': 'true' }, '–'),
          h('div', { class: 'wr-headtext' },
            cur.practice ? h('p', { class: 'wres-practice' }, cur.neutral ? '연습 결과 · 이 문제는 채점할 칸이 없어서 기록되지 않았어요'
              : `연습 결과 · 기록된 점수는 그대로 (${MARK_SYM[cur.readingMark] || '–'})`) : null,
            h('p', { class: 'wr-verdict wr-' + (g || '-') }, headline),
            fnote ? h('p', { class: 'wr-form' }, rich(fnote)) : null,
            h('p', { class: 'wr-answer' }, h('span', { class: 'wp-k' }, accepted.length > 1 ? '정답 (모두 인정)' : '정답'), alignAnswerNodes(entry, res ? res.best : model, accepted)),
            h('p', { class: 'wr-read' }, h('span', { lang: 'en' }, r.romaji), ' · ', r.hangul, !kanjiMode && entry.meaning ? ' · ' + entry.meaning : ''),
            noData ? h('p', { class: 'wr-note' }, `획 데이터가 없는 한자 ${noData}칸은 채점하지 않았어요 (–).`) : null,
            failed ? h('p', { class: 'wr-note' }, `채점하지 못한 칸 ${failed}개는 채점에서 뺐어요 (–).`) : null,
            (cur.cheat || cur.hintCounts) && !cur.practice ? h('p', { class: 'fb-cheat' }, cur.cheat ? '컨닝한 문제로 기록돼요.' : '힌트를 본 문제로 기록돼요.') : null,
            entry.note && !kanjiMode ? h('p', { class: 'wr-note' }, h('span', { class: 'wp-k' }, '메모'), rich(entry.note)) : null)),
        issuesList(issues.map((i) => i.message)),
        h('p', { class: 'wr-strip-label' }, res ? '정답에 맞춰 본 칸이에요 — 누르면 자세히 볼 수 있어요' : '글자를 누르면 바른 획순을 볼 수 있어요'),
        strip, detailBox));
      // open the first slot worth a look
      const first = res ? slots.find((s) => s.type !== 'match' || s.mark === 'x' || s.mark === 't') : cur.skipped && !cur.practice ? slots[0] : null;
      if (first) showSlot(first, true);
      // no scroll here: showNext / the 뜻 step bring the result into view under 다음 문제 (reveal)
    }

    function showSlot(s, quiet) {
      if (!shownSlots || !detailBox || !strip) return;
      Array.from(strip.children).forEach((b) => b.setAttribute('aria-pressed', b.dataset.key === s.key ? 'true' : 'false'));
      detailBox.textContent = '';
      detailBox.setAttribute('data-type', s.type);
      add(detailBox, slotDetail(s));
      if (!quiet) detailBox.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'nearest' });
    }
    // a graded cell of the 원고지 tapped: its slot (match or extra)
    function showCellAt(i) {
      const s = shownSlots && shownSlots.find((x) => x.cell === i);
      if (s) showSlot(s);
    }
  }

  // A frame to paint in (채점 중…) before a long synchronous step; a timer when frames are not coming (hidden tab).
  function nextPaint() {
    return new Promise((resolve) => {
      let done = false;
      const go = () => { if (!done) { done = true; setTimeout(resolve, 0); } };
      try { root.requestAnimationFrame(go); } catch (e) { /* none */ }
      setTimeout(go, 60);
    });
  }

  /* The judge KanaAlign.grade calls for a (cell, expected char) pair: kana / extras by KanaRecognizer (box mode), kanji
   * by KanjiJudge; null — a neutral cell, not graded — for a kanji without stroke data, or every kanji while
   * js/kanji-data.js could not be loaded (kanjiOk false: the caller then checks kanjiDataMissing). */
  function alignJudge(kanjiOk) {
    const strictness = App.getSettings().strictness;
    const KR = root.KanaRecognizer, KJ = root.KanjiJudge;
    return (strokes, ch, box) => {
      const t = cellTarget(ch);
      if (t === 'kana' || t === 'extra') return KR.judge(strokes, ch, { box, strictness });
      if (t === 'kanji' && kanjiOk && KJ && KJ.has(ch)) return KJ.judge(strokes, ch, { box, strictness });
      return null;
    };
  }

  // The 정답 line of a written answer: the spelling it was graded as (with furigana when it is the kanji form), then the
  // other accepted spellings in brackets — がっこう · てすと (テスト) · なん (なに · 何).
  function alignAnswerNodes(entry, best, list) {
    const t = answerTexts(best, list);
    const main = t.mainKanji ? wordFace(entry) : jp(t.main, 'wface');
    return [main, t.others.length ? h('span', { class: 'wr-alt' }, ' (', t.others.map((x, i) => [i ? h('span', { class: 'wr-sep' }, ' · ') : null, jp(x)]), ')') : null];
  }

  // KanaAlign's messages ('촉음 っ이 빠졌어요 — がっこう', 'っ을 하나 더 썼어요' …), missing / extra first as it orders them.
  function issuesList(messages) {
    const list = (messages || []).filter(Boolean);
    if (!list.length) return null;
    return h('ul', { class: 'wr-issues' }, list.map((m) => h('li', null, rich(m))));
  }

  /* ------------------------------------------------------------------ alignment strip (pen result, 결과 list) */

  const SLOT_TAG = { missing: '빠짐', extra: '필요 없음' };
  function slotClass(s) {
    return s.type === 'missing' ? 'wc-miss' : s.type === 'extra' ? 'wc-extra' : s.type === 'skip' ? 'wc-skip' : 'wc-' + (s.mark === '-' ? 'na' : s.mark);
  }
  function slotName(s) {
    if (s.type === 'missing') return `빠진 글자 ${s.ch}`;
    if (s.type === 'extra') return `${s.cell + 1}번째 칸${s.written ? ' ' + s.written : ''} — 필요 없는 칸`;
    if (s.type === 'skip') return `${s.pos + 1}번째 글자 ${s.ch}`;
    return `${s.cell + 1}번째 칸 ${s.ch} — ${s.neutral ? '채점 안 함' : MARK_LABEL[s.mark] || MARK_LABEL.x}`;
  }
  // A slot of the strip: the expected char with its mark, a missing char (dashed, 빠짐), or an extra cell (the ink as
  // written, 필요 없음).
  function slotButton(s, onClick) {
    const face = s.type === 'extra'
      ? h('span', { class: 'wc-ink', 'aria-hidden': 'true' }, s.strokes && s.strokes.length && root.StrokeView
        ? root.StrokeView.userDrawing(s.strokes, { box: 100, numbers: false, arrows: false, label: '쓴 글자' }) : jp(s.written || '?', 'wc-ch'))
      : jp(s.ch || '?', 'wc-ch');
    return h('button', { type: 'button', class: 'wc-cell ' + slotClass(s), 'data-key': s.key, 'aria-pressed': 'false', 'aria-label': slotName(s), on: { click: onClick } },
      face, s.type === 'skip' ? null : h('span', { class: 'wc-mark', 'aria-hidden': 'true' }, SLOT_TAG[s.type] || MARK_SYM[s.mark] || MARK_SYM.x));
  }
  // The detail of a slot: its heading ('3번째 칸 · こ', '빠진 글자 · っ'), KanaAlign's note on it, and the graded-drawing
  // detail (KanaApp.ui.judgeDetail with the expected char); a missing char shows the right stroke order, an extra cell
  // the ink as written.
  function slotDetail(s) {
    const look = s.type === 'extra' ? s.written : s.expected;
    const tgt = look ? cellTarget(look) : 'other';
    const head = s.type === 'missing' ? ['빠진 글자 · ', jp(s.ch)]
      : s.type === 'extra' ? [`${s.cell + 1}번째 칸 · 필요 없는 칸`]
        : s.type === 'skip' ? [`${s.pos + 1}번째 글자 · `, jp(s.ch)]
          : [`${s.cell + 1}번째 칸 · `, jp(s.ch)];
    const out = [h('p', { class: 'wc-detail-h' }, head, tgt === 'kana' || tgt === 'extra'
      ? h('button', { type: 'button', class: 'btn btn-sm btn-quiet', on: { click: () => App.openDetail(look) } }, jp(look), ' 글자 자세히') : null)];
    if (s.note) out.push(h('p', { class: 'wc-note' }, rich(s.note)));
    if (s.type === 'match') {
      out.push(App.ui.judgeDetail(s.result, s.strokes, { ch: s.expected, box: s.box, mark: s.neutral ? undefined : s.mark, compact: true }));
    } else if (s.type === 'missing') {
      out.push(App.ui.judgeDetail(null, [], { ch: s.expected, empty: true, compact: true, report: false }));
    } else if (s.type === 'skip') {
      out.push(App.ui.judgeDetail(null, [], { ch: s.expected, skipped: true, compact: true, report: false }));
    } else if (s.strokes && s.strokes.length && root.StrokeView) {
      out.push(h('div', { class: 'wres wres-x is-compact' }, h('div', { class: 'wres-compare' }, h('figure', { class: 'wres-mine' },
        h('div', { class: 'wres-mine-svg' }, root.StrokeView.userDrawing(s.strokes, { box: 100, label: '이 칸에 쓴 글자와 쓴 순서' })),
        h('figcaption', null, h('b', null, '이 칸에 쓴 글자'), s.written ? h('span', { class: 'legend' }, '읽힌 글자: ', jp(s.written)) : null)))));
    }
    return out;
  }

  /* The accepted answer in the form that was written, then the other forms in brackets: てすと (テスト) ·
   * なに / なん (何) · the kanji form with furigana (何 なに／なん). kanjiMode: readings only. The readings keep the
   * entry's order (text, then alts) so they line up with the romaji / 한글 line below; the graded one is named
   * separately ('채점한 읽기'). `used` is kept in the signature for callers. */
  function answerNodes(entry, form, used, kanjiMode) {
    const forms = answerForms(entry, { kanjiMode });
    const f = forms.find((x) => x.form === form) || forms[0];
    const list = (x) => x.readings.map((r, i) => [i ? h('span', { class: 'wr-sep' }, ' / ') : null, jp(r, x === f ? 'wface' : '')]);
    if (f.form === 'kanji') return [wordFace(entry)];        // the furigana already shows every reading
    const others = forms.filter((x) => x !== f);
    return [list(f), others.length ? h('span', { class: 'wr-alt' }, ' (', others.map((x, i) => [i ? ' · ' : null, list(x)]), ')') : null];
  }

  // Typed answer result (쓰기 / 한자 읽기 타자, or 모르겠어요 in 타자).
  function typedResult(entry, cur, info, kanjiMode) {
    const mark = cur.readingMark || 'x';
    const r = readingOf(entry);
    const res = info && info.res;
    const several = readingsOf(entry).length > 1 || (!kanjiMode && hasKanji(entry));
    let title;
    if (cur.skipped) title = '정답을 확인하세요';
    else if (mark === 'o') title = info.kind === 'write' && res.form === 'kanji' ? '정답! (한자 표기)' : '정답!';
    else title = '아쉬워요';
    const form0 = res && res.correct && res.form ? res.form : defaultForm(entry);
    const form = kanjiMode ? resolveForm(entry, form0, { kanjiMode }) : form0;
    const used = res && res.reading ? (form === 'hira' ? hiraganaOf(res.reading) : form === 'kanji' ? null : res.reading) : null;
    return h('div', { class: 'fb fb-' + mark + ' wr-typed card' },
      h('div', { class: 'fb-head' },
        App.ui.resultMark(mark, { size: 'md' }),
        h('div', { class: 'fb-text' },
          h('p', { class: 'fb-title' }, title),
          h('p', { class: 'wr-answer' }, h('span', { class: 'wp-k' }, several ? '정답 (모두 인정)' : '정답'), answerNodes(entry, form, used, kanjiMode)),
          h('p', { class: 'wr-read' }, h('span', { lang: 'en' }, r.romaji), ' · ', r.hangul, !kanjiMode && entry.meaning ? ' · ' + entry.meaning : ''),
          cur.typed && (mark !== 'o' || cur.converted) ? h('p', { class: 'fb-given' }, '입력한 답: ', h('span', { class: 'given' }, rich(cur.typed)),
            cur.converted ? [' → ', h('span', { class: 'given' }, jp(cur.converted))] : null) : null,
          cur.cheat ? h('p', { class: 'fb-cheat' }, '컨닝한 문제로 기록돼요.') : cur.hintCounts ? h('p', { class: 'fb-cheat' }, '힌트를 본 문제로 기록돼요.') : null)),
      info && info.kind === 'reading' && res && res.segments && mark !== 'o' ? segmentsView(res.segments, true) : null);
  }

  /* =================================================================== 결과 */

  VIEWS.result = function (main) {
    const run = S.lastRun;
    if (!run) { go('list'); return; }
    const sum = summarize(run.answers);
    const wrong = retryIds(run.answers, ['x']);
    const tri = retryIds(run.answers, ['t']);
    const unanswered = run.endless ? 0 : Math.max(0, run.questions.length - run.answers.length);
    const tile = (mark, n, label) => h('div', { class: 'score-tile tile-' + mark }, App.ui.resultMark(mark, { size: 'md' }), h('span', { class: 'tile-n' }, n), h('span', { class: 'tile-label' }, label));
    const again = (ids, label) => {
      const pool = ids.map((id) => run.entries.get(id)).filter(Boolean);
      startRun(pool, Object.assign({}, run.prefs, { count: 'all' }), { ids, label });
    };
    main.appendChild(h('div', { class: 'result-page wr-page' },
      h('header', { class: 'page-head' },
        h('h1', { class: 'page-title' }, '결과'),
        h('p', { class: 'page-sub' }, `단어장 · ${modeName(run.mode)}${run.label ? ' · ' + run.label : ''}${run.endless ? ' · ∞ 무한 모드' : ''} · ${run.answers.length}문제`,
          unanswered ? ` (그만두기 전까지, ${unanswered}문제 남음)` : '')),
      h('section', { class: 'card result-summary' },
        h('div', { class: 'score-tiles' },
          tile('o', sum.o, '정답'),
          run.mode !== 'read' ? tile('t', sum.t, '획순·방향·획수') : null,
          tile('x', sum.x, '오답'),
          // answers with no gradable cell: neither right nor wrong (kept out of 오답 and 틀린 것만 다시)
          sum.na ? h('div', { class: 'score-tile tile-na' }, h('span', { class: 'tile-n' }, sum.na), h('span', { class: 'tile-label' }, '채점 안 함')) : null,
          sum.cheat ? h('div', { class: 'score-tile tile-cheat' }, h('span', { class: 'tile-n' }, sum.cheat), h('span', { class: 'tile-label' }, '컨닝·힌트')) : null),
        h('div', { class: 'result-actions' },
          wrong.length ? h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => again(wrong, '틀린 것만 다시') } }, `틀린 것만 다시 (${wrong.length})`) : null,
          tri.length ? h('button', { type: 'button', class: 'btn', on: { click: () => again(tri, '△ 획순 연습') } }, h('span', { class: 'mchip-sym tri-sym', 'aria-hidden': 'true' }, '△'), srOnly('세모(△) 받은 단어'), `만 다시 (${tri.length})`) : null,
          h('button', { type: 'button', class: 'btn', on: { click: () => go('setup') } }, '연습 설정으로'),
          h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => go('list') } }, '단어장으로'))),
      h('section', { class: 'result-list' },
        h('h2', { class: 'sec-h' }, '문제별 결과', h('small', null, ' 누르면 자세히')),
        h('ol', { class: 'qlist wr-list' }, run.answers.map((a, i) => resultItem(run, a, i))))));
  };

  // 결과 list, 쓰기: the answer in the form it was written (てすと, なん, 学生) + the kanji form when another form was used
  // (a typed miss / 모르겠어요 has no written form: the reading in the type's default form, with the kanji form)
  function writeAnswerFace(e, a) {
    let form = a.form || defaultForm(e);
    let text = a.answerText;
    if (!text) {
      if (form === 'kanji') form = resolveForm(e, defaultForm(e));
      text = formReadings(e, form)[0] || e.text;
    }
    return [jp(text), form !== 'kanji' && hasKanji(e) ? [' ', jp(kanjiOf(e), 'qi-ko')] : null];
  }

  function resultItem(run, a, i) {
    const e = a.entry;
    const detail = h('div', { class: 'qdetail', hidden: true });
    let built = false;
    const kanjiMode = a.mode === 'kanji';
    const face = kanjiMode ? jp(e.kanji, 'qi-glyph wr-qi-face') : a.mode === 'write' ? h('span', { class: 'qi-glyph wr-qi-face' }, displayMeaning(e) || jp(e.text)) : jp(e.text, 'qi-glyph wr-qi-face');
    const given = a.skipped ? h('span', { class: 'qi-given is-skip' }, '모르겠어요')
      : a.mode === 'read' ? (a.reading === 'o' ? h('span', { class: 'qi-given' }) : h('span', { class: 'qi-given is-input' }, srOnly('입력한 답 '), a.typed || ''))
        : a.typed != null ? h('span', { class: 'qi-given' + (a.reading === 'o' ? '' : ' is-input') }, rich(a.typed), a.converted ? [' → ', jp(a.converted)] : null)
          // the alignment strip in small: the answer's characters with their marks, missing ones dashed, extra cells struck
          : h('span', { class: 'qi-given wr-qi-cells' }, (a.slots || []).map((sl) => h('span', { class: 'wr-qi-cell ' + slotClass(sl) },
            jp(sl.ch || '?'), h('span', { class: 'sr-only' }, ' ' + (sl.type === 'missing' ? '빠짐' : sl.type === 'extra' ? '필요 없음' : sl.type === 'skip' ? '' : sl.neutral ? '채점 안 함' : MARK_LABEL[sl.mark] || '')))));
    const parts = a.meaning !== undefined
      ? h('span', { class: 'wr-parts' }, h('span', { class: 'wr-part' }, a.mode === 'kanji' ? '읽기 ' : '발음 ', markChip(a.reading)), h('span', { class: 'wr-part' }, '뜻 ', okChip(a.meaning === true ? true : a.meaning === false ? false : null),
        a.overridden ? h('span', { class: 'wr-ovr' }, '(스스로 인정)') : a.meaningHint ? h('span', { class: 'wr-ovr' }, '(힌트로 봄)') : null))
      : null;
    const btn = h('button', { type: 'button', class: 'qitem wr-qitem', 'aria-expanded': 'false' },
      h('span', { class: 'qi-n' }, i + 1),
      face,
      h('span', { class: 'qi-read' }, a.mode === 'write' ? writeAnswerFace(e, a) : h('span', { class: 'qi-ko' }, readingOf(e).romaji)),
      given,
      parts,
      a.cheat ? h('span', { class: 'cheat-tag' }, '컨닝') : a.hint ? h('span', { class: 'cheat-tag', title: `힌트 ${a.hint}단계까지 봤어요` }, h('span', { 'aria-hidden': 'true' }, '힌트 ' + a.hint), srOnly(`힌트 ${a.hint}단계까지 본 문제`)) : null,
      markChip(a.mark, null, 'qi-mark'));
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (!built) { built = true; buildDetail(); }
      detail.hidden = open;
    });
    function buildDetail() {
      detail.appendChild(entryReveal(e, { kanji: true }));
      if (a.mode === 'read' || (a.typed != null && a.check && a.check.segments)) {
        detail.appendChild(readingFeedback(e, a.reading, a.check, a.typed, a.skipped, a.cheat));
      }
      if (a.slots && a.slots.length) {
        if (a.formNote) detail.appendChild(h('p', { class: 'wr-form' }, rich(a.formNote)));
        const issues = issuesList(a.issues);
        if (issues) detail.appendChild(issues);
        const box = h('div', { class: 'wc-detail' });
        const strip = h('div', { class: 'wc-strip wa-strip', role: 'group', 'aria-label': '정답에 맞춰 본 칸' });
        const show = (sl) => {
          Array.from(strip.children).forEach((b) => b.setAttribute('aria-pressed', b.dataset.key === sl.key ? 'true' : 'false'));
          box.textContent = '';
          box.setAttribute('data-type', sl.type);
          add(box, slotDetail(sl));
        };
        a.slots.forEach((sl) => strip.appendChild(slotButton(sl, () => show(sl))));
        detail.appendChild(strip);
        detail.appendChild(box);
        const first = a.slots.find((sl) => sl.type === 'missing' || sl.type === 'extra' || sl.mark === 'x' || sl.mark === 't') || a.slots[0];
        if (first) show(first);
      }
      if (a.meaning !== undefined) {
        detail.appendChild(h('p', { class: 'wr-mean-line' }, '뜻: ', okChip(a.meaning === true ? true : a.meaning === false ? false : null), ' ',
          a.meaningHint && a.meaning == null ? '힌트로 봐서 뜻 맞히기는 건너뛰었어요'
            : a.meaning == null ? '안 풀었어요' : a.meaningInput ? ['내 답 「', a.meaningInput, '」'] : '모르겠어요', a.overridden ? ' — 맞은 걸로 인정' : ''));
      }
    }
    return h('li', { class: 'qrow qrow-' + (a.mark === '-' ? 'na' : a.mark) }, btn, detail);
  }

  return { _pure: pure, start };
});
