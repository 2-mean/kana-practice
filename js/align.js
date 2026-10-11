/* KanaAlign — open-length grading of a handwritten answer (docs/SPEC-words.md §M "Open-length writing").
 * The learner writes on a run of cells that does not give the answer's length away and presses 채점 when done; the
 * written cells are aligned to every accepted spelling of the entry and the best explanation is reported:
 * which form was written, which cells match which characters, what is missing, what is extra — with the
 * points a learner has to memorise (촉음 っ, 장음 ー / a lengthening vowel kana, 요음 ゃゅょ, small vowels, ん,
 * 탁점 / 반탁점) named in Korean. Pure, deterministic, no DOM. UMD: Node requires ./romaji.js and ./kana-data.js;
 * the browser uses the globals KanaText and KANA_DATA (looked up lazily on first use).
 *
 * API
 *   KanaAlign.answers(entry, opts?) → [answer]              all accepted target sequences, de-duplicated, in
 *                                                            tie-break order (hiragana, as written, kanji)
 *     answer = { key: 'hira:0' | 'text:1' | 'kanji' | 'kanji-hira', form: 'hira'|'text'|'kanji', reading: 0..n | null,
 *                kana?: 'hira' (the kanji form with its kana in hiragana: アメリカ人 → あめりか人),
 *                text /* normalized, spaces kept *\/, chars: [...] /* write cells: spaces dropped, 、。 kept *\/,
 *                label /* '히라가나' · '표기대로' · '한자 섞어' (+ ' · なん' when the entry has several readings) *\/ }
 *     reading = index into [entry.text, ...entry.alts] (normalized; invalid / duplicate alts dropped), null for kanji.
 *     opts = { kanjiMode (한자 읽기: no kanji form — the kanji is the prompt), kanji: false (same),
 *              forms: ['hira','text','kanji'] (keep only these, e.g. when js/kanji-data.js could not be loaded) }
 *   KanaAlign.grade(cells, entry, judgeFn, opts?) → result
 *     cells   = [{ index, strokes, box }] — the WRITTEN cells in writing (grid) order; cells without strokes are
 *               ignored (trailing / skipped empty cells never count). index = the grid cell index (defaults to the
 *               position in the array); it is what steps / marks / messages ('3번째 칸') refer to.
 *     judgeFn(strokes, ch, box) → JudgeResult | null  — KanaRecognizer.judge(strokes, ch, { box, strictness }) for
 *               kana / extras, KanjiJudge.judge for kanji; null = cannot judge (a kanji without stroke data) → a
 *               neutral match ('-', left out of the grade). A judgeFn that throws is treated like null (error: true).
 *     opts    = answers() opts + { answers (precomputed list), maxJudges (search budget, default min(6·cells + 24,
 *               2·cells + 48)), prescore: false (judge every pair the search asks for, no shape pre-score) };
 *               kanjiMode also words the mixed-form message for 한자 읽기 (the prompt's kanji copied into the cells)
 *     result  = {
 *       best:   answer (+ cost) | null,          // the accepted form the writing was graded against
 *       grade:  'o' | 't' | 'x' | '-',           // ○ every char matched ○ · △ only stroke-order verdicts ·
 *                                                // ✕ anything wrong, missing or extra · '-' nothing gradable
 *       steps:  [step],                          // the alignment in order; every written cell and every expected
 *                                                // char appears exactly once
 *         { type: 'match', cell, at, pos, expected, kind, verdict: 'correct'|'order'|'wrong'|null, mark, result,
 *           written? /* what the judge read in a ✕ cell *\/, neutral?, error?, note?,
 *           swap? { cell, pos } /* written in the neighbour's place; written = the neighbour's char *\/,
 *           mixed? /* holds a char of the other form (学 in 学せい); written = that char *\/ }
 *         { type: 'missing', pos, expected, kind, after /* grid index of the written cell before the gap, -1 *\/, note,
 *           mixed? /* beside a mixed cell: what its kanji stands for *\/ }
 *         { type: 'extra', cell, at, pos /* insertion point *\/, written /* recognised char or null *\/, result, mark: 'x', note }
 *         (at = position in cells, pos = position in best.chars, kind = see kinds())
 *       marks:  [{ i: cell index, mark: 'o'|'t'|'x'|'-' }],   // for GridPad.setMarks (every written cell)
 *       issues: [{ type: 'missing'|'extra'|'wrong'|'size'|'order'|'swap'|'mixed'|'different'|'empty', kind, reason?,
 *                  message, pos?, cell?, count? }],  — a run of ≥ 3 missing / extra / plain ✕ cells is one issue (kind
 *                  'run'); 'mixed' (with any swap) or 'different' replaces the per-cell list
 *       counts: { o, t, x, neutral, missing, extra, swapped /* pairs; their two cells are in x *\/ }, cost /* 1 ≈ one wrong / missing / extra char *\/,
 *       empty /* nothing written *\/, judged /* judgeFn calls *\/ }
 *   KanaAlign.kinds(text, opts?) → [kind] per write char of text (spaces dropped): 'sokuon' (っ ッ) · 'long' (ー) ·
 *     'longVowel' (a vowel kana lengthening the previous mora: おかあさん's あ, がっこう's う, せんせい's い) ·
 *     'yoon' (ゃゅょ after a consonant kana) · 'smallVowel' (ァィゥェォ in ファ / ティ …, or alone) · 'n' (ん ン) ·
 *     'punct' (、。) · 'kanji' · 'kana' · 'other'.   opts = { sentence } (particles: わたしは's は)
 *   KanaAlign.COST — the cost table below (read-only).
 *
 * Algorithm: weighted edit distance (Needleman–Wunsch) between the written cells and each answer's chars, searched
 * for all answers at once with A* on the alignment grid (state = answer, cells used, chars used; h = the length
 * difference still to cover × the cheapest gap cost — admissible and consistent). Match costs come from the judge
 * and are evaluated lazily: a diagonal move is queued with cost 0 and the judge is called only when it is popped,
 * so a right answer costs about one judge call per cell, and answers far from the writing (a 2-cell kanji form
 * against 8 cells of hiragana) are never expanded. Judgements are cached per (cell, char) and shared by all
 * answers. Shape pre-score: once a cell has a KanaRecognizer judgement, its top-5 shape candidates (plus their
 * small / big twins, other-script pairs and ゛゜ family) are the only kana it can match; any other kana target is
 * costed as a plain ✕ without a call. The search has a judge budget (opts.maxJudges); beyond it unknown pairs are
 * estimated the same way. Every match on the chosen path that was costed without a call is then judged for real,
 * and the search runs again if that changed a cost (≤ 6 rounds), so the reported marks are always real judgements.
 * Gaps in runs of the same char are moved to the later cell / char (がっっこう: the 2nd っ is extra; おきい for
 * おおきい: the long お is missing). Then two neighbours written in each other's place become one 순서 issue (findSwaps),
 * and a ✕ cell holding the other form's character (学せい) one mixed-form issue (findMixed).
 *
 * Costs (×1000 internally, integers, so ties are exact): match ○ 0 · △ 250 · neutral 300 · ✕ 1000, or 850 when the
 * judge reads the drawing as a near miss of the expected char (wrong size — ょ/よ, っ/つ; the other script — す/ス;
 * ゛゜ — が/か, ぱ/ば; a named look-alike — ぬ/め); missing 1000, or 970 for the chars learners leave out (っ ー,
 * lengthening vowel kana, ゃゅょ, small vowels, ん, 、。); extra 1000. So a near-miss beats "missing + extra"
 * (ちよと for ちょっと = big よ for ょ + missing っ), a forgotten っ/ー/small kana beats a ✕ big kana, and equal
 * costs go to the earlier answer (hiragana, then as written, then kanji; main reading before alts).
 *
 * Grade: 'o' when every expected char is matched ○ (neutral kanji allowed) and nothing is missing or extra; 't' when
 * the only problems are △ verdicts on matched chars; '-' when the only matches are neutral; otherwise 'x'.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module && module.exports;
  const api = factory(root, isNode
    ? function () { return { T: require('./romaji.js'), D: require('./kana-data.js') }; }
    : function () { return { T: root && root.KanaText, D: root && root.KANA_DATA }; });
  if (isNode) module.exports = api;
  else root.KanaAlign = api;
})(typeof self !== 'undefined' ? self : this, function (root, loadDeps) {
  'use strict';

  let deps = null;
  const dep = () => {
    if (!deps || !deps.T || !deps.D) deps = loadDeps() || {};
    if (!deps.T || !deps.D) throw new Error('KanaAlign: KanaText (js/romaji.js) and KANA_DATA (js/kana-data.js) must be loaded first');
    return deps;
  };
  const TX = () => dep().T;
  const KD = () => dep().D;

  /* ------------------------------------------------------------------ costs */

  const COST = Object.freeze({
    correct: 0, order: 250, neutral: 300, near: 850, wrong: 1000,
    missing: 1000, missingSoft: 970, extra: 1000,
  });
  const MIN_GAP = Math.min(COST.missing, COST.missingSoft, COST.extra);
  const SOFT_KINDS = new Set(['sokuon', 'long', 'longVowel', 'yoon', 'smallVowel', 'n', 'punct']);
  const UNIT = 1000;
  const KANA_LIKE = 0.07;     // KanaRecognizer candidate score of a cell that clearly holds a kana (kanji / scribbles ≥ 0.12)

  /* ------------------------------------------------------------------ character tables (lazy) */

  let tables = null;
  function tab() {
    if (tables) return tables;
    const D = KD();
    const kana = D.kana || {}, extra = D.extra || {};
    const bigOf = new Map(), smallOf = new Map(), baseOf = new Map(), family = new Map();
    for (const [ch, e] of Object.entries(extra)) if (e.kind === 'small' && e.big) { bigOf.set(ch, e.big); smallOf.set(e.big, ch); }
    for (const [ch, e] of Object.entries(kana)) {
      const b = e.base || ch;
      baseOf.set(ch, b);
      if (!family.has(b)) family.set(b, []);
      family.get(b).push(ch);
    }
    tables = { kana, extra, bigOf, smallOf, baseOf, family };
    return tables;
  }
  const infoOf = (ch) => { const t = tab(); return t.kana[ch] || t.extra[ch] || null; };
  const isKanaCh = (ch) => !!infoOf(ch);
  const isIdeo = (ch) => /[々〆ヶ]/.test(ch) || !!TX().isKanjiForm(ch);
  const toHira = (s) => TX().toHiragana(s);
  const VOWEL_KANA = { 'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o', 'ア': 'a', 'イ': 'i', 'ウ': 'u', 'エ': 'e', 'オ': 'o' };
  const SOKUON = new Set(['っ', 'ッ']);
  const YOON_SMALL = new Set(['ゃ', 'ゅ', 'ょ', 'ャ', 'ュ', 'ョ']);
  const SMALL_VOWEL = new Set(['ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ']);

  // Chars a learner may write in place of ch by a near miss: small/big twin, other script, ゛゜ family (and the
  // other script of those).
  function relatives(ch) {
    const t = tab();
    const out = new Set();
    const add = (c) => { if (c && c !== ch) out.add(c); };
    const kata = TX().toKatakana, hira = toHira;
    const fam = (c) => (t.family.get(t.baseOf.get(c) || c) || []);
    for (const c of [ch, t.bigOf.get(ch), t.smallOf.get(ch)]) {
      if (!c) continue;
      add(c); add(hira(c)); add(kata(c));
      for (const f of fam(c)) { add(f); add(hira(f)); add(kata(f)); }
      for (const f of fam(hira(c))) { add(f); add(kata(f)); }
    }
    return out;
  }
  const relCache = new Map();
  const relSet = (a) => {
    if (!relCache.has(a)) relCache.set(a, relatives(a));
    return relCache.get(a);
  };
  const related = (a, b) => relSet(a).has(b);

  /* ------------------------------------------------------------------ readings & answers */

  function readingsOf(entry) {
    const T = TX();
    const out = [];
    const push = (s, check) => {
      let n = '';
      if (check) { const v = T.validate(String(s == null ? '' : s)); n = v.ok ? v.normalized : ''; } else n = T.normalize(String(s == null ? '' : s)).trim();
      if (n && !out.includes(n)) out.push(n);
    };
    push(entry && entry.text, false);
    for (const a of (entry && Array.isArray(entry.alts) ? entry.alts : [])) push(a, true);
    return out;
  }

  // A kana text in hiragana (テスト → てすと); ー, 、。, kanji and katakana without a hiragana that has stroke data
  // (ヴ, ヵ, ヶ) stay as they are — the same rule as js/words.js hiraganaOf.
  function hiraganaOf(text) {
    return Array.from(String(text == null ? '' : text), (ch) => {
      const hc = toHira(ch);
      return hc !== ch && isKanaCh(hc) ? hc : ch;
    }).join('');
  }
  const writeChars = (text) => Array.from(TX().normalize(text)).filter((c) => c !== ' ');
  const FORM_LABEL = { hira: '히라가나', text: '표기대로', kanji: '한자 섞어' };
  const FORM_ORDER = ['hira', 'text', 'kanji'];

  function answers(entry, opts) {
    const o = opts || {};
    const T = TX();
    const allow = (f) => (!Array.isArray(o.forms) || o.forms.includes(f)) && !(f === 'kanji' && (o.kanjiMode || o.kanji === false));
    const rs = readingsOf(entry);
    const several = rs.length > 1;
    const out = [], seen = new Set();
    const add = (a) => {
      a.chars = writeChars(a.text);
      const sig = a.chars.join('\u0001');
      if (!a.chars.length || seen.has(sig)) return;
      seen.add(sig);
      out.push(a);
    };
    if (allow('hira')) rs.forEach((r, i) => add({ key: 'hira:' + i, form: 'hira', reading: i, text: hiraganaOf(r), label: FORM_LABEL.hira + (several ? ' · ' + hiraganaOf(r) : '') }));
    if (allow('text')) rs.forEach((r, i) => add({ key: 'text:' + i, form: 'text', reading: i, text: r, label: FORM_LABEL.text + (several ? ' · ' + r : '') }));
    if (allow('kanji') && entry && entry.kanji && T.isKanjiForm(entry.kanji)) {
      const kj = T.validateKanji(String(entry.kanji)).normalized;
      add({ key: 'kanji', form: 'kanji', reading: null, text: kj, label: FORM_LABEL.kanji });
      const kh = hiraganaOf(kj);
      if (kh !== kj) add({ key: 'kanji-hira', form: 'kanji', reading: null, kana: 'hira', text: kh, label: FORM_LABEL.kanji + ' (가나는 히라가나)' });
    }
    return out;
  }

  /* ------------------------------------------------------------------ char kinds */

  function kindsWithContext(text, opts) {
    const T = TX();
    const norm = T.normalize(text);
    const cps = Array.from(norm);
    const segs = T.segment(norm, { sentence: !!(opts && opts.sentence) });
    const byIdx = new Array(cps.length).fill(null);
    for (const s of segs) for (let i = s.start; i < s.end; i++) byIdx[i] = s;
    const kinds = [], particle = [], prevText = [], textIdx = [];
    cps.forEach((ch, i) => {
      if (ch === ' ') return;
      const s = byIdx[i];
      let k;
      if (SOKUON.has(ch)) k = 'sokuon';
      else if (ch === 'ー') k = 'long';
      else if (s && s.kind === 'punct') k = 'punct';
      else if (ch === 'ん' || ch === 'ン') k = 'n';
      else if (s && s.kind === 'mora' && s.end - s.start === 2 && i === s.end - 1) k = YOON_SMALL.has(ch) ? 'yoon' : SMALL_VOWEL.has(ch) ? 'smallVowel' : 'kana';
      else if (SMALL_VOWEL.has(ch)) k = 'smallVowel';
      else if (YOON_SMALL.has(ch)) k = 'yoon';
      else if (s && s.kind === 'mora' && s.long && VOWEL_KANA[ch]) k = 'longVowel';
      else if (isKanaCh(ch)) k = 'kana';
      else if (isIdeo(ch)) k = 'kanji';
      else k = 'other';
      kinds.push(k);
      particle.push(!!(s && s.particle));
      // the mora this char lengthens / belongs to (for messages: こう's こ)
      const prev = s && s.start > 0 ? byIdx[s.start - 1] : null;
      prevText.push(prev && prev.kind !== 'space' && prev.kind !== 'punct' ? prev.text : '');
      textIdx.push(i);
    });
    return { kinds, particle, prevText, textIdx, cps };
  }
  const kinds = (text, opts) => kindsWithContext(text, opts).kinds;

  /* ------------------------------------------------------------------ Korean wording */

  // true = the Korean reading ends in a final consonant (받침), false = vowel, null = unknown (kanji)
  function hasFinal(ch) {
    if (SOKUON.has(ch)) return true;                       // 촉음 っ이 / っ을
    if (ch === 'ー' || ch === '、' || ch === '。') return false;  // 장음 ー가, 쉼표 、가, 마침표 。가
    const k = infoOf(ch);
    let ko = k && k.ko;
    if (!ko && k && k.big) { const b = infoOf(k.big); ko = b && b.ko; }
    if (!ko) return null;
    const c = ko.charCodeAt(ko.length - 1);
    if (c < 0xac00 || c > 0xd7a3) return null;
    return (c - 0xac00) % 28 !== 0;
  }
  // word + particle chosen by the last char: josa('っ', '이', '가') → 'っ이'. Kanji → '学 글자가'.
  function josa(word, withFinal, noFinal) {
    const w = String(word);
    // the particle follows the word before a trailing note: 탁점(゛) → 탁점이
    const core = w.replace(/\s*\([^()]*\)\s*$/, '') || w;
    const last = Array.from(core).pop() || '';
    const code = last.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) return w + ((code - 0xac00) % 28 !== 0 ? withFinal : noFinal);
    const f = hasFinal(last);
    if (f === null) {
      if (isIdeo(last) && Array.from(w).length === 1) return w + ' 글자' + noFinal;
      return w + withFinal + '(' + noFinal + ')';
    }
    return w + (f ? withFinal : noFinal);
  }
  const ro = (w) => {             // 로 / 으로 (ㄹ 받침 → 로; kana readings never end in ㄹ)
    const last = Array.from(String(w)).pop() || '';
    const f = hasFinal(last);
    if (f === null) return isIdeo(last) ? w + ' 글자로' : w + '(으)로';
    return w + (f ? '으로' : '로');
  };
  const cellName = (cell) => `${cell + 1}번째 칸`;
  const KIND_NAME = { sokuon: '촉음 ', long: '장음 ', longVowel: '장음(길게 읽는 소리) ', yoon: '요음 ', smallVowel: '작은 ' };
  const SIZE_NAME = { sokuon: '촉음 ', yoon: '요음 ' };
  const PUNCT_NAME = { '、': '쉼표 ', '。': '마침표 ' };

  /* ------------------------------------------------------------------ binary heap */

  function Heap(less) { this.a = []; this.less = less; }
  Heap.prototype.push = function (x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
  };
  Heap.prototype.pop = function () {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  };
  Object.defineProperty(Heap.prototype, 'size', { get() { return this.a.length; } });

  /* ------------------------------------------------------------------ judging (cache, pre-score, budget) */

  function verdictCost(ch, r) {
    if (!r) return COST.neutral;
    if (r.verdict === 'correct') return COST.correct;
    if (r.verdict === 'order') return COST.order;
    const size = Array.isArray(r.issues) && r.issues.some((i) => i && i.type === 'size');
    const rec = r.recognized;
    if (size || r.confusedWith || (rec && rec !== ch && related(ch, rec))) return COST.near;
    return COST.wrong;
  }

  function makeJudge(list, judgeFn, o) {
    const cache = new Map();                    // `${at}\u0001${ch}` → { cost, result, predicted, error }
    const plaus = list.map(() => null);         // per cell: Set of kana it can be, from a KanaRecognizer judgement
    const top = list.map(() => null);           // per cell: its best shape candidate
    const topScore = list.map(() => NaN);       // … and that candidate's shape distance (a written kana ≈ 0.01–0.05)
    const ctx = { calls: 0, searchCalls: 0, budget: o.maxJudges != null ? Math.max(0, o.maxJudges | 0) : Math.min(6 * list.length + 24, 2 * list.length + 48) };
    const usePrescore = o.prescore !== false;
    const key = (at, ch) => at + '\u0001' + ch;

    function learn(at, ch, r) {
      if (!r || !isKanaCh(ch) || !Array.isArray(r.candidates) || r.candidates.length < 3) return;
      const s = plaus[at] || new Set();
      const add = (c) => { if (!c) return; s.add(c); for (const x of relSet(c)) s.add(x); };
      for (const c of r.candidates) add(c && c.ch);
      add(r.recognized); add(r.confusedWith);
      if (r.verdict !== 'wrong') add(ch);
      plaus[at] = s;
      if (!top[at] && r.candidates[0]) { top[at] = r.candidates[0].ch; topScore[at] = Number(r.candidates[0].score); }
    }
    function real(at, ch) {
      const c = list[at];
      let result = null, error = false;
      ctx.calls++;
      try { result = judgeFn(c.strokes, ch, c.box) || null; } catch (e) { result = null; error = true; }
      const e = { cost: verdictCost(ch, result), result, predicted: false, error };
      cache.set(key(at, ch), e);
      learn(at, ch, result);
      return e;
    }
    // estimated cost without a call, or null when the pair must be judged
    function estimate(at, ch, force) {
      if (!usePrescore && !force) return null;
      if (isKanaCh(ch) && plaus[at]) {
        if (!plaus[at].has(ch)) return COST.wrong;
        if (!force) return null;
        return top[at] === ch ? COST.correct : COST.near;
      }
      return force ? COST.wrong : null;
    }
    return {
      ctx,
      known(at, ch) { const e = cache.get(key(at, ch)); return e && !e.predicted ? e.cost : null; },
      // the cell clearly holds a kana (its best shape candidate fits closely): not a kanji
      kanaLike(at) { return topScore[at] <= KANA_LIKE; },
      // false when the cell's shape candidates rule ch out (no call needed to know it is not ch)
      // past the overall call budget (search budget + two calls per cell): extras are named from what is known
      spent() { return ctx.calls >= ctx.budget + 2 * list.length; },
      plausible(at, ch) { return !(usePrescore && isKanaCh(ch) && plaus[at] && !plaus[at].has(ch)); },
      entry(at, ch) { return cache.get(key(at, ch)) || null; },
      // during the search: judged already, else pre-scored, else judged (within the budget), else estimated.
      // Estimates are not trusted later: they are made again with what the cell's judgements say by then.
      cost(at, ch) {
        const e = cache.get(key(at, ch));
        if (e && !e.predicted) return e.cost;
        const p = estimate(at, ch, false);
        if (p != null) { cache.set(key(at, ch), { cost: p, result: null, predicted: true }); return p; }
        if (ctx.searchCalls >= ctx.budget) {
          const q = estimate(at, ch, true);
          cache.set(key(at, ch), { cost: q, result: null, predicted: true });
          return q;
        }
        ctx.searchCalls++;
        return real(at, ch).cost;
      },
      // a real judgement (no budget): for the chosen path, run normalization and messages
      judge(at, ch) {
        const e = cache.get(key(at, ch));
        if (e && !e.predicted) return e;
        return real(at, ch);
      },
      // what a cell (extra) seems to be: a target it was judged ○/△ for, else what the judge read
      identity(at, near) {
        let firstOk = null, rec = null;
        for (const [k, e] of cache) {
          if (e.predicted || !e.result || k.split('\u0001')[0] !== String(at)) continue;
          const ch = k.slice(k.indexOf('\u0001') + 1);
          if (e.result.verdict !== 'wrong' && !firstOk) firstOk = { ch, result: e.result };
          if (!rec && e.result.recognized && isKanaCh(ch)) rec = { ch: e.result.recognized, result: e.result };
        }
        if (firstOk) return firstOk;
        for (const ch of near) {
          if (!ch || !this.plausible(at, ch) || (rec && this.spent())) continue;
          const e = this.judge(at, ch);
          if (e.result && e.result.verdict !== 'wrong') return { ch, result: e.result };
          if (!rec && e.result && e.result.recognized) rec = { ch: e.result.recognized, result: e.result };
        }
        return rec || { ch: null, result: null };
      },
    };
  }

  /* ------------------------------------------------------------------ A* over all answers */

  // entry: [f, rank, -depth, seq, ci, j, k, g, pending, parentId, move]
  const less = (a, b) => (a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] !== b[2] ? a[2] < b[2] : a[3] < b[3]);
  const MOVE_MATCH = 1, MOVE_EXTRA = 2, MOVE_MISSING = 3;

  function search(n, cands, J) {
    const heap = new Heap(less);
    let seq = 0;
    const st = cands.map((c) => {
      const m = c.chars.length, size = (n + 1) * (m + 1);
      return { m, g: new Float64Array(size).fill(Infinity), closed: new Uint8Array(size), par: new Int32Array(size).fill(-1), mv: new Uint8Array(size) };
    });
    const H = (ci, j, k) => Math.abs((n - j) - (st[ci].m - k)) * MIN_GAP;
    const push = (ci, j, k, g, pending, parent, move) => heap.push([g + H(ci, j, k), ci, -(j + k), seq++, ci, j, k, g, pending, parent, move]);
    const relax = (ci, j, k, g, parent, move) => {
      const S = st[ci], id = j * (S.m + 1) + k;
      if (S.closed[id] || g >= S.g[id]) return;
      S.g[id] = g;
      push(ci, j, k, g, 0, parent, move);
    };
    cands.forEach((c, ci) => { st[ci].g[0] = 0; push(ci, 0, 0, 0, 0, -1, 0); });
    while (heap.size) {
      const e = heap.pop();
      const ci = e[4], j = e[5], k = e[6], g = e[7], pending = e[8];
      const S = st[ci], W = S.m + 1, id = j * W + k;
      if (S.closed[id]) continue;
      if (pending) {                                   // a match move whose cost is evaluated only now
        relax(ci, j, k, g + J.cost(j - 1, cands[ci].chars[k - 1]), e[9], MOVE_MATCH);
        continue;
      }
      if (g > S.g[id]) continue;
      S.closed[id] = 1; S.par[id] = e[9]; S.mv[id] = e[10];
      if (j === n && k === S.m) {
        const path = [];
        for (let x = id; x > 0 && S.mv[x];) {
          const jj = Math.floor(x / W), kk = x % W, mv = S.mv[x];
          path.push({ move: mv, at: mv !== MOVE_MISSING ? jj - 1 : null, pos: mv !== MOVE_EXTRA ? kk - 1 : null });
          x = S.par[x];
        }
        path.reverse();
        return { ci, cost: g, path };
      }
      const chars = cands[ci].chars;
      if (j < n && k < S.m) {
        const cid = (j + 1) * W + k + 1;
        if (!S.closed[cid]) {
          const known = J.known(j, chars[k]);
          if (known != null) relax(ci, j + 1, k + 1, g + known, id, MOVE_MATCH);
          else if (g < S.g[cid]) push(ci, j + 1, k + 1, g, 1, id, MOVE_MATCH);
        }
      }
      if (j < n) relax(ci, j + 1, k, g + COST.extra, id, MOVE_EXTRA);
      if (k < S.m) relax(ci, j, k + 1, g + cands[ci].miss[k], id, MOVE_MISSING);
    }
    return null;   // unreachable: every answer has a complete path
  }

  /* ------------------------------------------------------------------ grading */

  function grade(cells, entry, judgeFn, opts) {
    const o = opts || {};
    const sentence = !!(entry && entry.type === 'sentence');
    const list = (Array.isArray(cells) ? cells : [])
      .map((c, i) => (c && Array.isArray(c.strokes) && c.strokes.length
        ? { index: Number.isFinite(c.index) ? c.index : i, strokes: c.strokes, box: c.box || { x: 0, y: 0, w: 100, h: 100 } } : null))
      .filter(Boolean);
    // internal copies (the caller's answer objects are never touched): chars + kinds + gap costs
    const cands = (Array.isArray(o.answers) ? o.answers : answers(entry, o))
      .filter((a) => a && Array.isArray(a.chars) && a.chars.length)
      .map((a) => {
        const text = typeof a.text === 'string' && a.text ? a.text : a.chars.join('');
        const ctx = kindsWithContext(text, { sentence });
        const c = Object.assign({}, a, { text, chars: a.chars.slice(), ctx });
        if (ctx.kinds.length !== c.chars.length) c.ctx = kindsWithContext(c.chars.join(''), { sentence });
        c.miss = c.ctx.kinds.map((k) => (SOFT_KINDS.has(k) ? COST.missingSoft : COST.missing));
        return c;
      });
    const counts = { o: 0, t: 0, x: 0, neutral: 0, missing: 0, extra: 0, swapped: 0 };
    if (!cands.length) {
      return { best: null, grade: '-', steps: [], marks: list.map((c) => ({ i: c.index, mark: '-' })), issues: [], counts, cost: 0, empty: !list.length, judged: 0 };
    }
    const n = list.length;

    // nothing written: the first answer, every char missing
    if (!n) {
      const best = cands[0];
      const steps = best.chars.map((ch, pos) => ({ type: 'missing', pos, expected: ch, kind: best.ctx.kinds[pos], after: -1 }));
      counts.missing = steps.length;
      return {
        best: publicAnswer(best, best.miss.reduce((s, x) => s + x, 0) / UNIT), grade: 'x', steps, marks: [],
        issues: [{ type: 'empty', kind: null, message: '아무것도 쓰지 않았어요.' }], counts,
        cost: best.miss.reduce((s, x) => s + x, 0) / UNIT, empty: true, judged: 0,
      };
    }

    const J = makeJudge(list, judgeFn, o);
    let res = null;
    for (let round = 0; round < 6; round++) {
      res = search(n, cands, J);
      // judge for real every match on the path that was costed without a call
      let changed = false;
      for (const s of res.path) {
        if (s.move !== MOVE_MATCH) continue;
        const ch = cands[res.ci].chars[s.pos];
        const before = J.entry(s.at, ch);
        if (before && !before.predicted) continue;
        const after = J.judge(s.at, ch);
        if (!before || after.cost !== before.cost) changed = true;
      }
      if (!changed) break;
    }
    const best = cands[res.ci];
    const path = normalizeGaps(res.path, best, J);
    return report(list, best, path, J, counts, sentence, cands, entry, o);
  }

  // Runs of the same char: an extra cell goes after the one that matches (がっっこう: the 2nd っ is extra), a
  // missing char goes to the later position (おきい for おおきい: the long お is missing).
  function normalizeGaps(path, best, J) {
    const p = path.map((s) => Object.assign({}, s));
    const chars = best.chars;
    for (let guard = 0, moved = true; moved && guard < 4 * p.length; guard++) {
      moved = false;
      for (let i = 0; i + 1 < p.length; i++) {
        const a = p[i], b = p[i + 1];
        if (a.move === MOVE_EXTRA && b.move === MOVE_MATCH) {
          const X = chars[b.pos];
          const cb = J.judge(b.at, X).cost;
          const ca = J.judge(a.at, X).cost;
          if (ca <= COST.order && ca <= cb) {
            p[i] = { move: MOVE_MATCH, at: a.at, pos: b.pos };
            p[i + 1] = { move: MOVE_EXTRA, at: b.at, pos: null };
            moved = true;
          }
        } else if (a.move === MOVE_MISSING && b.move === MOVE_MATCH && chars[a.pos] === chars[b.pos] && best.miss[b.pos] <= best.miss[a.pos]) {
          p[i] = { move: MOVE_MATCH, at: b.at, pos: a.pos };
          p[i + 1] = { move: MOVE_MISSING, at: null, pos: b.pos };
          moved = true;
        }
      }
    }
    return p;
  }

  function publicAnswer(a, cost) {
    const out = { key: a.key, form: a.form, reading: a.reading, text: a.text, chars: a.chars.slice(), label: a.label, cost };
    if (a.kana) out.kana = a.kana;
    return out;
  }

  // the word around char position pos of the answer (between spaces / 、。): the context shown in messages
  function contextOf(best, pos) {
    const cx = best.ctx;
    if (pos < 0 || pos >= cx.textIdx.length) pos = Math.max(0, Math.min(cx.textIdx.length - 1, pos));
    const brk = (c) => c === ' ' || c === '、' || c === '。';
    let i = cx.textIdx[pos];
    if (brk(cx.cps[i])) {                        // 、。 itself: the word before it, with the mark
      let a = i;
      while (a > 0 && !brk(cx.cps[a - 1])) a--;
      return a < i ? cx.cps.slice(a, i + 1).join('') : best.text;
    }
    let a = i, b = i + 1;
    while (a > 0 && !brk(cx.cps[a - 1])) a--;
    while (b < cx.cps.length && !brk(cx.cps[b])) b++;
    return cx.cps.slice(a, b).join('') || best.text;
  }

  // a match step for written cell `at` (position in list) against answer char `pos`
  function matchStep(list, best, J, at, pos) {
    const ch = best.chars[pos], e = J.judge(at, ch), r = e.result;
    const verdict = r ? r.verdict : null;
    const mark = !r ? '-' : verdict === 'correct' ? 'o' : verdict === 'order' ? 't' : 'x';
    const st = { type: 'match', cell: list[at].index, at, pos, expected: ch, kind: best.ctx.kinds[pos], verdict, mark, result: r };
    if (!r) st.neutral = true;
    if (e.error) st.error = true;
    if (mark === 'x' && r && r.recognized) st.written = r.recognized;
    return st;
  }
  const accepted = (e) => !!(e && e.result && (e.result.verdict === 'correct' || e.result.verdict === 'order'));

  /* Two neighbouring characters written in each other's place (がこっう, がっうこ, こね for ねこ): the alignment explains
   * them as two ✕ (or as an extra cell + a missing char around a match); when each of the two cells is accepted as the
   * other char, they are one mistake — the order. The pair becomes two ✕ matches flagged swap (written = the char the
   * cell holds), so the contract (every cell and char once, in order) holds. */
  function findSwaps(steps, list, best, J) {
    const chars = best.chars;
    const flag = (a, b) => {
      a.swap = { cell: b.cell, pos: b.pos }; b.swap = { cell: a.cell, pos: a.pos };
      a.written = chars[b.pos]; b.written = chars[a.pos];
    };
    let n = 0;
    for (let i = 0; i + 1 < steps.length; i++) {
      const a = steps[i], b = steps[i + 1], c = steps[i + 2];
      if (a.type === 'match' && b.type === 'match' && a.mark === 'x' && b.mark === 'x' && b.pos === a.pos + 1 && b.at === a.at + 1
        && chars[a.pos] !== chars[b.pos] && J.plausible(a.at, chars[b.pos]) && J.plausible(b.at, chars[a.pos])
        && accepted(J.judge(a.at, chars[b.pos])) && accepted(J.judge(b.at, chars[a.pos]))) {
        flag(a, b); n++; i++;
        continue;
      }
      if (!c || b.type !== 'match' || (b.mark !== 'o' && b.mark !== 't')) continue;
      // extra(a) · match(b, k) · missing(k + 1): cell a holds chars[k + 1]
      if (a.type === 'extra' && c.type === 'missing' && b.at === a.at + 1 && c.pos === b.pos + 1 && chars[b.pos] !== chars[c.pos]
        && J.plausible(a.at, chars[c.pos]) && accepted(J.judge(a.at, chars[c.pos])) && !accepted(J.judge(a.at, chars[b.pos]))) {
        const x = matchStep(list, best, J, a.at, b.pos), y = matchStep(list, best, J, b.at, c.pos);
        if (x.mark === 'x' && y.mark === 'x') { flag(x, y); steps.splice(i, 3, x, y); n++; i++; }
        continue;
      }
      // missing(k) · match(b, k + 1) · extra(c): cell c holds chars[k]
      if (a.type === 'missing' && c.type === 'extra' && c.at === b.at + 1 && b.pos === a.pos + 1 && chars[a.pos] !== chars[b.pos]
        && J.plausible(c.at, chars[a.pos]) && accepted(J.judge(c.at, chars[a.pos])) && !accepted(J.judge(b.at, chars[a.pos]))) {
        const x = matchStep(list, best, J, b.at, a.pos), y = matchStep(list, best, J, c.at, b.pos);
        if (x.mark === 'x' && y.mark === 'x') { flag(x, y); steps.splice(i, 3, x, y); n++; i++; }
      }
    }
    return n;
  }

  /* A spelling that mixes the entry's two forms (学せい, がく生 for 学生 / がくせい; 食じ for 食事 / しょくじ) is not an accepted
   * answer, but it is not a string of wrong characters either: when a ✕ / extra cell is accepted as one of the kanji of the
   * kanji form (graded as a kana form), or as one of the kana its kanji stand for (graded as the kanji form), the cells
   * are flagged mixed and one message names the two accepted forms. 한자 읽기 (kanjiMode): kanji copied from the prompt.
   * Bounded: a few ✕ cells only (≤ kanji + 2), ≤ 24 judge calls. → issue | null */
  function findMixed(steps, best, J, cands, entry, o) {
    const T = TX();
    if (!entry || !entry.kanji || !T.isKanjiForm(entry.kanji)) return null;
    const kanjiText = T.validateKanji(String(entry.kanji)).normalized;
    const kanjiChars = Array.from(new Set(writeChars(kanjiText).filter(isIdeo)));
    if (!kanjiChars.length) return null;
    const kanaAns = best.form !== 'kanji' ? cands.find((a) => a.key === 'hira:' + best.reading) || best : cands.find((a) => a.form === 'hira') || null;
    const kanaText = kanaAns ? kanaAns.text : '';
    const bad = steps.filter((s) => (s.type === 'match' && s.mark === 'x' && !s.swap) || s.type === 'extra');
    if (!bad.length || bad.length > kanjiChars.length + 2) return null;
    const kanaForm = best.form !== 'kanji';
    const good = steps.some((s) => s.type === 'match' && (s.mark === 'o' || s.mark === 't') && (kanaForm ? s.kind !== 'kanji' : s.kind === 'kanji'));
    if (!good && !(o.kanjiMode && kanaForm)) return null;
    // what a ✕ cell may hold instead: the kanji of the kanji form, or the kana that only its kanji stand for
    const inKanji = new Set(writeChars(kanjiText));
    const look = kanaForm ? kanjiChars : Array.from(new Set(writeChars(kanaText).filter((c) => isKanaCh(c) && !inKanji.has(c)))).slice(0, 10);
    if (!look.length) return null;
    let calls = 0;
    const hits = [];
    for (const st of bad) {
      if (kanaForm && J.kanaLike(st.at)) continue;      // a kana in a kana spelling: a wrong char, not a kanji
      for (const ch of look) {
        if (calls >= 24) break;
        if (!J.plausible(st.at, ch)) continue;
        if (!J.entry(st.at, ch) || J.entry(st.at, ch).predicted) calls++;
        if (accepted(J.judge(st.at, ch))) { hits.push([st, ch]); break; }
      }
    }
    if (!hits.length) return null;
    const what = uniqJoin(hits.map((x) => x[1]));
    let message;
    if (o.kanjiMode && kanaForm) message = `${what}: 한자를 그대로 옮겨 썼어요 — 읽기를 가나로 써요 (${kanaText})`;
    else if (kanaForm) message = `${what}만 한자로 썼어요 — ${kanjiText}처럼 한자 표기로 쓰거나 ${kanaText}처럼 모두 가나로 써요`;
    else message = `${what}만 가나로 썼어요 — ${kanjiText}처럼 한자 표기로 쓰거나 ${kanaText}처럼 모두 가나로 써요`;
    for (const [st, ch] of hits) { st.mixed = true; st.written = ch; st.note = message; }
    // the chars around a kanji cell that the kana alignment calls missing (学せい: が beside 学/く) are what that kanji
    // stands for — they carry the same note, not '…가 빠졌어요'
    steps.forEach((st, i) => {
      if (st.type === 'missing' && ((steps[i - 1] && steps[i - 1].mixed) || (steps[i + 1] && steps[i + 1].mixed))) { st.mixed = true; st.note = message; }
    });
    return { type: 'mixed', kind: null, message, cells: hits.map((x) => x[0].cell), chars: hits.map((x) => x[1]) };
  }
  const uniqJoin = (a) => Array.from(new Set(a)).join('·');

  function report(list, best, path, J, counts, sentence, cands, entry, o) {
    const cx = best.ctx;
    const chars = best.chars;
    const steps = [];
    let lastCell = -1, k = 0;
    for (const s of path) {
      if (s.move === MOVE_MATCH) {
        steps.push(matchStep(list, best, J, s.at, s.pos));
        lastCell = list[s.at].index; k = s.pos + 1;
      } else if (s.move === MOVE_EXTRA) {
        const near = [chars[k - 1], chars[k]].filter(Boolean);
        const id = J.identity(s.at, near);
        steps.push({ type: 'extra', cell: list[s.at].index, at: s.at, pos: k, written: id.ch, result: id.result, mark: 'x' });
        lastCell = list[s.at].index;
      } else {
        steps.push({ type: 'missing', pos: s.pos, expected: chars[s.pos], kind: cx.kinds[s.pos], after: lastCell });
        k = s.pos + 1;
      }
    }
    counts.swapped = findSwaps(steps, list, best, J);
    let cost = 0;
    for (const st of steps) cost += st.type === 'match' ? J.judge(st.at, st.expected).cost : st.type === 'extra' ? COST.extra : best.miss[st.pos];

    // notes per step, then issues (runs of ≥ 3 missing / extra / plain ✕ collapsed into one message)
    for (const st of steps) {
      const note = noteFor(st, best, steps, sentence);
      if (note) { st.note = note.message; if (!note.noteOnly) st._issue = note; }
    }
    const mixed = findMixed(steps, best, J, cands, entry, o || {});
    const plainX = (st) => st.type === 'match' && st.mark === 'x' && !st.swap && !st.mixed && st._issue && st._issue.type === 'wrong'
      && (st._issue.reason === 'other' || st._issue.reason === 'lookalike');
    const issues = [];
    for (let i = 0; i < steps.length;) {
      const st = steps[i];
      if (st.type === 'missing' || st.type === 'extra' || plainX(st)) {
        let j = i;
        const same = (x) => (st.type === 'match' ? plainX(x) : x.type === st.type);
        while (j < steps.length && same(steps[j])) j++;
        if (j - i >= 3) {
          issues.push(runIssue(steps.slice(i, j), best, i === 0, j === steps.length));
          i = j;
          continue;
        }
      }
      if (st._issue) issues.push(st._issue);
      i++;
    }
    for (const st of steps) delete st._issue;

    const marks = [];
    let gradable = 0, hasOrder = false, bad = false, swappedCells = 0;
    for (const st of steps) {
      if (st.type === 'match') {
        marks.push({ i: st.cell, mark: st.mark });
        if (st.mark === 'o') counts.o++; else if (st.mark === 't') counts.t++; else if (st.mark === 'x') counts.x++; else counts.neutral++;
        if (st.mark !== '-') gradable++;
        if (st.mark === 't') hasOrder = true;
        if (st.mark === 'x') bad = true;
        if (st.swap || st.mixed) swappedCells++;
      } else if (st.type === 'extra') {
        marks.push({ i: st.cell, mark: 'x' }); counts.extra++; bad = true;
        if (st.mixed) swappedCells++;
      } else { counts.missing++; bad = true; }
    }
    marks.sort((a, b) => a.i - b.i);
    const g = bad ? 'x' : !gradable ? '-' : hasOrder ? 't' : 'o';
    // a different word altogether (less than half of the answer found, at least half of the writing wrong):
    // one summary instead of a message per cell (the steps keep theirs for the detail view). Swapped cells and cells
    // that hold the other form's characters count as found.
    const found = counts.o + counts.t + counts.neutral + swappedCells;
    const wrongWritten = counts.x + counts.extra - swappedCells;
    const primary = cands[0];
    const outIssues = mixed ? [mixed].concat(issues.filter((i) => i.type === 'swap'))
      : found * 2 < chars.length && wrongWritten > 0 && wrongWritten * 2 >= list.length
        ? [{ type: 'different', kind: null, message: `정답과 많이 달라요 — 정답: ${(primary || best).text}` }]
        : issues;
    return { best: publicAnswer(best, cost / UNIT), grade: g, steps, marks, issues: outIssues, counts, cost: cost / UNIT, empty: false, judged: J.ctx.calls };
  }

  /* ------------------------------------------------------------------ messages */

  const isVowelKana = (c) => !!VOWEL_KANA[c];
  const vowelOfText = (t) => {
    // the vowel a mora ends in, from its romaji (こ → o, きょ → o, ー/っ/ん → null)
    try {
      const r = TX().toRomaji(t);
      const v = r.slice(-1);
      return 'aiueo'.includes(v) && v ? v : null;
    } catch (e) { return null; }
  };

  function noteFor(st, best, steps, sentence) {
    const ch = st.expected;
    const pos = st.pos;
    if (st.type === 'missing') {
      const ctx = contextOf(best, pos);
      let m;
      if (st.kind === 'punct') m = josa((PUNCT_NAME[ch] || '') + ch, '이', '가') + ' 빠졌어요';
      else m = josa((KIND_NAME[st.kind] || '') + ch, '이', '가') + ' 빠졌어요';
      return { type: 'missing', kind: st.kind, message: st.kind === 'punct' ? m + '.' : `${m} — ${ctx}`, pos };
    }
    if (st.type === 'extra') {
      const w = st.written;
      const prev = best.chars[st.pos - 1], next = best.chars[st.pos];
      const ctx = contextOf(best, Math.max(0, Math.min(best.chars.length - 1, st.pos - 1)));
      let m;
      if (w && (w === prev || w === next)) m = josa(w, '을', '를') + ' 하나 더 썼어요';
      else if (w && SOKUON.has(w)) m = `필요 없는 촉음 ${josa(w, '을', '를')} 썼어요 — ${ctx}`;
      else if (w === 'ー') m = `필요 없는 장음 ${josa(w, '을', '를')} 썼어요 — ${ctx}`;
      else if (w && isVowelKana(w) && prev && lengthens(lengthenedVowel(prev, best, st.pos - 1), w)) m = `필요 없는 장음 ${josa(w, '을', '를')} 썼어요 — ${ctx}`;
      else if (w) m = `${cellName(st.cell)}의 ${josa(w, '은', '는')} 필요 없어요`;
      else m = `${cellName(st.cell)}에 쓴 글자는 필요 없어요`;
      return { type: 'extra', kind: w ? kindOfLoose(w) : null, message: m, cell: st.cell, pos: st.pos };
    }
    // match
    if (st.mark === 'o' || st.mark === '-') return null;
    if (st.swap) {
      // one message for the pair (on its first cell); the second cell only carries the note
      const p = Math.min(pos, st.swap.pos), q = Math.max(pos, st.swap.pos);
      const message = `${josa(best.chars[p], '과', '와')} ${best.chars[q]}의 순서가 바뀌었어요 — ${contextOf(best, p)}`;
      return { type: 'swap', kind: st.kind, message, cell: Math.min(st.cell, st.swap.cell), pos: p, noteOnly: pos !== p };
    }
    const r = st.result || {};
    if (st.mark === 't') {
      const types = new Set((r.issues || []).map((i) => i && i.type));
      const what = types.has('order') ? '획순이' : types.has('direction') ? '획 방향이' : types.has('count') ? '획수가' : '획순이';
      return { type: 'order', kind: st.kind, message: `${cellName(st.cell)}(${ch}): ${what} 달라요`, cell: st.cell, pos };
    }
    // ✕
    const rec = r.recognized || null;
    const ctx = contextOf(best, pos);
    const sizeIssue = (r.issues || []).find((i) => i && i.type === 'size');
    const t = tab();
    const base = { kind: st.kind, cell: st.cell, pos };
    if (sizeIssue) {
      let m;
      if (t.bigOf.has(ch)) m = `${josa((SIZE_NAME[st.kind] || '') + ch, '은', '는')} 작게 써요 — ${ctx}`;
      else if (t.smallOf.has(ch)) m = `${josa(ch, '은', '는')} 칸을 채워 크게 써요 — 작게 쓰면 ${josa(t.smallOf.get(ch), '이', '가')} 돼요 (${ctx})`;
      else m = `${cellName(st.cell)}(${ch}): ${sizeIssue.message || '크기와 자리를 확인해요'}`;
      return Object.assign({ type: 'size', reason: 'size', message: m }, base);
    }
    const at = `${ch} 자리에 `;
    if (rec && rec !== ch) {
      const kC = infoOf(ch), kR = infoOf(rec);
      const bC = kC ? t.baseOf.get(ch) || ch : null, bR = kR ? t.baseOf.get(rec) || rec : null;
      // particles written as they sound (わたしわ, こんにちわ, ほんお)
      if (best.ctx.particle[pos] && ((ch === 'は' && rec === 'わ') || (ch === 'へ' && rec === 'え') || (ch === 'を' && rec === 'お'))) {
        return Object.assign({ type: 'wrong', reason: 'particle', message: `${at}${josa(rec, '을', '를')} 썼어요 — 조사 ${josa(ch, '은', '는')} ${ro(rec)} 읽지만 ${ro(ch)} 써요` }, base);
      }
      // ゛゜: same base, same script (が ← か, か ← が, ぱ ← ば)
      if (bC && bR && bC === bR && kC.script === kR.script) {
        const mark = (c) => (infoOf(c) && infoOf(c).group === 'handakuten' ? '반탁점(゜)' : '탁점(゛)');
        let m;
        if (rec === bC) m = `${ch}의 ${josa(mark(ch), '이', '가')} 빠졌어요 — ${ctx}`;
        else if (ch === bR) m = `${at}${josa(rec, '을', '를')} 썼어요 — ${josa(mark(rec), '은', '는')} 필요 없어요 (${ctx})`;
        else m = `${at}${josa(rec, '을', '를')} 썼어요 — ${josa(ch, '은', '는')} ${mark(ch)}이에요 (${ctx})`;
        return Object.assign({ type: 'wrong', reason: 'dakuten', message: m }, base);
      }
      if (toHira(rec) === toHira(ch)) {
        const script = /[ァ-ヺ]/.test(rec) ? '가타카나' : '히라가나';
        return Object.assign({ type: 'wrong', reason: 'script', message: `${at}${script} ${josa(rec, '을', '를')} 썼어요` }, base);
      }
      if (st.kind === 'long') {
        return Object.assign({ type: 'wrong', reason: 'long', message: `${at}${josa(rec, '을', '를')} 썼어요 — 가타카나의 장음은 ー로 써요 (${ctx})` }, base);
      }
      if (st.kind === 'longVowel' && (isVowelKana(rec) || rec === 'ー')) {
        const mora = (best.ctx.prevText[pos] || '') + ch;
        const msg = rec === 'ー' ? `${at}ー를 썼어요 — 히라가나 말의 장음은 ${ro(ch)} 써요 (${ctx})`
          : `${at}${josa(rec, '을', '를')} 썼어요 — ${mora}의 장음은 ${ro(ch)} 써요 (${ctx})`;
        return Object.assign({ type: 'wrong', reason: 'long', message: msg }, base);
      }
      if (st.kind === 'sokuon' || st.kind === 'yoon' || st.kind === 'smallVowel') {
        return Object.assign({ type: 'wrong', reason: r.confusedWith ? 'lookalike' : 'other', message: `${at}${josa(rec, '을', '를')} 썼어요 — ${josa((KIND_NAME[st.kind] || '') + ch, '이', '가')} 들어가요 (${ctx})` }, base);
      }
      return Object.assign({ type: 'wrong', reason: r.confusedWith ? 'lookalike' : 'other', message: `${at}${josa(rec, '을', '를')} 썼어요` }, base);
    }
    return Object.assign({ type: 'wrong', reason: 'other', message: `${cellName(st.cell)}: ${ro(ch)} 보기 어려워요` }, base);
  }

  // the vowel a char at answer position p ends in, when a vowel kana after it would lengthen it (こ → o)
  function lengthenedVowel(prev, best, p) {
    if (!prev || SOKUON.has(prev) || prev === 'ん' || prev === 'ン') return null;
    if (prev === 'ー' || isVowelKana(prev)) {
      for (let i = p - 1; i >= 0; i--) { const c = best.chars[i]; if (c !== 'ー' && !isVowelKana(c)) return vowelOfText(c) || null; }
      return VOWEL_KANA[prev] || null;
    }
    // 요음: きょ → o (the small kana carries the vowel)
    const two = p > 0 && (YOON_SMALL.has(prev) || SMALL_VOWEL.has(prev)) ? best.chars[p - 1] + prev : prev;
    return vowelOfText(two);
  }
  // does vowel kana w lengthen vowel v? a → あ, i → い, u → う, e → え / い, o → お / う
  const lengthens = (v, w) => {
    const x = VOWEL_KANA[w];
    return !!v && !!x && (x === v || (v === 'e' && x === 'i') || (v === 'o' && x === 'u'));
  };
  function kindOfLoose(c) {
    if (SOKUON.has(c)) return 'sokuon';
    if (c === 'ー') return 'long';
    if (c === 'ん' || c === 'ン') return 'n';
    if (YOON_SMALL.has(c)) return 'yoon';
    if (SMALL_VOWEL.has(c)) return 'smallVowel';
    if (c === '、' || c === '。') return 'punct';
    if (isKanaCh(c)) return 'kana';
    return isIdeo(c) ? 'kanji' : 'other';
  }

  function runIssue(run, best, atStart, atEnd) {
    if (run[0].type === 'match') {
      // ≥ 3 cells in a row that are other characters: one message for the stretch
      const text = run.map((s) => s.expected).join('');
      const first = run[0].cell, last = run[run.length - 1].cell;
      return { type: 'wrong', kind: 'run', reason: 'run', count: run.length, cell: first, pos: run[0].pos,
        message: `${first + 1}~${last + 1}번째 칸이 정답과 달라요 — 「${text}」 부분 (${run.length}글자)` };
    }
    if (run[0].type === 'missing') {
      const text = run.map((s) => s.expected).join('');
      const where = atEnd ? '뒷부분 ' : atStart ? '앞부분 ' : '';
      return { type: 'missing', kind: 'run', count: run.length, pos: run[0].pos, message: `${where}「${text}」 부분이 빠졌어요 (${run.length}글자)` };
    }
    const first = run[0].cell, last = run[run.length - 1].cell;
    return {
      type: 'extra', kind: 'run', count: run.length, cell: first,
      message: atEnd ? `뒤에 ${run.length}칸을 더 썼어요 (${first + 1}~${last + 1}번째 칸)` : `${run.length}칸을 더 썼어요 (${first + 1}~${last + 1}번째 칸)`,
    };
  }

  return { answers, grade, kinds, COST, _internal: { readingsOf, hiraganaOf, relatives, josa, contextOf } };
});
