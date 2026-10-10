# Kana Practice (가나 연습장)

A browser app for learning Japanese hiragana and katakana by handwriting them with a stylus or finger.

**Live:** https://2-mean.github.io/kana-practice/

The interface is in Korean.

## Features

- **Reading test**: a kana is shown and you type its pronunciation (romaji or Hangul).
- **Writing test**: a pronunciation is shown and you draw the kana. Hiragana, katakana, or both mixed.
- **Stroke checking**: stroke order, direction and stroke count are checked. A correct shape written with the wrong stroke order is marked △, separately from ○ (correct) and ✕ (wrong).
- **Look-alike detection**: similar characters (シ/ツ, ソ/ン, ぬ/め, ね/れ/わ, る/ろ and others) are told apart by their distinguishing features. Errors are explained and highlighted on the drawing.
- **Variant stroke forms**: both accepted forms of さ, き, そ, ふ and り are recognized.
- **Kana chart**: each character has an animated stroke order and a comparison with look-alikes. The chart is also available during tests.
- **Endless mode**: characters you missed come back more often.
- **Word book**:
  - Add your own words and sentences.
  - Write them on manuscript-style grid cells from a Korean prompt, in hiragana or with kanji.
  - Practice kanji readings and meanings.
  - Load a built-in list of 172 basic words.

## Notes

- Everything runs in the browser; there is no server.
- Progress and the word book are saved in each browser's local storage. Clearing site data removes them, and they are not synced between devices.
- Handwriting recognition is template-based: kana strokes are judged against KanjiVG stroke data, and kanji are checked against the 2,136 Jōyō kanji.

See [NOTICE.md](NOTICE.md) for data sources and licenses.
