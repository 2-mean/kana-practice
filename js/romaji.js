/* KanaText — text utilities for 내 단어장 (kana words & sentences): validation, 원고지 cells, mora
 * segmentation, Hepburn romaji, learner-style Hangul, reading/meaning answer checking and an IME-like
 * romaji → kana converter. Pure (no DOM). UMD: Node requires ./kana-data.js; the browser uses the global
 * KANA_DATA (load js/kana-data.js first — it is looked up lazily on first use).
 *
 * Decisions (see also docs/SPEC-words.md §E, §I):
 * • Normalization (validate/cells/segment share it): NFC; half-width katakana → full-width; spacing ゛゜
 *   after a kana are composed (か゛ → が; a mark that cannot compose stays a visible ゛/゜ so `bad` shows it);
 *   hiragana ゔ → ヴ (only ヴ is in the practice set); every kind of whitespace (incl. U+3000) → ' '; runs
 *   collapsed; trimmed; invisible format chars (ZWSP/ZWJ/BOM/soft hyphen/bidi marks) and variation selectors
 *   removed; ，． → 、。; a dash (- ‐ – — ― − － ㅡ) right after kana → ー and an ASCII , . right after kana →
 *   、。 (コ-ヒ- → コーヒー). validate() (the kana-only field) also reads 一 right after katakana as ー (ラ一メン).
 * • Romaji display (toRomaji) = modified Hepburn: shi chi tsu fu ji (じ and ぢ) zu (ず and づ), kya/sha/cha/ja,
 *   っ doubles the next consonant (っち → tch, end-of-word/before-vowel/before-ん っ → "'"), ん → n, "n'" before a
 *   vowel or y (しんよう shin'you, ほんや hon'ya, こんにちは konnichi…), ー repeats the previous vowel (ラーメン
 *   raamen), vowel kana are written as they are (がっこう gakkou, せんせい sensei). は/へ/を are romanized as
 *   written (ha/he/wo) — except: (1) a small lexicon of fixed expressions read with wa (こんにちは konnichiwa,
 *   こんばんは konbanwa, では dewa, それでは, または, あるいは); (2) with { sentence: true }, particles are shown
 *   as pronounced and set off by spaces: chunk-final は/へ after other kana → " wa"/" e", を → " o "; and a
 *   chunk-final です/でした/でしょう(+か/ね/よ/が) gets a space before it ("watashi wa gakusei desu.").
 *   、。 → ", " / ". ". Inherent Hepburn ambiguities (romajiToKana cannot restore them): ぢ/じ ji, づ/ず zu,
 *   を/ウォ wo, ティ ti, small ぁ a, っ before な行 (nn), ー (raamen → らあめん).
 * • Hangul display (toHangul): KANA_DATA ko per kana (か 카, つ 츠 …), 요음 캬/샤/챠/쟈 …, っ → ㅅ 받침,
 *   ん → ㄴ 받침 (응 when there is no syllable to attach to), ー omitted (ラーメン 라멘), a hiragana う/い that
 *   only lengthens o/e is shown in parentheses (ありがとう 아리가토(우), せんせい 센세(이); not in 〜ています);
 *   other long vowels are written out (おかあさん 오카아산, ぎゅうにゅう 규우뉴우). Particles as pronounced in
 *   sentence mode (와/에/오).
 * • checkReading result: { correct, empty, kind, exact /* true = canonical spelling, false = accepted leniently *\/,
 *   expected: { romaji, hangul }, segments: [{ text, kind, romaji, ko, start, end, long?, particle?, ok }] }.
 *   ok is null for spaces/punctuation (and for every segment when the answer is empty/'other').
 *   `exact` counts apostrophes: kin'youbi is exact, kinyoubi is accepted leniently (so is "kani" for かんい).
 * • checkReading — romaji: case/space/hyphen/apostrophe/punctuation-insensitive, invisible chars ignored;
 *   macron/circumflex → doubled vowel (ō = oo). Each mora has its own accepted spellings (し shi/si, ち chi/ti,
 *   つ tsu/tu, ふ fu/hu, じ ji/zi, ぢ ji/di/zi/dzi, づ zu/du/dzu, しゃ sha/sya/shya, ちゃ cha/tya/cya/chya,
 *   じゃ ja/zya/jya, を wo/o, ら行 r/l, ヴ v/b, ティ ti/thi …) — so "di" is accepted for ぢ/ディ but not for じ.
 *   ん: n / nn / n' (apostrophes are ignored, so "shinyou" is accepted for しんよう), m only before b/m/p.
 *   っ: double the next consonant (tch / cch / tt for っち); where toRomaji writes "'" (end of word, before a
 *   vowel / small vowel / ん): nothing or t. A missing っ or ん is always wrong (gomenasai ≠ ごめんなさい,
 *   konichiwa ≠ こんにちは, saporo ≠ さっぽろ).
 *   Long vowels (spec classes): ou/oo/ō/o, uu/ū/u, ei/ee/ē/e (also for ええ) may be shortened, so "gakuse" is
 *   accepted for がくせい and "tokyo" for とうきょう; aa/ā and ii/ī may NOT (おばあさん ≠ obasan, おいしい ≠
 *   "oishi", いいえ ≠ "ie") because that changes the word. ー may be written as the vowel or dropped (ramen,
 *   rāmen, ra-men, raamen) and, like vowel kana, as ou/ei after o/e (コーヒー kouhii, ケーキ keiki).
 *   Particles only in sentences: は ha|wa and へ he|e when preceded by kana in the same chunk; を wo|o
 *   everywhere. A word entry (≤ 10 cells, no space/、。) never infers particles: わたしは ≠ "watashi wa" unless
 *   the entry has a reading override. entry.reading (override) is accepted in addition to the automatic
 *   reading; it may be romaji (as specified), kana or Hangul. When it changes the pronunciation (watashi wa for
 *   the word わたしは) expected.hangul follows it and its Hangul is accepted too.
 *   Hangul: per-mora jamo matcher. Initials: か행 ㅋ/ㄱ/ㄲ, た·て·と ㅌ/ㄷ/ㄸ, ち ㅊ/ㅉ/ㅈ, つ ㅊ/ㅆ/ㅉ (츠 쓰 쯔),
 *   さ행 ㅅ/ㅆ, ぱ행 ㅍ/ㅃ; voiced rows only their plain consonant (が ㄱ, だ ㄷ, ざ ㅈ, ば ㅂ: 아리까또, 니혼꼬 are
 *   wrong); ふ only ㅎ (푸 is ぷ). Vowels: u = ㅜ/ㅡ, e = ㅔ/ㅐ, ちゃ/じゃ 행 with or without the y-glide
 *   (차/챠, 주/쥬), but しゃ행 needs it (사 ≠ しゃ). っ = a stop 받침 (ㄱㄷㅂㅅㅈㅊㅋㅌㅍ…) or a tense next initial (각코, 갓코, 가꼬; 간코 = がんこ is wrong);
 *   ん = ㄴ/ㅇ/ㅁ 받침 (or 응/은/음); long vowels as in romaji (aa/ii must be written; ー and ou/ei/uu optional,
 *   코우히/케이키 accepted). Kana answers must equal the text exactly (spaces/punctuation ignored; dashes / 一
 *   for ー as in validate(); no hiragana↔katakana folding).
 *   한/영 slip: a rejected Hangul answer that is really romaji typed with the Korean layout on (gakusei →
 *   ㅎ마ㅕㄴ댜) is decoded key by key and graded as romaji (kind 'romaji', exact false). Only when it contains
 *   standalone jamo and ≥ 3 keys, so genuine Hangul answers (냐, 재 …) never collide.
 *   Speed: acceptance is a sparse zero-cost search (instant at any length); marking the wrong segments of a
 *   rejected answer uses a DP limited to a diagonal band (≤ 60k states), so long entries never freeze the page.
 * • romajiToKana (IME-like, for live preview): n + consonant → ん; n' → ん; "nn" → ん, except that "nn" + vowel/y
 *   is read Hepburn-style as ん + な行/にゃ (minna みんな, konnichiha こんにちは, konnyaku こんにゃく; IME-style
 *   "konnnichiha" also works); a trailing single n stays pending ('kon' → こ + pending 'n', 'konn' → こん,
 *   'konb' → こん + pending 'b'), or becomes ん with { final: true }. m before b/m/p → ん (sempai せんぱい,
 *   samma さんま — Hepburn; an IME would give さっま). Doubled consonant → っ, tch → っch, x/l + vowel → small
 *   kana, xtu/ltu/xtsu/ltsu → っ, v… → ヴ (katakana in both scripts), dzi/dzu → ぢ/づ, and tha/thi…, dha…,
 *   twa…, kwa…, gwa…, vya… as in Microsoft IME. Dashes → ー, ',' → 、, '.' → 。, spaces kept, apostrophes
 *   (' ’ ‘ ` ´) only separate (n' → ん), uppercase folded, other accents dropped (é → e). Macrons/circumflexes:
 *   katakana → ー (kōhī コーヒー); hiragana spells them out: ā ああ, ī いい, ū うう, ē えい, ō おう (tōkyō
 *   とうきょう; ōkii gives おうきい — type "ookii"). Unconvertible letters are kept as-is (validate() flags them).
 *   Limitation: "kinnyoubi" → きんにょうび; type "kin'youbi". wa → わ (type "ha" for the particle は, as in any
 *   IME). l + vowel is small (la → ぁ) as in IMEs, although the grader accepts la for ら.
 * • checkMeaning: NFKC, lower-case, whitespace & punctuation dropped, then an exact match with one listed meaning
 *   (or the whole meaning string). Each listed meaning is accepted with its bracketed notes ((…) […] {…} 【…】
 *   〔…〕) dropped (물 (마시는 물) → 물) or kept inline (공부(하다) → 공부하다), and without a leading "~particle"
 *   placeholder (~을/를 좋아하다 → 좋아하다). An answer that is entirely in brackets keeps its content ("(물)").
 *   No stemming or synonym guessing (먹어요 ≠ 먹다) — the UI offers a self-grade override.
 *   splitMeanings separators: , / ; · ・ ㆍ • | 、 newline and their full-width forms — not inside brackets,
 *   not a digit-group comma (1,000원) and not a slash between particles (~을/를, 이/가, 은/는 …).
 * • validateKanji: CJK ideographs incl. Ext A–H (𠮟) and compatibility ideographs (﨑), 〆 〇 count as kanji;
 *   々 ヶ and kana are allowed; Kangxi-radical look-alikes from PDFs (⽇) are mapped to the ideograph (日).
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module && module.exports;
  const api = factory(root, isNode
    ? function () { return require('./kana-data.js'); }
    : function () { return root && root.KANA_DATA; });
  if (isNode) module.exports = api;
  else root.KanaText = api;
})(typeof self !== 'undefined' ? self : this, function (root, loadData) {
  'use strict';

  /* ------------------------------------------------------------------ basics */

  const VOWELS = 'aiueo';
  const toKata = (s) => String(s).replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const toHira = (s) => String(s).replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const PUNCT_RE = /[\p{P}\p{S}]/u;
  const PUNCT_MAP = { '、': ',', '。': '.' };
  // invisible format characters (ZWSP/ZWJ/BOM/soft hyphen/bidi marks …) and variation selectors
  const INVISIBLE_RE = /[\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
  const KANA_CH_RE = /[\u3041-\u3096\u30a1-\u30fa\u30fc]/;      // a kana letter or ー
  const DASHES = '-‐‑‒–—―−－ㅡ';                                   // typed in place of ー (ㅡ: Korean keyboard)
  const APOS = "'’‘`´ʼ′";

  function normalize(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(INVISIBLE_RE, '');
    s = s.replace(/[｡-ﾟ]+/g, (m) => m.normalize('NFKC'));      // half-width katakana / ｡､
    s = s.replace(/\u309b/g, '\u3099').replace(/\u309c/g, '\u309a');   // spacing ゛゜ → combining
    s = s.normalize('NFC');
    s = s.replace(/\u3099/g, '\u309b').replace(/\u309a/g, '\u309c');   // a mark that did not compose stays visible (゛゜)
    s = s.replace(/ゔ/g, 'ヴ');                                   // ゔ → ヴ
    s = s.replace(/[，]/g, '、').replace(/[．]/g, '。');
    // a dash / ASCII , . typed right after kana means ー / 、 / 。 (コ-ヒ- → コーヒー)
    let out = '', prev = '';
    for (const ch of s) {
      let c = ch;
      if (KANA_CH_RE.test(prev)) {
        if (DASHES.includes(ch)) c = 'ー';
        else if (ch === ',') c = '、';
        else if (ch === '.') c = '。';
      }
      out += c;
      prev = c;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  /* ------------------------------------------------------------------ static tables */

  // 요음 (chart reference + segmentation). ko uses the y-glide spelling (챠/쟈) so じゃ ≠ ざ visually.
  const YOON_ROWS = [
    ['き', ['kya', 'kyu', 'kyo'], ['캬', '큐', '쿄'], 'ka', 'basic'],
    ['し', ['sha', 'shu', 'sho'], ['샤', '슈', '쇼'], 'sa', 'basic'],
    ['ち', ['cha', 'chu', 'cho'], ['챠', '츄', '쵸'], 'ta', 'basic'],
    ['に', ['nya', 'nyu', 'nyo'], ['냐', '뉴', '뇨'], 'na', 'basic'],
    ['ひ', ['hya', 'hyu', 'hyo'], ['햐', '휴', '효'], 'ha', 'basic'],
    ['み', ['mya', 'myu', 'myo'], ['먀', '뮤', '묘'], 'ma', 'basic'],
    ['り', ['rya', 'ryu', 'ryo'], ['랴', '류', '료'], 'ra', 'basic'],
    ['ぎ', ['gya', 'gyu', 'gyo'], ['갸', '규', '교'], 'ga', 'dakuten'],
    ['じ', ['ja', 'ju', 'jo'], ['쟈', '쥬', '죠'], 'za', 'dakuten'],
    ['び', ['bya', 'byu', 'byo'], ['뱌', '뷰', '뵤'], 'ba', 'dakuten'],
    ['ぴ', ['pya', 'pyu', 'pyo'], ['퍄', '퓨', '표'], 'pa', 'handakuten'],
  ];
  const SMALL_Y = ['ゃ', 'ゅ', 'ょ'];
  const YOON = [];
  YOON_ROWS.forEach(([base, rs, ks, row, group]) => {
    for (let i = 0; i < 3; i++) {
      YOON.push(Object.freeze({ hira: base + SMALL_Y[i], kata: toKata(base + SMALL_Y[i]), romaji: rs[i], ko: ks[i], row, group }));
    }
  });
  Object.freeze(YOON);

  function yoonAlts(r) {
    const v = r.slice(-1);
    if (r.startsWith('sh')) return ['sy' + v, 'shy' + v];
    if (r.startsWith('ch')) return ['ty' + v, 'cy' + v, 'chy' + v];
    if (r.startsWith('j')) return ['zy' + v, 'jy' + v];
    if (r.startsWith('ry')) return ['ly' + v];
    return [];
  }

  // Extended katakana (and their hiragana spellings): [kata, Hepburn, other spellings, Hangul, extra Hangul].
  const EXT = [
    ['イェ', 'ye', [], '예'],
    ['ウィ', 'wi', ['whi'], '위'], ['ウェ', 'we', ['whe'], '웨'], ['ウォ', 'wo', ['who'], '워'],
    ['ヴァ', 'va', ['ba'], '바'], ['ヴィ', 'vi', ['bi'], '비'], ['ヴェ', 've', ['be'], '베'],
    ['ヴォ', 'vo', ['bo'], '보'], ['ヴュ', 'vyu', ['byu'], '뷰'],
    ['シェ', 'she', ['sye', 'shye'], '셰', ['쉐']], ['ジェ', 'je', ['zye', 'jye'], '제'],
    ['チェ', 'che', ['tye', 'cye', 'chye'], '체'],
    ['ティ', 'ti', ['thi'], '티'], ['ディ', 'di', ['dhi'], '디'], ['テュ', 'tyu', ['thu'], '튜'], ['デュ', 'dyu', ['dhu'], '듀'],
    ['トゥ', 'tu', ['twu'], '투'], ['ドゥ', 'du', ['dwu'], '두'],
    ['ファ', 'fa', ['fwa'], '파'], ['フィ', 'fi', ['fwi', 'fyi'], '피'], ['フェ', 'fe', ['fwe', 'fye'], '페'],
    ['フォ', 'fo', ['fwo'], '포'], ['フュ', 'fyu', [], '퓨'],
    ['ツァ', 'tsa', [], '차'], ['ツィ', 'tsi', [], '치'], ['ツェ', 'tse', [], '체'], ['ツォ', 'tso', [], '초'],
    ['クァ', 'kwa', ['qa'], '콰'], ['クィ', 'kwi', ['qi'], '퀴'], ['クェ', 'kwe', ['qe'], '퀘'], ['クォ', 'kwo', ['qo'], '쿼'],
    ['グァ', 'gwa', [], '과'],
    ['スィ', 'si', [], '시'], ['ズィ', 'zi', [], '지'],
  ];

  const VOWEL_KANA = {
    'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o', 'ア': 'a', 'イ': 'i', 'ウ': 'u', 'エ': 'e', 'オ': 'o',
    'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o', 'ァ': 'a', 'ィ': 'i', 'ゥ': 'u', 'ェ': 'e', 'ォ': 'o',
  };
  // previous vowel + this vowel kana → accepted romaji for this kana ('' = may be omitted)
  const LONG_ROMAJI = { aa: ['a'], ii: ['i'], uu: ['u', ''], ei: ['i', 'e', ''], ee: ['e', 'i', ''], ou: ['u', 'o', ''], oo: ['o', 'u', ''] };
  const LONG_OPTIONAL = { aa: false, ii: false, uu: true, ei: true, ee: true, ou: true, oo: true };
  const LONG_HANGUL_M = { aa: 'ㅏ', ii: 'ㅣ', uu: 'ㅜㅡ', ei: 'ㅣㅔㅐ', ee: 'ㅔㅐㅣ', ou: 'ㅜㅡㅗ', oo: 'ㅗㅜㅡ' };
  // ー after a vowel: accepted romaji / Hangul vowels (same classes as vowel kana: コー ko|koo|kou, ケー ke|kee|kei)
  const DASH_ROMAJI = { a: ['a', ''], i: ['i', ''], u: ['u', ''], e: ['e', 'i', ''], o: ['o', 'u', ''] };
  const DASH_HANGUL_M = { a: 'ㅏ', i: 'ㅣ', u: 'ㅜㅡ', e: 'ㅔㅐㅣ', o: 'ㅗㅜㅡ' };
  const GREETINGS = { 'こんにちは': 1, 'こんばんは': 1, 'では': 1, 'それでは': 1, 'または': 1, 'あるいは': 1 };
  const NOT_PARTICLE = { 'はは': 1 };
  const DESU_RE = /^(です|でした|でしょう)(か|ね|よ|が)?$/;
  const TE_IRU = ['ま', 'る', 'た', 'て', 'な', 'ら', 'れ', 'ろ'];

  /* ------------------------------------------------------------------ Hangul jamo */

  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
  const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  const TENSE_OF = { 'ㄱ': 'ㄲ', 'ㅋ': 'ㄲ', 'ㄲ': 'ㄲ', 'ㄷ': 'ㄸ', 'ㅌ': 'ㄸ', 'ㄸ': 'ㄸ', 'ㅂ': 'ㅃ', 'ㅍ': 'ㅃ', 'ㅃ': 'ㅃ', 'ㅅ': 'ㅆ', 'ㅆ': 'ㅆ', 'ㅈ': 'ㅉ', 'ㅊ': 'ㅉ', 'ㅉ': 'ㅉ' };
  const N_FINALS = 'ㄴㅇㅁ';
  const Q_FINALS = 'ㄱㄲㄳㄷㅂㅄㅅㅆㅈㅊㅋㅌㅍㅎ';     // っ: a stop-like 받침 — ㄴ/ㅇ/ㅁ/ㄹ would be ん (간코 = がんこ)

  function decompose(ch) {
    const c = ch ? ch.charCodeAt(0) - 0xac00 : -1;
    if (!(c >= 0 && c <= 11171)) return null;
    return { I: CHO[Math.floor(c / 588)], M: JUNG[Math.floor((c % 588) / 28)], F: JONG[c % 28] };
  }
  function compose(I, M, F) {
    return String.fromCharCode(0xac00 + (CHO.indexOf(I) * 21 + JUNG.indexOf(M)) * 28 + JONG.indexOf(F || ''));
  }
  function addFinal(syl, F) {
    const d = decompose(syl);
    return d && !d.F ? compose(d.I, d.M, F) : null;
  }

  // Hepburn onset → [allowed initials, glide] ; glide '' | 'y' | 'yp' (palatal: y optional) | 'w'
  const ONSET = {
    '': ['ㅇ', ''], k: ['ㅋㄱㄲ', ''], g: ['ㄱ', ''], s: ['ㅅㅆ', ''], z: ['ㅈ', ''], t: ['ㅌㄷㄸ', ''], d: ['ㄷ', ''],
    n: ['ㄴ', ''], h: ['ㅎ', ''], f: ['ㅎ', ''], b: ['ㅂ', ''], p: ['ㅍㅃ', ''], m: ['ㅁ', ''], r: ['ㄹ', ''], v: ['ㅂ', ''],
    y: ['ㅇ', 'y'], w: ['ㅇ', 'w'],
    ky: ['ㅋㄱㄲ', 'y'], gy: ['ㄱ', 'y'], ny: ['ㄴ', 'y'], hy: ['ㅎ', 'y'], my: ['ㅁ', 'y'], ry: ['ㄹ', 'y'],
    by: ['ㅂ', 'y'], py: ['ㅍㅃ', 'y'], vy: ['ㅂ', 'y'], fy: ['ㅍㅎ', 'y'], ty: ['ㅌㄷㄸ', 'y'], dy: ['ㄷ', 'y'],
    sh: ['ㅅㅆ', 'y'], ch: ['ㅊㅉㅈ', 'yp'], j: ['ㅈ', 'yp'], ts: ['ㅊㅆㅉ', ''], kw: ['ㅋㄱㄲ', 'w'], gw: ['ㄱ', 'w'],
  };
  const MED = {
    '': { a: 'ㅏ', i: 'ㅣ', u: 'ㅜㅡ', e: 'ㅔㅐ', o: 'ㅗ' },
    y: { a: 'ㅑ', i: 'ㅣ', u: 'ㅠ', e: 'ㅖ', o: 'ㅛ' },                 // シェ 셰 (쉐 via koAlt) — 세 is セ
    yp: { a: 'ㅑㅏ', i: 'ㅣ', u: 'ㅠㅜ', e: 'ㅔㅖㅐ', o: 'ㅛㅗ' },
    w: { a: 'ㅘ', i: 'ㅟ', u: 'ㅜ', e: 'ㅞㅙㅚ', o: 'ㅝ' },
  };
  function pairsFromRomaji(r) {
    const m = /^([^aiueo]*)([aiueo])$/.exec(r || '');
    if (!m || !ONSET[m[1]]) return [];
    const v = m[2];
    if (m[1] === 'f' && v !== 'u') return [{ I: 'ㅍ', M: MED[''][v] }, { I: 'ㅎ', M: MED.w[v] }]; // ファ 파/화
    const on = ONSET[m[1]];
    return [{ I: on[0], M: MED[on[1]][v] }];
  }
  function pairFromKo(k) {
    const d = k && k.length === 1 ? decompose(k) : null;
    return d && !d.F ? { I: d.I, M: d.M } : null;
  }

  /* ------------------------------------------------------------------ data-driven tables (lazy) */

  let TB = null;
  function tables() {
    if (TB) return TB;
    const D = loadData();
    if (!D || !D.kana) throw new Error('KanaText: KANA_DATA is not loaded (include js/kana-data.js before js/romaji.js)');
    const single = {};
    const allowed = new Set([' ']);
    for (const ch of Object.keys(D.kana)) {
      const k = D.kana[ch];
      allowed.add(ch);
      single[ch] = { romaji: k.romaji, alts: (k.romajiAlt || []).filter((a) => a !== k.romaji), ko: k.ko, koAlts: (k.koAlt || []).slice(), hira: k.script === 'hira' };
    }
    const extra = D.extra || {};
    for (const ch of Object.keys(extra)) {
      allowed.add(ch);
      const e = extra[ch];
      if (e.kind === 'small' && e.romaji) {                     // ぁ ぃ … ゃ ゅ ょ (standalone)
        single[ch] = { romaji: e.romaji, alts: ['x' + e.romaji, 'l' + e.romaji], ko: e.ko, koAlts: [], hira: e.script === 'hira' };
      } else if (ch === 'ヴ') {
        single[ch] = { romaji: 'vu', alts: ['bu'], ko: e.ko || '부', koAlts: [], hira: false };
      }
    }
    const combo = {};
    YOON.forEach((y) => { combo[y.kata] = { romaji: y.romaji, alts: yoonAlts(y.romaji), ko: y.ko, koAlts: [] }; });
    [['ヂャ', 'ja', '쟈'], ['ヂュ', 'ju', '쥬'], ['ヂョ', 'jo', '죠']].forEach(([k, r, ko]) => {
      const v = r.slice(-1);
      combo[k] = { romaji: r, alts: ['dy' + v, 'zy' + v, 'jy' + v], ko, koAlts: [] };
    });
    EXT.forEach(([k, r, alts, ko, koAlts]) => { combo[k] = { romaji: r, alts: alts.slice(), ko, koAlts: (koAlts || []).slice() }; });
    TB = { single, combo, allowed };
    return TB;
  }

  /* ------------------------------------------------------------------ validation & cells */

  // kana-only text (the word's kana field, kana answers): like normalize(), and since kanji cannot appear there,
  // 一 (the kanji "one") right after katakana is a mistyped ー (ラ一メン → ラーメン)
  const kanaOnly = (text) => normalize(text).replace(/([ァ-ヺー])一/g, '$1ー').replace(/([ァ-ヺー])一/g, '$1ー');

  function validate(text) {
    const { allowed } = tables();
    const normalized = kanaOnly(text);
    const bad = [];
    for (const ch of normalized) if (!allowed.has(ch) && !bad.includes(ch)) bad.push(ch);
    const empty = normalized.length === 0;
    return { ok: !empty && bad.length === 0, normalized, bad, empty, reason: empty ? 'empty' : (bad.length ? 'bad' : null) };
  }

  function cells(text) {
    return Array.from(normalize(text), (ch) => ({ ch, kind: ch === ' ' ? 'space' : 'write' }));
  }

  function autoType(text) {
    const n = normalize(text);
    return /[、。 ]/.test(n) || Array.from(n).length > 10 ? 'sentence' : 'word';
  }

  /* ------------------------------------------------------------------ segmentation */

  const lastVowel = (r) => { const c = r ? r.slice(-1) : ''; return VOWELS.includes(c) && c ? c : null; };
  const isWordSeg = (s) => s && s.kind !== 'space' && s.kind !== 'punct';

  // Internal rich segments. Public fields: text kind romaji ko start end (+ long, particle).
  function segs(text, sentence) {
    const t = tables();
    const chars = Array.from(normalize(text));
    const out = [];
    for (let i = 0; i < chars.length;) {
      const ch = chars[i];
      const s = { text: ch, kind: 'other', romaji: ch, ko: ch, start: i, end: i + 1 };
      if (ch === ' ') { s.kind = 'space'; }
      else if (PUNCT_MAP[ch] || PUNCT_RE.test(ch)) { s.kind = 'punct'; s.romaji = s.ko = PUNCT_MAP[ch] || ch.normalize('NFKC'); }
      else if (ch === 'っ' || ch === 'ッ') { s.kind = 'sokuon'; }
      else if (ch === 'ー') { s.kind = 'long'; }
      else {
        const nx = chars[i + 1];
        const c = nx ? t.combo[toKata(ch + nx)] : null;
        const k = c ? null : t.single[ch];
        const src = c || k;
        if (c) { s.text = ch + nx; s.end = i + 2; }
        if (src) {
          s.kind = 'mora';
          s.romaji = s.canon = src.romaji;
          s.ko = s.koBase = src.ko;
          s.alts = [src.romaji].concat(src.alts);
          s.koAlts = src.koAlts;
          s.hira = /^[ぁ-ゖ]/.test(s.text);
          s.isN = ch === 'ん' || ch === 'ン';
        }
      }
      out.push(s);
      i = s.end;
    }

    // chunks (runs between spaces/punctuation): fixed expressions & particles
    let seenChunk = false;
    for (let a = 0; a < out.length;) {
      if (!isWordSeg(out[a])) { a++; continue; }
      let b = a;
      while (b < out.length && isWordSeg(out[b])) b++;
      const chunk = out.slice(a, b);
      const ctext = chunk.map((x) => x.text).join('');
      const last = chunk[chunk.length - 1];
      if (GREETINGS[ctext] && last.text === 'は') {
        last.wa = true; last.particle = true; last.romaji = 'wa'; last.ko = '와';
      } else if (sentence) {
        // a lone は/へ/を written as its own chunk after a word ("はは は …") is a particle too
        const lone = chunk.length === 1 && a > 0 && out[a - 1].kind === 'space' && seenChunk;
        chunk.forEach((x, k) => {
          if ((k === 0 && !lone) || x.kind !== 'mora') return;
          if (x.text === 'は' || x.text === 'へ') x.particleAlt = true;
          if (x.text === 'を') {
            x.particle = true; x.romaji = 'o'; x.ko = '오'; x.spaceBefore = true;
            if (k < chunk.length - 1) x.spaceAfter = true;
          }
        });
        if ((chunk.length > 1 || lone) && (last.text === 'は' || last.text === 'へ') && !NOT_PARTICLE[ctext]) {
          last.particle = true; last.spaceBefore = true;
          if (last.text === 'は') { last.romaji = 'wa'; last.ko = '와'; } else { last.romaji = 'e'; last.ko = '에'; }
        }
        for (let k = 1; k < chunk.length; k++) {
          if (chunk[k].text === 'で' && !chunk[k - 1].particle && DESU_RE.test(chunk.slice(k).map((x) => x.text).join(''))) {
            chunk[k].spaceBefore = true;
            break;
          }
        }
      }
      seenChunk = true;
      a = b;
    }

    // long vowels (vowel kana / ー after a vowel)
    for (let k = 0; k < out.length; k++) {
      const s = out[k], p = out[k - 1];
      const pv = p && (p.kind === 'mora' || p.kind === 'long') && !p.isN && !p.particle ? p.vowel : null;
      if (s.kind === 'mora') {
        const own = VOWEL_KANA[s.text];
        if (own && pv && LONG_ROMAJI[pv + own] && !s.particle) {
          s.longPair = pv + own; s.vowel = pv; s.long = true;
          s.paren = (s.text === 'う' && s.longPair === 'ou') || (s.text === 'い' && s.longPair === 'ei');
          // 〜ています / ていた / ている: て+い is te-iru, not a long e — write the い out
          if (s.paren && (p.text === 'て' || p.text === 'で') && out[k + 1] && TE_IRU.includes(out[k + 1].text)) s.paren = false;
        } else {
          s.vowel = s.isN ? null : lastVowel(s.romaji);
        }
      } else if (s.kind === 'long') {
        s.vowel = pv; s.romaji = pv || '-'; s.ko = '';
      }
    }

    // っ and ん depend on the next segment
    for (let k = 0; k < out.length; k++) {
      const s = out[k], n = out[k + 1];
      if (s.kind === 'sokuon') {
        let c = '';
        if (n && n.kind === 'mora' && !n.isN && !n.spaceBefore) {
          c = n.romaji.startsWith('ch') ? 't' : (VOWELS.includes(n.romaji[0]) ? '' : n.romaji[0]);
        }
        s.romaji = c || "'"; s.ko = 'ㅅ';
      } else if (s.isN) {
        s.romaji = n && n.kind === 'mora' && !n.spaceBefore && /^[aiueoy]/.test(n.romaji) ? "n'" : 'n';
        s.ko = 'ㄴ';
      }
    }
    return out;
  }

  function pub(s) {
    const o = { text: s.text, kind: s.kind, romaji: s.romaji, ko: s.ko, start: s.start, end: s.end };
    if (s.long) o.long = true;
    if (s.particle) o.particle = true;
    return o;
  }
  const isSentence = (opts) => !!(opts && (opts.sentence || opts.type === 'sentence'));

  function segment(text, opts) { return segs(text, isSentence(opts)).map(pub); }

  /* ------------------------------------------------------------------ romaji / Hangul display */

  function romajiOf(list) {
    let out = '', gap = false;
    for (const s of list) {
      if (s.kind === 'space') { gap = out.length > 0; continue; }
      if (s.kind === 'punct') { out += s.romaji; gap = true; continue; }
      if ((gap || s.spaceBefore) && out && !out.endsWith(' ')) out += ' ';
      gap = !!s.spaceAfter;
      out += s.romaji;
    }
    return out;
  }
  function toRomaji(text, opts) { return romajiOf(segs(text, isSentence(opts))); }

  function hangulOf(list) {
    const units = [];
    let gap = false;
    const push = (str, paren) => {
      if (gap && units.length) units.push({ s: ' ', sep: true });
      gap = false;
      units.push({ s: str, paren: !!paren });
    };
    const attach = (F) => {
      if (gap) return false;
      const u = units[units.length - 1];
      if (!u || u.sep || u.punct) return false;
      const syl = addFinal(u.s.slice(-1), F);
      if (!syl) return false;
      u.s = u.s.slice(0, -1) + syl;
      u.paren = false;
      return true;
    };
    for (const s of list) {
      if (s.kind === 'space') { gap = units.length > 0; continue; }
      if (s.kind === 'punct') { units.push({ s: s.ko, punct: true }); gap = true; continue; }
      if (s.kind === 'long') continue;                       // ー: 장음은 생략
      if (s.kind === 'sokuon') { if (!attach('ㅅ')) push('ㅅ'); continue; }
      if (s.isN) { if (!attach('ㄴ')) push('응'); continue; }
      push(s.ko, s.paren);
    }
    return units.map((u) => (u.paren ? '(' + u.s + ')' : u.s)).join('');
  }
  function toHangul(text, opts) { return hangulOf(segs(text, isSentence(opts))); }

  /* ------------------------------------------------------------------ answer checking */

  const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힯ꥠ-꥿ힰ-퟿]/;
  const KANA_RE = /[぀-ヿｦ-ﾝ]/;

  function inputKind(s) {
    const t = String(s == null ? '' : s);
    if (!t.trim()) return 'empty';
    if (HANGUL_RE.test(t)) return 'hangul';
    if (/[a-z]/i.test(t.normalize('NFKD'))) return 'romaji';
    if (KANA_RE.test(t)) return 'kana';
    return 'other';
  }

  function foldLatin(s) {                       // NFKC, lower case, ō/ô → oo, other accents dropped
    let t = String(s == null ? '' : s).replace(INVISIBLE_RE, '').normalize('NFKC').toLowerCase().normalize('NFD');
    t = t.replace(/([aiueo])[\u0304\u0302]/g, '$1$1');
    return t.replace(/\p{M}/gu, '');
  }
  const normRomaji = (s) => foldLatin(s).replace(/[\s\p{P}\p{S}ʼʹー]/gu, '');
  // for `exact` only: like normRomaji but apostrophes count (kin'youbi is canonical, kinyoubi is accepted leniently)
  const exactRomaji = (s) => foldLatin(s).replace(/[’‘`´ʼʹ′]/g, "'").replace(/[^\p{L}\p{N}']/gu, '');
  const normHangul = (s) => String(s == null ? '' : s).replace(INVISIBLE_RE, '').normalize('NFC').replace(/[\s\p{P}\p{S}\p{M}ー]/gu, '');
  const stripKana = (s) => kanaOnly(s).replace(/[\s\p{P}\p{S}]/gu, '');

  function editDistance(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }

  /* Monotone alignment of units (expected) × tokens (input) with a flag f ∈ {0,1}.
   * step(u, t, f, emit, zeroOnly) emits moves emit(nu, nt, nf, cost, unit, ok); zero-cost moves always advance u.
   * reachable(): "is there a zero-cost path?" = the answer is accepted. Sparse, so instant even for long entries.
   * dpAlign(): cheapest path, used only to mark the wrong segments of a rejected answer. Limited to a diagonal
   * band around the expected position (≤ DP_CELLS states) so long entries never freeze the page. */
  const DP_CELLS = 60000;

  function reachable(U, T, step) {
    let cur = new Set([0]);                                           // key = t * 2 + f
    for (let u = 0; u < U; u++) {
      const next = new Set();
      const emit = (nu, nt, nf, dc) => { if (dc === 0 && nu === u + 1) next.add(nt * 2 + nf); };
      for (const key of cur) step(u, key >> 1, key & 1, emit, true);
      if (!next.size) return false;
      cur = next;
    }
    return cur.has(T * 2);
  }

  function dpAlign(U, T, step, lens) {
    // band: unit u is expected near input offset pos(u) (cumulative expected lengths scaled to T)
    const cum = new Float64Array(U + 1);
    for (let u = 0; u < U; u++) cum[u + 1] = cum[u] + (lens ? lens[u] : 1);
    const half = Math.max(8, Math.floor(DP_CELLS / (2 * (U + 1))));
    const lo = new Int32Array(U + 1), hi = new Int32Array(U + 1), base = new Int32Array(U + 2);
    for (let u = 0; u <= U; u++) {
      const p = cum[U] > 0 ? Math.round(cum[u] * T / cum[U]) : 0;
      lo[u] = half >= T || u === 0 ? 0 : Math.max(0, p - half);
      hi[u] = half >= T || u === U ? T : Math.min(T, p + half);
      base[u + 1] = base[u] + (hi[u] - lo[u] + 1);
    }
    const size = base[U + 1] * 2;
    const cost = new Float64Array(size).fill(Infinity);
    const from = new Int32Array(size).fill(-1);
    const unitOf = new Int32Array(size).fill(-1);
    const okOf = new Int8Array(size);
    const id = (u, t, f) => (u > U || t < lo[u] || t > hi[u] ? -1 : (base[u] + t - lo[u]) * 2 + f);
    cost[id(0, 0, 0)] = 0;
    for (let u = 0; u <= U; u++) for (let t = lo[u]; t <= hi[u]; t++) for (let f = 0; f < 2; f++) {
      const here = id(u, t, f), c = cost[here];
      if (c === Infinity) continue;
      step(u, t, f, (nu, nt, nf, dc, unit, ok) => {
        const j = id(nu, nt, nf);
        if (j < 0) return;
        const v = c + dc;
        if (v < cost[j] - 1e-9) { cost[j] = v; from[j] = here; unitOf[j] = unit; okOf[j] = ok ? 1 : 0; }
      }, false);
    }
    const end = id(U, T, 0);
    const marks = new Array(U).fill(null);
    if (cost[end] === Infinity) return { cost: Infinity, marks };
    for (let j = end; j > 0 && from[j] >= 0; j = from[j]) {
      const unit = unitOf[j];
      if (unit < 0 || unit >= U) continue;
      if (!okOf[j]) marks[unit] = false;
      else if (marks[unit] === null) marks[unit] = true;
    }
    return { cost: cost[end] < 1e-9 ? 0 : cost[end], marks };
  }

  // units: [{ alts: [string] }] ; inp: string
  function stringStep(units, inp) {
    const U = units.length, T = inp.length;
    return (u, t, f, emit, zeroOnly) => {
      if (!zeroOnly && t < T) emit(u, t + 1, 0, 1, Math.min(u, U - 1), false);   // extra input (blamed on the next unit)
      if (u >= U) return;
      const alts = units[u].alts;
      let maxLen = 0, minLen = Infinity;
      for (const a of alts) {
        if (inp.startsWith(a, t)) emit(u + 1, t + a.length, 0, 0, u, true);
        maxLen = Math.max(maxLen, a.length);
        if (a.length) minLen = Math.min(minLen, a.length);
      }
      if (zeroOnly) return;
      emit(u + 1, t, 0, minLen === Infinity ? 1 : minLen, u, false);            // missing
      for (let k = 1; k <= maxLen + 1 && t + k <= T; k++) {                      // written differently
        const sub = inp.substr(t, k);
        if (alts.includes(sub)) continue;
        let best = alts.length ? Infinity : k;
        for (const a of alts) best = Math.min(best, editDistance(sub, a));
        emit(u + 1, t + k, 0, Math.max(1, best) + 0.01, u, false);
      }
    };
  }
  const acceptStrings = (units, inp) => reachable(units.length, inp.length, stringStep(units, inp));
  const alignStrings = (units, inp) => dpAlign(units.length, inp.length, stringStep(units, inp),
    units.map((x) => (x.alts && x.alts.length ? x.alts[0].length : 1)));

  function romajiUnits(list, sentence) {
    const units = [];
    list.forEach((s) => {
      if (!isWordSeg(s)) return;
      let alts = null;
      if (s.kind === 'mora' && !s.isN) {
        if (s.longPair) alts = LONG_ROMAJI[s.longPair].slice();
        else {
          alts = s.alts.slice();
          if (s.wa || (sentence && s.particleAlt && s.text === 'は')) alts.push('wa');
          if (sentence && s.particleAlt && s.text === 'へ') alts.push('e');
        }
      } else if (s.kind === 'long') alts = s.vowel ? DASH_ROMAJI[s.vowel].slice() : [''];
      else if (s.kind === 'other') alts = [];
      units.push({ seg: s, alts });
    });
    for (let i = units.length - 1; i >= 0; i--) {                                // right to left: っ needs the next mora
      const u = units[i];
      if (u.alts) continue;
      const nu = units[i + 1];
      const next = nu && nu.seg.start === u.seg.end && nu.seg.kind === 'mora' ? nu : null;
      if (u.seg.isN) {
        u.alts = ['n', 'nn'];
        if (next && next.alts.some((a) => /^[bmp]/.test(a))) u.alts.push('m');
      } else {
        // っ doubles the next consonant — the same moras toRomaji doubles (not ん, not a spaced-off particle);
        // otherwise (end of word, before ん / a vowel / a small vowel) it may be written ' (ignored), t or nothing
        const nalts = next && !next.seg.isN && !next.seg.spaceBefore ? next.alts : [];
        const set = [];
        const add = (c) => { if (!set.includes(c)) set.push(c); };
        for (const a of nalts) {
          if (a.startsWith('ch')) { add('t'); add('c'); }
          else if (a && !VOWELS.includes(a[0])) add(a[0]);
        }
        if (!set.length || nalts.some((a) => !a || VOWELS.includes(a[0]))) { add(''); add('t'); }
        u.alts = set;
      }
    }
    return units;
  }

  function hangulPairs(s, sentence) {
    const pairs = pairsFromRomaji(s.canon).slice();
    const add = (k) => { const p = pairFromKo(k); if (p) pairs.push(p); };
    add(s.koBase);
    (s.koAlts || []).forEach(add);
    if (s.wa || (sentence && s.particleAlt && s.text === 'は')) add('와');
    if (sentence && s.particleAlt && s.text === 'へ') { add('에'); add('애'); }
    return pairs;
  }
  const matchPairs = (pairs, I, M) => pairs.some((p) => p.I.includes(I) && p.M.includes(M));
  const matchTense = (pairs, I, M) => pairs.some((p) => p.M.includes(M) && Array.from(p.I).some((x) => TENSE_OF[x] === I));

  function hangulUnits(list, sentence) {
    const units = [];
    list.forEach((s) => {
      if (!isWordSeg(s)) return;
      const u = { seg: s };
      if (s.kind === 'sokuon') u.type = 'q';
      else if (s.kind === 'long') { u.type = 'opt'; u.M = s.vowel ? DASH_HANGUL_M[s.vowel] : ''; }
      else if (s.kind === 'mora' && s.isN) u.type = 'n';
      else if (s.kind === 'mora' && s.longPair) {
        if (LONG_OPTIONAL[s.longPair]) { u.type = 'opt'; u.M = LONG_HANGUL_M[s.longPair]; }
        else { u.type = 'mora'; u.pairs = [{ I: 'ㅇ', M: LONG_HANGUL_M[s.longPair] }]; }
      } else if (s.kind === 'mora') { u.type = 'mora'; u.pairs = hangulPairs(s, sentence); }
      else u.type = 'other';
      units.push(u);
    });
    units.forEach((u, i) => {
      if (u.type !== 'q') return;
      const n = units[i + 1];
      u.tenseOk = !!(n && n.type === 'mora' && n.seg.start === u.seg.end &&
        n.pairs.some((p) => Array.from(p.I).some((x) => TENSE_OF[x])));
    });
    return units;
  }

  function hangulTokens(s) {
    const toks = [];
    for (const ch of normHangul(s)) {
      const d = decompose(ch);
      if (d) { toks.push({ cv: true, I: d.I, M: d.M }); if (d.F) toks.push({ fin: d.F }); }
      else if (/[ㄱ-ㅎ]/.test(ch)) toks.push({ j: ch });
      else toks.push({ x: ch });
    }
    return toks;
  }

  function hangulStep(units, toks) {
    const U = units.length;
    return (u, t, f, emit, zeroOnly) => {
      const tok = toks[t];
      if (!zeroOnly && tok) emit(u, t + 1, f, 1, Math.min(u, U - 1), false);   // extra syllable / 받침
      if (u >= U) return;
      const un = units[u];
      if (un.type === 'mora') {
        if (tok && tok.cv) {
          const plain = matchPairs(un.pairs, tok.I, tok.M);
          if (f === 0 && plain) emit(u + 1, t + 1, 0, 0, u, true);
          else if (f === 1 && matchTense(un.pairs, tok.I, tok.M)) emit(u + 1, t + 1, 0, 0, u, true);
          else if (!zeroOnly) emit(u + 1, t + 1, 0, f === 1 && plain ? 1.1 : 1.01, u, false);
        } else if (tok && !zeroOnly) emit(u + 1, t + 1, 0, 1.01, u, false);
        if (!zeroOnly) emit(u + 1, t, 0, 1, u, false);
      } else if (un.type === 'opt') {
        emit(u + 1, t, f, 0, u, true);
        if (tok && tok.cv && f === 0) {
          if (tok.I === 'ㅇ' && un.M.includes(tok.M)) emit(u + 1, t + 1, 0, 0, u, true);
          else if (!zeroOnly) emit(u + 1, t + 1, 0, 1.01, u, false);
        }
      } else if (un.type === 'n') {
        if (f === 0 && tok && ((tok.fin && N_FINALS.includes(tok.fin)) || (tok.j && N_FINALS.includes(tok.j)))) emit(u + 1, t + 1, 0, 0, u, true);
        const t2 = toks[t + 1];
        if (f === 0 && tok && tok.cv && tok.I === 'ㅇ' && 'ㅡㅔㅓ'.includes(tok.M) && t2 && t2.fin && N_FINALS.includes(t2.fin)) {
          emit(u + 1, t + 2, 0, 0, u, true);                                       // 응 / 은 / 음 / 엔
        }
        if (zeroOnly) return;
        if (tok) emit(u + 1, t + 1, 0, 1.01, u, false);
        emit(u + 1, t, 0, 1, u, false);
      } else if (un.type === 'q') {
        if (f === 0 && tok && Q_FINALS.includes(tok.fin || tok.j || '-')) emit(u + 1, t + 1, 0, 0, u, true);  // 받침 ㄱㄷㅂㅅ…
        if (f === 0 && un.tenseOk) emit(u + 1, t, 1, 0, u, true);                    // doubled next initial
        if (zeroOnly) return;
        if (tok) emit(u + 1, t + 1, 0, 1.01, u, false);
        emit(u + 1, t, 0, 1, u, false);
      } else if (!zeroOnly) {
        if (tok) emit(u + 1, t + 1, 0, 1.01, u, false);
        emit(u + 1, t, 0, 1, u, false);
      }
    };
  }
  const acceptHangul = (units, toks) => reachable(units.length, toks.length, hangulStep(units, toks));
  const alignHangul = (units, toks) => dpAlign(units.length, toks.length, hangulStep(units, toks),
    units.map((x) => (x.type === 'opt' ? 0.5 : 1)));

  // Keys pressed on a 두벌식 keyboard for a Hangul string (ㅎ먀ㅕㄴㄷㅑ → gakusei); null if it holds anything else.
  const KEY_OF = {
    'ㅂ': 'q', 'ㅈ': 'w', 'ㄷ': 'e', 'ㄱ': 'r', 'ㅅ': 't', 'ㅛ': 'y', 'ㅕ': 'u', 'ㅑ': 'i', 'ㅐ': 'o', 'ㅔ': 'p',
    'ㅁ': 'a', 'ㄴ': 's', 'ㅇ': 'd', 'ㄹ': 'f', 'ㅎ': 'g', 'ㅗ': 'h', 'ㅓ': 'j', 'ㅏ': 'k', 'ㅣ': 'l',
    'ㅋ': 'z', 'ㅌ': 'x', 'ㅊ': 'c', 'ㅍ': 'v', 'ㅠ': 'b', 'ㅜ': 'n', 'ㅡ': 'm',
    'ㅃ': 'q', 'ㅉ': 'w', 'ㄸ': 'e', 'ㄲ': 'r', 'ㅆ': 't', 'ㅒ': 'o', 'ㅖ': 'p',               // shifted
    'ㅘ': 'hk', 'ㅙ': 'ho', 'ㅚ': 'hl', 'ㅝ': 'nj', 'ㅞ': 'np', 'ㅟ': 'nl', 'ㅢ': 'ml',
    'ㄳ': 'rt', 'ㄵ': 'sw', 'ㄶ': 'sg', 'ㄺ': 'fr', 'ㄻ': 'fa', 'ㄼ': 'fq', 'ㄽ': 'ft', 'ㄾ': 'fx', 'ㄿ': 'fv', 'ㅀ': 'fg', 'ㅄ': 'qt',
  };
  function dubeolsikKeys(s) {
    let out = '';
    for (const ch of normHangul(s)) {
      const d = decompose(ch);
      if (d) out += KEY_OF[d.I] + KEY_OF[d.M] + (d.F ? KEY_OF[d.F] : '');
      else if (KEY_OF[ch]) out += KEY_OF[ch];
      else return null;
    }
    return out || null;
  }

  // entry.reading (override): romaji as the spec intends, but kana or Hangul typed there are understood too.
  // Returns { romaji: display string, kana: kana text it stands for (or null), hangul: Hangul override (or null) }.
  function readOverride(override, sentence, text) {
    const kind = override ? inputKind(override) : 'empty';
    let kana = null;
    if (kind === 'romaji') {
      // katakana entries convert to katakana, so kōhī / ko-hi- mean コーヒー (not こうひい)
      const script = /[ァ-ヺ]/.test(text) && !/[ぁ-ゖ]/.test(text) ? 'kata' : 'hira';
      const conv = romajiToKana(override, { final: true, script });
      if (!conv.pending && validate(conv.kana).ok) kana = conv.kana;
    } else if (kind === 'kana' && validate(override).ok) kana = normalize(override);
    return {
      kind,
      kana,
      romaji: kind === 'romaji' ? override : kind === 'kana' && kana ? romajiOf(segs(kana, sentence)) : null,
      hangul: kind === 'hangul' ? override : null,
    };
  }

  function checkReading(input, entry) {
    if (typeof entry === 'string') entry = { text: entry };
    entry = entry || {};
    const text = normalize(entry.text);
    const type = entry.type === 'sentence' || entry.type === 'word' ? entry.type : autoType(text);
    const sentence = type === 'sentence';
    const list = segs(text, sentence);
    const ov = readOverride(String(entry.reading == null ? '' : entry.reading).trim(), sentence, text);
    const ovList = ov.kana ? segs(ov.kana, sentence) : null;
    const autoRomaji = romajiOf(list), autoHangul = hangulOf(list);
    // the override changes the pronunciation (watashi wa for the word わたしは) → its Hangul is shown and accepted too
    const ovSounds = !!(ovList && normRomaji(romajiOf(ovList)) !== normRomaji(autoRomaji));
    const expected = {
      romaji: ov.romaji || autoRomaji,
      hangul: ov.hangul || (ovSounds ? hangulOf(ovList) : autoHangul),
    };
    const k = inputKind(input);
    const res = {
      correct: false, empty: k === 'empty', kind: k === 'empty' ? 'other' : k, exact: false, expected,
      segments: list.map((s) => Object.assign(pub(s), { ok: null })),
    };
    if (res.empty) return res;

    let units = null, marks = null;
    const rUnits = () => units && k === 'romaji' ? units : romajiUnits(list, sentence);
    const romajiOk = (inp) => {
      const tooLong = inp.length > 4 * Math.max(autoRomaji.length, (ov.romaji || '').length) + 40;   // absurd answer
      return { tooLong, ok: (!tooLong && acceptStrings(rUnits(), inp)) || (!!ov.romaji && normRomaji(ov.romaji) === inp) ||
        (!tooLong && !!ovList && acceptStrings(romajiUnits(ovList, sentence), inp)) };
    };
    if (k === 'romaji') {
      const inp = normRomaji(input);
      units = romajiUnits(list, sentence);
      const r = romajiOk(inp);
      res.correct = r.ok;
      if (!res.correct) marks = r.tooLong ? units.map(() => false) : alignStrings(units, inp).marks;
      const ex = exactRomaji(input);
      res.exact = res.correct && (ex === exactRomaji(autoRomaji) || (!!ov.romaji && ex === exactRomaji(ov.romaji)));
    } else if (k === 'hangul') {
      units = hangulUnits(list, sentence);
      const toks = hangulTokens(input);
      const inp = normHangul(input);
      const tooLong = toks.length > 4 * units.length + 40;
      res.correct = (!tooLong && acceptHangul(units, toks)) ||
        (!!ov.hangul && normHangul(ov.hangul) === inp) ||
        (!tooLong && ovSounds && acceptHangul(hangulUnits(ovList, sentence), toks));
      const exactOf = (h) => inp === normHangul(h) || inp === normHangul(h.replace(/\([^)]*\)/g, ''));
      res.exact = res.correct && (exactOf(autoHangul) || exactOf(expected.hangul));
      if (!res.correct) {
        // 한/영 slip: romaji typed with the Korean layout on (gakusei → ㅎ마ㅕㄴ댜) is graded as romaji. Only when the
        // answer has the slip's tell-tale standalone jamo and ≥ 3 keys, so a real Hangul answer never collides (냐 ≠ si)
        const keys = /[ㄱ-ㅣ]/.test(inp) ? dubeolsikKeys(input) : null;
        if (keys && keys.length >= 3 && romajiOk(normRomaji(keys)).ok) { res.correct = true; res.kind = 'romaji'; }
        else marks = tooLong ? units.map(() => false) : alignHangul(units, toks).marks;
      }
    } else if (k === 'kana') {
      const inp = stripKana(input);
      res.correct = inp === stripKana(text);
      res.exact = res.correct;
      if (!res.correct) {
        units = list.filter(isWordSeg).map((s) => ({ seg: s, alts: [s.text] }));
        marks = inp.length > 4 * text.length + 40 ? units.map(() => false) : alignStrings(units, inp).marks;
      }
    }

    if (res.correct) {
      res.segments.forEach((s) => { if (s.kind !== 'space' && s.kind !== 'punct') s.ok = true; });
    } else if (units && marks) {
      const segIndex = new Map(list.map((s, i) => [s, i]));
      units.forEach((u, i) => {
        const idx = segIndex.get(u.seg);
        if (idx >= 0) res.segments[idx].ok = marks[i] === null ? false : marks[i];
      });
    }
    return res;
  }

  /* ------------------------------------------------------------------ romaji → kana (IME-like) */

  const RK = (function () {
    const m = {};
    const rows = {
      '': 'あいうえお', k: 'かきくけこ', g: 'がぎぐげご', s: 'さしすせそ', z: 'ざじずぜぞ', t: 'たちつてと',
      d: 'だぢづでど', n: 'なにぬねの', h: 'はひふへほ', b: 'ばびぶべぼ', p: 'ぱぴぷぺぽ', m: 'まみむめも', r: 'らりるれろ',
    };
    for (const c of Object.keys(rows)) for (let i = 0; i < 5; i++) m[c + VOWELS[i]] = rows[c][i];
    const yo = { ky: 'き', gy: 'ぎ', sy: 'し', sh: 'し', zy: 'じ', jy: 'じ', j: 'じ', ty: 'ち', cy: 'ち', ch: 'ち', dy: 'ぢ',
      ny: 'に', hy: 'ひ', by: 'び', py: 'ぴ', my: 'み', ry: 'り', shy: 'し', chy: 'ち' };
    for (const c of Object.keys(yo)) {
      m[c + 'a'] = yo[c] + 'ゃ'; m[c + 'u'] = yo[c] + 'ゅ'; m[c + 'o'] = yo[c] + 'ょ'; m[c + 'e'] = yo[c] + 'ぇ';
      if (/y$/.test(c)) m[c + 'i'] = yo[c] + 'ぃ';
    }
    Object.assign(m, {
      shi: 'し', chi: 'ち', tsu: 'つ', fu: 'ふ', ji: 'じ',
      ya: 'や', yu: 'ゆ', yo: 'よ', yi: 'い', ye: 'いぇ',
      wa: 'わ', wo: 'を', wu: 'う', wi: 'うぃ', we: 'うぇ', wha: 'うぁ', whi: 'うぃ', whu: 'う', whe: 'うぇ', who: 'うぉ',
      ca: 'か', ci: 'し', cu: 'く', ce: 'せ', co: 'こ', qa: 'くぁ', qi: 'くぃ', qu: 'く', qe: 'くぇ', qo: 'くぉ',
      fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ', fya: 'ふゃ', fyu: 'ふゅ', fyo: 'ふょ',
      tsa: 'つぁ', tsi: 'つぃ', tse: 'つぇ', tso: 'つぉ',
      tha: 'てゃ', thi: 'てぃ', thu: 'てゅ', the: 'てぇ', tho: 'てょ', dha: 'でゃ', dhi: 'でぃ', dhu: 'でゅ', dhe: 'でぇ', dho: 'でょ',
      twa: 'とぁ', twi: 'とぃ', twu: 'とぅ', twe: 'とぇ', two: 'とぉ', dwa: 'どぁ', dwi: 'どぃ', dwu: 'どぅ', dwe: 'どぇ', dwo: 'どぉ',
      kwa: 'くぁ', kwi: 'くぃ', kwu: 'くぅ', kwe: 'くぇ', kwo: 'くぉ', gwa: 'ぐぁ', gwi: 'ぐぃ', gwu: 'ぐぅ', gwe: 'ぐぇ', gwo: 'ぐぉ',
      dzi: 'ぢ', dzu: 'づ',                                   // KANA_DATA romajiAlt spellings
      va: 'ヴァ', vi: 'ヴィ', vu: 'ヴ', ve: 'ヴェ', vo: 'ヴォ', vya: 'ヴャ', vyi: 'ヴィ', vyu: 'ヴュ', vye: 'ヴェ', vyo: 'ヴョ',
      xa: 'ぁ', xi: 'ぃ', xu: 'ぅ', xe: 'ぇ', xo: 'ぉ', la: 'ぁ', li: 'ぃ', lu: 'ぅ', le: 'ぇ', lo: 'ぉ',
      xya: 'ゃ', xyu: 'ゅ', xyo: 'ょ', lya: 'ゃ', lyu: 'ゅ', lyo: 'ょ',
      xtu: 'っ', ltu: 'っ', xtsu: 'っ', ltsu: 'っ', xn: 'ん',
    });
    return m;
  })();
  const RK_PREFIX = (function () {
    const p = new Set();
    for (const k of Object.keys(RK)) for (let i = 1; i <= k.length; i++) p.add(k.slice(0, i));
    return p;
  })();
  const isLetter = (c) => c >= 'a' && c <= 'z';

  // macron / circumflex long vowels: hiragana spells them out (ō → ou, ē → ei: とうきょう, せんせい), katakana uses ー
  const MACRON_HIRA = { a: 'aa', i: 'ii', u: 'uu', e: 'ei', o: 'ou' };

  function romajiToKana(input, opts) {
    const kata = !!(opts && opts.script === 'kata');
    const final = !!(opts && opts.final);
    const s = String(input == null ? '' : input).replace(INVISIBLE_RE, '').normalize('NFKC').toLowerCase().normalize('NFD')
      .replace(/([aiueo])[̄̂]/g, (m, v) => (kata ? v + '-' : MACRON_HIRA[v]))
      .replace(/[̀-ͯ]/g, '')                                          // other accents: é → e
      .normalize('NFC');
    let out = '', pending = '';
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (!isLetter(c)) {
        if (DASHES.includes(c)) out += 'ー';
        else if (c === ',') out += '、';
        else if (c === '.') out += '。';
        else if (!APOS.includes(c)) out += c;
        i++;
        continue;
      }
      const n1 = s[i + 1], n2 = s[i + 2];
      if (c === 'n') {
        if (n1 === undefined) { if (final) out += 'ん'; else pending = 'n'; i++; continue; }
        if (APOS.includes(n1)) { out += 'ん'; i += 2; continue; }
        if (n1 === 'n') {
          out += 'ん';
          i += n2 !== undefined && (VOWELS.includes(n2) || n2 === 'y') ? 1 : 2;   // minna / konn
          continue;
        }
        if (!isLetter(n1) || (!VOWELS.includes(n1) && n1 !== 'y')) { out += 'ん'; i++; continue; }
      } else if (c === 'm' && (n1 === 'b' || n1 === 'p' || n1 === 'm')) { out += 'ん'; i++; continue; }   // sempai, samma (Hepburn)
      else if (!VOWELS.includes(c) && c === n1) { out += 'っ'; i++; continue; }
      else if (c === 't' && n1 === 'c' && n2 === 'h') { out += 'っ'; i++; continue; }
      let matched = false;
      for (let len = 4; len >= 1; len--) {
        const key = s.substr(i, len);
        if (key.length === len && RK[key]) { out += RK[key]; i += len; matched = true; break; }
      }
      if (matched) continue;
      const rest = s.length - i <= 4 ? s.slice(i) : '';            // (prefixes are ≤ 4 letters: no rescans)
      if (rest && /^[a-z]+$/.test(rest) && (RK_PREFIX.has(rest) || rest === 'tc')) { pending = rest; break; }
      out += c;                                   // not convertible: keep the letter (validate() flags it)
      i++;
    }
    return { kana: kata ? toKata(out) : out, pending };
  }

  /* ------------------------------------------------------------------ kanji forms & meanings */

  // CJK ideographs: URO, Ext A, compatibility ideographs (﨑 …), Ext B–H (𠮟 is a 常用漢字), 〆 and 〇
  const IDEO_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{3ffff}〆〇]/u;
  const KANJI_MARKS = '々ヶ';

  function validateKanji(str) {
    const { allowed } = tables();
    // Kangxi radicals (⽇ U+2F47 from PDF copy-paste) look like kanji: NFKC maps them to the ideograph (日)
    const normalized = normalize(String(str == null ? '' : str).replace(/[\u2f00-\u2fdf]/g, (c) => c.normalize('NFKC')));
    const bad = [];
    let ideo = 0;
    for (const ch of normalized) {
      if (IDEO_RE.test(ch)) { ideo++; continue; }
      if (allowed.has(ch) || KANJI_MARKS.includes(ch)) continue;
      if (!bad.includes(ch)) bad.push(ch);
    }
    const empty = normalized.length === 0;
    const reason = empty ? 'empty' : bad.length ? 'bad' : ideo ? null : 'noKanji';
    return { ok: empty || reason === null, normalized, bad, empty, reason };
  }

  function isKanjiForm(str) {
    const v = validateKanji(str);
    return v.ok && !v.empty;
  }

  const OPEN = '([{（［｛「『【〔', CLOSE = ')]}）］｝」』】〕', SEP = ',/;·，／；・･、ㆍ•|｜\n\r';
  // "~을/를 좋아하다": a slash between two particles is not a separator
  const PARTICLES = new Set(['을', '를', '이', '가', '은', '는', '와', '과', '로', '으로', '에', '에게', '에서', '한테', '께', '랑', '이랑']);
  const isDigit = (c) => c >= '0' && c <= '9';

  function splitMeanings(meaning) {
    const out = [];
    const push = (x) => { x = x.trim(); if (x && !out.includes(x)) out.push(x); };
    const chars = Array.from(String(meaning == null ? '' : meaning).normalize('NFC'));
    let cur = '', depth = 0;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (OPEN.includes(ch)) depth++;
      else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
      let sep = depth === 0 && SEP.includes(ch);
      if (sep && (ch === ',' || ch === '，') && isDigit(chars[i - 1] || '') && isDigit(chars[i + 1] || '')) sep = false;   // 1,000원
      if (sep && (ch === '/' || ch === '／')) {
        // 을/를 + more words (~을/를 좋아하다) is one meaning; a bare list of particles (은/는 for は) is split
        const left = (/[^\s]*$/.exec(cur)[0] || '').replace(/^[~〜～∼]/, '');
        let j = i + 1, right = '';
        while (j < chars.length && !/\s/.test(chars[j]) && !SEP.includes(chars[j])) right += chars[j++];
        while (j < chars.length && /\s/.test(chars[j]) && !SEP.includes(chars[j])) j++;
        const more = j < chars.length && !SEP.includes(chars[j]);
        if (more && PARTICLES.has(left) && PARTICLES.has(right)) sep = false;
      }
      if (sep) { push(cur); cur = ''; continue; }
      cur += ch;
    }
    push(cur);
    return out;
  }

  const NOTE_RE = /\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}|【[^【】]*】|〔[^〔〕]*〕/g;
  const foldMeaning = (s) => String(s == null ? '' : s).replace(INVISIBLE_RE, '').normalize('NFKC').toLowerCase();
  const squash = (s) => s.replace(/[\s\p{P}\p{S}]/gu, '');
  function dropNotes(t) {
    let prev;
    do { prev = t; t = t.replace(NOTE_RE, ' '); } while (t !== prev);
    return t;
  }
  // the learner's answer: notes in brackets dropped — unless the whole answer is in brackets ("(물)" → 물)
  function normMeaning(s) {
    const t = foldMeaning(s);
    return squash(dropNotes(t)) || squash(t);
  }
  // accepted spellings of one listed meaning: note dropped (물 (마시는 물) → 물) or kept inline (공부(하다) →
  // 공부하다), and without a leading "~particle" placeholder (~을/를 좋아하다 → 좋아하다)
  function meaningForms(m) {
    const t = foldMeaning(m);
    const forms = new Set();
    for (const v of [dropNotes(t), t]) {
      forms.add(squash(v));
      const tail = /^\s*[~〜∼]\S*\s+(\S[\s\S]*)$/.exec(v);
      if (tail) forms.add(squash(tail[1]));
    }
    forms.delete('');
    return forms;
  }

  function checkMeaning(input, meaning) {
    const accepted = splitMeanings(meaning);
    const n = normMeaning(input);
    if (!n) return { correct: false, empty: true, accepted, matched: null };
    let matched = accepted.find((m) => meaningForms(m).has(n)) || null;
    if (!matched && accepted.length && meaningForms(meaning).has(n)) matched = accepted[0];   // the whole string typed
    return { correct: !!matched, empty: false, accepted, matched };
  }

  /* ------------------------------------------------------------------ export */

  return {
    validate, cells, segment, toRomaji, toHangul, checkReading, romajiToKana, YOON,
    isKanjiForm, validateKanji, checkMeaning, splitMeanings,
    normalize, autoType, inputKind, toKatakana: toKata, toHiragana: toHira,
  };
});
