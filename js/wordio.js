/* WordIO — the word book's file format "kana-practice-words" v1 (docs/WORDS-FORMAT.md): reading files and AI
 * answers leniently, the identity rule (which entries are the same word), the merge rule, and the AI prompt.
 * Pure (no DOM, no storage); KanaStore (js/store.js) uses it to plan and apply imports and the 중복 정리, js/words.js
 * for the 가져오기·내보내기 screen. UMD: window.WordIO / require('./wordio.js'). Needs KanaText (js/romaji.js).
 *
 *   WordIO.read(textOrData) → { ok, items, notes, error, count }
 *       items: canonical inputs for KanaStore.words.planImport / applyImport — { text, kanji, meaning, alts, note, tag,
 *       type, reading, source, id?, createdAt?, updatedAt?, tally?, stats?, _index, _raw, _problem? } (_index: the
 *       item's place in the file, 0-based, across every JSON block; _raw: the item as written, for the problem list).
 *       notes: what was read leniently, in Korean (code fences and prose dropped, trailing commas, smart quotes, a cut-
 *       off answer, field aliases …). error: why nothing could be read (Korean), else null.
 *   WordIO.sameWord(a, b, ctx?) → 'sure' | 'maybe' | false  (entries: { text, kanji, alts, meaning }; ctx: { kanjiReadings })
 *   WordIO.makeIndex(entries, extraKanjiReadings?) / findTarget(index, entry) / groupEntries(entries, extraKanjiReadings?)
 *   WordIO.mergeContent(base, incoming, { mode: 'merge'|'overwrite', typeGiven }) → { value, dropped }
 *   WordIO.diffContent(before, after) → [change] ; describeChange(change) → Korean
 *   WordIO.problemMessage(checkResult, input) → Korean ; problemsText(problems) → text to paste back to the AI
 *   WordIO.PROMPT, WordIO.EXAMPLE_JSON
 *
 * Identity (docs/WORDS-FORMAT.md §Identity) — readings compare in hiragana with spaces and 、。 dropped (テスト = てすと,
 * わたしは がくせいです。 = わたしはがくせいです), kanji forms with spaces and 、。 dropped:
 *   • both have a kanji form: different kanji → different words (橋 ≠ 箸). Same kanji → the same word when they share a
 *     reading, or their meanings overlap (or one has none); otherwise only 'maybe' (一日 ついたち 1일 / いちにち 하루).
 *   • kanji form vs kana only (学生/がくせい vs がくせい): they must share a reading; then the same word unless both list
 *     meanings and none overlap ('maybe': 橋/はし 다리 vs はし 젓가락).
 *   • both kana only: they must share a reading; then the same word (はい 네 / 예) — unless a kanji word of that reading is
 *     in the book or the file and the meanings are disjoint ('maybe': かみ 종이 / かみ 신 next to 紙).
 *   'maybe' never merges by itself: an import adds such an item as a new word (the preview says so), 중복 정리 lists the
 *   pair unticked. A kana-only item that fits words with different kanji (はし with 橋 and 箸) goes to the one whose
 *   meaning overlaps; if that does not decide it, it stays on its own.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module && module.exports;
  const api = factory(root, isNode);
  if (isNode) module.exports = api;
  else root.WordIO = api;
})(typeof self !== 'undefined' ? self : this, function (root, isNode) {
  'use strict';

  let ktN = null;
  const KT = () => (root && root.KanaText) || ktN || (isNode ? (ktN = require('./romaji.js')) : null);

  const FORMAT = 'kana-practice-words';
  const VERSION = 1;
  const MAX_TEXT = 5 * 1024 * 1024;        // characters read from one paste / file set
  const MAX_ITEMS = 5000;
  const MAX_DEPTH = 64;
  const MAYBE_MAX = 100;
  const LIM = { meaning: 200, note: 1000, alts: 5 };
  const EXAMPLE_TAG = '예시';             // the 예시 넣기 label: loses to a real tag when two entries merge
  const PROMPT_HEAD = '아래 일본어 단어 목록을 「가나 연습장」 단어장에 가져올 수 있는 JSON으로 바꿔 주세요.';

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : '');
  const chars = (s) => Array.from(String(s || '')).length;

  /* =================================================================== lenient JSON */

  // string openers → the characters that close them (smart quotes from word processors and chat apps)
  const OPEN = { '"': '"', '“': '”“"', '”': '”“"', '„': '”“"', "'": "'", '‘': '’‘\'', '’': '’‘\'' };
  const EOF = { eof: true };
  const WORDS = new Map([['true', true], ['false', false], ['null', null], ['True', true], ['False', false], ['None', null], ['undefined', null]]);

  // End (exclusive) of the bracketed value starting at s[start] ('{' or '['), string- and comment-aware;
  // -1 when the text ends first (a cut-off answer).
  function scanSpan(s, start, end) {
    let depth = 0, q = null;
    for (let i = start; i < end; i++) {
      const c = s[i];
      if (q) {
        if (c === '\\') { i++; continue; }
        if (q.includes(c)) q = null;
        continue;
      }
      if (OPEN[c]) { q = OPEN[c]; continue; }
      if (c === '/' && s[i + 1] === '/') { const j = s.indexOf('\n', i); i = j < 0 ? end : j; continue; }
      if (c === '/' && s[i + 1] === '*') { const j = s.indexOf('*/', i + 2); i = j < 0 ? end : j + 1; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; }
    }
    return -1;
  }

  // JSON with the slips AI answers and hand edits make: trailing / missing commas, smart or single quotes, bare keys,
  // comments, raw newlines and unescaped quotes inside strings, True/None, '...' between items, ： and ，, and a cut-off
  // end (every container still open is closed; an array drops its cut element). `used` collects which of these
  // happened. Throws { pos, what } on anything else.
  function parseLenient(s, start, end, used) {
    let i = start, depth = 0;
    const cut = new Set();
    const fail = (what) => { const e = new Error(what); e.pos = i; e.what = what; throw e; };
    function ws() {
      for (;;) {
        while (i < end && /[\s ﻿​]/.test(s[i])) i++;
        if (s[i] === '/' && s[i + 1] === '/') { used.add('comments'); while (i < end && s[i] !== '\n') i++; continue; }
        if (s[i] === '/' && s[i + 1] === '*') { used.add('comments'); const j = s.indexOf('*/', i + 2); i = j < 0 || j >= end ? end : j + 2; continue; }
        return;
      }
    }
    function cutOff(v) { cut.add(v); used.add('truncated'); depth--; return v; }
    function string() {
      const open = s[i], closers = OPEN[open];
      if (open !== '"') used.add(open === "'" || open === '‘' || open === '’' ? 'single' : 'quotes');
      i++;
      let out = '';
      for (;;) {
        if (i >= end) throw EOF;
        const c = s[i];
        if (c === '\\') {
          if (i + 1 >= end) throw EOF;
          const n = s[i + 1];
          if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6; continue; }
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === 'b' ? '\b' : n === 'f' ? '\f' : n;
          i += 2;
          continue;
        }
        if (closers.includes(c)) {
          // a quote inside the text that was not escapes ("말하다 ("이야기하다")"): on the same line, something other
          // than , : } ] follows it → it is part of the text
          // (another quote next = a missing comma, not an inner quote)
          let j = i + 1;
          while (j < end && (s[j] === ' ' || s[j] === '\t')) j++;
          if (j < end && !/[,:}\]，：\r\n/]/.test(s[j]) && !OPEN[s[j]]) {
            used.add('innerQuote');
            out += c;
            i++;
            continue;
          }
          i++;
          return out;
        }
        if (c === '\n') used.add('newline');
        out += c;
        i++;
      }
    }
    function number() {
      const m = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(s.slice(i, Math.min(end, i + 40)));
      if (!m) fail('value');
      i += m[0].length;
      return Number(m[0]);
    }
    function key() {
      if (OPEN[s[i]]) return string();
      const m = /^[\p{L}\p{N}_$][\p{L}\p{N}_$-]*/u.exec(s.slice(i, Math.min(end, i + 80)));
      if (!m) fail('key');
      used.add('keys');
      i += m[0].length;
      return m[0];
    }
    function value() {
      ws();
      if (i >= end) throw EOF;
      const c = s[i];
      if (c === '{') return object();
      if (c === '[') return array();
      if (OPEN[c]) return string();
      if (/[-+0-9.]/.test(c)) return number();
      const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i, Math.min(end, i + 40)));
      if (m && WORDS.has(m[0])) {
        i += m[0].length;
        if (!/^(true|false|null)$/.test(m[0])) used.add('words');
        return WORDS.get(m[0]);
      }
      return fail('value');
    }
    function object() {
      if (++depth > MAX_DEPTH) fail('depth');
      i++;
      const o = {};
      let need = false, lastComma = false;
      for (;;) {
        ws();
        if (i >= end) return cutOff(o);
        const c = s[i];
        if (c === '}') { if (lastComma) used.add('comma'); i++; depth--; return o; }
        if (c === ',' || c === '，') { if (c === '，') used.add('fullwidth'); if (!need) used.add('comma'); need = false; lastComma = true; i++; continue; }
        if (need) used.add('missingComma');
        let k, v;
        try { k = key(); } catch (e) { if (e === EOF) return cutOff(o); throw e; }
        ws();
        if (i >= end) return cutOff(o);
        if (s[i] === ':' || s[i] === '=') i++;
        else if (s[i] === '：') { used.add('fullwidth'); i++; } else fail('colon');
        try { v = value(); } catch (e) { if (e === EOF) return cutOff(o); throw e; }
        if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') o[k] = v;
        if (cut.has(v)) return cutOff(o);
        need = true;
        lastComma = false;
      }
    }
    function array() {
      if (++depth > MAX_DEPTH) fail('depth');
      i++;
      const a = [];
      let need = false, lastComma = false;
      for (;;) {
        ws();
        if (i >= end) return cutOff(a);
        const c = s[i];
        if (c === ']') { if (lastComma) used.add('comma'); i++; depth--; return a; }
        if (c === ',' || c === '，') { if (c === '，') used.add('fullwidth'); if (!need) used.add('comma'); need = false; lastComma = true; i++; continue; }
        if (c === '…' || s.startsWith('...', i)) { used.add('ellipsis'); i += c === '…' ? 1 : 3; while (s[i] === '.') i++; continue; }
        if (need) used.add('missingComma');
        let v;
        try { v = value(); } catch (e) { if (e === EOF) return cutOff(a); throw e; }
        if (cut.has(v)) return cutOff(a);       // the element was cut off: dropped
        a.push(v);
        need = true;
        lastComma = false;
      }
    }
    try {
      return { value: value(), end: i };
    } catch (e) {
      if (e === EOF) { const x = new Error('eof'); x.pos = i; x.what = 'eof'; throw x; }
      throw e;
    }
  }

  const lineOf = (s, pos) => s.slice(0, Math.max(0, pos)).split('\n').length;
  const PARSE_WHAT = {
    colon: '칸 이름 뒤에 「:」이 없어요',
    key: '칸 이름을 읽을 수 없어요 — 따옴표나 쉼표가 빠졌는지 확인해 주세요',
    value: '값을 읽을 수 없어요 — 따옴표나 쉼표가 빠졌는지 확인해 주세요',
    depth: '괄호가 너무 깊게 겹쳐 있어요',
    eof: '내용이 중간에 끊겼어요',
  };

  /* =================================================================== finding the JSON in a file / an AI answer */

  const PARSE_NOTES = {
    fence: '코드 블록(```) 밖의 설명 글은 빼고 읽었어요.',
    gap: '코드 블록 밖에 있던 JSON 단어도 읽었어요 — 빠지거나 겹친 단어가 없는지 확인해 주세요.',
    prose: '앞뒤 설명 글은 빼고 JSON만 읽었어요.',
    comma: '남는 쉼표는 무시했어요.',
    missingComma: '빠진 쉼표를 채워서 읽었어요.',
    quotes: '둥근 따옴표(“ ”)를 보통 따옴표로 읽었어요.',
    single: '작은따옴표(\' \')로 감싼 글을 읽었어요.',
    keys: '따옴표 없는 칸 이름을 읽었어요.',
    comments: '주석(// …)은 건너뛰었어요.',
    newline: '글 안의 줄바꿈을 그대로 읽었어요.',
    innerQuote: '글 안의 따옴표(")를 글자로 읽었어요.',
    words: 'True·False·None을 true·false·null로 읽었어요.',
    fullwidth: '전각 기호(： ，)를 읽었어요.',
    ellipsis: '목록 중간의 「...」는 건너뛰었어요 — 생략된 단어가 없는지 확인해 주세요.',
    truncated: '답이 중간에 끊긴 것 같아요. 끝까지 들어 있는 항목만 읽었어요 — 나머지는 AI에게 「이어서 써 줘」라고 해서 받아 주세요.',
  };

  // The value's word list: [items] and a note when it was not the plain { format, v, words } / bare array.
  function wordList(v) {
    if (Array.isArray(v)) {
      if (!v.length || v.some(isObj)) return { list: v, note: null, envelope: null };
      return null;
    }
    if (!isObj(v)) return null;
    if (Array.isArray(v.words)) return { list: v.words, note: null, envelope: v };
    // { "たべる": "먹다", … }: words mapped to their meanings
    const asMap = (o) => {
      const ks = Object.keys(o);
      return ks.length && ks.every((k) => isJapanese(k) && typeof o[k] === 'string') ? ks.map((k) => ({ text: k, meaning: o[k] })) : null;
    };
    const MAP_NOTE = '「단어: 뜻」 짝을 단어 목록으로 읽었어요.';
    if (isObj(v.words) && asMap(v.words)) return { list: asMap(v.words), note: MAP_NOTE, envelope: v };
    if (asMap(v)) return { list: asMap(v), note: MAP_NOTE, envelope: null };
    if (Array.isArray(v.entries)) return { list: v.entries, note: '「entries」 목록을 단어 목록으로 읽었어요.', envelope: v };
    for (const k of Object.keys(v)) {
      if (Array.isArray(v[k]) && v[k].length && v[k].every(isObj)) return { list: v[k], note: `「${k}」 목록을 단어 목록으로 읽었어요.`, envelope: v };
    }
    if (['text', 'kana', 'hiragana', 'kanji', 'word', 'reading'].some((k) => has(v, k))) return { list: [v], note: '단어 하나({ … })를 목록으로 읽었어요.', envelope: null, single: true };
    return null;
  }

  // Every JSON value in the text that holds a word list, in order. Code blocks first (an AI answer, maybe several
  // blocks of ≤ 300 words); with no code block, the whole text (a .json file, or JSON with prose around it).
  function extract(text) {
    const s = String(text);
    const regions = [];
    // an opening fence may follow a list marker ("1. ```json", "- ```json"); the closing one stands on its own line
    const OPENER = '(^|\\n)[ \\t]*(?:(?:\\d{1,3}[.)]|[-*+•])[ \\t]+)?(`{3,}|~{3,})[^\\n`]*\\n';
    const fence = new RegExp(OPENER + '([\\s\\S]*?)\\n[ \\t]*\\2[ \\t]*(?=\\n|$)', 'g');
    const WORDY = /["'“”]?(text|kana|kanji|meaning|words)["'“”]?\s*[:：]/;
    let m, last = 0, outside = '';
    const gaps = [];               // the text between code blocks: read too when it holds JSON words (a block not fenced)
    while ((m = fence.exec(s))) {
      const start = m.index + m[0].indexOf('\n', m[1].length) + 1;    // after the opening ```json line
      gaps.push([last, m.index]);
      regions.push([start, start + m[3].length]);
      outside += s.slice(last, m.index);
      last = m.index + m[0].length;
    }
    let rest = s.slice(last);
    const open = new RegExp(OPENER).exec(rest);    // an unclosed block (the answer was cut off)
    if (open && (regions.length || /[{[]/.test(rest.slice(open.index + open[0].length)))) {
      const start = last + open.index + open[0].length;
      gaps.push([last, last + open.index]);
      regions.push([start, s.length]);
      outside += rest.slice(0, open.index);
      rest = '';
    } else gaps.push([last, s.length]);
    outside += rest;
    const fenced = regions.length > 0;
    if (!fenced) regions.push([0, s.length]);
    else {
      let added = 0;
      for (const [a, b] of gaps) if (b > a && WORDY.test(s.slice(a, b))) { regions.push([a, b, true]); added++; }
      if (added) regions.sort((x, y) => x[0] - y[0]);
    }
    const found = [], used = new Set(), errors = [];
    let prose = false, values = 0;
    for (const [a, b, gap] of regions) {
      let pos = a, tries = 0;
      while (pos < b && tries < 400) {
        tries++;
        let k = pos;
        while (k < b && s[k] !== '{' && s[k] !== '[') k++;
        if (k >= b) { if (s.slice(pos, b).trim()) prose = true; break; }
        if (s.slice(pos, k).trim()) prose = true;
        const spanEnd = scanSpan(s, k, b);
        const stop = spanEnd < 0 ? b : spanEnd;
        let v = null, ok = false, errPos = -1;
        const u = new Set();
        try { v = JSON.parse(s.slice(k, stop)); ok = true; } catch (e) {
          try {
            const r = parseLenient(s, k, stop, u);
            v = r.value;
            ok = !(r.end < stop && s.slice(r.end, stop).trim());
            if (!ok) errPos = r.end;
          } catch (err) {
            errPos = typeof err.pos === 'number' ? err.pos : k;
            if (!gap && WORDY.test(s.slice(k, stop))) errors.push({ line: lineOf(s, errPos), what: err.what || 'value', size: stop - k });
          }
        }
        // between code blocks only a list counts: one { "text": … } there is an example in the prose
        const wl = ok ? wordList(v) : null;
        if (wl && gap && wl.single) { pos = stop; continue; }
        if (wl) {
          if (gap) used.add('gap');
          found.push(wl);
          values++;
          u.forEach((x) => used.add(x));
          pos = stop;
          continue;
        }
        if (ok) { if (stop - k > 2) prose = true; pos = stop; continue; }
        // not JSON: a bracket in the prose ("[참고]") — or broken JSON. A balanced span is skipped whole (its inner
        // objects are not words of their own); an open one that failed right at its start was prose, read on after it.
        if (spanEnd >= 0) pos = stop;
        else if (errPos - k <= 3) { prose = true; pos = k + 1; } else pos = b;
      }
    }
    if (fenced && outside.trim()) used.add('fence');
    else if (!fenced && prose && found.length) used.add('prose');
    errors.sort((x, y) => y.size - x.size);
    return { found, used, error: errors[0] || null, errors, blocks: values };
  }

  /* =================================================================== items: aliases → the canonical fields */

  const fold = (k) => String(k).normalize('NFKC').toLowerCase().replace(/[\s_\-.]/g, '');
  const ALIAS = {
    text: ['text'],
    kanaAlt: ['kana', 'hiragana', 'katakana', 'readingkana', 'kanareading', 'yomi', 'yomigana', 'furigana', 'hira', '読み', 'よみ', 'ふりがな', '읽기', '가나', '히라가나', '요미'],
    word: ['word', 'japanese', 'jp', 'ja', 'term', 'expression', 'vocab', 'headword', '単語', '단어', '일본어'],
    kanji: ['kanji', 'kanjiform', 'written', '漢字', '表記', '한자', '한자표기', '표기'],
    meaning: ['meaning', 'meanings', 'korean', 'ko', 'kr', 'kor', 'translation', 'definition', 'definitions', 'gloss', '뜻', '의미', '한국어', '한국어뜻'],
    alts: ['alts', 'alt', 'alternatives', 'otherreadings', 'altreadings', 'readings', '다른읽기'],
    note: ['note', 'notes', 'memo', 'comment', 'remark', '메모', '비고', '설명', '참고'],
    tag: ['tag', 'tags', 'category', 'lesson', 'topic', 'group', 'chapter', 'unit', '태그', '과', '주제', '분류', '단원'],
    type: ['type', 'kind', '종류', '유형'],
    reading: ['reading'],
    romaji: ['romaji', 'romanization', 'romaji_reading', 'pronunciation', '로마자', '발음'],
    source: ['source', '출처'],
  };
  const PASS = ['id', 'createdAt', 'updatedAt', 'stats', 'tally'];
  const KEY_OF = new Map();
  for (const f of Object.keys(ALIAS)) for (const a of ALIAS[f]) KEY_OF.set(fold(a), f);
  const CANON = new Set(['text', 'kanji', 'meaning', 'alts', 'note', 'tag', 'type', 'reading', 'source']);

  const POS_WORD = new Set(['word', 'noun', 'verb', 'adjective', 'adverb', 'pronoun', 'particle', 'counter', 'number', 'numeral', 'name', 'interjection', 'conjunction',
    '단어', '낱말', '명사', '동사', '형용사', '부사', '대명사', '조사', '수사', '조수사', '감탄사', '접속사', '고유명사', 'い형용사', 'な형용사', '名詞', '動詞', '形容詞', '副詞']);
  const POS_SENT = new Set(['sentence', 'sentences', 'example', '문장', '예문', '文', '例文']);
  const POS_AUTO = new Set(['phrase', 'expression', 'idiom', 'greeting', '표현', '구', '인사', '관용구', '']);

  // 'word' | 'sentence' | '' (automatic) for a type as written (parts of speech are words)
  function typeOf(v) {
    const ty = str(v).trim(), f = fold(ty);
    return POS_SENT.has(f) || POS_SENT.has(ty) ? 'sentence' : POS_WORD.has(f) || POS_WORD.has(ty) ? 'word' : '';
  }
  const hasLatin = (s) => /[A-Za-zＡ-Ｚａ-ｚ]/.test(s);
  const hasKana = (s) => /[ぁ-ゖァ-ヺ]/.test(s);
  const hasIdeo = (s) => /[一-鿿㐀-䶿豈-﫿々〆]|[\u{20000}-\u{3ffff}]/u.test(s);

  /* ---- tidying what AI answers write in a kana reading (text, alts) or a kanji form that the word book cannot store:
   * quotes 「」, ellipses …, wave dashes 〜, ？！ (the app writes only 、 。), furigana in brackets (学生（がくせい）),
   * several readings in one field (なに/なん, なに・なん), a kana-only "kanji" form (コーヒー). Each fix names itself. */
  const KANA_CH = 'ぁ-ゖァ-ヺーｦ-ﾟゝゞヽヾ';
  const isKanaStr = (s) => !!s && new RegExp('^[' + KANA_CH + '\\s、。]+$').test(s) && /[ぁ-ゖァ-ヺｦ-ﾝ]/.test(s);
  const isKanjiForm = (s) => !!s && hasIdeo(s) && new RegExp('^(?:[' + KANA_CH + '\\s、。一-鿿㐀-䶿豈-﫿々〆ヶ]|[\\u{20000}-\\u{3ffff}])+$', 'u').test(s);
  const TIDY = {
    quotes: 'text·kanji의 따옴표(「 」 " ")는 뺐어요',
    ellipsis: 'text·kanji의 말줄임표(…)는 뺐어요',
    wave: 'text·kanji의 물결표(〜)는 뺐어요',
    mark: 'text·kanji의 물음표·느낌표(？ ！)는 문장이면 。로 바꾸고, 단어면 뺐어요',
    comma: '문장 text의 쉼표(,)를 、로 바꿨어요',
    split: 'text에 읽기가 여럿 있어서(/ ・ ·) 첫 번째를 text로, 나머지를 alts로 넣었어요',
    kataDot: '가타카나 단어 사이의 ・는 뺐어요 (サッカー・ボール → サッカーボール)',
    paren: '괄호 속 읽기·한자 표기를 text·kanji·alts로 나눠 넣었어요 (学生（がくせい） → kanji 学生, text がくせい)',
    parenDrop: 'text·kanji의 괄호 속 한국어·로마자는 뺐어요',
    kanjiNoIdeo: '한자가 없는 kanji 칸(コーヒー 같은 가나 표기)은 비웠어요',
    kanjiToText: 'text가 비어 있거나 가나가 아니어서 kanji 칸의 가나를 text로 썼어요',
    swapFields: 'text와 kanji가 뒤바뀌어 있어서 바로잡았어요',
  };

  // quotes, ellipses, wave dashes and ？！ out of one field. dropFinal: one word — a final ？！ is dropped (else 。)
  function tidyMarks(s, note, dropFinal) {
    let t = s;
    const q = t.replace(/[「」『』〈〉《》【】"“”＂]/g, '');
    if (q !== t) { note('tidy:quotes', TIDY.quotes); t = q; }
    const e = t.replace(/\s*(?:…+|‥+|\.{2,}|・{3,}|。{3,})\s*/g, ' ').trim();
    if (e !== t.trim()) { note('tidy:ellipsis', TIDY.ellipsis); t = e; }
    const w = t.replace(/^[\s〜～~]+|[\s〜～~]+$/g, '').replace(/\s*[〜～~]+\s*/g, ' ');
    if (w !== t) { note('tidy:wave', TIDY.wave); t = w; }
    if (/[？?！!]|[.．]\s*$/.test(t)) {
      const end = dropFinal && !/[\s、。]/.test(t.replace(/[？?！!.．\s]+$/, '')) ? '' : '。';
      t = t.replace(/(?:[？?！!]+|[.．])\s*$/, end).replace(/\s*[？?！!]+/g, '。').replace(/[、。]+。|。[、。]+/g, '。').trim();
      note('tidy:mark', TIDY.mark);
    }
    return /^[\s、。]*$/.test(t) ? '' : t;
  }

  // The parts of "A（B）C" (one bracket pair) → { out: A+C, inner: B, joined: A+B+C, tail: nothing after it } or null
  function parenParts(s) {
    const m = /^([^()（）]*?)\s*[(（]([^()（）]*)[)）]\s*([^()（）]*)$/.exec(s);
    if (!m) return null;
    return { out: (m[1] + m[3]).trim(), inner: m[2].trim(), joined: (m[1] + m[2] + m[3]).trim(), tail: !m[3].trim() };
  }
  const isJapanese = (s) => hasKana(s) || hasIdeo(s);

  /* A kana reading as written (the text or one alt) → { text, more: [other readings], kanji: a kanji form found in it,
   * joined: the reading with its brackets dropped (い(きる) → いきる) | '' }.
   * opts: { type: 'word'|'sentence'|'', kanji: the item has a kanji form, isAlt } */
  function tidyReading(raw, note, opts) {
    const o = opts || {};
    let s = tidyMarks(String(raw).trim(), note, o.isAlt || o.type === 'word');
    const out = { text: s, more: [], kanji: '', joined: '' };
    if (!s) return out;
    const p = parenParts(s);
    if (p) {
      if (!p.inner) s = p.out;
      else if (!isJapanese(p.inner)) { s = p.out; note('tidy:parenDrop', TIDY.parenDrop); }
      else if (isKanjiForm(p.out) && !isKanaStr(p.out) && isKanaStr(p.inner)) { out.kanji = p.out; s = p.inner; note('tidy:paren', TIDY.paren); }
      else if (isKanaStr(p.out) && isKanjiForm(p.inner) && !isKanaStr(p.inner)) { out.kanji = p.inner; s = p.out; note('tidy:paren', TIDY.paren); }
      else if (isKanaStr(p.out) && isKanaStr(p.inner)) {
        // なに（なん）: another reading; (お)さけ: an optional part — the caller may prefer `joined` (い(きる) → いきる)
        out.joined = p.joined;
        if (p.tail) { s = p.out; out.more.push(p.inner); } else { s = p.joined; out.more.push(p.out); }
        note('tidy:paren', TIDY.paren);
      }
    }
    // サッカー・ボール: one katakana word
    const k = s.replace(/([ァ-ヺー])[・･]\s*(?=[ァ-ヺ])/g, '$1');
    if (k !== s) { note('tidy:kataDot', TIDY.kataDot); s = k; }
    // a sentence (typed so, or with spaces / 、。 besides the separators) is never split into readings
    const sentence = !o.isAlt && (o.type === 'sentence' || /[\s、。]/.test(s.replace(/\s*[/／|｜·・･,，]\s*/g, '/')));
    // a comma in a sentence is 、; between readings (何: なに, なん) it separates them — a word, or an item with a kanji form
    if (!o.isAlt && /[,，]/.test(s) && (sentence || (o.type !== 'word' && !o.kanji))) { s = s.replace(/\s*[,，]\s*/g, '、'); note('tidy:comma', TIDY.comma); }
    // なに/なん, なに・なん, なに·なん: several readings (and maybe the kanji form: 学生/がくせい)
    const parts = sentence ? [s] : s.split(/\s*[/／|｜·・･,，]\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1) {
      const kana = parts.filter(isKanaStr), forms = parts.filter((x) => !isKanaStr(x) && isKanjiForm(x));
      if (kana.length && kana.length + forms.length === parts.length && forms.length <= 1) {
        s = kana[0];
        out.more.push(...kana.slice(1));
        if (forms.length && !out.kanji) out.kanji = forms[0];
        if (!o.isAlt) note('tidy:split', TIDY.split);
      }
    }
    out.text = s;
    return out;
  }

  // A kanji form as written → { kanji, reading: kana found in brackets | '', kana: the whole field when it has no kanji }
  function tidyKanji(raw, note, dropFinal) {
    let s = tidyMarks(String(raw).trim(), note, dropFinal);
    const out = { kanji: s, reading: '', kana: '' };
    const p = s ? parenParts(s) : null;
    if (p) {
      if (!p.inner) s = p.out;
      else if (!isJapanese(p.inner)) { s = p.out; note('tidy:parenDrop', TIDY.parenDrop); }
      else if (isKanjiForm(p.out) && !isKanaStr(p.out) && isKanaStr(p.inner)) { s = p.out; out.reading = p.inner; note('tidy:paren', TIDY.paren); }
    }
    if (s && !hasIdeo(s) && isKanaStr(s.replace(/[・･]/g, ''))) { out.kana = s; s = ''; }
    out.kanji = s;
    return out;
  }

  // One item as written → { input (canonical fields), noteKeys: [[key, label]] }
  function normalizeItem(raw, index) {
    const notes = [];
    const note = (key, label, ex) => notes.push([key, label, ex]);
    if (!isObj(raw)) {
      return { input: { _index: index, _raw: raw, _problem: Array.isArray(raw) ? '항목이 { … } 가 아니라 [ … ] 목록이에요. 단어마다 { "text": …, "meaning": … } 처럼 적어 주세요.' : '항목이 { … } 형식이 아니에요. 단어마다 { "text": …, "meaning": … } 처럼 적어 주세요.' }, notes };
    }
    const got = {}, from = {}, unknown = [];
    for (const k of Object.keys(raw)) {
      if (PASS.includes(k)) continue;
      const f = KEY_OF.get(fold(k));
      if (!f) { if (k.charAt(0) !== '_' && raw[k] !== '' && raw[k] != null) unknown.push(k); continue; }
      if (has(got, f) && k !== f) continue;                 // the canonical name wins over an alias; else the first
      got[f] = raw[k];
      from[f] = k;
    }
    const input = { _index: index, _raw: raw };
    for (const k of PASS) if (has(raw, k)) input[k] = raw[k];
    const RO = { text: 'text로', kanji: 'kanji로', meaning: 'meaning으로', alts: 'alts로', note: 'note로', tag: 'tag로', type: 'type으로' };
    const aliasNote = (f, to) => { if (from[f] && from[f] !== to) note('alias:' + from[f] + '>' + to, `「${from[f]}」 칸을 ${RO[to] || to + '로'} 읽었어요`); };

    // --- text / kanji
    let text = str(got.text).trim();
    let kanji = str(got.kanji).trim();
    if (kanji) aliasNote('kanji', 'kanji');
    const kanaAlt = str(got.kanaAlt).trim();
    const reading = str(got.reading).trim();
    const readingIsKana = reading && hasKana(reading) && !hasLatin(reading) && !hasIdeo(reading);
    const word = str(got.word).trim();
    if (!text) {
      if (kanaAlt) { text = kanaAlt; aliasNote('kanaAlt', 'text'); }
      else if (readingIsKana) { text = reading; note('readingKana', '「reading」의 가나를 text로 읽었어요'); }
      else if (word && !hasIdeo(word)) { text = word; aliasNote('word', 'text'); }
    } else if (kanaAlt && kanaAlt !== text && !hasIdeo(text)) note('kanaAltDropped', '「' + from.kanaAlt + '」 칸은 text가 있어서 넣지 않았어요');
    if (word && hasIdeo(word) && !kanji) { kanji = word; note('alias:' + from.word + '>kanji', `「${from.word}」의 한자 표기를 kanji로 읽었어요`); }
    // what the word book cannot store, tidied (「」 … 〜 ？！, 学生（がくせい）, なに/なん, a kana-only kanji form)
    const tyHint = typeOf(got.type);
    const extra = [];
    if (text) {
      const tr = tidyReading(text, note, { type: tyHint, kanji: !!kanji });
      text = tr.text;
      extra.push(...tr.more);
      if (tr.kanji && !kanji) kanji = tr.kanji;
    }
    if (kanji) {
      const tk = tidyKanji(kanji, note, tyHint === 'word');
      kanji = tk.kanji;
      if (tk.reading) {
        if (!text || (hasIdeo(text) && !kanaAlt && !readingIsKana)) text = tk.reading;
        else extra.push(tk.reading);
      }
      if (tk.kana) {
        if (!text || (!isKanaStr(text) && !hasIdeo(text))) { text = tk.kana; note('tidy:kanjiToText', TIDY.kanjiToText); }
        else if (!kanji && isKanjiForm(text) && !isKanaStr(text) && !kanaAlt && !readingIsKana) { kanji = text; text = tk.kana; note('tidy:swapFields', TIDY.swapFields); }
        else note('tidy:kanjiNoIdeo', TIDY.kanjiNoIdeo);
      }
    }
    if (text && hasIdeo(text)) {
      // 学生 in text with the kana elsewhere: the kanji form moves to kanji
      const kana = kanaAlt || (readingIsKana ? reading : '');
      if (kana && !hasIdeo(kana)) {
        if (!kanji) kanji = text;
        text = kana;
        note('swap', 'text에 있던 한자 표기를 kanji로 옮기고, 가나 읽기를 text로 썼어요');
      }
    }
    input.text = text;
    input.kanji = kanji;

    // --- meaning
    let meaning = got.meaning;
    if (Array.isArray(meaning)) { meaning = meaning.map(str).map((x) => x.trim()).filter(Boolean).join(', '); note('meaningArray', '뜻 목록([ … ])을 「, 」로 이어 붙였어요'); }
    else if (isObj(meaning)) {
      const ko = str(meaning.ko || meaning.korean || meaning.kr || meaning['한국어']);
      meaning = ko;
      note('meaningObject', ko ? '뜻({ … })에서 한국어 뜻을 읽었어요' : '뜻({ … })을 읽지 못했어요');
    } else meaning = str(meaning);
    if (meaning) aliasNote('meaning', 'meaning');
    input.meaning = meaning.trim();

    // --- alts (other kana readings)
    let alts = got.alts;
    if (typeof alts === 'string') { alts = alts.split(/[/／,，、;；・|]+/); }
    alts = Array.isArray(alts) ? alts.map(str).map((x) => x.trim()).filter(Boolean) : [];
    if (alts.length) aliasNote('alts', 'alts');
    if (alts.length || extra.length) {
      // readings split off the text first, then the alts as written — each tidied like the text (い(きる) for いきる is
      // the text again; なに（なん） two readings); a reading that is not kana (何, nan) is left out, named in the notes
      const known = new Set([text ? foldReading(text) : '']);
      const list = [];
      for (const a of extra.concat(alts)) {
        const r = tidyReading(a, note, { isAlt: true });
        if (r.joined && known.has(foldReading(r.joined))) continue;
        for (const x of [r.text].concat(r.more)) {
          if (!x) continue;
          if (!isKanaStr(x)) { note('altsBad', '가나가 아닌 다른 읽기(alts)는 뺐어요', x); continue; }
          list.push(x);
        }
      }
      // テスト with alt てすと, わたしは がくせい with わたしはがくせい: the same reading (the app accepts either script)
      const seen = new Set(text ? [foldReading(text)] : []);
      alts = list.filter((a) => { const f = foldReading(a); if (!f || seen.has(f)) return false; seen.add(f); return true; });
      if (alts.length > LIM.alts) {
        for (const x of alts.slice(LIM.alts)) note('altsMax', `다른 읽기는 ${LIM.alts}개까지라 앞의 ${LIM.alts}개만 넣었어요 — 뺀 읽기`, x);
        alts = alts.slice(0, LIM.alts);
      }
    }
    input.alts = alts;

    // --- note, tag, type, reading, source
    let n = got.note;
    if (Array.isArray(n)) { n = n.map(str).map((x) => x.trim()).filter(Boolean).join(' / '); note('noteArray', '메모 목록([ … ])을 「 / 」로 이어 붙였어요'); }
    else n = str(n);
    if (n) aliasNote('note', 'note');
    input.note = n.trim();
    let tag = got.tag;
    if (Array.isArray(tag)) {
      const tags = tag.map(str).map((x) => x.trim()).filter(Boolean);
      tag = tags[0] || '';
      if (tags.length > 1) note('tagArray', '태그는 하나만 넣을 수 있어서 첫 번째 태그만 넣었어요');
    } else tag = str(tag);
    if (tag) aliasNote('tag', 'tag');
    input.tag = tag.trim();
    const ty = str(got.type).trim();
    const tyF = fold(ty);
    if (tyHint === 'sentence') input.type = 'sentence';
    else if (tyHint === 'word') {
      input.type = 'word';
      if (tyF !== 'word') note('typePos', 'type의 품사(noun·verb …)는 단어(word)로 읽었어요');
    } else {
      input.type = '';
      if (ty && !POS_AUTO.has(tyF)) note('typeAuto', 'type을 알 수 없어서(「' + ty + '」 …) 단어/문장은 자동으로 정했어요');
    }
    if (reading && !readingIsKana) input.reading = reading;
    else {
      input.reading = '';
      if (readingIsKana && reading !== input.text && got.text) note('readingDropped', '「reading」의 가나는 text와 달라서 넣지 않았어요 (로마자 읽기만 넣는 칸이에요)');
    }
    if (got.romaji != null && str(got.romaji).trim()) note('romaji', '로마자(' + from.romaji + ') 칸은 넣지 않았어요 — 발음은 앱이 만들어요');
    input.source = str(got.source).trim();
    if (unknown.length) note('unknown:' + unknown.slice(0, 6).join(','), null);
    input._unknown = unknown;
    return { input, notes };
  }

  /* WordIO.read(input): the items of a pasted text / file text (or an already parsed value). */
  function read(input) {
    const out = { ok: false, items: [], notes: [], error: null, count: 0 };
    let found, used;
    if (typeof input === 'string') {
      let t = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
      if (!t.trim()) { out.error = '붙여 넣은 내용이 없어요.'; return out; }
      if (t.length > MAX_TEXT) { out.error = '내용이 너무 커요 (5 MB까지). 여러 번에 나눠서 가져와 주세요.'; return out; }
      // the prompt itself — alone, or copied together with the AI's answer (a whole conversation): its example is not
      // a word list to import
      const withPrompt = t.includes(PROMPT_HEAD);
      if (withPrompt) t = t.split(PROMPT).join('\n').split(EXAMPLE_JSON).join('\n');
      const x = extract(t);
      const exampleOnly = (wl) => wl.list.every((w) => isObj(w) && EXAMPLE_TEXTS.has(w.text));
      if (withPrompt) {
        x.found = x.found.filter((wl) => !exampleOnly(wl));
        x.blocks = x.found.length;
        x.errors = [];
        if (!x.found.length) { out.error = '붙여 넣은 내용은 AI에 줄 프롬프트예요. 이 프롬프트로 AI가 만들어 준 답(JSON)을 붙여 넣어 주세요.'; return out; }
      }
      if (!x.found.length) {
        if (x.error) out.error = `${x.error.line}번째 줄 근처에서 JSON을 읽지 못했어요 — ${PARSE_WHAT[x.error.what] || PARSE_WHAT.value}.`;
        else out.error = /[{[]/.test(t) ? '단어 목록(words)을 찾지 못했어요. 위의 형식대로 { "format": "kana-practice-words", "v": 1, "words": [ … ] } 를 붙여 넣어 주세요.'
          : 'JSON을 찾지 못했어요. 위의 프롬프트로 AI에게 단어 파일(JSON)을 먼저 만들어 달라고 해 보세요.';
        return out;
      }
      found = x.found;
      used = x.used;
      if (x.blocks > 1) out.notes.push(`JSON ${x.blocks}개를 이어서 읽었어요.`);
      for (const e of x.errors.slice(0, 3)) out.notes.push(`${e.line}번째 줄 근처는 읽지 못했어요 — ${PARSE_WHAT[e.what] || PARSE_WHAT.value}. 그 부분의 단어는 빠졌어요.`);
    } else {
      const wl = wordList(input);
      if (!wl) { out.error = '단어 목록(words)을 찾지 못했어요.'; return out; }
      found = [wl];
      used = new Set();
    }
    for (const k of ['fence', 'gap', 'prose', 'truncated', 'ellipsis', 'comma', 'missingComma', 'quotes', 'single', 'keys', 'comments', 'newline', 'innerQuote', 'words', 'fullwidth']) {
      if (used.has(k)) out.notes.push(PARSE_NOTES[k]);
    }
    const envNotes = new Set();
    for (const wl of found) {
      if (wl.note) envNotes.add(wl.note);
      const env = wl.envelope;
      if (env && has(env, 'format') && env.format !== FORMAT) envNotes.add(`format이 "${FORMAT}"가 아니지만(${String(env.format).slice(0, 40)}) 단어 목록을 읽었어요.`);
      if (env && typeof env.v === 'number' && env.v > VERSION) envNotes.add(`더 새로운 형식(v${env.v})이에요. 이 버전이 아는 칸만 읽었어요.`);
    }
    envNotes.forEach((n) => out.notes.push(n));
    const agg = new Map();
    const unknown = new Map();
    let index = 0, full = false;
    for (const wl of found) {
      for (const raw of wl.list) {
        if (index >= MAX_ITEMS) { full = true; break; }
        const r = normalizeItem(raw, index++);
        out.items.push(r.input);
        const seen = new Set();
        for (const [key, label, ex] of r.notes) {
          if (key.startsWith('unknown:')) continue;
          let a = agg.get(key);
          if (!a) agg.set(key, a = { label, n: 0, ex: [] });
          if (!seen.has(key)) { a.n++; seen.add(key); }
          if (ex && a.ex.length < 4 && !a.ex.includes(ex)) a.ex.push(ex);
        }
        for (const k of r.input._unknown || []) unknown.set(k, (unknown.get(k) || 0) + 1);
        delete r.input._unknown;
      }
    }
    if (full) out.notes.push(`항목이 너무 많아서 처음 ${MAX_ITEMS}개만 읽었어요.`);
    const exList = (ex) => (ex.length ? ': ' + ex.slice(0, 3).join(', ') + (ex.length > 3 ? ' …' : '') : '');
    for (const { label, n, ex } of agg.values()) out.notes.push(label + exList(ex) + (out.items.length > 1 ? ` (${n}개)` : '') + '.');
    // what the format allows but the learner should know (these items import as they are)
    const warn = (list, msg) => { if (list.length) out.notes.push(msg(list.length) + exList(Array.from(new Set(list.map((x) => cutShort(x, 20))))) + '.'); };
    const fine = out.items.filter((x) => !x._problem && x.text);
    warn(fine.filter((x) => x.meaning && !/[가-힣]/.test(x.meaning)).map((x) => x.meaning),
      (n) => `뜻에 한글이 없는 항목이 ${n}개 있어요. 뜻 맞히기는 한국어로 답하니, AI에게 「뜻은 한국어로 써 줘」라고 다시 부탁해 보세요`);
    warn(fine.filter((x) => !x.meaning).map((x) => x.kanji || x.text),
      (n) => `뜻이 비어 있는 항목이 ${n}개 있어요. 그대로 넣을 수 있지만 뜻 맞히기에는 뜻이 필요해요`);
    warn(fine.filter((x) => /^[ぁ-ゖー]+$/.test(x.text) && x.text.includes('ー')).map((x) => x.text),
      (n) => `ー가 들어간 히라가나 단어가 ${n}개 있어요. 가타카나로 쓰는 말(외래어)이면 가타카나로 고쳐 주세요`);
    if (unknown.size) {
      const names = Array.from(unknown.keys());
      out.notes.push(`모르는 칸은 넣지 않았어요: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ' …' : ''}.`);
    }
    out.count = out.items.length;
    out.ok = true;
    if (!out.items.length) { out.ok = false; out.error = '단어 목록이 비어 있어요.'; }
    return out;
  }

  /* =================================================================== identity */

  const NOISE = /[\s、。，．,.!?！？・]/g;
  function foldReading(s) {
    const T = KT();
    const n = T ? T.normalize(s) : String(s || '').normalize('NFC');
    return (T ? T.toHiragana(n) : n).replace(NOISE, '');
  }
  function kanjiKey(e) {
    const k = e && e.kanji ? String(e.kanji) : '';
    if (!k) return '';
    const T = KT();
    return (T ? T.normalize(k) : k.normalize('NFC')).replace(NOISE, '');
  }
  function readingKeys(e) {
    const out = [];
    for (const r of [e && e.text].concat(e && Array.isArray(e.alts) ? e.alts : [])) {
      const f = r ? foldReading(r) : '';
      if (f && !out.includes(f)) out.push(f);
    }
    return out;
  }
  function splitM(m) {
    const T = KT();
    const s = String(m == null ? '' : m);
    return T ? T.splitMeanings(s) : s.split(/[,/;·]/).map((x) => x.trim()).filter(Boolean);
  }
  // Is meaning m (one listed meaning) already in the list `all`? Bracketed notes and a leading ~particle do not count
  // (나 (주로 남성이 사용) ≈ 나), as in 뜻 맞히기.
  function covers(all, m) {
    const T = KT();
    if (!T) return splitM(all).some((x) => x.replace(/\s/g, '') === String(m).replace(/\s/g, ''));
    if (T.checkMeaning(m, all).correct) return true;
    return splitM(all).some((x) => T.checkMeaning(x, m).correct);
  }
  // one meaning folded for comparing: bracketed notes dropped, spaces / punctuation squashed (나 (주로 남성) → 나)
  const BRACKETS = /\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}|（[^（）]*）|【[^【】]*】|〔[^〔〕]*〕/g;
  const normM = (m) => {
    const t = String(m).normalize('NFKC').toLowerCase();
    return (t.replace(BRACKETS, ' ').replace(/[\s\p{P}\p{S}]/gu, '') || t.replace(/[\s\p{P}\p{S}]/gu, ''));
  };
  /* Do two meaning lists share a meaning? true / false, or null when either side has none. Bracketed notes and a
   * leading ~particle do not count (as in 뜻 맞히기). loose: a meaning of ≥ 2 letters inside another counts too
   * (학생 / 대학생) — used where the readings already agree and the meaning only tells homophones apart (橋 다리 /
   * 箸 젓가락); not between two readings of one kanji (一日: ついたち 초하루 / いちにち 하루 are different words). */
  function meaningsOverlap(a, b, loose) {
    const la = splitM(a), lb = splitM(b);
    if (!la.length || !lb.length) return null;
    const jb = lb.join(', ');
    if (la.some((m) => covers(jb, m))) return true;
    if (!loose) return false;
    const na = la.map(normM).filter((x) => x.length >= 2), nb = lb.map(normM).filter((x) => x.length >= 2);
    // one inside the other (학생 / 대학생), or the same first two letters (미국인 / 미국 사람)
    return na.some((x) => nb.some((y) => x.includes(y) || y.includes(x) || x.slice(0, 2) === y.slice(0, 2)));
  }
  function sharesReading(a, b) {
    const rb = readingKeys(b);
    return readingKeys(a).some((r) => rb.includes(r));
  }

  // Two kanji forms of one word written with more or less kana (ご飯 / 御飯, 受付 / 受け付け, 水をください。/ 水を下さい。):
  // the kanji of one, in order, are among the kanji of the other. Homophones never pass (橋 / 箸, 日本 / 二本, 会う / 合う).
  function kanjiVariant(ka, kb) {
    const ia = Array.from(ka).filter((ch) => hasIdeo(ch)), ib = Array.from(kb).filter((ch) => hasIdeo(ch));
    if (!ia.length || !ib.length) return false;
    const sub = (x, y) => { let i = 0; for (const ch of y) if (ch === x[i]) i++; return i === x.length; };
    return sub(ia, ib) || sub(ib, ia);
  }

  /* ctx (optional): { kanjiReadings: Set } — the readings (folded) that some entry WITH a kanji form has, in the book and
   * the file being read. Two kana-only entries sharing a reading are one card face; with no kanji word of that reading
   * around they are the same word whatever the glosses say (はい 네 / はい 예, あなた 당신 / 너 — the meanings are joined).
   * With a kanji word of that reading around (はし and 橋 / 箸), or without ctx, glosses that share nothing keep them apart
   * ('maybe'), so a joined かみ 종이, 신 never hands 紙 the meaning 신. */
  function sameWord(a, b, ctx) {
    if (!a || !b) return false;
    const ka = kanjiKey(a), kb = kanjiKey(b);
    const shared = sharesReading(a, b);
    if (ka && kb) {
      // other kanji: another word (橋 ≠ 箸) — unless it is the same reading written with more or less kana
      if (ka !== kb) return shared && kanjiVariant(ka, kb) ? 'sure' : false;
      if (shared) return 'sure';
      return meaningsOverlap(a.meaning, b.meaning, false) === false ? 'maybe' : 'sure';
    }
    if (!shared) return false;
    if (meaningsOverlap(a.meaning, b.meaning, true) !== false) return 'sure';
    if (!ka && !kb && ctx && ctx.kanjiReadings) {
      const rb = readingKeys(b);
      if (!readingKeys(a).some((r) => rb.includes(r) && ctx.kanjiReadings.has(r))) return 'sure';
    }
    return homophoneProne(a, b) ? 'maybe' : 'sure';
  }
  // The readings of the entries that have a kanji form (sameWord's ctx.kanjiReadings), added to `into` when given.
  function kanjiReadings(entries, into) {
    const set = into || new Set();
    for (const e of entries || []) if (e && kanjiKey(e)) for (const r of readingKeys(e)) set.add(r);
    return set;
  }
  // Homophones are short words (はし, かみ, こうこう, かんせい): two entries reading the same with meanings that share
  // nothing are only 'maybe' the same word when the reading is ≤ 6 letters, neither is a sentence and neither is a
  // katakana word (テスト 시험 / てすと 테스트 is one word; so is a sentence written with other spacing).
  function homophoneProne(a, b) {
    const sentence = (e) => e.type === 'sentence' || /[、。\s]/.test(String(e.text || '').trim());
    const kata = (e) => /^[ァ-ヺー・]+$/.test(String(e.text || '').replace(/\s/g, ''));
    if (sentence(a) || sentence(b) || kata(a) || kata(b)) return false;
    const rb = readingKeys(b);
    const shared = readingKeys(a).filter((r) => rb.includes(r));
    return shared.some((r) => Array.from(r).length <= 6);
  }

  // Bucketed lookup over entries (kanji key, each reading key). entries in preference order (oldest first).
  // extraKanjiReadings: readings of kanji words outside these entries (the file being imported) for sameWord's ctx.
  function makeIndex(entries, extraKanjiReadings) {
    const by = new Map();
    const put = (k, i) => { let a = by.get(k); if (!a) by.set(k, a = []); a.push(i); };
    const list = entries || [];
    list.forEach((e, i) => {
      const kk = kanjiKey(e);
      if (kk) put('k\u0000' + kk, i);
      for (const r of readingKeys(e)) put('r\u0000' + r, i);
    });
    const ctx = { kanjiReadings: kanjiReadings(list, new Set(extraKanjiReadings || [])) };
    return {
      entries: list,
      ctx,
      candidates(e) {
        const set = new Set();
        const kk = kanjiKey(e);
        if (kk) for (const i of by.get('k\u0000' + kk) || []) set.add(i);
        for (const r of readingKeys(e)) for (const i of by.get('r\u0000' + r) || []) set.add(i);
        return Array.from(set).sort((x, y) => x - y);
      },
      keys: () => by,
    };
  }

  /* The existing entry an incoming one merges into → { target: i | -1, maybe: [i], ambiguous: [i] }.
   * Several sure matches: with a kanji form — the same kanji sharing a reading, then the same kanji, then the oldest;
   * kana only — the kanji forms among them decide: one (kana-only matches aside) → the oldest of it; several → the one
   * whose meaning overlaps; still several → ambiguous (no target: the item is added as a word of its own). */
  function findTarget(index, e) {
    const sure = [], maybe = [];
    for (const i of index.candidates(e)) {
      const s = sameWord(e, index.entries[i], index.ctx);
      if (s === 'sure') sure.push(i); else if (s === 'maybe') maybe.push(i);
    }
    const E = index.entries;
    if (sure.length <= 1) return { target: sure.length ? sure[0] : -1, maybe, ambiguous: [] };
    const kk = kanjiKey(e);
    if (kk) {
      const same = sure.filter((i) => kanjiKey(E[i]) === kk);
      const shared = same.filter((i) => sharesReading(e, E[i]));
      return { target: (shared[0] != null ? shared[0] : same[0] != null ? same[0] : sure[0]), maybe, ambiguous: [] };
    }
    const forms = (list) => Array.from(new Set(list.map((i) => kanjiKey(E[i])).filter(Boolean)));
    let pick = sure;
    if (forms(pick).length > 1) {
      pick = sure.filter((i) => meaningsOverlap(e.meaning, E[i].meaning, true) === true);
      if (forms(pick).length !== 1) return { target: -1, maybe, ambiguous: sure };
    }
    const f = forms(pick);
    const withKanji = f.length ? pick.filter((i) => kanjiKey(E[i]) === f[0]) : pick;
    return { target: withKanji[0], maybe, ambiguous: [] };
  }

  /* Groups of the same word among entries (in preference order: the first member of a group is the one kept).
   * → { groups: [[i, …]] (every index once, groups ordered by their first member), maybe: [[gA, gB]] (indices into
   * groups: pairs that may be the same word — never merged by themselves) }.
   * Kanji forms group first (same kanji, sure), then kana-only entries among themselves, then each kana-only group
   * joins the one kanji group it is surely the same word as (meaning overlap breaks a tie; otherwise it stays apart). */
  function groupEntries(entries, extraKanjiReadings) {
    const E = entries || [];
    const ctx = { kanjiReadings: kanjiReadings(E, new Set(extraKanjiReadings || [])) };
    const n = E.length;
    const parent = E.map((_, i) => i);
    const rep = E.map((e) => ({ text: e.text, kanji: e.kanji || '', alts: Array.isArray(e.alts) ? e.alts.slice() : [], meaning: e.meaning || '' }));
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const unite = (a, b) => {
      let ra = find(a), rb = find(b);
      if (ra === rb) return;
      if (rb < ra) { const t = ra; ra = rb; rb = t; }
      parent[rb] = ra;
      const A = rep[ra], B = rep[rb];
      A.kanji = A.kanji || B.kanji;
      for (const r of [B.text].concat(B.alts)) if (r && !A.alts.includes(r) && r !== A.text) A.alts.push(r);
      for (const m of splitM(B.meaning)) if (!covers(A.meaning, m)) A.meaning = A.meaning ? A.meaning + ', ' + m : m;
    };
    const idx = makeIndex(E);
    const buckets = Array.from(idx.keys().entries());
    const pass = (prefix, ok) => {
      for (let round = 0; round < n + 1; round++) {
        let changed = false;
        for (const [key, members] of buckets) {
          if (!key.startsWith(prefix)) continue;
          const roots = Array.from(new Set(members.filter(ok).map(find))).sort((x, y) => x - y);
          for (let x = 0; x < roots.length; x++) {
            for (let y = x + 1; y < roots.length; y++) {
              const a = find(roots[x]), b = find(roots[y]);
              if (a === b) continue;
              if (sameWord(rep[a], rep[b], ctx) === 'sure') { unite(a, b); changed = true; }
            }
          }
        }
        if (!changed) break;
      }
    };
    const withKanji = (i) => !!kanjiKey(E[i]);
    pass('k\u0000', withKanji);                          // 1. same kanji form
    pass('r\u0000', withKanji);                          //    and the same reading in another spelling (ご飯 / 御飯)
    pass('r\u0000', (i) => !withKanji(i));               // 2. kana-only entries among themselves
    // 3. each kana-only group joins the kanji group it surely is
    const kanaRoots = Array.from(new Set(E.map((_, i) => i).filter((i) => !withKanji(i)).map(find))).filter((r) => !kanjiKey(rep[r]));
    for (const g of kanaRoots) {
      const cands = new Set();
      for (let i = 0; i < n; i++) {
        if (find(i) !== g) continue;
        for (const j of idx.candidates(E[i])) if (withKanji(j)) cands.add(find(j));
      }
      let sure = Array.from(cands).filter((R) => sameWord(rep[R], rep[g], ctx) === 'sure').sort((x, y) => x - y);
      if (sure.length > 1) {
        const forms = new Set(sure.map((R) => kanjiKey(rep[R])));
        if (forms.size > 1) sure = sure.filter((R) => meaningsOverlap(rep[R].meaning, rep[g].meaning, true) === true);
        const forms2 = new Set(sure.map((R) => kanjiKey(rep[R])));
        if (forms2.size !== 1) continue;
      }
      if (sure.length) unite(sure[0], g);
    }
    const order = [];
    const members = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!members.has(r)) { members.set(r, []); order.push(r); }
      members.get(r).push(i);
    }
    const gOf = new Map(order.map((r, k) => [r, k]));
    // suggestions only (never merged by themselves): at most MAYBE_MAX pairs, none from a crowded bucket
    const maybe = [], seen = new Set();
    for (const [, list] of buckets) {
      const roots = Array.from(new Set(list.map(find))).sort((x, y) => x - y);
      if (roots.length > 40 || maybe.length >= MAYBE_MAX) continue;
      for (let x = 0; x < roots.length && maybe.length < MAYBE_MAX; x++) {
        for (let y = x + 1; y < roots.length; y++) {
          const a = roots[x], b = roots[y];
          const key = a + ':' + b;
          if (seen.has(key)) continue;
          seen.add(key);
          if (sameWord(rep[a], rep[b], ctx)) maybe.push([gOf.get(a), gOf.get(b)]);
        }
      }
    }
    maybe.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    return { groups: order.map((r) => members.get(r)), maybe };
  }

  /* =================================================================== merging two entries' content */

  const CONTENT = ['text', 'kanji', 'alts', 'meaning', 'type', 'tag', 'note', 'reading', 'source'];
  const pickContent = (e) => {
    const o = {};
    for (const f of CONTENT) o[f] = f === 'alts' ? (Array.isArray(e && e.alts) ? e.alts.slice() : []) : str(e && e[f]);
    return o;
  };

  // readings to keep as alts: list in order, without the text and without readings equal to one already there (in
  // hiragana: テスト has no alt てすと); → { alts, dropped } with at most 5
  function altsFor(text, list) {
    const seen = new Set([foldReading(text)]);
    const out = [], dropped = [];
    for (const r of list) {
      if (!r) continue;
      const f = foldReading(r);
      if (!f || seen.has(f)) continue;
      seen.add(f);
      if (out.length < LIM.alts) out.push(r); else dropped.push(r);
    }
    return { alts: out, dropped };
  }

  // meaning b's meanings added to a (a's own wording kept; only what a does not cover is appended with ', ')
  function unionMeaning(a, b) {
    const A = str(a).trim(), B = str(b).trim();
    if (!B) return { value: A, dropped: [] };
    if (!A && chars(B) <= LIM.meaning) return { value: B, dropped: [] };
    let v = A;
    const dropped = [];
    for (const m of splitM(B)) {
      if (v && covers(v, m)) continue;
      const next = v ? v + ', ' + m : m;
      if (chars(next) <= LIM.meaning) v = next; else dropped.push(m);
    }
    return { value: v, dropped };
  }

  function unionNote(a, b) {
    const A = str(a).trim(), B = str(b).trim();
    if (!B || A === B) return { value: A, dropped: false };
    if (!A) return { value: B, dropped: false };
    const squash = (s) => s.replace(/\s+/g, '');
    if (squash(A).includes(squash(B))) return { value: A, dropped: false };
    const next = A + ' / ' + B;
    return chars(next) <= LIM.note ? { value: next, dropped: false } : { value: A, dropped: true };
  }

  /* base ⊕ incoming → { value, dropped: { alts: [..], meaning: [..], note: bool } }
   *   merge     — base's kana text stays (incoming readings that differ in hiragana become alts, ≤ 5), kanji form kept
   *               (or taken when base has none), meanings unioned (base's wording first), base's note kept and the
   *               incoming one appended with ' / ' when different, tag / reading / source / type kept unless empty (the
   *               예시 tag yields to a real one).
   *   overwrite — every field the incoming entry fills replaces base's; empty fields keep base's. alts: incoming
   *               alts when given, else base's readings the new text does not cover. typeGiven: incoming type explicit. */
  function mergeContent(base, inc, opts) {
    const o = opts || {};
    const B = pickContent(base), I = pickContent(inc);
    const dropped = { alts: [], meaning: [], note: false };
    const v = Object.assign({}, B);
    if (o.mode === 'overwrite') {
      for (const f of ['text', 'kanji', 'meaning', 'tag', 'note', 'reading', 'source']) if (I[f]) v[f] = I[f];
      if (o.typeGiven !== false && I.type) v.type = I.type;
      const a = I.alts.length ? altsFor(v.text, I.alts) : altsFor(v.text, [B.text].concat(B.alts));
      v.alts = a.alts;
      dropped.alts = a.dropped;
      return { value: v, dropped };
    }
    v.kanji = B.kanji || I.kanji;
    // こーひー (a katakana word written in hiragana: the reader warns about it) gives way to コーヒー
    if (/^[ぁ-ゖー\s、。]+$/.test(B.text) && B.text.includes('ー') && /[ァ-ヺ]/.test(I.text) && foldReading(B.text) === foldReading(I.text)) v.text = I.text;
    const a = altsFor(v.text, B.alts.concat([I.text], I.alts));
    v.alts = a.alts;
    dropped.alts = a.dropped;
    const m = unionMeaning(B.meaning, I.meaning);
    v.meaning = m.value;
    dropped.meaning = m.dropped;
    const nt = unionNote(B.note, I.note);
    v.note = nt.value;
    dropped.note = nt.dropped;
    v.tag = B.tag && !(B.tag === EXAMPLE_TAG && I.tag) ? B.tag : (I.tag || B.tag);
    v.reading = B.reading || I.reading;
    v.source = B.source || I.source;
    v.type = B.type || I.type;
    return { value: v, dropped };
  }

  /* Field changes from before to after (both content objects) → [{ field, kind: 'set'|'add'|'replace'|'clear',
   * before, after, added?: [..], removed?: [..] }] in field order. */
  function diffContent(before, after) {
    const B = pickContent(before), A = pickContent(after);
    const out = [];
    for (const f of CONTENT) {
      if (f === 'alts') {
        const added = A.alts.filter((x) => !B.alts.includes(x)), removed = B.alts.filter((x) => !A.alts.includes(x));
        if (added.length || removed.length) out.push({ field: f, kind: removed.length ? 'replace' : 'add', before: B.alts, after: A.alts, added, removed });
        continue;
      }
      const b = B[f], a = A[f];
      if (a === b) continue;
      if (!b) out.push({ field: f, kind: 'set', before: b, after: a });
      else if (!a) out.push({ field: f, kind: 'clear', before: b, after: a });
      else if (f === 'meaning' && a.startsWith(b + ', ')) out.push({ field: f, kind: 'add', before: b, after: a, added: splitM(a.slice(b.length + 2)) });
      else if (f === 'note' && a.startsWith(b + ' / ')) out.push({ field: f, kind: 'add', before: b, after: a, added: [a.slice(b.length + 3)] });
      else out.push({ field: f, kind: 'replace', before: b, after: a });
    }
    return out;
  }

  const FIELD_KO = { text: '가나', kanji: '한자 표기', alts: '다른 읽기', meaning: '뜻', type: '종류', tag: '태그', note: '메모', reading: '로마자 읽기', source: '출처' };
  const TYPE_KO = { word: '단어', sentence: '문장' };
  const cutShort = (s, n) => { const a = Array.from(String(s)); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
  function describeChange(c) {
    const name = FIELD_KO[c.field] || c.field;
    const val = (x) => (c.field === 'type' ? TYPE_KO[x] || x : cutShort(x, 28));
    if (c.field === 'alts') {
      const parts = [];
      if (c.added && c.added.length) parts.push('+ ' + c.added.join(' / '));
      if (c.removed && c.removed.length) parts.push('− ' + c.removed.join(' / '));
      return name + ' ' + parts.join(' ');
    }
    if (c.kind === 'add') return name + ' + ' + (c.added || []).map((x) => cutShort(x, 28)).join(', ');
    if (c.kind === 'set') return name + ' + ' + val(c.after);
    if (c.kind === 'clear') return name + ' 지움';
    return name + ' ' + val(c.before) + ' → ' + val(c.after);
  }

  /* =================================================================== problems (Korean, for the learner and the AI) */

  function charKind(ch) {
    const f = String(ch).normalize('NFKC');
    if (hasIdeo(ch)) return 'kanji';
    if (/[A-Za-z]/.test(f)) return 'latin';
    if (/[가-힣ㄱ-ㆎ]/.test(ch)) return 'hangul';
    if (/[0-9]/.test(f)) return 'digit';
    return 'other';
  }
  // KanaStore's { error, field, message, bad } for an item → one Korean sentence naming the field (for the AI too)
  function problemMessage(res, input) {
    const r = res || {};
    const it = input || {};
    const bad = Array.isArray(r.bad) ? r.bad : [];
    const list = bad.slice(0, 6).join(' ');
    if (r.field === 'text') {
      if (r.error === 'text' && !str(it.text).trim()) return 'text(가나 읽기)가 비어 있어요. 단어의 읽기를 히라가나·가타카나로 넣어 주세요.';
      const kinds = new Set(bad.map(charKind));
      const whole = str(it.text).trim();
      const shown = whole && chars(whole) <= 16 ? whole : list;     // 学生 / gakusei rather than 学 生 / g a k u s e i
      if (kinds.has('kanji')) return `text에 한자(${shown})가 있어요. text에는 가나 읽기를, kanji에는 한자 표기를 넣어 주세요.`;
      if (kinds.size === 1 && kinds.has('latin')) return `text에 로마자(${shown})가 있어요. 가나로 적어 주세요 (gakusei → がくせい).`;
      if (kinds.size === 1 && kinds.has('hangul')) return 'text에 한글이 있어요. text에는 가나만, 한국어 뜻은 meaning에 넣어 주세요.';
      if (kinds.size === 1 && kinds.has('digit')) return `text에 숫자(${list})가 있어요. 가나로 적어 주세요 (1 → いち).`;
      if (r.error === 'text' && bad.length) return `text에 쓸 수 없는 글자(${list})가 있어요. 가나와 ー 、 。, 띄어쓰기만 쓸 수 있어요.`;
      return 'text: ' + (r.message || '가나를 확인해 주세요.');
    }
    if (r.field === 'kanji') return 'kanji: ' + (r.message || '한자 표기를 확인해 주세요.') + (bad.length ? ` (${list})` : '');
    if (r.field === 'alts') {
      if (r.error === 'alts' && /5개/.test(r.message || '')) return 'alts: 다른 읽기는 5개까지만 넣을 수 있어요.';
      return 'alts: ' + (r.message || '다른 읽기를 확인해 주세요.');
    }
    if (r.field) return r.field + ': ' + (r.message || '');
    return r.message || '이 항목을 넣지 못했어요.';
  }

  function rawShort(raw) {
    let s;
    try { s = JSON.stringify(raw); } catch (e) { s = String(raw); }
    if (s === undefined) s = String(raw);
    return cutShort(s, 220);
  }

  // The problem list to paste back to the AI (problems: [{ index, message, raw, kind? }]) — without the words that did
  // not fit (kind 'limit': the word book is full, nothing the AI could fix)
  function problemsText(problems) {
    const list = (problems || []).filter((p) => p && p.kind !== 'limit');
    if (!list.length) return '';
    const lines = [
      '가나 연습장 단어장에 가져오다가 아래 항목에서 문제가 생겼어요.',
      `이 항목들만 규칙대로 고쳐서, 처음과 같은 형식({"format": "${FORMAT}", "v": 1, "words": [ … ]})의 JSON 코드 블록 하나로 다시 주세요.`,
      '',
    ];
    list.forEach((p, k) => {
      lines.push(`${k + 1}. ${p.index >= 0 ? p.index + 1 + '번째 항목' : '항목'} ${p.raw !== undefined ? rawShort(p.raw) : ''}`.trimEnd());
      lines.push('   → ' + p.message);
    });
    return lines.join('\n');
  }

  /* =================================================================== the AI prompt (docs/WORDS-FORMAT.md) */

  const EXAMPLE = {
    format: FORMAT, v: VERSION,
    words: [
      { text: 'がくせい', kanji: '学生', meaning: '학생', type: 'word', tag: '1과' },
      { text: 'たべる', kanji: '食べる', meaning: '먹다', type: 'word', tag: '1과' },
      { text: 'なに', kanji: '何', alts: ['なん'], meaning: '무엇', type: 'word', tag: '1과', note: '뒤에 오는 소리에 따라 なん으로도 읽어요' },
      { text: 'コーヒー', meaning: '커피', type: 'word', tag: '1과' },
      { text: 'アメリカじん', kanji: 'アメリカ人', meaning: '미국인, 미국 사람', type: 'word', tag: '1과' },
      { text: 'みずを ください。', kanji: '水をください。', meaning: '물 주세요', type: 'sentence', tag: '1과' },
      { text: 'トイレは どこですか。', meaning: '화장실은 어디예요?', type: 'sentence', tag: '1과' },
    ],
  };
  const EXAMPLE_JSON = '{\n  "format": "' + FORMAT + '",\n  "v": 1,\n  "words": [\n'
    + EXAMPLE.words.map((w) => '    ' + JSON.stringify(w).replace(/":/g, '": ').replace(/,"/g, ', "')).join(',\n') + '\n  ]\n}';
  const EXAMPLE_TEXTS = new Set(EXAMPLE.words.map((w) => w.text));
  const PER_BLOCK = 100;

  const PROMPT = [
    PROMPT_HEAD,
    '',
    '[형식]',
    '{ "format": "kana-practice-words", "v": 1, "words": [ 단어, 단어, … ] }',
    '단어 하나 = { "text": …, "kanji": …, "alts": […], "meaning": …, "type": …, "tag": …, "note": … }',
    '',
    '[칸 규칙]',
    '- text (꼭): 가나로 쓴 읽기 하나(120자까지). 히라가나·가타카나, 장음 ー, 、 。, 띄어쓰기만 써요. 한자·로마자·한글·숫자는 넣지 않아요.',
    '  · 한자가 들어간 말은 읽기를 히라가나로: 学生 → "がくせい", 食べる → "たべる".',
    '  · 가타카나 단어는 가타카나 그대로: "コーヒー", "テスト". 가타카나와 한자가 섞이면 가타카나는 두고 한자 부분만 히라가나로: アメリカ人 → "アメリカじん".',
    '  · 작은 글자(っ ゃ ゅ ょ ぁ ぃ ぅ ぇ ぉ)와 장음 ー를 정확히: がっこう, きょう, ラーメン. 숫자는 읽기로: 1年生 → "いちねんせい".',
    '  · 문장은 조사 뒤를 한 칸 띄어 쓰고 끝은 。로: "わたしは がくせいです。" ？ ！ 「 」 〜 … ( ) / 같은 기호는 쓰지 않아요: どこですか？ → "どこですか。"',
    '  · 읽기가 여럿이면 가장 흔한 하나만 text에, 나머지는 alts에 넣어요 ("なに/なん"처럼 잇지 않아요).',
    '- kanji: 한자가 들어간 표기(送り仮名 포함, 60자까지) — 学生, 食べる, 水をください。 한자가 하나도 없는 말(コーヒー, ありがとう, トイレはどこですか。)은 kanji를 빼요.',
    '- alts: 같은 단어의 다른 읽기(가나)를 목록으로, 5개까지 — 何: text "なに", alts ["なん"]. 히라가나/가타카나로만 다른 표기는 넣지 않아요. 없으면 빼요.',
    '- meaning (꼭): 한국어 뜻(200자까지, 영어가 아니라 한국어로). 뜻이 여러 개면 ", "로 구분 — "먹다, 먹음". 쉼표는 뜻과 뜻 사이에만 써요: 문장의 뜻은 쉼표 없이 한 문장으로. 짧은 설명은 괄호로 — "나 (주로 남성이 사용)".',
    '- type: 단어와 짧은 인사말은 "word", 문장은 "sentence".',
    '- tag: 과·주제 이름 하나(30자 이내) — "3과", "음식". 목록에 단원이나 주제 구분이 있으면 그것을 써요. 없으면 빼요.',
    '- note: 짧은 한국어 메모(선택) — "숫자로 쓰면 1年生", "가타카나로도 써요".',
    '- 로마자, 품사, id, 날짜 같은 다른 칸은 넣지 않아요.',
    '',
    '[출력 규칙]',
    '1. 목록에 있는 일본어 단어·문장만, 목록 순서대로, 빠짐없이 넣어요. 새 단어를 지어내거나 "..."로 줄이지 않아요.',
    '2. 일본어가 아닌 줄(제목, 설명, 쪽 번호 등)은 건너뛰어요. 같은 단어가 두 번 나오면 한 번만 넣어요.',
    '3. 목록에 읽기나 뜻이 없으면 가장 흔한 읽기와 뜻을 넣고, 확실하지 않으면 note에 "읽기 확인 필요"라고 적어요.',
    '4. 답은 JSON만, ```json 코드 블록 하나에 담아요. 앞뒤 설명은 쓰지 않아요.',
    `5. 단어가 ${PER_BLOCK}개보다 많으면 한 번에 ${PER_BLOCK}개씩만 주세요: 위 형식 전체({ "format": …, "words": [ … ] })로 된 블록 하나를 주고, 블록 아래에 "1–${PER_BLOCK} / 250"처럼 어디까지 했는지만 적어요. 제가 "계속"이라고 하면 다음 ${PER_BLOCK}개를 같은 형식으로 주세요.`,
    '',
    '[예시]',
    '입력:',
    '1과',
    '学生 がくせい 학생 / 食べる 먹다 / 何 なに·なん 무엇 / コーヒー 커피 / アメリカ人 미국인 / 水をください。 물 주세요 / トイレはどこですか？ 화장실은 어디예요?',
    '',
    '출력:',
    '```json',
    EXAMPLE_JSON,
    '```',
    '',
    '[단어 목록]',
    '(여기에 단어 목록을 붙여 넣거나, 목록 사진·파일을 함께 올려 주세요)',
  ].join('\n');

  return {
    FORMAT, VERSION, LIMITS: LIM, EXAMPLE_TAG, PROMPT, EXAMPLE, EXAMPLE_JSON,
    read, normalizeItem, extract, parseLenient, scanSpan,
    foldReading, kanjiKey, readingKeys, meaningsOverlap, sharesReading, sameWord, kanjiReadings, makeIndex, findTarget, groupEntries,
    mergeContent, unionMeaning, altsFor, diffContent, describeChange, problemMessage, problemsText,
  };
});
