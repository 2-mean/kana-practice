/* KanaRecognizer — handwriting judge of the writing test (docs/SPEC.md "Recognizer API").
 * Shape matching (candidate B + grafts, see Provenance) with key points (판별 포인트): KP-A's automatic per-stroke
 * checkpoints plus three pair rules grafted from KP-B (tools/bench/RESULTS.md, "Key points").
 *
 *   KanaRecognizer.judge(strokes, target, opts?)  → JudgeResult (+ keypoints, see below)
 *   KanaRecognizer.recognize(strokes, opts?)      → { candidates: [{ ch, variantId, score }] }
 *   KanaRecognizer.keypoints(ch, variantId?)      → { ch, variantId, points } (no hit; the chart's '구별 포인트';
 *                                                   unknown ch throws, unknown variantId → the first form)
 *   opts = { strictness: 'lenient' | 'normal' (default) | 'strict', pool: [chars to compare against],
 *            box: { x, y, w, h } (one 원고지 cell, in the strokes' coordinates: box mode, docs/SPEC-words.md D) }
 *   target = a key of KANA_DATA.kana or KANA_DATA.extra (small kana, ヴ, ー 、 。)
 *
 * Key-point contract (additive to JudgeResult; consumers must tolerate its absence; docs/SPEC.md "JudgeResult")
 *   result.keypoints = null (empty input, too many strokes) or {
 *     ch, variantId,                    // the target and the form the drawing was measured against
 *     points: [{ id,                    // 'loop2', 'cross1-2', 'dot2-1', 'corner2b' … (kind + template stroke numbers),
 *                                       //   unique and stable per character and form
 *                stroke,                // template stroke index (0-based; for a pair of strokes the first one)
 *                x, y,                  // where the point is, in the template's 109 box (KANA_DATA coordinates)
 *                kind,                  // 'start'|'end'|'corner'|'loop'|'hook'|'dot'|'cross'|'direction'|'count'|'feature'
 *                label,                 // short Korean, e.g. '2번째 획 끝의 작은 고리', '1번째 획과 2번째 획의 교차'
 *                critical,              // the point distinguishes the target from a look-alike …
 *                against,               // … these look-alikes (non-empty exactly when critical)
 *                hit }],                // true | false | null (not judged: the stroke is not in the drawing, or the
 *                                       //   drawing was matched with a same-shape / small-big twin's form)
 *     failed: [ids] }                   // the points with hit === false (critical: on a look-alike's side)
 *   result.notes (additive, always an array): [{ type: 'twin', message }] when a drawing of り / リ looked like the other
 *   script's form (り: and its left stroke has no clear flick, which the note asks for; accepted all the same: verdict,
 *   issues and grade never change; KANA_DATA kana[ch].twinNote), else [].
 *   A drawing whose shape was accepted but that misses a critical point where a look-alike explains it better →
 *   verdict 'wrong', recognized = confusedWith = that look-alike (crossScript when it is the other-script pair),
 *   variantId null, reversed / orderErrors / structure.misplaced empty, issues [{ type: 'keypoint', message:
 *   'ぬ의 포인트: 2번째 획 끝에 작은 고리를 만들어요. 지금은 め처럼 보여요.' }] (+ the 'script' issue for a pair). A
 *   drawing the shape match already rejects as a look-alike gets the same kind of 'keypoint' issue after its
 *   'lookalike' one when a point explains it — first the stroke count when only the look-alike has the drawing's
 *   ('タ의 포인트: 3번째 획을 빠뜨리지 말고 써요.', 'は에는 ほ의 2번째 획이 없어요.', 'シ는 3획으로 써요.'), else the
 *   missed point, measured with strokes drawn the other way round giving their direction too (and keypoints with
 *   it). A ○ / △ may still list a failed point (informational: too little evidence). Box mode: when the size
 *   rules change the character (a big kana drawn clearly small, a small kana drawn big) they come first, also
 *   over a key-point ✕ (a small ウ is ゥ whatever its dot looks like at that size).
 *
 * How the key points work (section "Key points" below; derived from KanjiVG, nothing hand-written but the wording)
 *   - Checkpoints per template stroke: start / end (registered position), corner (sharp turn), loop (self-crossing
 *     or end curl ≥ 0.8 turn: turning over a stretch of the stroke, plus a closure check — does the stroke come back
 *     onto itself there, the self-intersection test; reported, not weighed), hook (how the last part turns), dot (where a
 *     short stroke sits next to its nearest stroke), direction (start → end as drawn), feature (length next to the
 *     longest other stroke), cross (how two strokes that come close meet: arc on each side of the meeting point
 *     and the gap; an X, a T junction, stopping at / sticking out past, apart) and count (a stroke a look-alike
 *     lacks). Each look-alike's templates are aligned to the target's exactly like a drawing; its own loops,
 *     corners and meeting strokes where the target has none become checkpoints too ("no loop here").
 *   - A checkpoint is critical against C when the target's and C's measurements differ by ≥ KP.CRIT σ (σ per kind,
 *     calibrated on rough-dev roughCorrect). 142 kana → ~2000 checkpoints, built lazily per form (~3 ms each).
 *   - A drawing is measured on the part of it that the alignment (and a DTW correspondence along each stroke) puts
 *     on each template stroke, in the registered frame (direction: in the drawing's own frame). Per look-alike the
 *     evidence L_C = Σ ρ(d_T) − ρ(d_C) over the checkpoints that separate T and C (ρ = Huber on distances capped at
 *     KP.DCAP; a loop / corner / length beyond C counts as C), plus KP.GW per 0.01 of shape cost in C's favour.
 *     Non-critical checkpoints only add to this sum; a critical one missed (d_T ≥ HIT, on C's side, d_C ≤ MATCH_C)
 *     is what gets named. A drawing's stroke drawn the other way round gives no direction evidence (that is △) for an
 *     accepted shape; a look-alike's stroke that runs the other way (シ's long stroke against ツ's, ソ/ン) gives its
 *     own direction, so the direction is a critical point there and a drawing written in T's direction clears T.
 *     Merge cuts and specks are left out, and the template's own reversals (zigzags of ね ろ る れ わ) do not count
 *     as loops. An end hook that a look-alike's loop covers stays for the other look-alikes (れ's flick against
 *     わ), where a straight-ish end tells neither (rough writing drops flicks; わ's inward curl lies beyond).
 *   - Decision: an accepted shape becomes ✕ = C when C's shape cost is within KP.WINDOW of the target's, C's reading
 *     of the drawing leaves none of C's body strokes out and none of the drawn strokes unexplained and joins no more
 *     strokes than the target's (a セ with a weak hook is no せ), a critical point is missed and L_C reaches
 *     KP.L[strictness] (the pair rules: the same reading condition). A rejected drawing that the shape match named
 *     after no look-alike is named after the look-alike with the best key-point score when that one fits about
 *     as well as the target (or, against the other-script pair, clearly better on its points).
 *   - Pair rules (ク←ワ, り←い, ヤ←セ; section "Pair rules"): where the checkpoints did not vote, a learnt linear vote
 *     on two named measures per pair (KP-B's feature library and thresholds, kept only where it added dev rejections
 *     of rough look-alikes without a new false rejection on any dev split); its measures are public points too.
 *   - Discriminants (ろ←る, ユ←コ, し←レ, り←い, い←り, ア←マ, ク←ワ, メ←ヌ, ヤ←セ, モ←も, レ←し; PR_RULES entries with
 *     all: true): the difference a reader looks at, made decisive — how far ろ's bowl turns after its corner and where it
 *     ends (る curls on into a loop), ユ's short top over a long base that runs out on both sides of the vertical (コ: as
 *     wide as its top, stopping at the vertical), し's round bottom and low end (レ: a corner and a high end), り's long
 *     second stroke close to the first (い: short and apart) … — as one calibrated linear vote with the shape costs' gap;
 *     one public point and one message each.
 *   - Mutual consistency (prVeto): look-alike C is not named over the target T — by the shape match, the checkpoints or
 *     T's rules — when C's own discriminant against T votes T on the drawing (a sharp-cornered レ with a lowish end is not
 *     し): such drawings were turned down both as T and as C. (A wider veto by C's checkpoints was tried and left out: it
 *     let ご for ゴ and 25 % morphs through on dev.)
 *   - Proportion pairs (bandBlocks; い / り): the asked character gets the benefit of the doubt — C is named over T (by
 *     the shape match, the checkpoints or T's rules) only when C fits clearly better (BAND_GAP) or T's own discriminant
 *     against C finds the drawing C-like (BAND.TH × its th) and the drawing shows C's defining proportions (BAND_DEF: り
 *     for an asked い only with the right stroke clearly taller than the left or reaching clearly below it); an ambiguous
 *     drawing between the two is the asked character.
 *   - Labels: a label that would read the same as the look-alike's own point against this character (the chart shows
 *     both) says more — where a stroke goes after a bend, which way an end goes, a start / end against the look-alike.
 *
 * Box mode (opts.box; tuned on tools/bench/box): the pool becomes the 142 kana + the 22 extras, and the size and
 *   place of the drawing in the cell count where they change the character. The shape is judged as usual with a
 *   small kana and its big twin as one shape (っ/つ); then a small kana must be small and low (else ✕ = the big
 *   twin), a big kana that has a small twin must not be clearly small in the lower left (else ✕ = the small
 *   twin), 、 。 must be small in the lower left and ー a wide line through the middle (✕ with an issue of type
 *   'size'). A one-stroke drawing as small as a 、 / 。 is classified by its geometry (tick / loop / dot), since
 *   pen jitter is a large part of it. Full-size kana are judged leniently at any size. Without opts.box nothing
 *   of this applies and the 142 kana are judged exactly as before (extras by shape only, never in the pool).
 *
 * Provenance
 *   Three competing implementations were benchmarked (tools/bench/RESULTS.md). This module is candidate B
 *   ("elastic matching with directional features", js/recognizer-candidates/B.js), the winner on the held-out
 *   test split, with these techniques grafted from candidate A. Each was measured on the non-test splits
 *   (dev + two private splits) and kept because together they raised the score there (99.50 → 99.76 on dev)
 *   without lowering the acceptance of correct drawings; the stray-speck rule changes no benchmark verdict
 *   and was kept because the spec grades a wrong stroke count as △:
 *     - the signed total turning of a stroke is part of the stroke distance (る/ろ, ぬ/め, ね/れ/わ);
 *     - after the body is registered, ゛/゜ may move as one unit (writers place the marks freely);
 *     - "close relatives" = look-alikes + other-script pair + the ゛/゜ family. They are always compared,
 *       whatever opts.pool says, get almost no benefit of the doubt, and every one in contention is checked
 *       (not only the best competitor); a merged/split stroke does not count as evidence against the target;
 *     - naming a rejected drawing: the relative that beat the target, else the best reading where near ties
 *       go to the reading that needs fewer writing mistakes, else a close relative within 0.04 of it;
 *     - a stray speck (tap, accidental dot) is cheap in the alignment and gives △ (count) instead of ✕.
 *   API hardening: an unknown target throws an Error; mapping has one entry per user stroke.
 *   Learner-error review (tools/review-scratch/FINDINGS.md; measured with tools/bench/make-ext.js, "extended
 *   metrics" in run.js, without changing the original SCORE): the two ゛ ticks written as one stroke are a
 *   merge of the marks (△), told apart from a ゜ by size and thickness, while a ゜ is compared from any
 *   starting point; a stroke drawn twice in a row is one stroke plus a copy (△, "두 번"); a drawing that left
 *   a stroke out is not passed off as a joined / shorter form (✕); a speck far outside the glyph does not
 *   shift the frame, and a speck paired with a stroke is reported as a speck, not a broken stroke; one stroke
 *   out of place is one order error (longest increasing subsequence), not a rotation; result.structure
 *   lists merged / split / extra / speck / missing / misplaced strokes for the app's red highlighting.
 *   Key points (user feedback: a roughly written look-alike was accepted; KP-Bench, tools/bench/make-rough.js):
 *   two candidates were built on this judge, tuned on dev only, and compared on the held-out test splits
 *   (tools/bench/RESULTS.md, "Key points"). KP-A (js/recognizer-candidates/KP-A.js, the checkpoints above) won:
 *   rough look-alikes ✕ with the look-alike named 98.7 % vs KP-B 97.7 % (accepted as the target 0.8 % vs 0.9 %,
 *   baseline 2.0 %), rough targets ○ 95.6 % (= baseline) vs 95.4 %, correct drawings ○ 99.5 % for both, and a
 *   key-point message on almost every look-alike rejection (KP-B names a point only when it flips a verdict).
 *   Adversarial verification (tools/bench/scratch-kp-verify: harder rough look-alikes and targets, 30–40 % blends,
 *   box cells, reversed / swapped strokes, the API test's own distortion): a look-alike whose stroke runs the other
 *   way now gives that direction (ツ with a low first dot was ✕ シ, ソ/ン had no point), a look-alike is named only
 *   when its reading needs no missing / joined strokes, れ/わ's end hook, count messages, dot places in words
 *   ('2번째 획(점) 위'), and box size rules before a key point. No dev verdict changed; regressions in
 *   tools/test-recognizer-api.js.
 *   Look-alike leaks, round 3 (tools/bench/RESULTS.md §12; scripts and calibration sets in tools/bench/scratch-leak):
 *   the discriminants above, calibrated on dev plus private calibration drawings of the bench's own writers and
 *   simulator (new seeds) and on the API test's distortion model, never on test: threshold ≈ the 99.5–100th
 *   percentile of the target's own accepted drawings (own loss ≤ 0.4 % there); normal strictness gives unrelated
 *   characters less of an edge (accept 0.14 → 0.16, margin 0.02 → 0.05, lenient 0.17 / 0.03 → 0.18 / 0.06 — no dev or
 *   calibration look-alike, 'other' or scribble drawing changed, rough targets ○ 95.5 → 97.7 % on dev); a stroke
 *   "drawn twice" must have copies of similar length (a loop around a line is no retrace: ゆ / み read as ノ); a
 *   rejected drawing is named after the close relative its strokes say rather than the one that beat the target by a
 *   hair (ソ for シ, not ン); a look-alike written in its own stroke order beats a target reading that needs an order error by
 *   a little more (LOOK_ORDER 0.01 → 0.02: メ for ナ, も for モ). Dev: rough look-alikes accepted 0.5 → 0.2 %, rough targets ○
 *   95.5 → 97.7 %, SCORE 99.72 → 99.76; test (run once): 0.6 → 0.3 %, 95.7 → 97.5 %, SCORE 99.58 → 99.54.
 *   Grafted from KP-B (js/recognizer-candidates/KP-B.js) on dev evidence: the pair rules for ク←ワ, り←い, ヤ←セ
 *   (dev: +6 rough / 25 %-morph look-alikes rejected, no correct drawing lost on any dev split or strictness; ろ←る, こ←ニ and
 *   the other pairs were left out because they cost a correct drawing on dev or gained nothing). Also changed
 *   from KP-A: keypoints.ch is always the target (a twin's form → the target's points, unjudged), and failed lists
 *   exactly the points with hit === false.
 *   Natural い / り / リ (user report, stylus: correct り, リ and い rejected too often — り read as リ without a strong flick,
 *   リ as り with a small one, the connected one-stroke り as "1번째 획이 빠졌어요", い / り as each other at the edge of their
 *   proportions; measured with tools/bench/natural, its v1 split used as dev; calibration scripts in tools/bench/natural/fix,
 *   on dev, private calibration drawings and the API test's distortion model, never test): り / リ became same-shape twins in
 *   KANA_DATA (like へ / ヘ: either is right in writing, with a gentle twin note instead of ✕; the リ←り discriminant left with
 *   it, and rules against a twin never vote); an い←り discriminant (th = the 99.8th percentile of い's own drawings) and
 *   い / り as a proportion pair (bandBlocks: the り←い pair rule, whose 1.ey spread of 0.03 voted い for natural り, now votes
 *   only where り's discriminant agrees); り written in one stroke keeps its joined form when the stroke has all three parts
 *   (joinedRun, JOIN_RUN); a count point names a look-alike's joined form as such ('い는 2획 (り를 이어 쓰면 1획)'). Natural set
 *   as the app calls it, v1: り false rejections core / combo / connected / edge 9.1 / 23.0 / 13.8 / 1.9 % → 0.3 / 0.0 /
 *   0.1 / 0.6 %, リ 8.0 / 23.0 → 0 / 0 %, い 0.2 / 1.5 / edge 11.5 % → 0.0 / 0.5 / 4.0 % (held-out split 'test', run once:
 *   り 0.1 / 0.3 / 0.3 / 0.7 %, リ 0 / 0 %, い 0.1 / 0.3 / 5.3 %); clear い↔り look-alikes 100 % ✕ in every context (lenient
 *   included). Dev: SCORE 99.82 and correct drawings 99.8 % unchanged, rough look-alikes accepted 0.2 % unchanged, 25 %
 *   morphs 1.3 → 1.1 %; private い / り rough calibration drawings: targets ✕ 107 → 31 of 1600, look-alikes accepted 11 →
 *   14 of 1000. Test (run once): SCORE 99.54, rough look-alikes 0.3 %, box 99.71 % — as before. A single-script leniency
 *   (opts.script) was tried and left out: on dev and private sets it accepted no more correct drawings but let more
 *   cross-script look-alikes through.
 *   Adversarial verification (own い / り / リ shapes and seeds, scratch; tools/test-recognizer-api.js 'い / り / リ
 *   verification'): い with a right stroke about as long as the left and drawn upright was still read as り by the い←り
 *   discriminant (core い 4.4 %, right stroke 0.85–1 × the left 45 % ✕) → BAND_DEF (0.6 % / 15 %; natural v1 い edge 4.0 →
 *   3.8 %; dev, box and rough-dev per pair unchanged, private m25 い←り morphs 21 → 25 of 504); い drawn for リ with a
 *   katakana-only pool was accepted as り's form → closeSet adds a twin's look-alikes; り's twin note told a り with a clear
 *   flick to flick (57 % of the verifier's natural り, a textbook-like り half the time) → TWIN_FLICK (no-flick り 87 %,
 *   medium / long flick 3 % / 0 %).
 *
 * How it works
 *  1. Normalisation. User and template strokes are mapped to a common frame (bounding-box centre at the
 *     origin, larger side = 1, aspect kept). Every stroke is resampled by arc length at a fixed spacing (so
 *     loops and hooks keep their detail); each point carries its position and its unit tangent. Dots have
 *     no tangent. Each stroke also gets its signed total turning (in turns; reversing flips the sign).
 *  2. Stroke distance. A banded DTW over (position, tangent) features compares a user stroke with a template
 *     stroke, as written and reversed, plus a small length-ratio term and the turning difference. DTW
 *     absorbs uneven speed, trimmed / extended ends and local deformation; tangent and turning separate
 *     strokes that occupy the same place but run or curl differently. ゛/゜ are compared by shape (centred)
 *     with a tolerant position term.
 *  3. Character alignment. A dynamic programme over (user strokes consumed, set of template strokes used)
 *     explains the user's strokes with the template's: 1:1 matches in any order, one user stroke covering
 *     two consecutive template strokes (merged; for the two ゛ ticks a cheap, shape-checked merge), two
 *     consecutive user strokes covering one template stroke (broken, or the same stroke retraced), extra
 *     strokes (a speck is cheap) and missing strokes. Order, direction and count errors come out of the
 *     alignment explicitly — the same alignment fills mapping / reversed / orderErrors / structure / issues.
 *  4. Ranking. A coarse pass (8 points per stroke, no warping) ranks every character of the pool; a
 *     shortlist plus the target's family and close relatives is aligned at the fine level, and the leaders
 *     are refined: the drawing is re-registered to each template by a regularised affine fit (slant,
 *     rotation, uneven scale; the deformation is charged) estimated from the DTW correspondences, the marks
 *     may then shift as a unit, and the drawing is aligned again.
 *  5. Decision. The target (or its same-shape twin, or any accepted variant) is accepted when it is close
 *     enough in absolute terms and not clearly beaten (benefit of the doubt against unrelated characters,
 *     almost none against close relatives, where each reading is also charged for the order / direction
 *     errors it needs: a look-alike written properly beats the target written wrongly, while a clear target
 *     with a reversed stroke stays △). Accepted → ○, or △ when the alignment needed an order error, a
 *     reversed long stroke (marks and dots are never direction-judged), a merge / split / retrace or stray
 *     specks — unless a reading with a stroke left out fits clearly better (✕, "원래 N번째 획이 빠졌어요"; not for り
 *     written in one stroke when the stroke has the left part, the way up and the right stroke: joinedRun).
 *     Rejected → ✕ with what was written instead (confusedWith / crossScript / ゛゜ / same-sound explanation).
 *
 * Pure, deterministic, synchronous, zero dependencies besides SvgPath and KANA_DATA. Templates are
 * precomputed at load (~30 ms); judge() over the full pool takes ~2 ms in Node, ~25 ms at worst for 8–16
 * scribbled strokes (budget: 30 ms in a browser). The key points add ~0.2 ms per judge() and, the first time a
 * form is judged, ~3 ms to build its checkpoint model (look-alikes aligned to it); results never depend on that
 * order (the models are a pure function of KANA_DATA).
 * Node: require('./svgpath.js') and require('./kana-data.js'). Browser: globals SvgPath / KANA_DATA, sets
 * window.KanaRecognizer. _params / _internals are tuning hooks, not part of the API.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(
    isNode ? require('./svgpath.js') : root.SvgPath,
    isNode ? require('./kana-data.js') : root.KANA_DATA
  );
  if (isNode) module.exports = api;
  else root.KanaRecognizer = api;
})(typeof self !== 'undefined' ? self : this, function (SvgPath, DATA) {
  'use strict';

  // ---------------------------------------------------------------------------------------------
  // Parameters (distances are in "character units": the larger side of the drawing = 1)
  // ---------------------------------------------------------------------------------------------
  const P = {
    // two resolutions: the coarse one ranks all characters cheaply, the fine one decides
    SPACING: 0.07,       // fine: resampling step along a stroke
    NMIN: 5,             // fine: points per stroke, at least …
    NMAX: 48,            // … and at most
    C_N: 8,              // coarse: fixed points per stroke, compared point by point (no warping)
    SHORTLIST: 16,       // characters re-scored at the fine level (plus the target's family)
    BAND: 0.3,           // DTW Sakoe-Chiba band, fraction of the longer sequence
    W_DIR: 0.20,         // weight of the tangent (direction) term in the DTW point cost
    DOT_LEN: 0.04,       // user strokes shorter than this have no usable direction
    W_FLOOR: 0.08,       // stroke weight = sqrt(max(length, W_FLOOR))
    MISS: 0.45,          // cost (per unit weight) of a template stroke the user did not write …
    MISS_ABS: 0.03,      // … plus this, per missing stroke, on the final score
    EXTRA: 0.45,         // cost (per unit weight) of a user stroke that matches nothing …
    EXTRA_ABS: 0.03,     // … plus this, per extra stroke
    P_MERGE: 0.020,      // score penalty per connected (merged) pair
    P_MERGE_MARK: 0.004, // … for the two ゛ ticks written as one stroke (a common habit; it must not let a ゜ win) …
    JOIN_RATIO: [0.35, 2.2], // … whose length must be within these multiples of the joined template ticks …
    JOIN_THICK: 0.33,    // … and which is two ticks side by side, not one line: minor / major principal spread ≥ this
    P_SPLIT: 0.025,      // score penalty per broken stroke (a stroke in three pieces: twice) …
    SPLIT_GAP: 0.3,      // … whose next piece starts within this of the previous piece's end (or one piece is a speck)
    LOOP_JOIN: 0.25,     // a ゜ / 。 in two arcs: their ends meet within this × the arcs' total length, …
    LOOP_CURVE: 0.8,     // … each arc's chord is at most this × its length (゛ ticks: ≥ 0.85; tools/bench/scratch-verify/loop-cal.js) …
    LOOP_ROUND: 0.3,     // … the closed path's isoperimetric quotient is at least this, …
    P_SPLIT_LOOP: 0.004, // … the split costs this, not P_SPLIT (like P_MERGE_MARK: it must not let a ゛ win) …
    LOOP_TICK: 0.1,      // … and either arc read as a ゛ tick costs this much more (two ticks never close a loop)
    P_DIR: 0.020,        // DTW-cost penalty for matching a judged stroke reversed (recognition only)
    VAR_STRUCT: 0.03,    // when picking the target's variant: extra cost per merge/split
    LEN_W: 0.02,         // weight of |log(length ratio)| in a stroke-pair cost
    MARK_TOL: 0.10,      // ゛/゜ marks: position offset tolerated for free …
    MARK_K: 0.25,        // … beyond it, cost per unit of offset (the mark's shape is compared centred)
    JUDGE_T_LEN: 0.2,    // template strokes shorter than this (fraction of char size) are not direction-judged
    JUDGE_U_LEN: 0.12,   // ... nor user strokes shorter than this
    DIR_MARGIN: 0.02,    // reversed only when rev + margin < fwd
    AFF_REG: 0.02,       // ridge toward identity (fraction of total weight)
    AFF_ROT: 0.02,       // score penalty per radian of rotation used by the refinement
    AFF_DEV: 0.03,       // ... per unit of shear / anisotropic deviation
    AFF_SCALE: 0.02,     // ... per unit of log scale
    REFINE_ITERS: 2,     // affine refinement iterations
    AFF_MAX: 0.05,       // refinements needing a larger penalty are rejected
    REFINE_TOP: 8,       // refine at most this many best characters (plus the target's family) …
    REFINE_WINDOW: 0.08, // … and only those within this of the best
    FOCUS_WINDOW: 0.1,   // close relatives of the target are refined within REFINE_WINDOW + this
    REFINE_HOPE: 0.3,    // nothing above RECOG_MAX + this is refined (it never came back: refinement lowered a cost
                         // by at most 0.26 on the benchmark), whatever the target
    // decision thresholds per strictness
    STRICT: {
      lenient: { accept: 0.18, acceptOrder: 0.17, margin: 0.060, marginOrder: 0.030, lookMargin: 0.010 },
      normal:  { accept: 0.16, acceptOrder: 0.14, margin: 0.050, marginOrder: 0.020, lookMargin: 0.005 },
      strict:  { accept: 0.115, acceptOrder: 0.115, margin: 0.008, marginOrder: 0.008, lookMargin: -0.003 },
    },
    MAX_STROKES: 16,     // more strokes than this is not an attempt at any kana (and would be slow)
    MANY_STROKES: 8,     // above this many strokes: shortlist and refine fewer characters …
    MANY_SHORTLIST: 8,
    MANY_REFINE_TOP: 3,
    RECOG_MAX: 0.22,     // above this the drawing is "unreadable" (recognized = null)
    LOOK_ORDER: 0.02,    // vs a look-alike: penalty for a reading that needs an order error (メ for ナ, も for モ: written in
                         // their own order they are the look-alike; 0.01 before tools/bench/RESULTS.md §12) …
    LOOK_DIR: 0.01,      // … a reversed stroke …
    LOOK_STRUCT: 0,      // … but not for a merge / split, which already pays P_MERGE / P_SPLIT (from A)
    LOOK_REPORT: 0.04,   // a wrong drawing within this of the best match is reported as the close relative
    REC_ERR: 0.03,       // naming a rejected drawing: per writing mistake a reading needs (from A)
    MARK_SHIFT: 0.4,     // ゛/゜ may move together by up to this much after the body is registered (from A) …
    MARK_SHIFT_W: 0.05,  // … at this cost per unit of shift
    TURN_W: 0.03,        // weight of the signed total turning difference (in turns) of a stroke pair (from A) …
    TURN_FULL: 0.2,      // … scaled down for strokes shorter than this
    SPECK_LEN: 0.06,     // a user stroke shorter than this is a speck (tap, stray dot) …
    EXTRA_SPECK: 0.2,    // … an unmatched speck costs this per unit weight …
    EXTRA_SPECK_ABS: 0.01, // … plus this (instead of EXTRA / EXTRA_ABS) (from A: a stray speck is cheap)
    COUNT_ACCEPT: 0.85,  // a target reading with stray specks is accepted (△) only below accept × this
    FAR_SPECK: 0.25,     // a speck lying this far (× the size of the rest) outside the rest of the drawing does not
                         // take part in the normalisation (a tap in the pad's corner must not shrink the glyph)
    DECIMATE: 0.002,     // input points closer than this (× the drawing's size) to the previous kept point are dropped …
    MAX_PTS: 512,        // … and a stroke keeps about this many points at most
    P_DUP: 0.025,        // score penalty for a stroke drawn twice in a row (retraced instead of undone) …
    RETRACE_T_LEN: 0.2,  // … only for template strokes at least this long …
    RETRACE_RATIO: 0.5,  // … with both copies at least this fraction of the template stroke's length …
    RETRACE_TOL: 0.25,   // … lying on top of each other: mean distance ≤ this × the longer copy's length …
    RETRACE_ABS: 0.12,   // … and ≤ this …
    RETRACE_LEN: 2,      // … and the longer copy at most this many times the shorter (a loop around a line is no retrace)
    LOOP_GAP: 0.45,      // a user stroke whose ends are closer than this × its length is a closed loop …
    LOOP_ROT: 7,         // … and is compared with a ゜ from this many other starting points as well
    MISS_READ: -0.008,   // a "stroke left out" reading wins over a merged / fewer-stroke form when its matched
                         // strokes fit better than the form's by more than this (mean weighted stroke distance) …
    MISS_INK: 0.05,      // … unless it is where the longer form splits a standard form's stroke (そ) and this fraction of it, away from the joint, has drawn ink within MISS_INK_R
    MISS_INK_R: 0.08,
    TWIN_NOTE: 0.01,     // a near same-shape twin's form (リ for り) fitting the drawing this much better than the target's own: a note
                         // (natural り: 2 % of drawings, without the flick 56 %; plain リ for り 100 %: tools/bench/natural/fix)
    TWIN_FLICK: 0.06,    // … for り only when its left stroke has no clear flick: the pen rises less than this × the stroke's height
                         // after its lowest point (flickRise; drawn without a flick ≤ 0.02, a medium / long flick ≥ 0.1 typically)
    JOIN_RUN: 0.15,      // … and a one-stroke drawing of a character written in one stroke (り) keeps that form when the stroke runs
                         // along the first joined stroke's chord, then the connector, then the second stroke's chord, each by at
                         // least this × its length (connected り ≥ 0.22, a stroke of り alone ≤ 0.04: tools/bench/natural/fix)
    JOIN_MIN: 0.2,       // joined forms: the connector is at least this long …
    JOIN_BACK: -0.5,     // … and turns back (cos between it and the second stroke's chord ≤ this; ふ's dot → middle stroke does not)
  };

  // Box mode (opts.box = the 원고지 cell; docs/SPEC-words.md D): where and how big the drawing is, in fractions of
  // the cell (L = larger side of its bounding box, cx / cy = its centre, y down). Tuned on tools/bench/box (dev).
  const BOX = {
    SMALL_MAX: 0.62,     // a small kana is small: L + SMALL_SLOPE × (SMALL_CY − cy) ≤ this (the larger, the lower it sits;
    SMALL_SLOPE: 1,      // centred in the cell, L ≤ 0.56 is still small: learners often centre small kana) …
    SMALL_CY: 0.56,
    SMALL_ABS: 0.68,     // … L ≤ this anyway …
    SMALL_TOP: 0.44,     // … and its centre is not clearly above the middle
    TINY_MAX: 0.46,      // a big kana with a small twin reads as the small twin only when clearly small: L ≤ this …
    TINY_CY: 0.55,       // … centre below this …
    TINY_CX: 0.62,       // … and left of this (the lower-left quarter, roughly)
    NAME_SMALL: 0.52,    // naming any other drawing of a small / big pair: the small one when placed small and L ≤ this
    PUNCT_MAX: 0.4,      // 、 。: L ≤ this …
    PUNCT_CY: 0.55,      // … centre below this …
    PUNCT_CX: 0.65,      // … and left of this
    PUNCT_POOL: 0.5,     // 、 。 compete with other characters only for a drawing with L ≤ this
    PUNCT_KANA: 0.25,    // any other target drawn as a 、 / 。 mark this small, in their corner, reads as that mark
    DOT_MAX: 0.08,       // marks (one stroke, L ≤ PUNCT_MAX): this small is a dot (a 、, never a 。) …
    LOOP_TURN: 0.45,     // … turning (in turns) at least this with its ends within LOOP_GAP × its bbox diagonal: a 。 …
    LOOP_GAP: 0.6,
    TICK_STRAIGHT: 0.8,  // … a tick: ends at least this × its bbox diagonal apart, axis within TICK_ANGLE[0..1]° (y down; the
    TICK_ANGLE: [8, 98, 172], // "\" diagonal or upright: 、) or up to TICK_ANGLE[2]° ("/": a Western comma)
    BAR_FLAT: 0.4,       // ー competes with other characters only for a drawing at most this × as high as wide
    BAR_MIN: 0.3,        // ー: at least this wide …
    BAR_CY: [0.25, 0.72],// … its centre between these heights
  };

  const KANA = DATA.kana;
  const ALL_CHARS = Object.keys(KANA);

  // Extras (docs/SPEC-words.md C/D): small kana ぁ…ョ, ヴ, ー 、 。 from KANA_DATA.extra. Each gets a kana-like
  // record (group / base / pair / confusables), so the code below treats it like a kana. Without opts.box an
  // extra is only ever the target, judged by shape (っ ≈ つ); with opts.box every extra is in the pool and the
  // size and position of the drawing in the cell decide between a small kana and its big twin.
  const EXTRA = DATA.extra || {};
  const EXTRA_CHARS = Object.keys(EXTRA);
  const BOX_CHARS = ALL_CHARS.concat(EXTRA_CHARS);
  const SMALL_OF = new Map(); // big kana → its small twin (あ → ぁ, つ → っ, ヨ → ョ …)
  for (const ch of EXTRA_CHARS) if (EXTRA[ch].kind === 'small' && KANA[EXTRA[ch].big]) SMALL_OF.set(EXTRA[ch].big, ch);
  const isSmall = (ch) => !!EXTRA[ch] && EXTRA[ch].kind === 'small' && SMALL_OF.get(EXTRA[ch].big) === ch;
  const sizeTwin = (ch) => SMALL_OF.get(ch) || (isSmall(ch) ? EXTRA[ch].big : null);
  const XINFO = {};
  for (const ch of EXTRA_CHARS) {
    const e = EXTRA[ch], big = isSmall(ch) ? KANA[e.big] : null;
    const nfd = ch.normalize('NFD'); // ヴ = ウ + combining ゛
    const base = nfd.length === 2 && nfd[1] === '゙' && KANA[nfd[0]] ? nfd[0] : null;
    XINFO[ch] = {
      ch, script: e.script, kind: e.kind, big: big ? e.big : null, romaji: e.romaji, ko: e.ko, strokeCount: e.strokeCount, variants: e.variants,
      group: base ? 'dakuten' : 'basic', base,
      // a small kana inherits its big twin's look-alikes (and their small forms) and pairs with the other script's small kana
      pair: big ? SMALL_OF.get(big.pair) || null : null,
      confusables: big ? big.confusables.concat(big.confusables.map((c) => SMALL_OF.get(c)).filter(Boolean)) : [],
      // 、 and 。 are one dot-like mark: compared by shape, never direction-judged; 。 is a loop (any starting point)
      marks: ch === '、' || ch === '。' ? 1 : undefined, loop: ch === '。',
    };
  }
  if (XINFO['、'] && XINFO['。']) { XINFO['、'].confusables = ['。']; XINFO['。'].confusables = ['、']; }
  const info = (ch) => KANA[ch] || XINFO[ch];

  // ---------------------------------------------------------------------------------------------
  // Geometry helpers
  // ---------------------------------------------------------------------------------------------
  // (Math.sqrt rather than Math.hypot, which is several times slower in V8 and runs for every input point)
  function polyLength(pts) {
    let L = 0;
    for (let k = 1; k < pts.length; k++) {
      const dx = pts[k][0] - pts[k - 1][0], dy = pts[k][1] - pts[k - 1][1];
      L += Math.sqrt(dx * dx + dy * dy);
    }
    return L;
  }

  // n points evenly spaced by arc length (the algorithm of SvgPath.resample, with Math.sqrt).
  function resample(pts, n) {
    if (pts.length === 0) return [];
    const total = polyLength(pts);
    if (pts.length === 1 || total === 0) return Array.from({ length: n }, () => pts[0].slice());
    const step = total / (n - 1);
    const out = [pts[0].slice()];
    let acc = 0, k = 1, px = pts[0][0], py = pts[0][1];
    while (out.length < n - 1 && k < pts.length) {
      const dx = pts[k][0] - px, dy = pts[k][1] - py, seg = Math.sqrt(dx * dx + dy * dy);
      if (acc + seg >= step && seg > 0) {
        const t = (step - acc) / seg;
        px += t * dx;
        py += t * dy;
        out.push([px, py]);
        acc = 0;
      } else {
        acc += seg;
        px = pts[k][0];
        py = pts[k][1];
        k++;
      }
    }
    while (out.length < n) out.push(pts[pts.length - 1].slice());
    return out;
  }

  function bboxOf(strokes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of strokes) for (const p of s) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }

  // Centre the bbox at (0,0) and scale the larger side to 1.
  function normalise(strokes) {
    const b = bboxOf(strokes);
    const s = Math.max(b.w, b.h) || 1;
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    return strokes.map((st) => st.map((p) => [(p[0] - cx) / s, (p[1] - cy) / s]));
  }

  // Number of resampled points for a polyline of length L at level lv (0 = fine, 1 = coarse).
  function pointsFor(L, lv) {
    return lv ? P.C_N : Math.min(P.NMAX, Math.max(P.NMIN, Math.round(L / P.SPACING) + 1));
  }

  // Feature vector of a polyline resampled by arc length: Float64Array [x, y, tx, ty] * n.
  // Tangents are unit vectors, or (0,0) for a dot (no usable direction).
  function features(pts, isDot, lv) {
    const n = pointsFor(polyLength(pts), lv);
    const r = resample(pts, n);
    const f = new Float64Array(4 * n);
    for (let i = 0; i < n; i++) {
      f[4 * i] = r[i][0];
      f[4 * i + 1] = r[i][1];
      if (isDot) continue;
      const a = r[Math.max(0, i - 1)], b = r[Math.min(n - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1e-9) { f[4 * i + 2] = dx / d; f[4 * i + 3] = dy / d; }
    }
    return f;
  }

  // The same sequence written the other way round (positions reversed, tangents negated).
  function reverseFeatures(f) {
    const n = f.length / 4, r = new Float64Array(f.length);
    for (let i = 0; i < n; i++) {
      const s = 4 * (n - 1 - i);
      r[4 * i] = f[s]; r[4 * i + 1] = f[s + 1]; r[4 * i + 2] = -f[s + 2]; r[4 * i + 3] = -f[s + 3];
    }
    return r;
  }

  // Signed total turning of a polyline, in turns (a full loop = ±1, a hook ≈ ±0.3). Reversing a stroke
  // flips its sign. Separates strokes that occupy the same place but curl differently: る/ろ, ぬ/め,
  // ね/れ/わ (graft from candidate A).
  const TURN_N = 32;
  function signedTurning(pts) {
    if (pts.length < 3 || !(polyLength(pts) > 0)) return 0;
    const r = resample(pts, TURN_N);
    let tot = 0, prev = null;
    for (let k = 1; k < TURN_N; k++) {
      const dx = r[k][0] - r[k - 1][0], dy = r[k][1] - r[k - 1][1];
      if (dx === 0 && dy === 0) continue;
      const a = Math.atan2(dy, dx);
      if (prev !== null) {
        let d = a - prev;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        tot += d;
      }
      prev = a;
    }
    return tot / (2 * Math.PI);
  }
  const turnWeight = (L) => Math.min(1, L / P.TURN_FULL);

  // Centroid of a feature sequence, and the sequence translated so that its centroid is the origin.
  function centroidOf(f) {
    const n = f.length >> 2;
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) { x += f[4 * i]; y += f[4 * i + 1]; }
    return [x / n, y / n];
  }
  function centred(f, c) {
    const g = Float64Array.from(f);
    for (let i = 0; i < g.length; i += 4) { g[i] -= c[0]; g[i + 1] -= c[1]; }
    return g;
  }

  // ---------------------------------------------------------------------------------------------
  // DTW over (position, tangent) features with a Sakoe-Chiba band and the symmetric step pattern
  // (diagonal steps count twice), normalised by n + m so the result is a mean point cost.
  // ---------------------------------------------------------------------------------------------
  let rowA = new Float64Array(128), rowB = new Float64Array(128);
  function dtw(a, b) {
    const n = a.length >> 2, m = b.length >> 2;
    if (rowA.length < m + 1) { rowA = new Float64Array(m + 1); rowB = new Float64Array(m + 1); }
    let prev = rowA, cur = rowB;
    const band = Math.max(2, Math.ceil(P.BAND * Math.max(n, m)));
    const wd = P.W_DIR * 0.5;
    const ratio = (m - 1) / Math.max(1, n - 1);
    for (let j = 0; j <= m; j++) prev[j] = Infinity;
    for (let i = 0; i < n; i++) {
      const centre = i * ratio;
      const jlo = Math.max(0, Math.floor(centre - band)), jhi = Math.min(m - 1, Math.ceil(centre + band));
      for (let j = 0; j <= m; j++) cur[j] = Infinity;
      const ax = a[4 * i], ay = a[4 * i + 1], atx = a[4 * i + 2], aty = a[4 * i + 3];
      const an = atx !== 0 || aty !== 0 ? 1 : 0;
      for (let j = jlo; j <= jhi; j++) {
        const o = 4 * j;
        const dx = ax - b[o], dy = ay - b[o + 1];
        const btx = b[o + 2], bty = b[o + 3];
        const bn = btx !== 0 || bty !== 0 ? 1 : 0;
        const c = Math.sqrt(dx * dx + dy * dy) + wd * (an * bn - (atx * btx + aty * bty));
        let best;
        if (i === 0 && j === 0) best = 2 * c;
        else {
          const diag = i > 0 && j > 0 ? prev[j - 1] + 2 * c : Infinity;
          const up = i > 0 ? prev[j] + c : Infinity;
          const left = j > 0 ? cur[j - 1] + c : Infinity;
          best = diag < up ? (diag < left ? diag : left) : (up < left ? up : left);
        }
        cur[j] = best;
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[m - 1] / (n + m);
  }

  // Coarse level: equal-length sequences compared point by point with the same point cost.
  function lockstep(a, b) {
    const n = a.length >> 2, wd = P.W_DIR * 0.5;
    let s = 0;
    for (let o = 0; o < a.length; o += 4) {
      const atx = a[o + 2], aty = a[o + 3], btx = b[o + 2], bty = b[o + 3];
      const an = atx !== 0 || aty !== 0 ? 1 : 0, bn = btx !== 0 || bty !== 0 ? 1 : 0;
      const dx = a[o] - b[o], dy = a[o + 1] - b[o + 1];
      s += Math.sqrt(dx * dx + dy * dy) + wd * (an * bn - (atx * btx + aty * bty));
    }
    return s / n;
  }

  // The same DTW, returning the warping path as a flat list [i0, j0, i1, j1, …] (for the affine fit).
  function dtwPath(a, b) {
    const n = a.length >> 2, m = b.length >> 2;
    const band = Math.max(2, Math.ceil(P.BAND * Math.max(n, m)));
    const wd = P.W_DIR * 0.5;
    const ratio = (m - 1) / Math.max(1, n - 1);
    const D = new Float64Array(n * m).fill(Infinity);
    const from = new Int8Array(n * m); // 0 diag, 1 up (i-1), 2 left (j-1)
    for (let i = 0; i < n; i++) {
      const centre = i * ratio;
      const jlo = Math.max(0, Math.floor(centre - band)), jhi = Math.min(m - 1, Math.ceil(centre + band));
      const atx = a[4 * i + 2], aty = a[4 * i + 3], an = atx !== 0 || aty !== 0 ? 1 : 0;
      for (let j = jlo; j <= jhi; j++) {
        const o = 4 * j, btx = b[o + 2], bty = b[o + 3], bn = btx !== 0 || bty !== 0 ? 1 : 0;
        const dx = a[4 * i] - b[o], dy = a[4 * i + 1] - b[o + 1];
        const c = Math.sqrt(dx * dx + dy * dy) + wd * (an * bn - (atx * btx + aty * bty));
        if (i === 0 && j === 0) { D[0] = 2 * c; continue; }
        const diag = i > 0 && j > 0 ? D[(i - 1) * m + j - 1] + 2 * c : Infinity;
        const up = i > 0 ? D[(i - 1) * m + j] + c : Infinity;
        const left = j > 0 ? D[i * m + j - 1] + c : Infinity;
        let best = diag, k = 0;
        if (up < best) { best = up; k = 1; }
        if (left < best) { best = left; k = 2; }
        D[i * m + j] = best; from[i * m + j] = k;
      }
    }
    const path = [];
    let i = n - 1, j = m - 1;
    for (;;) {
      path.push(i, j);
      if (i === 0 && j === 0) break;
      const k = from[i * m + j];
      if (k === 0) { i--; j--; } else if (k === 1) i--; else j--;
      if (i < 0 || j < 0) break;
    }
    return path;
  }

  // ---------------------------------------------------------------------------------------------
  // Templates (precomputed once at load)
  // ---------------------------------------------------------------------------------------------
  const strokeWeight = (L) => Math.sqrt(Math.max(L, P.W_FLOOR));

  // ゛ = the last two strokes of a dakuten form, ゜ = the last stroke of a handakuten form (、 。: their one stroke).
  function markCount(k) {
    if (k.marks !== undefined) return k.marks;
    return k.group === 'dakuten' ? 2 : k.group === 'handakuten' ? 1 : 0;
  }

  function buildTemplate(ch, variant) {
    const k = info(ch);
    const raw = variant.strokes.map((d) => SvgPath.flatten(d));
    const pts = normalise(raw);
    const m = pts.length, marks = markCount(k);
    const T = { ch, variantId: variant.id, n: m, pts, raw, len: [], w: [], judge: [], isMark: [], loop: [], c: [], L: [], W: 0, turn: [], tw: [], mturn: [] };
    for (let j = 0; j < m; j++) {
      const L = polyLength(pts[j]);
      T.len.push(L);
      T.turn.push(signedTurning(pts[j]));
      T.tw.push(turnWeight(L));
      if (j + 1 < m) T.mturn.push(signedTurning(pts[j].concat(pts[j + 1])));
      T.w.push(strokeWeight(L));
      const isMark = j >= m - marks;
      T.isMark.push(isMark);
      T.loop.push(isMark && (k.group === 'handakuten' || !!k.loop)); // ゜ (。): a closed loop, compared from any starting point
      T.judge.push(!isMark && L >= P.JUDGE_T_LEN);
    }
    T.W = T.w.reduce((a, b) => a + b, 0);
    // features at both levels: f / r = stroke as written / reversed; fc / rc = centred (marks only);
    // mf / mr = consecutive pair j, j+1 written as one stroke (pen-up gap bridged by a straight line);
    // mk = the two ゛ ticks written as one stroke, centred, in the ways people join them (N: tick, bridge, tick;
    // V: tick, then the second tick upwards; Λ: the first tick upwards, then the second) and reversed — the
    // direction of a mark is never judged, so any of them will do
    for (let lv = 0; lv < 2; lv++) {
      const F = { f: [], r: [], fc: [], rc: [], mf: [], mr: [], mk: [] };
      for (let j = 0; j < m; j++) {
        F.f.push(features(pts[j], false, lv));
        F.r.push(reverseFeatures(F.f[j]));
        if (lv === 0) T.c.push(centroidOf(F.f[j]));
        // marks are compared by shape (centred) plus a tolerant position term
        F.fc.push(T.isMark[j] ? centred(F.f[j], centroidOf(F.f[j])) : null);
        F.rc.push(T.isMark[j] ? reverseFeatures(F.fc[j]) : null);
      }
      for (let j = 0; j + 1 < m; j++) {
        F.mf.push(features(pts[j].concat(pts[j + 1]), false, lv));
        F.mr.push(reverseFeatures(F.mf[j]));
      }
      if (marks === 2) {
        const a = pts[m - 2], b = pts[m - 1], ra = a.slice().reverse(), rb = b.slice().reverse();
        for (const s of [a.concat(b), a.concat(rb), ra.concat(b)]) {
          const f = features(s, false, lv), c = centroidOf(f);
          if (lv === 0 && !T.mc) { T.mc = c; T.mlen = polyLength(s); } // centre and length of the joined ゛ (N shape)
          F.mk.push(centred(f, c));
          F.mk.push(reverseFeatures(F.mk[F.mk.length - 1]));
        }
      }
      T.L.push(F);
    }
    return T;
  }

  const TEMPLATES = [];          // every (char, variant) of the 142 kana
  const BY_CHAR = new Map();     // ch → [templates] (kana and extras)
  function buildTemplates() {
    TEMPLATES.length = 0;
    for (const ch of ALL_CHARS) {
      const list = KANA[ch].variants.map((v) => buildTemplate(ch, v));
      BY_CHAR.set(ch, list);
      for (const t of list) TEMPLATES.push(t);
    }
    for (const ch of EXTRA_CHARS) BY_CHAR.set(ch, XINFO[ch].variants.map((v) => buildTemplate(ch, v)));
  }
  buildTemplates();

  // Same-shape twins (へ/ヘ, り/リ …): drawing one counts as the other. A near twin (り/リ: KANA_DATA twinNote) whose form
  // fits a drawing clearly better than the target's own gets result.notes (a gentle note, never an issue).
  const TWINS = new Map();
  for (const ch of BOX_CHARS) TWINS.set(ch, new Set([ch]));
  for (const g of DATA.sameShape || []) for (const a of g) for (const b of g) if (TWINS.has(a)) TWINS.get(a).add(b);

  // ---------------------------------------------------------------------------------------------
  // User input
  // ---------------------------------------------------------------------------------------------
  function prepareInput(strokes) {
    const clean = [];
    for (const s of strokes || []) {
      if (!s || !s.length) continue;
      const pts = [];
      for (const p of s) {
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
        const last = pts[pts.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push([+p[0], +p[1]]);
      }
      if (pts.length) clean.push(pts);
    }
    if (!clean.length) return null;
    // Pointer events can be very dense (0.6 px apart on a pen); downstream everything is resampled by arc
    // length (≤ NMAX points), so points closer than DECIMATE × size to the previous kept point, or than
    // 1 / MAX_PTS of the stroke, only cost time (the last point of a stroke is always kept).
    const b0 = bboxOf(clean), size0 = Math.max(b0.w, b0.h) || 1;
    const dec = clean.map((s) => {
      if (s.length < 3) return s;
      const step = Math.max(P.DECIMATE * size0, s.length > P.MAX_PTS ? polyLength(s) / P.MAX_PTS : 0);
      const out = [s[0]];
      for (let k = 1; k < s.length - 1; k++) {
        const last = out[out.length - 1];
        const dx = s[k][0] - last[0], dy = s[k][1] - last[1];
        if (dx * dx + dy * dy >= step * step) out.push(s[k]);
      }
      out.push(s[s.length - 1]);
      return out;
    });
    // A speck far outside the rest of the drawing (a tap in the pad's corner, an accidental touch) does not
    // define the frame: the centre and scale come from the other strokes, so the glyph keeps its size and
    // the speck stays an extra stroke (△ for the count) instead of distorting the registration.
    let frame = null;
    const big = dec.filter((st) => polyLength(st) >= P.SPECK_LEN * size0);
    if (big.length && big.length < dec.length) {
      const bb = bboxOf(big), sz = Math.max(bb.w, bb.h) || 1;
      const far = (st) => polyLength(st) < P.SPECK_LEN * sz &&
        st.every((p) => Math.max(bb.x0 - p[0], p[0] - bb.x1, bb.y0 - p[1], p[1] - bb.y1) > P.FAR_SPECK * sz);
      const keep = dec.filter((st) => !far(st));
      if (keep.length < dec.length) frame = bboxOf(keep);
    }
    // centre the frame at (0,0), its larger side = 1 (as normalise())
    frame = frame || bboxOf(dec);
    const s = Math.max(frame.w, frame.h) || 1, cx = (frame.x0 + frame.x1) / 2, cy = (frame.y0 + frame.y1) / 2;
    const U = buildInput(dec.map((st) => st.map((p) => [(p[0] - cx) / s, (p[1] - cy) / s])), null);
    U.frame = frame; // the drawing's extent in input coordinates (box mode: its size and place in the cell)
    U.org = { cx, cy, s }; // input point = normalised point × s + (cx, cy)
    return U;
  }

  // Per-stroke data of the input; features per level are built lazily (see inputLevel).
  function buildInput(pts, w) {
    const U = { n: pts.length, pts, len: [], w: w || [], dot: [], closed: [], c: [], L: [null, null], W: 0, turn: [], tw: [], spTurn: [], spTurn3: [], ov: [], thick: [] };
    for (let i = 0; i < U.n; i++) {
      const L = polyLength(pts[i]);
      U.len.push(L);
      U.turn.push(signedTurning(pts[i]));
      U.tw.push(turnWeight(L));
      if (!w) U.w.push(strokeWeight(L));
      U.dot.push(L < P.DOT_LEN);
      const a = pts[i][0], b = pts[i][pts[i].length - 1];
      U.closed.push(L >= P.SPECK_LEN && Math.hypot(a[0] - b[0], a[1] - b[1]) < P.LOOP_GAP * L);
    }
    U.W = U.w.reduce((a, b) => a + b, 0);
    inputLevel(U, 0);
    for (let i = 0; i < U.n; i++) U.c.push(centroidOf(U.L[0].f[i]));
    return U;
  }

  // f = strokes; fc = centred strokes (for marks), sp / sp3 = two / three consecutive strokes joined (a broken
  // stroke hypothesis) and lj = two strokes closing one loop (loopJoin), all computed on demand.
  function inputLevel(U, lv) {
    if (!U.L[lv]) U.L[lv] = { f: U.pts.map((s, i) => features(s, U.dot[i], lv)), fc: [], sp: [], sp3: [], lj: [], rot: [] };
    return U.L[lv];
  }
  function centredInput(U, F, i) {
    return F.fc[i] || (F.fc[i] = centred(F.f[i], centroidOf(F.f[i])));
  }
  // A closed loop (a ゜ circle) started at LOOP_ROT other points: where a circle starts is not part of its shape.
  function rotations(g) {
    const n = g.length >> 2, out = [];
    for (let r = 1; r <= P.LOOP_ROT; r++) {
      const q = Math.round((r * n) / (P.LOOP_ROT + 1));
      if (q <= 0 || q >= n) continue;
      const h = new Float64Array(g.length);
      h.set(g.subarray(4 * q), 0);
      h.set(g.subarray(0, 4 * q), 4 * (n - q));
      out.push(h);
    }
    return out;
  }
  function loopStarts(U, F, i) {
    return F.rot[i] || (F.rot[i] = rotations(centredInput(U, F, i)));
  }
  // p consecutive user strokes from i joined into one (a stroke broken into p = 2 or 3 pieces)
  const joined = (U, i, p) => (p === 3 ? U.pts[i].concat(U.pts[i + 1], U.pts[i + 2]) : U.pts[i].concat(U.pts[i + 1]));
  function splitTurn(U, i, p) {
    const c = p === 3 ? U.spTurn3 : U.spTurn;
    if (c[i] === undefined) c[i] = signedTurning(joined(U, i, p));
    return c[i];
  }
  function splitFeatures(U, F, i, lv, p) {
    const c = p === 3 ? F.sp3 : F.sp;
    return c[i] || (c[i] = features(joined(U, i, p), false, lv));
  }
  // Does a broken stroke go on from user stroke i to i+1 (near where it stopped; a speck may be anywhere)?
  function continues(U, i) {
    const e = U.pts[i][U.pts[i].length - 1], b = U.pts[i + 1][0];
    return U.len[i] < P.SPECK_LEN || U.len[i + 1] < P.SPECK_LEN || Math.hypot(b[0] - e[0], b[1] - e[1]) <= P.SPLIT_GAP;
  }
  // User strokes i and i+1 that close one loop together (a ゜ / 。 drawn as two arcs, both from the top, or one
  // after the other): their ends meet, both are curved (two ゛ ticks are straight, however close they are) and
  // the closed path is round. { g: the loop's centred features, c: its centre } or null. Cached per level.
  function loopJoin(U, F, i, lv) {
    if (F.lj[i] !== undefined) return F.lj[i];
    let out = null;
    const A = U.pts[i], B = U.pts[i + 1], tot = U.len[i] + U.len[i + 1];
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const a0 = A[0], a1 = A[A.length - 1], b0 = B[0], b1 = B[B.length - 1], tol = P.LOOP_JOIN * tot;
    if (U.len[i] >= P.SPECK_LEN && U.len[i + 1] >= P.SPECK_LEN &&
      d(a0, a1) <= P.LOOP_CURVE * U.len[i] && d(b0, b1) <= P.LOOP_CURVE * U.len[i + 1]) {
      const path = d(a1, b0) <= tol && d(b1, a0) <= tol ? A.concat(B)
        : d(a0, b0) <= tol && d(a1, b1) <= tol ? A.concat(B.slice().reverse()) : null;
      if (path && roundness(path) >= P.LOOP_ROUND) {
        const f = features(path, false, lv), c = centroidOf(f);
        out = { g: centred(f, c), c };
      }
    }
    return (F.lj[i] = out);
  }
  // Isoperimetric quotient of a closed polygon: 4π·area / perimeter² (a circle 1, a line 0).
  function roundness(p) {
    let a = 0, per = 0;
    for (let k = 0; k < p.length; k++) {
      const q = p[(k + 1) % p.length];
      a += p[k][0] * q[1] - q[0] * p[k][1];
      per += Math.hypot(q[0] - p[k][0], q[1] - p[k][1]);
    }
    return per > 0 ? (2 * Math.PI * Math.abs(a)) / (per * per) : 0;
  }
  // Is user stroke i one of two arcs that close a loop (loopJoin with its neighbour)? Then it is not a ゛ tick.
  function inLoop(U, F, i, lv) {
    return (i + 1 < U.n && !!loopJoin(U, F, i, lv)) || (i > 0 && !!loopJoin(U, F, i - 1, lv));
  }

  // How "thick" user stroke i is: sqrt(minor / major) principal variance of its points spread by arc length.
  // A line (one ゛ tick) is ≈ 0.1–0.3; the two ticks joined into one stroke are ≈ 0.4–0.9.
  function thickness(U, i) {
    if (U.thick[i] === undefined) {
      const r = resample(U.pts[i], TURN_N);
      let mx = 0, my = 0;
      for (const p of r) { mx += p[0]; my += p[1]; }
      mx /= r.length; my /= r.length;
      let a = 0, b = 0, c = 0;
      for (const p of r) { const x = p[0] - mx, y = p[1] - my; a += x * x; b += x * y; c += y * y; }
      const h = (a + c) / 2, d = Math.sqrt(Math.max(0, h * h - (a * c - b * b)));
      U.thick[i] = h + d > 0 ? Math.sqrt(Math.max(0, h - d) / (h + d)) : 0;
    }
    return U.thick[i];
  }

  // Mean distance from the points of feature sequence a to the polyline of b (positions only).
  function meanDistTo(a, b) {
    const n = a.length >> 2, m = b.length >> 2;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const px = a[4 * i], py = a[4 * i + 1];
      let best = (px - b[0]) * (px - b[0]) + (py - b[1]) * (py - b[1]);
      for (let j = 1; j < m; j++) {
        const ax = b[4 * j - 4], ay = b[4 * j - 3], dx = b[4 * j] - ax, dy = b[4 * j + 1] - ay;
        const L2 = dx * dx + dy * dy;
        let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - ax - t * dx, ey = py - ay - t * dy, d = ex * ex + ey * ey;
        if (d < best) best = d;
      }
      s += Math.sqrt(best);
    }
    return s / n;
  }

  // Do user strokes i and i+1 lie on top of each other (the same stroke drawn twice instead of undoing it)?
  // Mean distance between them, both ways, in character units. Cached; the affine refinement (close to the
  // identity) keeps the value of the drawing it started from.
  function overlapOf(U, i) {
    if (U.ov[i] === undefined) {
      const F = inputLevel(U, 0);
      U.ov[i] = (meanDistTo(F.f[i], F.f[i + 1]) + meanDistTo(F.f[i + 1], F.f[i])) / 2;
    }
    return U.ov[i];
  }

  // Apply an affine map [a, b, c, d, e, f]: (x, y) → (a x + b y + e, c x + d y + f) to the input.
  function transformInput(U, A) {
    const pts = U.pts.map((s) => s.map((p) => [A[0] * p[0] + A[1] * p[1] + A[4], A[2] * p[0] + A[3] * p[1] + A[5]]));
    const V = buildInput(pts, U.w);
    V.affine = A;
    V.ov = U.ov;
    return V;
  }

  // ---------------------------------------------------------------------------------------------
  // Character alignment: DP over (user strokes consumed, template strokes used)
  // ---------------------------------------------------------------------------------------------
  const T_MATCH = 1, T_MERGE = 2, T_SPLIT = 3, T_EXTRA = 4, T_DUP = 5, T_SPLIT3 = 6;

  // Scratch buffers for the DP, grown on demand (align is not re-entrant, nor needs to be).
  let dpBuf = new Float64Array(1024), btBuf = new Int8Array(1024), bjBuf = new Int8Array(1024);

  // Align input U with template T at level lv. Returns { cost, steps, missing, nStruct, T, U }, where
  // cost is the weighted mean stroke distance plus penalties, and steps lists, in the user's order,
  // { type: 'match'|'merge'|'split'|'dup'|'extra', u: [user strokes], t: [template strokes], fwd, rev }
  // ('split': two or three consecutive user strokes are the pieces of one template stroke — for a ゜ / 。, two
  // arcs closing its loop; 'dup': two consecutive user strokes are the same template stroke drawn twice; `keep`
  // is the copy that fits better, fwd / rev are its distances).
  // With lite = true only the cost is returned (no steps): used by the coarse pass. With noMerge = true no
  // body strokes may be joined (the "stroke left out" reading, see missingReading).
  function align(U, T, lv, lite, noMerge) {
    lv = lv || 0;
    const k = U.n, m = T.n, W = T.W, w = T.w;
    const F = inputLevel(U, lv), G = T.L[lv];
    const dist = lv ? lockstep : dtw;
    // 1:1 pair costs in both directions; pc = weighted cost the DP uses
    const fw = new Float64Array(k * m), rv = new Float64Array(k * m), pc = new Float64Array(k * m);
    for (let i = 0; i < k; i++) {
      const judgeU = U.len[i] >= P.JUDGE_U_LEN;
      for (let j = 0; j < m; j++) {
        const o = i * m + j;
        if (T.isMark[j]) {
          const g = centredInput(U, F, i);
          const off = Math.hypot(U.c[i][0] - T.c[j][0], U.c[i][1] - T.c[j][1]);
          const pos = P.MARK_K * Math.max(0, off - P.MARK_TOL);
          let df = dist(g, G.fc[j]), dr = dist(g, G.rc[j]);
          if (T.loop[j] && U.closed[i]) {
            for (const h of loopStarts(U, F, i)) { df = Math.min(df, dist(h, G.fc[j])); dr = Math.min(dr, dist(h, G.rc[j])); }
          }
          const arc = !T.loop[j] && inLoop(U, F, i, lv) ? P.LOOP_TICK : 0; // half of a ゜ is no ゛ tick
          fw[o] = df + pos + arc;
          rv[o] = dr + pos + arc;
        } else {
          // relative length: DTW tolerates a stroke that is too short or too long; make it count a little
          const lr = P.LEN_W * Math.abs(Math.log((U.len[i] + 0.05) / (T.len[j] + 0.05)));
          const tk = P.TURN_W * Math.min(U.tw[i], T.tw[j]);
          fw[o] = dist(F.f[i], G.f[j]) + lr + tk * Math.abs(U.turn[i] - T.turn[j]);
          rv[o] = dist(F.f[i], G.r[j]) + lr + tk * Math.abs(U.turn[i] + T.turn[j]);
        }
        // a reversed judged stroke costs a little extra (direction-defined look-alikes)
        pc[o] = w[j] * Math.min(fw[o], rv[o] + (judgeU && T.judge[j] ? P.P_DIR : 0));
      }
    }
    // merges (user wrote fewer strokes than the template) and splits / retraced strokes (more)
    let mfw = null, mrv = null, mc = null, sfw = null, srv = null, sc = null, dc = null, s3fw = null, s3rv = null, s3c = null;
    if (k < m) {
      const n2 = k * (m - 1);
      mfw = new Float64Array(n2).fill(Infinity); mrv = new Float64Array(n2).fill(Infinity); mc = new Float64Array(n2).fill(Infinity);
      for (let i = 0; i < k; i++) {
        if (U.dot[i]) continue;
        for (let j = 0; j < m - 1; j++) {
          const o = i * (m - 1) + j;
          if (T.isMark[j] || T.isMark[j + 1]) {
            // a ゛/゜ is never written in one stroke with the body; the two ゛ ticks often are (quick writing):
            // compared centred with every way of joining them, plus the tolerant position term of a mark
            if (!(T.isMark[j] && T.isMark[j + 1])) continue;
            const ratio = U.len[i] / T.mlen;
            if (ratio < P.JOIN_RATIO[0] || ratio > P.JOIN_RATIO[1] || thickness(U, i) < P.JOIN_THICK) continue; // not a ゛
            const g = centredInput(U, F, i);
            const off = Math.hypot(U.c[i][0] - T.mc[0], U.c[i][1] - T.mc[1]);
            let d = Infinity;
            for (const s of G.mk) d = Math.min(d, dist(g, s));
            mfw[o] = mrv[o] = d + P.MARK_K * Math.max(0, off - P.MARK_TOL) + P.LEN_W * Math.abs(Math.log(ratio));
            mc[o] = (w[j] + w[j + 1]) * mfw[o] + P.P_MERGE_MARK * W;
          } else if (!noMerge) {
            const tk = P.TURN_W * U.tw[i];
            mfw[o] = dist(F.f[i], G.mf[j]) + tk * Math.abs(U.turn[i] - T.mturn[j]);
            mrv[o] = dist(F.f[i], G.mr[j]) + tk * Math.abs(U.turn[i] + T.mturn[j]);
            mc[o] = (w[j] + w[j + 1]) * Math.min(mfw[o], mrv[o]) + P.P_MERGE * W;
          }
        }
      }
    }
    if (k > m) {
      const n2 = (k - 1) * m;
      sfw = new Float64Array(n2).fill(Infinity); srv = new Float64Array(n2).fill(Infinity); sc = new Float64Array(n2).fill(Infinity);
      dc = new Float64Array(n2).fill(Infinity);
      for (let i = 0; i + 1 < k; i++) {
        // a broken stroke goes on near where it stopped (a speck may be anywhere: see structureOf)
        const broken = continues(U, i);
        const g = broken ? splitFeatures(U, F, i, lv, 2) : null;
        const longer = Math.max(U.len[i], U.len[i + 1]), shorter = Math.min(U.len[i], U.len[i + 1]);
        for (let j = 0; j < m; j++) {
          const o = i * m + j;
          if (T.isMark[j]) {
            // a ゜ (。) drawn as two arcs that close one loop: compared like the mark itself, from any start
            const lj = T.loop[j] ? loopJoin(U, F, i, lv) : null;
            if (lj) {
              const pos = P.MARK_K * Math.max(0, Math.hypot(lj.c[0] - T.c[j][0], lj.c[1] - T.c[j][1]) - P.MARK_TOL);
              let d = Math.min(dist(lj.g, G.fc[j]), dist(lj.g, G.rc[j]));
              for (const h of lj.rot || (lj.rot = rotations(lj.g))) d = Math.min(d, dist(h, G.fc[j]), dist(h, G.rc[j]));
              sfw[o] = srv[o] = d + pos;
              sc[o] = w[j] * sfw[o] + P.P_SPLIT_LOOP * W;
            }
            continue;
          }
          if (broken) {
            const tk = P.TURN_W * T.tw[j], tu = splitTurn(U, i, 2);
            sfw[o] = dist(g, G.f[j]) + tk * Math.abs(tu - T.turn[j]);
            srv[o] = dist(g, G.r[j]) + tk * Math.abs(tu + T.turn[j]);
            sc[o] = w[j] * Math.min(sfw[o], srv[o]) + P.P_SPLIT * W;
          }
          // the same (long) stroke drawn twice in a row: the better copy counts, the other one is charged P_DUP
          if (T.len[j] >= P.RETRACE_T_LEN && shorter >= P.RETRACE_RATIO * T.len[j] && longer <= P.RETRACE_LEN * shorter &&
            overlapOf(U, i) <= Math.min(P.RETRACE_ABS, P.RETRACE_TOL * longer)) {
            dc[o] = Math.min(pc[i * m + j], pc[(i + 1) * m + j]) + P.P_DUP * W;
          }
        }
      }
      // a stroke broken into three pieces (the pen lifted twice; not looked for in drawings with many more strokes)
      if (k >= m + 2 && k <= m + 3) {
        const n3 = (k - 2) * m;
        s3fw = new Float64Array(n3).fill(Infinity); s3rv = new Float64Array(n3).fill(Infinity); s3c = new Float64Array(n3).fill(Infinity);
        for (let i = 0; i + 2 < k; i++) {
          if (!continues(U, i) || !continues(U, i + 1)) continue;
          const g = splitFeatures(U, F, i, lv, 3), tu = splitTurn(U, i, 3);
          for (let j = 0; j < m; j++) {
            if (T.isMark[j]) continue;
            const o = i * m + j, tk = P.TURN_W * T.tw[j];
            s3fw[o] = dist(g, G.f[j]) + tk * Math.abs(tu - T.turn[j]);
            s3rv[o] = dist(g, G.r[j]) + tk * Math.abs(tu + T.turn[j]);
            s3c[o] = w[j] * Math.min(s3fw[o], s3rv[o]) + 2 * P.P_SPLIT * W;
          }
        }
      }
    }

    // DP over (user strokes consumed i, set of template strokes used mask)
    const S = 1 << m, size = (k + 1) * S;
    if (dpBuf.length < size) { dpBuf = new Float64Array(size); btBuf = new Int8Array(size); bjBuf = new Int8Array(size); }
    const dp = dpBuf, bt = btBuf, bj = bjBuf;
    dp.fill(Infinity, 0, size);
    dp[0] = 0;
    for (let i = 0; i < k; i++) {
      const speck = U.len[i] < P.SPECK_LEN;
      const next = (i + 1) * S, extra = (speck ? P.EXTRA_SPECK : P.EXTRA) * U.w[i] + (speck ? P.EXTRA_SPECK_ABS : P.EXTRA_ABS) * W;
      for (let mask = 0; mask < S; mask++) {
        const cur = dp[i * S + mask];
        if (cur === Infinity) continue;
        for (let j = 0; j < m; j++) {
          const bit = 1 << j;
          if (mask & bit) continue;
          let v = cur + pc[i * m + j], idx = next + (mask | bit);
          if (v < dp[idx]) { dp[idx] = v; bt[idx] = T_MATCH; bj[idx] = j; }
          if (mc && j + 1 < m && !(mask & (bit << 1))) {
            v = cur + mc[i * (m - 1) + j]; idx = next + (mask | bit | (bit << 1));
            if (v < dp[idx]) { dp[idx] = v; bt[idx] = T_MERGE; bj[idx] = j; }
          }
          if (sc && i + 1 < k) {
            v = cur + sc[i * m + j]; idx = next + S + (mask | bit);
            if (v < dp[idx]) { dp[idx] = v; bt[idx] = T_SPLIT; bj[idx] = j; }
            v = cur + dc[i * m + j];
            if (v < dp[idx]) { dp[idx] = v; bt[idx] = T_DUP; bj[idx] = j; }
          }
          if (s3c && i + 2 < k) {
            v = cur + s3c[i * m + j]; idx = next + 2 * S + (mask | bit);
            if (v < dp[idx]) { dp[idx] = v; bt[idx] = T_SPLIT3; bj[idx] = j; }
          }
        }
        const idx = next + mask, v = cur + extra;
        if (v < dp[idx]) { dp[idx] = v; bt[idx] = T_EXTRA; bj[idx] = -1; }
      }
    }
    // close: template strokes left unused are missing
    let best = Infinity, bestMask = 0;
    for (let mask = 0; mask < S; mask++) {
      let v = dp[k * S + mask];
      if (v === Infinity) continue;
      for (let j = 0; j < m; j++) if (!(mask & (1 << j))) v += P.MISS * w[j] + P.MISS_ABS * W;
      if (v < best) { best = v; bestMask = mask; }
    }
    if (lite) return { cost: best / W, T };
    // backtrack
    const steps = [];
    let i = k, mask = bestMask, nStruct = 0;
    while (i > 0) {
      const idx = i * S + mask, type = bt[idx], j = bj[idx];
      if (type === T_MATCH) {
        steps.push({ type: 'match', u: [i - 1], t: [j], fwd: fw[(i - 1) * m + j], rev: rv[(i - 1) * m + j] });
        mask &= ~(1 << j); i -= 1;
      } else if (type === T_MERGE) {
        const o = (i - 1) * (m - 1) + j;
        steps.push({ type: 'merge', u: [i - 1], t: [j, j + 1], fwd: mfw[o], rev: mrv[o] });
        mask &= ~(3 << j); i -= 1; nStruct++;
      } else if (type === T_SPLIT) {
        const o = (i - 2) * m + j;
        steps.push({ type: 'split', u: [i - 2, i - 1], t: [j], fwd: sfw[o], rev: srv[o] });
        mask &= ~(1 << j); i -= 2; nStruct++;
      } else if (type === T_SPLIT3) {
        const o = (i - 3) * m + j;
        steps.push({ type: 'split', u: [i - 3, i - 2, i - 1], t: [j], fwd: s3fw[o], rev: s3rv[o] });
        mask &= ~(1 << j); i -= 3; nStruct += 2;
      } else if (type === T_DUP) {
        const a = i - 2, b = i - 1, keep = pc[b * m + j] < pc[a * m + j] ? b : a;
        steps.push({ type: 'dup', u: [a, b], t: [j], keep, fwd: fw[keep * m + j], rev: rv[keep * m + j] });
        mask &= ~(1 << j); i -= 2; nStruct++;
      } else {
        steps.push({ type: 'extra', u: [i - 1], t: [] });
        i -= 1;
      }
    }
    steps.reverse();
    const missing = [];
    for (let j = 0; j < m; j++) if (!(bestMask & (1 << j))) missing.push(j);
    return { cost: best / W, steps, missing, nStruct, T, U, noMerge: !!noMerge };
  }

  // ---------------------------------------------------------------------------------------------
  // Affine refinement: weighted least-squares affine map user → template from the aligned strokes,
  // regularised toward the identity; the drawing is then aligned again.
  // ---------------------------------------------------------------------------------------------
  function fitAffine(al) {
    const { U, T } = al;
    let Sw = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0, Syy = 0;
    let Su = 0, Sv = 0, Sxu = 0, Syu = 0, Sxv = 0, Syv = 0;
    for (const st of al.steps) {
      if (st.type === 'extra' || st.t.some((j) => T.isMark[j])) continue; // fit the body, not the marks
      // the sequences the alignment compared, and the DTW correspondence between them
      const fwd = st.fwd <= st.rev, i = st.type === 'dup' ? st.keep : st.u[0], j = st.t[0];
      const F = inputLevel(U, 0), G = T.L[0];
      const a = st.type === 'split' ? splitFeatures(U, F, i, 0, st.u.length) : F.f[i];
      const b = st.type === 'merge' ? (fwd ? G.mf[j] : G.mr[j]) : (fwd ? G.f[j] : G.r[j]);
      const path = dtwPath(a, b);
      let w = 0;
      for (const jj of st.t) w += T.w[jj];
      w /= path.length / 2;
      for (let q = 0; q < path.length; q += 2) {
        const pi = 4 * path[q], tj = 4 * path[q + 1];
        const p = [a[pi], a[pi + 1]], t = [b[tj], b[tj + 1]];
        Sw += w; Sx += w * p[0]; Sy += w * p[1];
        Sxx += w * p[0] * p[0]; Sxy += w * p[0] * p[1]; Syy += w * p[1] * p[1];
        Su += w * t[0]; Sv += w * t[1];
        Sxu += w * p[0] * t[0]; Syu += w * p[1] * t[0]; Sxv += w * p[0] * t[1]; Syv += w * p[1] * t[1];
      }
    }
    if (Sw === 0) return null;
    const lam = P.AFF_REG * Sw;
    // normal equations for [a b e] / [c d f], ridge pulling the linear part toward the identity
    const M = [[Sxx + lam, Sxy, Sx], [Sxy, Syy + lam, Sy], [Sx, Sy, Sw]];
    const sx = solve3(M, [Sxu + lam, Syu, Su]), sy = solve3(M, [Sxv, Syv + lam, Sv]);
    if (!sx || !sy) return null;
    return [sx[0], sx[1], sy[0], sy[1], sx[2], sy[2]];
  }

  function solve3(M, r) {
    const [a, b, c] = M[0], [d, e, f] = M[1], [g, h, i] = M[2];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return null;
    const x = (r[0] * (e * i - f * h) - b * (r[1] * i - f * r[2]) + c * (r[1] * h - e * r[2])) / det;
    const y = (a * (r[1] * i - f * r[2]) - r[0] * (d * i - f * g) + c * (d * r[2] - r[1] * g)) / det;
    const z = (a * (e * r[2] - r[1] * h) - b * (d * r[2] - r[1] * g) + r[0] * (d * h - e * g)) / det;
    return [x, y, z];
  }

  // Penalty for how far an affine map is from the identity (rotation, shear, anisotropic scale).
  function affinePenalty(A) {
    const a = A[0], b = A[1], c = A[2], d = A[3];
    const det = a * d - b * c;
    if (det <= 0.2) return Infinity;
    const s = Math.sqrt(det);
    const na = a / s, nb = b / s, nc = c / s, nd = d / s;
    const rot = Math.atan2(nc - nb, na + nd);
    const cr = Math.cos(rot), sr = Math.sin(rot);
    // remove the rotation (R^T · L) and measure the remaining shear / anisotropy
    const l00 = cr * na + sr * nc, l01 = cr * nb + sr * nd, l10 = -sr * na + cr * nc, l11 = -sr * nb + cr * nd;
    const dev = Math.hypot(l00 - 1, l01, l10, l11 - 1);
    return P.AFF_ROT * Math.abs(rot) + P.AFF_DEV * dev + P.AFF_SCALE * Math.abs(Math.log(s));
  }

  // Each iteration fits the map on the current alignment and composes it with the previous one.
  function refine(U, al) {
    let best = al, cur = al, A = [1, 0, 0, 1, 0, 0];
    for (let it = 0; it < P.REFINE_ITERS; it++) {
      const B = fitAffine(cur);
      if (!B) break;
      // compose: x → B(A(x))
      A = [B[0] * A[0] + B[1] * A[2], B[0] * A[1] + B[1] * A[3], B[2] * A[0] + B[3] * A[2], B[2] * A[1] + B[3] * A[3],
        B[0] * A[4] + B[1] * A[5] + B[4], B[2] * A[4] + B[3] * A[5] + B[5]];
      const pen = affinePenalty(A);
      if (!(pen < P.AFF_MAX)) break;
      cur = align(transformInput(U, A), al.T, 0, false, al.noMerge);
      cur.cost += pen;
      cur.affine = A;
      cur.pen = pen;
      if (cur.cost < best.cost) best = cur; else break;
    }
    if (P.MARK_SHIFT > 0) {
      const sh = shiftMarks(best);
      if (sh && sh.cost < best.cost) best = sh;
    }
    return best;
  }

  // ゛/゜ placement varies a lot between writers (graft from candidate A): once the body is registered,
  // let the strokes matched to the marks move together, as one unit, towards the template's marks (at most
  // MARK_SHIFT, charged MARK_SHIFT_W per unit), then align again.
  function shiftMarks(al) {
    const { U, T } = al;
    let dx = 0, dy = 0, c = 0;
    const moved = new Set();
    for (const st of al.steps) {
      if (st.type === 'extra' || st.type === 'dup' || !T.isMark[st.t[0]]) continue;
      // a joined ゛ moves to the joined ticks' centre; a ゜ in two arcs (split) moves as one loop
      const i = st.u[0], to = st.type === 'merge' ? T.mc : T.c[st.t[0]];
      const from = st.type === 'split' ? loopJoin(U, inputLevel(U, 0), i, 0).c : U.c[i];
      dx += to[0] - from[0]; dy += to[1] - from[1]; c++;
      for (const u of st.u) moved.add(u);
    }
    if (!c) return null;
    dx /= c; dy /= c;
    const L = Math.hypot(dx, dy);
    if (L < 1e-3) return null;
    if (L > P.MARK_SHIFT) { dx *= P.MARK_SHIFT / L; dy *= P.MARK_SHIFT / L; }
    const V = buildInput(U.pts.map((s, i) => (moved.has(i) ? s.map((p) => [p[0] + dx, p[1] + dy]) : s)), U.w);
    V.affine = U.affine;
    V.ov = U.ov;
    const r = align(V, T, 0, false, al.noMerge);
    r.pen = al.pen || 0;
    r.cost += r.pen + P.MARK_SHIFT_W * Math.hypot(dx, dy);
    r.affine = al.affine;
    return r;
  }

  // ---------------------------------------------------------------------------------------------
  // Ranking
  // ---------------------------------------------------------------------------------------------
  // All variants of `ch` aligned with the input at level lv (best first).
  function alignChar(U, ch, lv, lite) {
    return BY_CHAR.get(ch).map((T) => align(U, T, lv, lite)).sort((a, b) => a.cost - b.cost);
  }

  // Score the candidate characters: a coarse pass over all of them, a fine pass over the shortlist
  // and the `focus` characters, then affine refinement of the leaders and of `focus`.
  // Returns [{ ch, al, alts: [fine alignment per variant] }] sorted by cost.
  // `must` characters (the target's family) are always scored and refined; `focus` characters (its
  // look-alikes) are always scored and refined when they are in contention.
  function rank(U, chars, focus, must) {
    focus = focus || [];
    must = must || [];
    const coarse = chars.map((ch) => ({ ch, cost: alignChar(U, ch, 1, true)[0].cost }));
    coarse.sort((a, b) => a.cost - b.cost);
    // more strokes than any kana attempt has (6 strokes + a retrace + a speck): a scribble or several attempts,
    // never accepted — a smaller search keeps judge() fast (the worst case is MAX_STROKES strokes)
    const many = U.n > P.MANY_STROKES;
    const fine = new Set(coarse.slice(0, many ? P.MANY_SHORTLIST : P.SHORTLIST).map((e) => e.ch));
    for (const ch of focus) fine.add(ch);
    for (const ch of must) fine.add(ch);
    const list = [...fine].map((ch) => { const alts = alignChar(U, ch, 0); return { ch, al: alts[0], alts }; });
    list.sort((a, b) => a.al.cost - b.al.cost);
    // refinement only lowers costs, and rarely by more than the window: skip hopeless candidates
    const limit = list[0].al.cost + P.REFINE_WINDOW;
    const toRefine = new Set(list.slice(0, many ? P.MANY_REFINE_TOP : P.REFINE_TOP).filter((e) => e.al.cost <= limit).map((e) => e.ch));
    for (const e of list) if (focus.includes(e.ch) && e.al.cost <= limit + P.FOCUS_WINDOW) toRefine.add(e.ch);
    for (const ch of must) toRefine.add(ch);
    for (const e of list) {
      if (!toRefine.has(e.ch)) continue;
      const keep = Math.min(P.RECOG_MAX + P.REFINE_HOPE, must.includes(e.ch) ? Infinity : focus.includes(e.ch) ? limit + P.FOCUS_WINDOW : limit);
      e.alts = e.alts.map((al) => (al.cost <= keep ? refine(U, al) : al)).sort((a, b) => a.cost - b.cost);
      e.al = e.alts[0];
    }
    list.sort((a, b) => a.al.cost - b.al.cost);
    return list;
  }

  // ---------------------------------------------------------------------------------------------
  // Interpreting an alignment: order, direction and count errors
  // ---------------------------------------------------------------------------------------------
  function structureOf(al) {
    const { U, T } = al;
    const steps = al.steps.map((st) => Object.assign({}, st, { u: st.u.slice(), t: st.t.slice() }));
    // The two ゛ marks are interchangeable: give them out in the order the user wrote them.
    const markSteps = steps.filter((st) => st.type === 'match' && T.isMark[st.t[0]]);
    const markIdx = markSteps.map((st) => st.t[0]).sort((a, b) => a - b);
    markSteps.forEach((st, q) => { st.t[0] = markIdx[q]; });

    const isSpeck = (i) => U.len[i] < P.SPECK_LEN;
    const mapping = new Array(U.n).fill(-1);
    const reversed = [];
    // extras = strokes the alignment left unmatched; specks = specks it paired with a stroke as a "broken"
    // stroke (reported as specks, see below); retraces = strokes drawn twice in a row
    const merges = [], splits = [], extras = [], specks = [], retraces = [];
    const seq = []; // non-extra steps in user order, with the user strokes that stand for them
    for (const st of steps) {
      if (st.type === 'extra') { extras.push(st.u[0]); continue; }
      if (st.type === 'split' && !T.isMark[st.t[0]] && st.u.some(isSpeck) && !st.u.every(isSpeck)) {
        // a speck next to a stroke is a stray tap or a pen bounce, not a piece of a broken stroke: it is reported
        // as a speck that belongs to no stroke (only the report changes; the cost and the verdict do not)
        for (const i of st.u) if (isSpeck(i)) specks.push(i);
        st.u = st.u.filter((i) => !isSpeck(i));
        if (st.u.length === 1) st.type = 'match';
      }
      let u = st.u;
      if (st.type === 'dup') {
        retraces.push({ user: st.u.slice(), dup: st.u[0] === st.keep ? st.u[1] : st.u[0], tpl: st.t[0] });
        u = [st.keep];
      }
      for (const i of u) mapping[i] = st.t[0];
      if (st.type === 'merge') merges.push({ user: st.u[0], tpl: st.t.slice() });
      if (st.type === 'split') splits.push({ user: st.u.slice(), tpl: st.t[0] });
      seq.push({ st, u });
      // direction: only long, non-mark strokes, and only with clear evidence
      const judgeT = st.t.some((j) => T.judge[j]);
      let ulen = 0;
      for (const i of u) ulen += U.len[i];
      if (judgeT && ulen >= P.JUDGE_U_LEN && st.rev + P.DIR_MARGIN < st.fwd) {
        for (const i of u) reversed.push(i);
      }
    }
    // order: read in the user's order, the template indices must increase. Two strokes exchanged are one swap.
    // Otherwise the misplaced strokes are those outside a longest increasing subsequence: one stroke written
    // too late (ほ's first stroke last) is ONE error, not a rotation of every stroke in between. Among equally
    // long subsequences the one that keeps the body strokes wins (a ゛ written first is what was misplaced).
    const keys = seq.map((x) => x.st.t[0]);
    const sorted = keys.slice().sort((a, b) => a - b);
    const off = [];
    keys.forEach((t, q) => { if (t !== sorted[q]) off.push(q); });
    let bad = [], swap = false;
    if (off.length === 2 && keys[off[0]] === sorted[off[1]] && keys[off[1]] === sorted[off[0]]) {
      bad = off;
      swap = true;
    } else if (off.length) {
      const n = keys.length, val = keys.map((t) => (T.isMark[t] ? 1000 : 1001));
      const best = new Array(n), prev = new Array(n).fill(-1);
      for (let q = 0; q < n; q++) {
        best[q] = val[q];
        for (let p = 0; p < q; p++) if (keys[p] < keys[q] && best[p] + val[q] > best[q]) { best[q] = best[p] + val[q]; prev[q] = p; }
      }
      let end = 0;
      for (let q = 1; q < n; q++) if (best[q] > best[end]) end = q;
      const keep = new Set();
      for (let q = end; q >= 0; q = prev[q]) keep.add(q);
      for (let q = 0; q < n; q++) if (!keep.has(q)) bad.push(q);
    }
    const misplaced = bad.map((q) => ({ user: seq[q].u[0], users: seq[q].u, tpl: keys[q], slot: sorted[q] }));
    const orderErrors = [];
    for (const e of misplaced) for (const i of e.users) orderErrors.push({ user: i, expected: e.tpl });
    reversed.sort((a, b) => a - b);
    // every user stroke that is not (part of) a template stroke: unmatched strokes, specks, second copies
    const extraAll = extras.concat(specks, retraces.map((r) => r.dup)).sort((a, b) => a - b);
    return {
      mapping, reversed, orderErrors, misplaced, swap, merges, splits, extras, specks, retraces, missing: al.missing.slice(),
      extraAll, speckAll: extraAll.filter(isSpeck),
    };
  }

  // The JudgeResult's structure field (docs/SPEC.md): which user strokes are merged / split / extra, which
  // template strokes are missing, which user strokes are misplaced (the same strokes as orderErrors).
  function publicStructure(st, withOrder) {
    const num = (a, b) => a - b;
    return {
      merged: st.merges.map((m) => m.user).sort(num),
      split: st.splits.flatMap((s) => s.user).sort(num),
      extra: st.extraAll.slice(),
      specks: st.speckAll.slice(),
      missing: st.missing.slice(),
      misplaced: withOrder ? st.orderErrors.map((e) => e.user).sort(num) : [],
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Korean messages
  // ---------------------------------------------------------------------------------------------
  const nth = (i) => `${i + 1}번째`;
  // "왼쪽→오른쪽" + 으로, "위→아래" + 로: 으로 after a final consonant other than ㄹ (graft from A)
  function withRo(word) {
    const c = String(word).charCodeAt(word.length - 1);
    const jong = c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0;
    return word + (jong && jong !== 8 ? '으로' : '로');
  }

  // "위→아래" style description of how a template stroke runs (null for loop-like strokes).
  function directionText(pts) {
    const a = pts[0], b = pts[pts.length - 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = polyLength(pts) || 1;
    if (Math.hypot(dx, dy) < 0.25 * L) return null;
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI; // y down: 90 = downwards
    const names = [
      [0, '왼쪽→오른쪽'], [45, '왼쪽 위→오른쪽 아래'], [90, '위→아래'], [135, '오른쪽 위→왼쪽 아래'],
      [180, '오른쪽→왼쪽'], [-180, '오른쪽→왼쪽'], [-135, '오른쪽 아래→왼쪽 위'], [-90, '아래→위'], [-45, '왼쪽 아래→오른쪽 위'],
    ];
    let best = null, bd = Infinity;
    for (const [d, s] of names) { const e = Math.abs(ang - d); if (e < bd) { bd = e; best = s; } }
    return best;
  }

  // Messages for the count / order / direction errors of an alignment. Numbers: "N번째로 쓴 획" is the user's
  // order, "원래 N번째 획" the template's.
  function structureIssues(st, al, target) {
    const issues = [];
    const T = al.T, U = al.U;
    if (st.merges.length || st.splits.length || st.extraAll.length) {
      if (T.n !== U.n) issues.push({ type: 'count', message: `획수가 달라요: ${T.n}획인데 ${U.n}획으로 썼어요.` });
      for (const r of st.retraces) {
        issues.push({ type: 'count', message: `${nth(r.user[0])}·${nth(r.user[1])}로 쓴 두 획은 같은 획(원래 ${r.tpl + 1}번째 획)을 두 번 그은 거예요. 한 획은 한 번에 그어요.` });
      }
      for (const i of st.extras.concat(st.specks).sort((a, b) => a - b)) {
        const what = U.len[i] < P.SPECK_LEN ? '작은 점' : '획';
        issues.push({ type: 'count', message: `${nth(i)}로 쓴 ${what}은 '${target}'에 없는 획이에요.` });
      }
      for (const mg of st.merges) {
        if (T.isMark[mg.tpl[0]]) issues.push({ type: 'count', message: '탁점(゛)은 두 번에 나눠 찍어요.' });
        else issues.push({ type: 'count', message: `${nth(mg.user)}로 쓴 획은 원래 ${mg.tpl[0] + 1}번째와 ${mg.tpl[1] + 1}번째 획을 이어 쓴 거예요. 두 획으로 떼어 써야 해요.` });
      }
      for (const sp of st.splits) {
        if (T.isMark[sp.tpl]) {
          issues.push({ type: 'count', message: target === '。' ? '。는 한 획으로 동그랗게 써요.' : `${markName(target)}은 한 획으로 동그랗게 써요.` });
          continue;
        }
        const who = sp.user.map(nth).join('·'), many = sp.user.length === 3 ? '세' : '두';
        issues.push({ type: 'count', message: `${who}로 쓴 ${many} 획은 원래 한 획(${sp.tpl + 1}번째 획)이에요. 이어서 써야 해요.` });
      }
    }
    // "N번째 획" without a qualifier only where the user's and the template's numbers are the same stroke
    const mp = st.misplaced;
    if (st.swap) {
      const plain = mp[0].user === mp[1].tpl && mp[1].user === mp[0].tpl;
      issues.push({ type: 'order', message: plain ? `${nth(mp[0].user)} 획과 ${nth(mp[1].user)} 획의 순서가 바뀌었어요.`
        : `${nth(mp[0].user)}로 쓴 획과 ${nth(mp[1].user)}로 쓴 획의 순서가 바뀌었어요.` });
    } else {
      let marksSaid = false;
      for (const e of mp) {
        if (!T.isMark[e.tpl]) issues.push({ type: 'order', message: `원래 ${e.tpl + 1}번째 획을 ${nth(e.user)}로 썼어요.` });
        else if (!marksSaid) {
          issues.push({ type: 'order', message: `${markName(target)}은 마지막에 써요.` });
          marksSaid = true;
        }
      }
    }
    for (const i of st.reversed) {
      const j = st.mapping[i];
      const dir = j >= 0 ? directionText(T.raw[j]) : null;
      const who = j >= 0 && j !== i ? `${nth(i)}로 쓴 획(원래 ${j + 1}번째 획)` : `${nth(i)} 획`;
      issues.push({ type: 'direction', message: `${who}을 반대 방향으로 썼어요.` + (dir ? ` (${withRo(dir)} 써야 해요)` : '') });
    }
    return issues;
  }

  // ---------------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------------
  function emptyResult(target, k, got) {
    return {
      verdict: 'wrong', target, recognized: null, variantId: null, confusedWith: null, crossScript: false,
      strokeCount: { expected: k ? k.strokeCount : 0, got }, mapping: [], reversed: [], orderErrors: [],
      structure: { merged: [], split: [], extra: [], specks: [], missing: [], misplaced: [] },
      issues: [], notes: [], candidates: [], score: 1, keypoints: null,
    };
  }

  // Top 5 candidates. In box mode a small kana and its big twin (same shape) are named by the drawing's size,
  // once.
  function candidatesOf(list, pl) {
    const out = [], seen = new Set();
    for (const e of list) {
      if (out.length === 5) break;
      const ch = pl ? bySize(e.ch, pl, null) : e.ch;
      if (seen.has(ch)) continue;
      seen.add(ch);
      out.push({ ch, variantId: e.al.T.variantId, score: +e.al.cost.toFixed(4) });
    }
    return out;
  }

  // Box mode: 、 。 compete only with a drawing small enough to be one, ー only with a flat one.
  function boxPool(chars, pl) {
    if (!pl) return chars;
    return chars.filter((c) => !XINFO[c] || (XINFO[c].marks ? pl.L <= BOX.PUNCT_POOL : c !== 'ー' || pl.h <= BOX.BAR_FLAT * pl.w));
  }

  // The candidate pool: opts.pool (kana only; with a box, extras too) or every kana (with a box: kana + extras).
  function poolOf(opts, box) {
    const known = (c) => !!KANA[c] || (box && !!XINFO[c]);
    const pool = opts && Array.isArray(opts.pool) && opts.pool.length ? opts.pool.filter(known) : null;
    return pool && pool.length ? pool : box ? BOX_CHARS : ALL_CHARS;
  }

  const scriptName = (ch) => (info(ch).script === 'kata' ? '가타카나' : info(ch).script === 'hira' ? '히라가나' : '기호');
  // Korean particle after a kana read aloud: only ん/ン end in a consonant (받침).
  const josa = (ch, vowel, consonant) => (ch === 'ん' || ch === 'ン' ? consonant : vowel);
  const same = (a, b) => !!a && !!b && TWINS.get(a).has(b);
  const markName = (ch) => (info(ch).group === 'handakuten' ? '반탁점(゜)' : '탁점(゛)');
  // じ/ぢ, ず/づ, お/を (and katakana): the same reading in the same script, different letters
  const homophone = (a, b) => a !== b && info(a).script === info(b).script && !!info(a).ko && info(a).ko === info(b).ko;
  function homophoneMessage(target, rec) {
    const k = info(target);
    const how = k.base ? `(${k.base}+${k.group === 'handakuten' ? '゜' : '゛'})` : '';
    return `'${rec}'${josa(rec, '와', '과')} 발음은 같지만 '${target}'${how}${josa(target, '를', '을')} 써야 해요.`;
  }

  // Box mode (words): the long-vowel mark ー written for a vowel kana, or a vowel kana for ー. Hiragana words
  // spell a long vowel with a vowel kana (おかあさん), katakana words with ー (コーヒー).
  const VOWELS = new Set('あいうえおアイウエオぁぃぅぇぉァィゥェォ');
  function longVowelMessage(target, rec) {
    if (target === 'ー' && VOWELS.has(rec)) return '이 칸은 장음 표시 ー예요. 모음 글자 대신 ー를 가로로 길게 써요.';
    if (rec !== 'ー' || !VOWELS.has(target)) return null;
    return info(target).script === 'hira' ? `히라가나에서는 장음을 ー로 쓰지 않고 '${target}'처럼 모음 글자로 써요.`
      : `'${target}' 자리에 장음 표시 ー를 썼어요.`;
  }

  // A ゛/゜ explanation when the drawing is the target's base, a marked form of it, or the other mark.
  function markRelation(target, rec) {
    const kt = info(target), kr = info(rec);
    if (same(kt.base, rec)) return `${markName(target)}이 빠졌어요.`;
    if (same(kr.base, target)) return `'${target}'에는 ${markName(rec)}이 없어요.`;
    if (kt.base && same(kt.base, kr.base)) return `${markName(rec)}이 아니라 ${markName(target)}을 써야 해요.`;
    return null;
  }

  // The target's close relatives: declared look-alikes, the other-script pair and (graft from A) the
  // ゛/゜ family (base, voiced / semi-voiced forms). Against these the target gets almost no benefit of
  // the doubt, and they are always compared, whatever opts.pool says. `sized` (box mode, or an extra as the
  // target): extras take part, and with every relative comes its small / big twin.
  function closeSet(target, sized) {
    const k = info(target), twins = sized ? twinsOf(target, true) : TWINS.get(target);
    const close = new Set([...k.confusables, k.pair]);
    // a same-shape twin's look-alikes are the target's too: the twin's form counts as the target (り's い for リ), so a
    // restricted pool must still compare them (with opts.pool = the katakana, い drawn for リ was accepted as り's form)
    for (const t of TWINS.get(target) || []) if (t !== target && info(t)) for (const c of info(t).confusables || []) close.add(c);
    if (k.base) close.add(k.base);
    for (const ch of sized ? BOX_CHARS : ALL_CHARS) {
      const b = info(ch).base;
      if (b && (b === target || (k.base && b === k.base) || twins.has(b))) close.add(ch);
    }
    if (sized) for (const c of [...close]) if (c && sizeTwin(c)) close.add(sizeTwin(c));
    for (const c of twins) close.delete(c);
    for (const c of [...close]) if (!c || !info(c)) close.delete(c);
    return close;
  }

  // Characters whose drawing counts as the target's shape: same-shape twins (へ/ヘ) and, when `sized`, the
  // small / big twin (っ/つ: the same shape, told apart by size in box mode).
  function twinsOf(target, sized) {
    const tw = sizeTwin(target);
    if (!sized || !tw) return TWINS.get(target);
    return new Set([...TWINS.get(target), ...TWINS.get(tw)]);
  }

  // Rank the candidates for a target and pick out what the decision needs. pl = the drawing's placement in
  // the cell (box mode) or null.
  function analyse(U, target, opts, pl) {
    const sized = !!pl || !KANA[target];
    const twins = twinsOf(target, sized);
    const close = closeSet(target, sized);
    // candidates: the pool plus the target's own family and close relatives (a restricted pool must never
    // turn a look-alike into a false ○); in box mode 、 。 ー only compete with a drawing that could be one
    const chars = boxPool(poolOf(opts, !!pl), pl).slice();
    const inPool = new Set(chars);
    for (const c of [...twins, ...close]) if (!inPool.has(c)) { chars.push(c); inPool.add(c); }
    const list = rank(U, chars, [...close], [...twins]);

    let tgt = null;
    for (const e of list) if (twins.has(e.ch)) { tgt = e; break; }

    // which accepted form did the user write? prefer forms that need no merge/split. The target's own forms (and
    // its same-shape twins') first: the small / big twin's form (ッ for ツ in box mode) has the same shape, but its
    // checkpoints are not the target's, which would leave the target's key points unjudged (no rings in a cell)
    let form = null, formCost = Infinity;
    const tw = sizeTwin(target);
    for (const ownOnly of [true, false]) {
      for (const e of list) {
        if (!twins.has(e.ch) || (ownOnly && e.ch !== target && e.ch === tw)) continue;
        for (const al of e.alts) {
          const c = al.cost + P.VAR_STRUCT * al.nStruct;
          if (c < formCost) { formCost = c; form = al; }
        }
      }
      if (form) break;
    }
    const st = structureOf(form);
    return { list, twins, close, tgt, form, st };
  }

  function explainPenalty(st) {
    return (st.orderErrors.length ? P.LOOK_ORDER : 0) + (st.reversed.length ? P.LOOK_DIR : 0) +
      P.LOOK_STRUCT * (st.merges.length + st.splits.length);
  }

  // Writing mistakes a reading needs: each misplaced stroke (a swap counts once), each reversed stroke, each
  // merge / pen lift inside a stroke / retraced / extra / missing stroke.
  function mistakes(st) {
    let lifts = 0;
    for (const s of st.splits) lifts += s.user.length - 1;
    return (st.swap ? 1 : st.misplaced.length) + st.reversed.length + st.merges.length + lifts +
      st.retraces.length + st.extras.length + st.specks.length + st.missing.length;
  }

  // Weighted mean stroke distance over the template strokes an alignment matched (missing and extra strokes
  // and penalties left out).
  function fitMean(al) {
    let s = 0, w = 0;
    for (const st of al.steps) {
      if (st.type === 'extra') continue;
      let ww = 0;
      for (const j of st.t) ww += al.T.w[j];
      s += ww * Math.min(st.fwd, st.rev);
      w += ww;
    }
    return w ? s / w : Infinity;
  }

  // A drawing that left a stroke out can pass for a joined or shorter accepted form: ふ without its dot
  // reads as the 3-stroke form, お without its bar as "bar and curve connected". When the chosen form joins
  // body strokes, or another form of the target has more strokes, the drawing is also aligned with each
  // longer form with joining forbidden. If every user stroke then matches one template stroke and the
  // matched strokes fit clearly better than the form's (MISS_READ), a stroke was left out (✕): that reading
  // is returned. Otherwise null (the form stands).
  function missingReading(U, an) {
    const form = an.form;
    const bodyMerge = form.steps.some((st) => st.type === 'merge' && !form.T.isMark[st.t[0]]);
    let best = null;
    for (const ch of an.twins) for (const T of BY_CHAR.get(ch)) {
      if (T.n <= U.n || (!bodyMerge && T.n <= form.T.n)) continue;
      const al = refine(U, align(U, T, 0, false, true));
      if (!al.missing.length || al.steps.some((st) => st.type !== 'match')) continue;
      const mm = fitMean(al);
      if (!best || mm < best.mm) best = { mm, al };
    }
    if (!best || !(best.mm - fitMean(form) < P.MISS_READ)) return null;
    // り written in one stroke (the left stroke, a rising connector, the right stroke) is not its two-stroke form short of a
    // stroke when the drawn stroke has all three parts (tools/bench/natural: connected り with a short left part, a low join
    // or a rounded top read as "1번째 획이 빠졌어요"). One stroke only: with more, the other strokes hold the registration
    // and さ / き without their last stroke do run a little along their connectors.
    if (U.n === 1 && form.T.n === 1 && best.al.T.n === 2 && best.al.missing.length === 1 && joinedRun(U, form) >= P.JOIN_RUN) return null;
    // そ / ぞ written in their textbook one-stroke (standard) form with a short lead-in are not their two-stroke form short
    // of its first stroke: when the "left out" stroke is where the longer form splits the chosen standard form's stroke
    // (it continues into the next stroke), and the drawing has some ink on it, the standard form stands
    const Tl = best.al.T, miss = best.al.missing.filter((j) => !Tl.isMark[j]);
    if (form.T.variantId === 'std' && U.n === form.T.n && Tl.n === form.T.n + 1 && miss.length === 1) {
      const j = miss[0], end = (q) => Tl.pts[q][Tl.pts[q].length - 1], gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      // (the joint itself does not count: the next stroke starts there anyway)
      const at = j + 1 < Tl.n && gap(end(j), Tl.pts[j + 1][0]) < 0.05 ? end(j) : j > 0 && gap(end(j - 1), Tl.pts[j][0]) < 0.05 ? Tl.pts[j][0] : null;
      if (at && inkOn(best.al, j, at) >= P.MISS_INK) return null;
    }
    return best.al;
  }
  // The stroke whose flick (はね) a near twin's note is about (り: its left stroke; リ writes it without one), and how far
  // the pen rises after the lowest point of the drawn stroke an alignment matched to template stroke j (in its last 60 %),
  // × the stroke's height; NaN without a one-to-one match.
  const TWIN_FLICK = { 'り': 0 };
  function flickRise(U, al, j) {
    const st = al.steps.find((x) => x.type === 'match' && x.t[0] === j);
    if (!st || U.pts[st.u[0]].length < 2) return NaN;
    const p = resample(st.rev < st.fwd ? U.pts[st.u[0]].slice().reverse() : U.pts[st.u[0]], 40);
    let y0 = Infinity, y1 = -Infinity;
    for (const q of p) { if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
    let lo = Math.floor(0.4 * p.length);
    for (let i = lo; i < p.length; i++) if (p[i][1] > p[lo][1]) lo = i;
    let top = p[lo][1];
    for (let i = lo; i < p.length; i++) if (p[i][1] < top) top = p[i][1];
    return (p[lo][1] - top) / Math.max(y1 - y0, 1e-6);
  }
  // A joined form (a variant with one stroke fewer than the standard form, two of whose strokes it writes as one, joined by
  // a straight connector): { k: that stroke of the form, a / b: the unit chords of the two joined strokes of the standard
  // form, v: the connector's unit vector (the end of the first → the start of the second), La / Lb / L: their lengths } in
  // the standard template's frame (the same frame: the connector lies inside the glyph), or null (also for a connector
  // shorter than JOIN_MIN or one that does not turn back, JOIN_BACK).
  function joinOf(T) {
    if (T.join !== undefined) return T.join;
    T.join = null;
    const S = T.variantId === 'std' ? null : (BY_CHAR.get(T.ch) || []).find((t) => t.variantId === 'std');
    if (S && S.n === T.n + 1) {
      let k = 0;
      while (k < T.n - 1 && Math.abs(T.len[k] - S.len[k]) < 0.02) k++;
      const unit = (p, q) => { const L = Math.hypot(q[0] - p[0], q[1] - p[1]); return { u: L > 0 ? [(q[0] - p[0]) / L, (q[1] - p[1]) / L] : [0, 0], L }; };
      const A = S.pts[k], Bs = S.pts[k + 1];
      const ca = unit(A[0], A[A.length - 1]), cv = unit(A[A.length - 1], Bs[0]), cb = unit(Bs[0], Bs[Bs.length - 1]);
      if (cv.L >= P.JOIN_MIN && ca.L > 0 && cb.L > 0 && cv.u[0] * cb.u[0] + cv.u[1] * cb.u[1] <= P.JOIN_BACK) T.join = { k, a: ca.u, La: ca.L, v: cv.u, L: cv.L, b: cb.u, Lb: cb.L };
    }
    return T.join;
  }
  // Does the drawn stroke that an alignment matched to a joined form's joined stroke write both strokes and the way from
  // one to the other: a run along the first stroke's chord, then along the connector, then along the second stroke's
  // chord, in that order? → the least of the three runs, each × its template length (best over the stroke, drawn in the
  // template's direction); 0 without a joined stroke. A stroke of り alone lacks one of the three (the left one with its
  // flick has nothing long after it; the right one alone no way up to it).
  function joinedRun(U, al) {
    const J = joinOf(al.T);
    const st = J ? al.steps.find((x) => x.type === 'match' && x.t[0] === J.k) : null;
    if (!st) return 0;
    const raw = st.rev < st.fwd ? U.pts[st.u[0]].slice().reverse() : U.pts[st.u[0]];
    const pts = raw.length > 1 ? resample(raw, 48) : raw, n = pts.length;
    const proj = (d) => pts.map((p) => p[0] * d[0] + p[1] * d[1]);
    // best[i] = the best min-run of the phases so far ending at point i; each phase extends it from an earlier point
    let best = new Array(n).fill(Infinity);
    for (const [d, L] of [[J.a, J.La], [J.v, J.L], [J.b, J.Lb]]) {
      const x = proj(d), next = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let h = 0; h <= i; h++) {
        const v = Math.min(best[h], (x[i] - x[h]) / L);
        if (v > next[i]) next[i] = v;
      }
      for (let i = 1; i < n; i++) if (next[i - 1] > next[i]) next[i] = next[i - 1]; // a phase may end before point i
      best = next;
    }
    return best[n - 1];
  }
  // How much of template stroke j has drawn ink on it (registered drawing al.U): the fraction of its points with a
  // drawn point within MISS_INK_R (points next to `joint`, where it meets the next stroke, left out).
  function inkOn(al, j, joint) {
    const S = shapeOf(al.T.pts[j]), R2 = P.MISS_INK_R * P.MISS_INK_R;
    let hit = 0, n = 0;
    for (const p of S.p) {
      if (joint && Math.hypot(p[0] - joint[0], p[1] - joint[1]) <= 1.5 * P.MISS_INK_R) continue;
      n++;
      let on = false;
      for (const s of al.U.pts) {
        for (const q of s) { const dx = q[0] - p[0], dy = q[1] - p[1]; if (dx * dx + dy * dy <= R2) { on = true; break; } }
        if (on) break;
      }
      if (on) hit++;
    }
    return n ? hit / n : 0;
  }

  // The character that beats the target, or null. Against an unrelated character the target gets the
  // benefit of the doubt (margin); against a close relative almost none (lookMargin), and each reading is
  // charged for the order / direction / count errors it needs, so the relative written properly beats the
  // target written wrongly (シ/ツ, ソ/ン, ナ/メ …) while a clear target with a reversed stroke stays △.
  function beaterOf(an, th, vetoed) {
    const { list, twins, close, tgt, st } = an;
    const tBase = tgt.al.cost, tPen = explainPenalty(st);
    const slack = Math.max(0, -Math.min(th.margin, th.lookMargin));
    for (const e of list) {
      if (twins.has(e.ch)) continue;
      if (e.al.cost > tBase + tPen + slack) break;
      if (close.has(e.ch)) {
        if (tBase + tPen > e.al.cost + explainPenalty(structureOf(e.al)) + th.lookMargin && !(vetoed && vetoed(e.ch))) return e;
      } else if (tBase > e.al.cost + th.margin) return e;
    }
    return null;
  }

  // =============================================================================================
  // Key points (판별 포인트): automatic per-stroke checkpoints
  // =============================================================================================
  // Every template stroke gets checkpoints derived from its KanjiVG geometry (nothing is hand-written):
  //   start / end   where the stroke begins and ends (registered frame)
  //   corner        a sharp turn inside the stroke (turning within a short arc window)
  //   loop          a self-crossing of the stroke, or an end curl of ≥ KP.CURL_TURN turns: measured as the turning
  //                 over the matching part of the drawn stroke (a loop that the pen left slightly open still turns)
  //   hook          how the last part of the stroke turns (a flick, a curl, or straight on): measured on every end
  //   dot           where a short stroke sits relative to its nearest stroke (direction between their centres)
  //   direction     the stroke's start → end direction as drawn (in the drawing's own frame; not for a stroke drawn
  //                 the other way round, whose direction is an order error)
  //   feature       the stroke's length next to the longest other stroke (log ratio)
  //   cross         how two strokes that come close meet: arc on each side of the meeting point, capped, and the
  //                 gap (an X crossing, a T junction, a stroke that stops at another or sticks out past it, apart)
  //   count         a stroke that a look-alike does not have (present or not; named in messages, not weighed)
  //   closure       per loop: how close the drawn stroke comes back onto itself there (0 = it crosses itself); public
  //                 kind 'loop'; reported (hit / failed / messages), not weighed (the loop's turning already is)
  // Look-alikes add checkpoints at their own features: a loop / corner of C on a stroke of T that has none there
  // becomes a T checkpoint "no loop here" (め against ぬ), and a pair of strokes that C joins becomes a cross point.
  // Each checkpoint is a measurement m(·) taken on the part of the drawing that corresponds to the template stroke
  // (alignment steps + a DTW correspondence along the stroke). The template gives m_T, every look-alike C (its
  // templates aligned to T's, exactly like a drawing) gives m_C. A checkpoint is CRITICAL against C when
  // |m_T − m_C| ≥ KP.CRIT σ (σ per kind: about the 90th percentile of |m_U − m_T| / 1.4 on rough-dev roughCorrect).
  // On a drawing: d_T = |m_U − m_T| / σ, d_C = |m_U − m_C| / σ; the evidence for C adds ρ(d_T) − ρ(d_C) over every
  // checkpoint that separates T and C by ≥ KP.SMIN σ, and a critical checkpoint is MISSED when the drawing is well
  // away from T (d_T ≥ HIT), on C's side ((d_C − d_T) / separation ≤ −MISS_Z) and C matches it there (d_C ≤ MATCH_C).
  const KP = {
    STEP: 0.025,        // dense resampling step of the measurements (character units) …
    DENSE_MAX: 160,     // … at most this many points per stroke
    SMOOTH: 1,          // moving-average half-width (points) before the turning is measured
    CUSP: 3.05,         // a single step turning more than this (rad) is a cusp (the pen reverses): it adds no rotation …
    CUSP_TURN: 2.6,     // … a template stroke turns back where it turns this much (rad) within ±CUSP_ARC of arc; loops are
    CUSP_ARC: 0.05,     //   measured without the turning within ±CUSP_ZONE of those points (a reversal drawn round a tiny loop)
    CUSP_ZONE: 0.08,
    LOOP_ARC: 0.12,     // template self-crossings enclosing less arc than this are not loops …
    CURL_TURN: 0.8,     // … an end curl without a crossing: the last CURL_SPAN of the stroke turns at least this (turns)
    CURL_SPAN: 0.45,
    CORNER_W: 0.05,     // corner detection: turning within ±CORNER_W of arc …
    CORNER_MIN: 0.85,   // … at least this (rad, ≈ 49°) …
    CORNER_EDGE: 0.07,  // … not within this of the stroke's start (KanjiVG entry artefacts)
    HOOK_ZONE: 0.3,     // a corner in the last HOOK_ZONE of a stroke, at most HOOK_MAX of arc from its end, is a hook
    HOOK_MAX: 0.3,
    LOOP_PAD: 0.06,     // measuring: hooks covered by a loop within this are left to the loop …
    LOOP_WIN: 1.5,      // … a loop's turning is taken over a stretch this many times its own arc …
    CORNER_MW: 0.09,    // … a corner's turning is taken within ±this …
    HOOK_H: 0.16,       // … an end's turning over the last max(this, the template's hook) of arc
    CUT_ZONE: 0.25,     // a merged stroke's halves: this much of each half next to the cut is not looked at for loops
    MIN_LEN: 0.12,      // strokes shorter than this get no direction / start / end / hook checkpoints
    DOT_LEN: 0.3,       // strokes shorter than this are dots (their place relative to the nearest stroke)
    NEAR: 0.1,          // two strokes closer than this (in T or a look-alike) get a cross checkpoint
    REL_CAP: 0.3,       // cross: arc on each side of the meeting point, capped at this …
    GAP_CAP: 0.2,       // … and the gap, capped at this; …
    REL_FADE: [0.04, 0.1], // … the arcs count fully when both meet within the first gap, not at all beyond the second
    // noise scale σ per kind (turns, rad, rad, rad, char, char, rad, char, char, log ratio, presence, char): about the
    // 90th percentile of |m_U − m_T| / 1.4 on rough-dev roughCorrect (tools/bench/scratch-kp-A/calib.js)
    SIG: { loop: 0.15, corner: 0.78, hook: 0.71, direction: 0.31, start: 0.15, end: 0.15, dot: 0.31, cross: 0.086, gap: 0.06, feature: 0.4, count: 0.3, closure: 0.06 },
    CLOSE_MIN: 0.15,    // closure: a stroke "comes back" to a point at least this far back along it (or half the loop) …
    CLOSE_CUSP: 0.15,   // … not within this of the template's reversals (template arc)
    BOGUS: [0.4, 2.5],  // a look-alike's stroke matched out of order to a template stroke this many times (outside) its length tells nothing
    CORNER_SAME: 0.12,  // a look-alike's corner this close to one of T's own (same stroke) is that corner
    SELF_LOOP: { lenient: 3.5, normal: 3, strict: 2.5 }, // the target's own loop left out: its turning this many σ short …
    SELF_OPEN: 0.1,     // … and the stroke not coming back onto itself there (closure at least this)
    ALONG: 0.06,        // a look-alike's extra stroke whose points lie this close (mean) to a template stroke runs along it
    EXTRA_NEAR: 0.2,    // a drawn stroke left over whose middle is this close to a look-alike's extra stroke is that stroke
    CRIT: 1.5,          // critical against C: |m_T − m_C| ≥ CRIT σ
    SMIN: 1.2,          // checkpoints that separate T and C by at least this (σ) take part in the evidence …
    HUBER: 2,           // … each adds ρ(d_T) − ρ(d_C), ρ = Huber with this knee …
    DCAP: 3,            // … on distances capped at this: a drawing far from both T and C there says nothing about either
    HIT: 1.0,           // a critical point is missed: the drawing is more than HIT σ from T …
    MISS_Z: 0.3,        // … on C's side: (d_C − d_T) / separation ≤ −MISS_Z …
    MATCH_C: 2.5,       // … and where C matches the drawing: d_C ≤ MATCH_C
    HIT_NC: 2.0,        // a non-critical point is hit within this many σ of the template
    WINDOW: 0.08,       // a look-alike can win on key points only when its shape cost is within this of the target's …
    GW: 0.5,            // … the evidence for it (Σ ρ(d_T) − ρ(d_C)) plus GW per 0.01 that C's shape cost is below T's …
    L: { lenient: 2.5, normal: 1.5, strict: 1 }, // … reaches this
    // which missed point a message names: kind weight × separation (≤ 5) × how clearly it is missed
    NAME_PRIO: { loop: 2, closure: 2, count: 3, cross: 1.8, dot: 1.6, corner: 1.5, hook: 1.4, direction: 1.2, feature: 1, start: 0.7, end: 0.7 },
    NAME_WIN: 0.04,     // a rejected drawing is named after a look-alike by its key points when that look-alike's shape cost is
    NAME_L: 0,          //   within NAME_WIN of the target's and its key-point score is at least NAME_L …
    NAME_PAIR_WIN: 0.02, // … instead of the other-script pair only within this of the pair's cost and …
    NAME_PAIR_L: 5,     // … with at least this score
  };

  // A polyline prepared for measuring: dense points by arc length, the turning at each point (radians, on a lightly
  // smoothed copy; a cusp adds none), its length and step.
  function shapeOf(pts) {
    const L = polyLength(pts);
    const n = Math.max(3, Math.min(KP.DENSE_MAX, Math.round(L / KP.STEP) + 1));
    const p = resample(pts, n);
    const k = KP.SMOOTH, sm = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = Math.min(k, i, n - 1 - i);
      let x = 0, y = 0;
      for (let q = i - r; q <= i + r; q++) { x += p[q][0]; y += p[q][1]; }
      sm[i] = [x / (2 * r + 1), y / (2 * r + 1)];
    }
    const tr = new Float64Array(n);
    let prev = null;
    for (let i = 1; i < n; i++) {
      const dx = sm[i][0] - sm[i - 1][0], dy = sm[i][1] - sm[i - 1][1];
      if (dx * dx + dy * dy < 1e-14) continue;
      const a = Math.atan2(dy, dx);
      if (prev !== null) {
        let d = a - prev;
        if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
        tr[i - 1] = Math.abs(d) > KP.CUSP ? 0 : d;
      }
      prev = a;
    }
    let cx = 0, cy = 0;
    for (const q of p) { cx += q[0]; cy += q[1]; }
    return { p, tr, n, L, h: L / (n - 1), c: [cx / n, cy / n] };
  }
  // Total turning (rad) of a shape between arc positions s0 and s1.
  function netTurn(S, s0, s1) {
    if (!(S.h > 0)) return 0;
    const i0 = Math.max(1, Math.ceil(s0 / S.h - 1e-9)), i1 = Math.min(S.n - 2, Math.floor(s1 / S.h + 1e-9));
    let t = 0;
    for (let i = i0; i <= i1; i++) t += S.tr[i];
    return t;
  }
  function pointAt(S, s) {
    if (!(S.h > 0)) return S.p[0].slice();
    const x = Math.max(0, Math.min(S.n - 1, s / S.h)), i = Math.min(S.n - 2, Math.floor(x)), t = x - i;
    return [S.p[i][0] + t * (S.p[i + 1][0] - S.p[i][0]), S.p[i][1] + t * (S.p[i + 1][1] - S.p[i][1])];
  }
  // Segment ab × segment cd → [t on ab, u on cd] or null.
  function segCross(a, b, c, d) {
    const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    const qx = c[0] - a[0], qy = c[1] - a[1];
    const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
  }

  // Features of one template stroke (shape S, oriented as written): loops, corners and the end hook.
  function strokeFeatures(S) {
    const loops = [], corners = [];
    let hook = null;
    // self-crossings → loops (the arc between the two passes)
    for (let i = 0; i + 1 < S.n; i++) {
      for (let j = i + 2; j + 1 < S.n; j++) {
        const x = segCross(S.p[i], S.p[i + 1], S.p[j], S.p[j + 1]);
        if (!x) continue;
        const a = (i + x[0]) * S.h, b = (j + x[1]) * S.h;
        if (b - a < KP.LOOP_ARC) continue;
        if (loops.some((l) => a < l.b && b > l.a)) continue; // nested / overlapping: the first one stands
        loops.push({ a, b });
      }
    }
    // an end curl that does not cross itself (a loop left open)
    if (!loops.some((l) => l.b > S.L * (1 - KP.CURL_SPAN))) {
      const a = S.L * (1 - KP.CURL_SPAN), t = netTurn(S, a, S.L);
      if (Math.abs(t) >= KP.CURL_TURN * 2 * Math.PI) loops.push({ a, b: S.L, curl: true });
    }
    for (const l of loops) {
      l.sign = Math.sign(netTurn(S, l.a, l.b)) || 1;
      let cx = 0, cy = 0, c = 0;
      for (let i = Math.ceil(l.a / S.h); i <= Math.floor(l.b / S.h); i++) { cx += S.p[i][0]; cy += S.p[i][1]; c++; }
      l.at = c ? [cx / c, cy / c] : pointAt(S, (l.a + l.b) / 2);
    }
    // corners: local maxima of the windowed turning, outside loops and the entry zone
    const win = [];
    for (let i = 0; i < S.n; i++) win.push(netTurn(S, i * S.h - KP.CORNER_W, i * S.h + KP.CORNER_W));
    for (let i = 1; i + 1 < S.n; i++) {
      const s = i * S.h, w = Math.abs(win[i]);
      if (w < KP.CORNER_MIN || s < KP.CORNER_EDGE || w < Math.abs(win[i - 1]) || w < Math.abs(win[i + 1])) continue;
      if (loops.some((l) => s > l.a - KP.CORNER_W && s < l.b + KP.CORNER_W)) continue;
      const last = corners[corners.length - 1];
      if (last && s - last.s < 2 * KP.CORNER_W) { if (w > Math.abs(last.turn)) corners.pop(); else continue; }
      corners.push({ s, turn: win[i], sign: Math.sign(win[i]) });
    }
    const c = corners[corners.length - 1];
    if (c && c.s >= S.L * (1 - KP.HOOK_ZONE) && S.L - c.s <= KP.HOOK_MAX) { hook = c; corners.pop(); }
    return { loops, corners, hook };
  }

  // Where two strokes meet: [arc before / after the meeting point on A (capped), the same on B, gap (capped)]
  // plus the point. The meeting point is the crossing nearest `near` (if they cross) or the closest approach.
  function relation(A, B, near) {
    let best = null, bd = Infinity;
    const pa = A.p, pb = B.p;
    for (let i = 0; i + 1 < A.n; i++) {
      const a0 = pa[i], a1 = pa[i + 1];
      const ax0 = Math.min(a0[0], a1[0]), ax1 = Math.max(a0[0], a1[0]), ay0 = Math.min(a0[1], a1[1]), ay1 = Math.max(a0[1], a1[1]);
      for (let j = 0; j + 1 < B.n; j++) {
        const b0 = pb[j], b1 = pb[j + 1];
        if (Math.max(b0[0], b1[0]) < ax0 || Math.min(b0[0], b1[0]) > ax1 || Math.max(b0[1], b1[1]) < ay0 || Math.min(b0[1], b1[1]) > ay1) continue;
        const x = segCross(a0, a1, b0, b1);
        if (!x) continue;
        const pt = [a0[0] + x[0] * (a1[0] - a0[0]), a0[1] + x[0] * (a1[1] - a0[1])];
        const d = near ? Math.hypot(pt[0] - near[0], pt[1] - near[1]) : 0;
        if (d < bd) { bd = d; best = { sa: (i + x[0]) * A.h, sb: (j + x[1]) * B.h, pt, gap: 0 }; }
      }
    }
    if (!best) {
      // closest approach (point of one to segment of the other, both ways)
      let g = Infinity;
      const scan = (P, Q, swap) => {
        for (let i = 0; i < P.n; i++) {
          const p = P.p[i];
          for (let j = 0; j + 1 < Q.n; j++) {
            const q0 = Q.p[j], q1 = Q.p[j + 1], dx = q1[0] - q0[0], dy = q1[1] - q0[1], L2 = dx * dx + dy * dy;
            let t = L2 > 0 ? ((p[0] - q0[0]) * dx + (p[1] - q0[1]) * dy) / L2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = p[0] - q0[0] - t * dx, ey = p[1] - q0[1] - t * dy, d = Math.sqrt(ex * ex + ey * ey);
            if (d < g) {
              g = d;
              const sp = i * P.h, sq = (j + t) * Q.h, pt = [p[0] - ex / 2, p[1] - ey / 2];
              best = swap ? { sa: sq, sb: sp, pt, gap: d } : { sa: sp, sb: sq, pt, gap: d };
            }
          }
        }
      };
      scan(A, B, false);
      scan(B, A, true);
    }
    const C = KP.REL_CAP;
    return { v: [Math.min(best.sa, C), Math.min(A.L - best.sa, C), Math.min(best.sb, C), Math.min(B.L - best.sb, C), Math.min(best.gap, KP.GAP_CAP)], pt: best.pt };
  }

  // DTW correspondence along a stroke: P (drawn part, oriented like the template stroke Q) → for each fraction of
  // Q's arc, the matching fraction of P's arc. Returns a function f_Q → f_P (monotone).
  function arcMap(P, Q) {
    const fP = features(P, false, 0), fQ = features(Q, false, 0);
    const nP = fP.length >> 2, nQ = fQ.length >> 2;
    if (nP < 2 || nQ < 2) return (f) => f;
    const path = dtwPath(fP, fQ);
    const sum = new Float64Array(nQ), cnt = new Float64Array(nQ);
    for (let q = 0; q < path.length; q += 2) { sum[path[q + 1]] += path[q]; cnt[path[q + 1]]++; }
    const tab = new Float64Array(nQ);
    for (let j = 0; j < nQ; j++) tab[j] = Math.max(j ? tab[j - 1] : 0, cnt[j] ? sum[j] / cnt[j] / (nP - 1) : (j ? tab[j - 1] : 0));
    return (f) => {
      const x = Math.max(0, Math.min(nQ - 1, f * (nQ - 1))), i = Math.min(nQ - 2, Math.floor(x)), t = x - i;
      return tab[i] + t * (tab[i + 1] - tab[i]);
    };
  }
  // The part of a drawing that stands for one template stroke: pts = the part in the registered frame, oriented like
  // the template stroke; e0 / e1 = its first / last point as drawn, in the drawing's own (unregistered) frame.
  // rev = drawn the other way round (its direction is then an order error, not a shape: no direction evidence).
  function partOf(pts, tpl, e0, e1, rev) {
    const S = shapeOf(pts), LT = polyLength(tpl);
    const map = arcMap(pts, tpl);
    return { S, LT, map, d0: e0, d1: e1, rev, at: (s) => map(LT > 0 ? Math.max(0, Math.min(1, s / LT)) : 0) * S.L };
  }
  // Template stroke j as its own drawing (identity correspondence).
  function selfPart(T, j) {
    const S = shapeOf(T.pts[j]);
    return { S, LT: S.L, map: (f) => f, d0: T.pts[j][0], d1: T.pts[j][T.pts[j].length - 1], at: (s) => Math.max(0, Math.min(S.L, s)) };
  }
  // Per template stroke: the drawn part that stands for it (or null: missing, or a ゛/゜ mark), from an alignment.
  // U0 = the drawing before registration (same strokes and points as al.U).
  function partsOf(al, U0) {
    const { U, T } = al;
    U0 = U0 || U;
    const out = new Array(T.n).fill(null);
    const first = (i) => U0.pts[i][0], last = (i) => U0.pts[i][U0.pts[i].length - 1];
    for (const st of al.steps) {
      if (st.type === 'extra') continue;
      const j = st.t[0];
      if (T.isMark[j]) continue;
      const fwd = st.fwd <= st.rev;
      if (st.type === 'match' || st.type === 'dup') {
        const i = st.type === 'dup' ? st.keep : st.u[0], drawn = U.pts[i];
        out[j] = partOf(fwd ? drawn : drawn.slice().reverse(), T.pts[j], first(i), last(i), !fwd);
      } else if (st.type === 'split') {
        // a speck next to a stroke is a tap or a pen bounce, not a piece of it (as in structureOf)
        let us = st.u.filter((i) => U.len[i] >= P.SPECK_LEN);
        if (!us.length) us = st.u;
        const drawn = [].concat(...us.map((i) => U.pts[i]));
        out[j] = partOf(fwd ? drawn : drawn.slice().reverse(), T.pts[j], first(us[0]), last(us[us.length - 1]), !fwd);
      } else if (st.type === 'merge') {
        // one drawn stroke for template strokes j, j+1: cut where the DTW puts the template's pen-up gap
        const i = st.u[0], drawn = U.pts[i], raw = U0.pts[i], n = drawn.length;
        const pts = fwd ? drawn : drawn.slice().reverse();
        const a = T.pts[j], b = T.pts[j + 1], La = T.len[j], Lb = T.len[j + 1];
        const gap = Math.hypot(b[0][0] - a[a.length - 1][0], b[0][1] - a[a.length - 1][1]);
        const uB = arcMap(pts, a.concat(b))((La + gap / 2) / (La + gap + Lb)) * polyLength(pts);
        let acc = 0, q = 1;
        for (; q < n - 1; q++) {
          const seg = Math.hypot(pts[q][0] - pts[q - 1][0], pts[q][1] - pts[q - 1][1]);
          if (acc + seg >= uB) break;
          acc += seg;
        }
        const seg = Math.hypot(pts[q][0] - pts[q - 1][0], pts[q][1] - pts[q - 1][1]);
        const t = seg > 0 ? Math.max(0, Math.min(1, (uB - acc) / seg)) : 0;
        const lerp = (P, k0, k1) => [P[k0][0] + t * (P[k1][0] - P[k0][0]), P[k0][1] + t * (P[k1][1] - P[k0][1])];
        const X = lerp(pts, q - 1, q);
        // the same cut on the unregistered stroke (point k of pts is point n-1-k of the stroke when reversed)
        const r0 = fwd ? q - 1 : n - q, r1 = fwd ? q : n - 1 - q, Xr = [raw[r0][0] + t * (raw[r1][0] - raw[r0][0]), raw[r0][1] + t * (raw[r1][1] - raw[r0][1])];
        const p1 = pts.slice(0, q).concat([X]), p2 = [X].concat(pts.slice(q));
        // as drawn: forward → part j runs from the stroke's start to the cut; reversed → from the cut to the stroke's end
        const s0 = raw[0], s1 = raw[n - 1];
        // the cut is only approximately where the pen would have been lifted: what happens at it is not measured
        out[j] = partOf(p1, a, fwd ? s0 : Xr, fwd ? Xr : s1, !fwd);
        out[j].cutEnd = true;
        out[j].merge = j + 1;
        if (!T.isMark[j + 1]) { out[j + 1] = partOf(p2, b, fwd ? Xr : s0, fwd ? s1 : Xr, !fwd); out[j + 1].cutStart = true; out[j + 1].merge = j + 1; }
      }
    }
    return out;
  }
  const selfParts = (T) => T.pts.map((_, j) => (T.isMark[j] ? null : selfPart(T, j)));

  // The largest turning (sign-aware, rad) of the shape over any stretch of arc length len between s0 and s1.
  // (tr = the shape's turning array, or a filtered copy of it)
  function maxTurn(S, tr, s0, s1, len, sign) {
    if (!(S.h > 0)) return 0;
    const i0 = Math.max(0, Math.floor(s0 / S.h)), i1 = Math.min(S.n - 1, Math.ceil(s1 / S.h)), w = Math.max(1, Math.round(len / S.h));
    if (i1 - i0 <= w) {
      let t = 0;
      for (let i = Math.max(1, i0); i <= Math.min(S.n - 2, i1); i++) t += tr[i];
      return sign * t;
    }
    let cur = 0;
    for (let i = i0 + 1; i < i0 + w && i < S.n - 1; i++) cur += tr[i];
    let best = sign * cur;
    for (let i = i0 + 1; i + w - 1 <= i1; i++) {
      // window (i, i + w - 1]: drop tr[i], add tr[i + w - 1]
      cur += (i + w - 1 < S.n - 1 ? tr[i + w - 1] : 0) - tr[i];
      if (sign * cur > best) best = sign * cur;
    }
    return best;
  }
  // The part's turning with the template's reversals taken out: within ±KP.CUSP_ZONE (template arc) of each point where
  // the template stroke turns back (≥ KP.CUSP_TURN within ±KP.CUSP_ARC), the turning counts as zero. Whether the pen
  // turns back in a sharp V or round a tiny loop there (the zigzags of ね ろ る れ わ) is not what tells look-alikes
  // apart. Cached on the part.
  function reversalFree(A, cusps) {
    if (A.trc) return A.trc;
    const S = A.S, tr = Float64Array.from(S.tr);
    if (S.h > 0) for (const c of cusps) {
      const i0 = Math.max(1, Math.floor(A.at(c - KP.CUSP_ZONE) / S.h)), i1 = Math.min(S.n - 2, Math.ceil(A.at(c + KP.CUSP_ZONE) / S.h));
      for (let i = i0; i <= i1; i++) tr[i] = 0;
    }
    return (A.trc = tr);
  }
  // Where a template stroke (shape S) turns back: arc positions of the local maxima of |turning| within ±CUSP_ARC
  // that reach CUSP_TURN.
  function cuspsOf(S) {
    const out = [];
    if (!(S.h > 0)) return out;
    const w = [];
    for (let i = 0; i < S.n; i++) w.push(Math.abs(netTurn(S, i * S.h - KP.CUSP_ARC, i * S.h + KP.CUSP_ARC)));
    for (let i = 1; i + 1 < S.n; i++) {
      if (w[i] < KP.CUSP_TURN || w[i] < w[i - 1] || w[i] < w[i + 1]) continue;
      if (out.length && i * S.h - out[out.length - 1] < 2 * KP.CUSP_ARC) continue;
      out.push(i * S.h);
    }
    return out;
  }
  // How close the drawn part comes back onto itself around a loop checkpoint: the smallest distance between a point
  // near the loop and any point at least half a loop (KP.CLOSE_MIN at least) earlier along the stroke; 0 when it
  // crosses itself (a closed loop), small for a loop the pen left slightly open, large for an open curve. Points near
  // the template's reversals (two arms of a zigzag run side by side) and next to a merge cut are left out.
  function closure(A, site) {
    const S = A.S;
    if (!(S.h > 0)) return KP.GAP_CAP;
    const sc = A.LT > 0 ? S.L / A.LT : 1, half = site.len / 2;
    const at = (t) => (t <= 0 ? 0 : t >= A.LT ? S.L : A.at(t));
    const j0 = Math.max(0, Math.floor(at(Math.max(site.lo, site.a - half)) / S.h)), j1 = Math.min(S.n - 1, Math.ceil(at(Math.min(site.hi, site.b + half)) / S.h));
    const gapIdx = Math.max(1, Math.round((Math.max(KP.CLOSE_MIN, half) * sc) / S.h));
    const bad = new Uint8Array(S.n);
    for (const c of site.cusps) {
      const i0 = Math.max(0, Math.floor(at(c - KP.CLOSE_CUSP) / S.h)), i1 = Math.min(S.n - 1, Math.ceil(at(c + KP.CLOSE_CUSP) / S.h));
      for (let i = i0; i <= i1; i++) bad[i] = 1;
    }
    if (A.cutStart) for (let i = 0; i < S.n && i * S.h < at(KP.CUT_ZONE * A.LT); i++) bad[i] = 1;
    if (A.cutEnd) for (let i = S.n - 1; i >= 0 && i * S.h > at(A.LT - KP.CUT_ZONE * A.LT); i--) bad[i] = 1;
    let best = KP.GAP_CAP * KP.GAP_CAP;
    for (let j = j0; j <= j1; j++) {
      if (bad[j]) continue;
      const pj = S.p[j];
      for (let i = 0; i <= j - gapIdx; i++) {
        if (bad[i]) continue;
        const dx = S.p[i][0] - pj[0], dy = S.p[i][1] - pj[1], d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }
  // The sharpest turn (sign-aware, rad) within ±CORNER_W of arc (scaled to the part's size) around any point of
  // the part between drawn arc positions s0 and s1.
  function sharpest(A, s0, s1, sign) {
    const S = A.S, w = KP.CORNER_W * (A.LT > 0 ? S.L / A.LT : 1);
    if (!(S.h > 0)) return 0;
    let best = -Infinity;
    for (let i = Math.max(0, Math.floor(s0 / S.h)); i <= Math.min(S.n - 1, Math.ceil(s1 / S.h)); i++) {
      const v = sign * netTurn(S, i * S.h - w, i * S.h + w);
      if (v > best) best = v;
    }
    return best === -Infinity ? 0 : best;
  }

  // The measurement of checkpoint `site` on a drawing given by its parts (null when the stroke(s) are missing).
  // asDrawn: a stroke drawn the other way round still gives its direction as drawn (a look-alike that writes the stroke
  // that way, e.g. シ's long stroke against ツ's; and the message of a drawing that is rejected anyway). Without it a
  // reversed stroke gives no direction (an order error of the target, △, is never evidence for a look-alike).
  function measure(site, parts, asDrawn) {
    const A = parts[site.j];
    if (site.kind === 'count') return A ? 1 : 0;
    if (!A) return null;
    const S = A.S;
    const B = site.k !== undefined ? parts[site.k] : null;
    if (site.k !== undefined && (!B || (A.merge && A.merge === B.merge))) return null; // two halves of one drawn stroke
    if ((A.cutEnd && (site.kind === 'end' || site.kind === 'hook' || (site.kind === 'corner' && site.s > A.LT - 2 * KP.CORNER_MW))) ||
      (A.cutStart && (site.kind === 'start' || (site.kind === 'corner' && site.s < 2 * KP.CORNER_MW)))) return null;
    switch (site.kind) {
      case 'loop': {
        // the most the drawn stroke turns (in the loop's sense) over a stretch a little longer than the loop,
        // anywhere between the template's neighbouring loops on that stroke (the correspondence along a stroke
        // with and without a loop is too loose to look only where the template has it)
        let s0 = site.lo <= 0 ? 0 : A.at(site.lo), s1 = site.hi >= A.LT ? S.L : A.at(site.hi);
        // next to a merge cut the pen's connector curls: not part of the stroke's own shape
        if (A.cutStart) s0 = Math.max(s0, A.at(Math.max(2 * KP.CORNER_MW, KP.CUT_ZONE * A.LT)));
        if (A.cutEnd) s1 = Math.min(s1, A.at(A.LT - Math.max(2 * KP.CORNER_MW, KP.CUT_ZONE * A.LT)));
        if (s1 <= s0) return null;
        return maxTurn(S, reversalFree(A, site.cusps), s0, s1, KP.LOOP_WIN * site.len * (A.LT > 0 ? S.L / A.LT : 1), site.sign) / (2 * Math.PI);
      }
      case 'closure': return closure(A, site);
      case 'corner': return sharpest(A, A.at(site.s - KP.CORNER_MW), A.at(site.s + KP.CORNER_MW), site.sign);
      case 'hook': return netTurn(S, A.at(A.LT - site.H), S.L);
      case 'direction': return (A.rev && !asDrawn) || A.merge ? null : Math.atan2(A.d1[1] - A.d0[1], A.d1[0] - A.d0[0]);
      case 'start': return S.p[0];
      case 'end': return S.p[S.n - 1];
      case 'dot': {
        const B = parts[site.k];
        return B ? [S.c[0] - B.S.c[0], S.c[1] - B.S.c[1]] : null;
      }
      case 'cross': {
        const B = parts[site.k];
        return B ? relation(S, B.S, site.near).v : null;
      }
      case 'feature': {
        const B = parts[site.k];
        return B ? Math.log(Math.max(S.L, 0.02) / Math.max(B.S.L, 0.02)) : null;
      }
    }
    return null;
  }
  const wrapAngle = (d) => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  // Distance between two measurements of a checkpoint, in σ.
  function kpDist(kind, a, b) {
    if (a === null || b === null) return NaN; // not comparable (a missing stroke, a reversed direction, a merge cut)
    switch (kind) {
      case 'loop': case 'corner': case 'hook': return Math.abs(a - b) / KP.SIG[kind];
      case 'direction': return Math.abs(wrapAngle(a - b)) / KP.SIG.direction;
      case 'start': case 'end': return Math.hypot(a[0] - b[0], a[1] - b[1]) / KP.SIG[kind];
      case 'dot': {
        if (Math.hypot(a[0], a[1]) < 0.03 || Math.hypot(b[0], b[1]) < 0.03) return Math.hypot(a[0] - b[0], a[1] - b[1]) / 0.15;
        return Math.abs(wrapAngle(Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]))) / KP.SIG.dot;
      }
      case 'cross': {
        // where along the strokes they meet matters only when they (nearly) meet in one of the two
        const w = Math.max(0, Math.min(1, (KP.REL_FADE[1] - Math.max(a[4], b[4])) / (KP.REL_FADE[1] - KP.REL_FADE[0])));
        let d = Math.abs(a[4] - b[4]) / KP.SIG.gap;
        for (let q = 0; q < 4; q++) d = Math.max(d, (w * Math.abs(a[q] - b[q])) / KP.SIG.cross);
        return d;
      }
      case 'feature': return Math.abs(a - b) / KP.SIG.feature;
      case 'closure': return Math.abs(a - b) / KP.SIG.closure;
      case 'count': return Math.abs(a - b) / KP.SIG.count;
    }
    return Infinity;
  }

  // A drawing's distances (σ) to T's and C's value at a checkpoint. Loops, corners and stroke lengths are amounts:
  // beyond C (even more of a loop than C, even rounder than C …) is as C-like as C itself.
  const AMOUNTS = new Set(['loop', 'corner', 'feature', 'closure']);
  function kpPair(kind, m, vT, vC) {
    const dT = kpDist(kind, m, vT);
    let dC = kpDist(kind, m, vC);
    if (AMOUNTS.has(kind) && m !== null && (m - vC) * (vC - vT) > 0) dC = 0;
    return [dT, dC];
  }

  // Checkpoint model of one template (lazy, cached): the sites, the template's values, and per look-alike variant
  // its values and the separation of each site.
  const KP_MODELS = new Map();
  function kpModel(T) {
    let M = KP_MODELS.get(T);
    if (M) return M;
    const own = selfParts(T);
    const feats = own.map((A) => (A ? strokeFeatures(A.S) : null));
    const sites = [];
    const add = (s) => { s.id = sites.length; sites.push(s); return s; };
    const body = [];
    for (let j = 0; j < T.n; j++) if (own[j]) body.push(j);
    for (const j of body) {
      const S = own[j].S, f = feats[j];
      for (const l of f.loops) add({ kind: 'loop', j, a: l.a, b: l.b, len: l.b - l.a, sign: l.sign, at: l.at, has: true, end: l.b > S.L - 0.15 * S.L, curl: !!l.curl });
      for (const c of f.corners) add({ kind: 'corner', j, s: c.s, sign: c.sign, at: pointAt(S, c.s), has: true });
      if (S.L >= KP.MIN_LEN) {
        add({ kind: 'hook', j, H: f.hook ? Math.max(KP.HOOK_H, S.L - f.hook.s + KP.CORNER_W) : KP.HOOK_H, at: f.hook ? pointAt(S, f.hook.s) : S.p[S.n - 1], has: true, hasHook: !!f.hook });
        const chord = Math.hypot(S.p[S.n - 1][0] - S.p[0][0], S.p[S.n - 1][1] - S.p[0][1]);
        if (chord >= 0.35 * S.L) add({ kind: 'direction', j, at: S.p[0], has: true });
        add({ kind: 'start', j, at: S.p[0], has: true });
        add({ kind: 'end', j, at: S.p[S.n - 1], has: true });
      }
      if (S.L < KP.DOT_LEN) {
        let k = -1, bd = Infinity;
        for (const q of body) {
          if (q === j) continue;
          const d = Math.hypot(own[q].S.c[0] - S.c[0], own[q].S.c[1] - S.c[1]);
          if (d < bd) { bd = d; k = q; }
        }
        if (k >= 0) add({ kind: 'dot', j, k, at: S.c, has: true });
      }
    }
    // how long each stroke is next to the longest other stroke (い/り, ア/マ, ユ/コ)
    if (body.length >= 2) for (const j of body) {
      let k = -1;
      for (const q of body) if (q !== j && (k < 0 || own[q].S.L > own[k].S.L)) k = q;
      if (sites.some((x) => x.kind === 'feature' && x.j === k && x.k === j)) continue; // the same ratio, inverted
      add({ kind: 'feature', j, k, at: pointAt(own[j].S, own[j].S.L / 2), has: true });
    }
    const pairSites = new Map();
    const crossSite = (j, k, at) => {
      const key = j * 64 + k;
      if (!pairSites.has(key)) pairSites.set(key, add({ kind: 'cross', j, k, near: at, at, has: true }));
      return pairSites.get(key);
    };
    for (let x = 0; x < body.length; x++) for (let y = x + 1; y < body.length; y++) {
      const r = relation(own[body[x]].S, own[body[y]].S, null);
      if (r.v[4] <= KP.NEAR) crossSite(body[x], body[y], r.pt);
    }
    // the look-alikes, aligned to this template like drawings; their own loops / corners / meeting strokes where T
    // has none become checkpoints too
    const rivals = [];
    const k = info(T.ch);
    for (const C of (k.confusables || [])) {
      if (!BY_CHAR.has(C) || TWINS.get(T.ch).has(C)) continue;
      for (const CT of BY_CHAR.get(C)) {
        const U = prepareInput(CT.raw);
        const al = refine(U, align(U, T, 0));
        const parts = partsOf(al, U);
        const extraC = al.steps.filter((x) => x.type === 'extra').map((x) => x.u[0]).filter((i) => !CT.isMark[i] || !CT.isMark.some((m, q) => m && q !== i && al.steps.some((y) => y.type !== 'extra' && y.u.includes(q))));
        // a stroke of C matched out of order to a stroke of T of a very different length (お's dot for あ's vertical,
        // マ's dot for ム's bend): the order-free alignment's way of pairing leftovers, not a correspondence a learner
        // would see — nothing measured on that stroke of T is compared with this variant of C
        const mis = new Set(structureOf(al).misplaced.map((e) => e.tpl)), bogus = new Set();
        for (const j of body) {
          const A = parts[j], ratio = A ? A.S.L / Math.max(own[j].S.L, 1e-6) : 1;
          if (A && mis.has(j) && (ratio < KP.BOGUS[0] || ratio > KP.BOGUS[1])) bogus.add(j);
        }
        // where C's strokes that T does not have lie (registered to T): the middle of each, the stroke of T it runs
        // along (ケ's bar on ク's bent stroke) or -1, and whether it is a dot
        const extraAt = extraC.map((i) => { const S = shapeOf(al.U.pts[i]); return pointAt(S, S.L / 2); });
        const extraAlong = extraC.map((i) => alongStroke(T, al.U.pts[i]));
        const extraDot = extraC.map((i) => polyLength(CT.pts[i]) < KP.DOT_LEN);
        // where C joins two strokes of T or breaks one (ヤ's bent stroke for や's first two, ぼ's bar pair …): the joint
        const structAt = [];
        for (const st of al.steps) {
          if (st.type === 'merge' && !T.isMark[st.t[0]]) structAt.push(T.pts[st.t[0]][T.pts[st.t[0]].length - 1]);
          else if (st.type === 'split' && !T.isMark[st.t[0]]) { const piece = al.U.pts[st.u[0]]; structAt.push(piece[piece.length - 1]); }
        }
        rivals.push({ ch: C, variantId: CT.variantId, n: CT.n, parts, cost: al.cost, missingT: al.missing.filter((j) => !T.isMark[j]), extraC, extraAt, extraAlong, extraDot, bogus, structAt });
        for (const j of body) {
          const A = parts[j];
          if (!A || bogus.has(j)) continue;
          const inv = (sP) => { // drawn arc → template arc (invert the monotone map)
            let lo = 0, hi = 1;
            for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (A.map(mid) * A.S.L < sP) lo = mid; else hi = mid; }
            return lo * A.LT;
          };
          const f = strokeFeatures(A.S);
          for (const l of f.loops) {
            const a = inv(l.a), b = inv(l.b);
            const same = sites.find((s) => s.kind === 'loop' && s.j === j && a < s.b + KP.LOOP_PAD && b > s.a - KP.LOOP_PAD);
            if (same) { if (!same.has) same.from.add(C); continue; }
            add({ kind: 'loop', j, a, b: Math.max(b, a + KP.LOOP_ARC / 2), len: (l.b - l.a) * (A.S.L > 0 ? A.LT / A.S.L : 1), sign: l.sign, at: pointAt(own[j].S, (a + b) / 2), has: false, end: b > A.LT - 0.15 * A.LT, from: new Set([C]) });
          }
          for (const c of f.corners) {
            const s = inv(c.s), p = pointAt(own[j].S, s);
            if (sites.some((x) => x.kind === 'corner' && x.j === j && Math.abs(x.s - s) < 2 * KP.CORNER_MW)) continue;
            // (T's own corner at the same place, reached at another arc position — a joined stroke of C runs longer)
            if (sites.some((x) => x.kind === 'corner' && x.j === j && x.has && Math.hypot(x.at[0] - p[0], x.at[1] - p[1]) < KP.CORNER_SAME)) continue;
            if (sites.some((x) => x.kind === 'loop' && x.j === j && s > x.a && s < x.b)) continue;
            add({ kind: 'corner', j, s, sign: c.sign, at: pointAt(own[j].S, s), has: false });
          }
          if (f.hook) {
            const hs = sites.find((x) => x.kind === 'hook' && x.j === j);
            if (hs) hs.H = Math.min(own[j].S.L, Math.max(hs.H, A.LT - inv(f.hook.s) + KP.CORNER_W));
          }
        }
        for (let x = 0; x < body.length; x++) for (let y = x + 1; y < body.length; y++) {
          const A = parts[body[x]], B = parts[body[y]];
          if (!A || !B || bogus.has(body[x]) || bogus.has(body[y]) || pairSites.has(body[x] * 64 + body[y])) continue;
          const r = relation(A.S, B.S, null);
          if (r.v[4] <= KP.NEAR) {
            const t = relation(own[body[x]].S, own[body[y]].S, null);
            const s = crossSite(body[x], body[y], t.pt);
            s.has = false;
          }
        }
      }
    }
    // strokes of T that a look-alike does not have (き's second bar against さ, タ's dot against ク)
    for (const j of body) if (rivals.some((r) => r.missingT.includes(j))) add({ kind: 'count', j, at: pointAt(own[j].S, own[j].S.L / 2), has: true });
    // an end hook that a loop of T covers is measured by that loop; one that only a look-alike's loop covers is measured
    // by that loop against that look-alike (ね's against れ) and stays for the others (れ's outward flick against わ's
    // inward curl)
    for (let q = sites.length - 1; q >= 0; q--) {
      const h = sites[q];
      if (h.kind !== 'hook') continue;
      const LT = own[h.j].S.L;
      const cover = sites.filter((x) => x.kind === 'loop' && x.j === h.j && x.b + KP.LOOP_PAD >= LT - h.H);
      if (cover.some((x) => x.has)) sites.splice(q, 1);
      else if (cover.length) h.skip = new Set([].concat(...cover.map((x) => [...x.from])));
    }
    // a loop is looked for between the template's neighbouring loops on the same stroke, away from its reversals;
    // each loop also gets a closure checkpoint (does the stroke come back onto itself there: a loop that crosses)
    for (const x of sites.slice()) {
      if (x.kind !== 'loop') continue;
      x.cusps = cuspsOf(own[x.j].S);
      x.lo = 0; x.hi = own[x.j].S.L;
      for (const y of sites) {
        if (y === x || y.kind !== 'loop' || y.j !== x.j || !y.has) continue;
        if (y.b <= x.a + 1e-9) x.lo = Math.max(x.lo, y.b);
        else if (y.a >= x.b - 1e-9) x.hi = Math.min(x.hi, y.a);
      }
      add(Object.assign({}, x, { kind: 'closure' }));
    }
    const seen = new Map();
    sites.forEach((x, q) => {
      x.id = q;
      const base = x.kind + (x.j + 1) + (x.k !== undefined ? '-' + (x.k + 1) : '');
      const c = seen.get(base) || 0;
      seen.set(base, c + 1);
      x.pid = c ? base + String.fromCharCode(97 + c) : base;
    });
    // values: the template's and each look-alike variant's; separations
    for (const s of sites) s.vT = measure(s, own);
    for (const r of rivals) {
      r.v = sites.map((s) => measure(s, r.parts, true));
      r.sep = sites.map((s, q) => (s.skip && s.skip.has(r.ch) ? NaN
        : s.kind !== 'count' && (r.bogus.has(s.j) || (s.k !== undefined && r.bogus.has(s.k))) ? NaN : kpDist(s.kind, s.vT, r.v[q])));
      r.parts = null; // not needed any more
    }
    M = { T, sites, rivals, feats };
    KP_MODELS.set(T, M);
    return M;
  }

  // ---------------------------------------------------------------------------------------------
  // Key points on a drawing: evidence per look-alike, the public points, the Korean labels and messages
  // ---------------------------------------------------------------------------------------------
  const huber = (d0) => {
    const d = Math.min(d0, KP.DCAP);
    return d <= KP.HUBER ? (d * d) / 2 : KP.HUBER * d - (KP.HUBER * KP.HUBER) / 2;
  };

  // Measures the drawing at the checkpoints of the target's form (an.form) and weighs, per look-alike C, the
  // evidence that it is C: L_C = Σ ρ(d_T) − ρ(d_C) over the checkpoints that separate T and C by ≥ KP.SMIN σ, and
  // the most decisive critical point it misses (on C's side). Returns { M, mU, byC: Map(C → {L, miss, r}), plausible }.
  // asDrawn: strokes drawn the other way round give their direction as drawn (only for a drawing rejected anyway).
  function kpEvaluate(U, an, asDrawn) {
    const form = an.form, M = kpModel(form.T);
    const parts = partsOf(form, U);
    const mU = M.sites.map((x) => measure(x, parts, asDrawn));
    const byC = new Map();
    for (const r of M.rivals) {
      let L = 0;
      const misses = [];
      M.sites.forEach((x, q) => {
        const sep = r.sep[q];
        if (!(sep >= KP.SMIN) || !isFinite(sep)) return;
        const [dT, dC] = kpPair(x.kind, mU[q], x.vT, r.v[q]);
        if (!isFinite(dT) || !isFinite(dC)) return;
        if (neutral(x, mU[q], r.v[q])) return;
        // a stroke more or less is the alignment's business (it already costs the shape match), and whether a loop
        // closes repeats its loop checkpoint: these name a point and report hits, they are not weighed again
        if (x.kind !== 'count' && x.kind !== 'closure') L += huber(dT) - huber(dC);
        const z = (dC - dT) / sep;
        if (sep >= KP.CRIT && z <= -KP.MISS_Z && dT >= KP.HIT && dC <= KP.MATCH_C) {
          // which missed point to name: the most telling kind, well separated, clearly missed
          const pr = (KP.NAME_PRIO[x.kind] || 1) * Math.min(sep, 5) * -z * (tellable(x, x.vT, r.v[q]) ? 1 : 0.3);
          misses.push({ q, z, pr });
        }
      });
      misses.sort((a, b) => b.pr - a.pr);
      const e = byC.get(r.ch);
      if (!e || L > e.L) byC.set(r.ch, { ch: r.ch, L, miss: misses[0] || null, misses, r });
    }
    // the middles of drawn strokes the form leaves unmatched (registered frame): a look-alike's extra stroke drawn
    const extraMid = form.steps.filter((st) => st.type === 'extra' && form.U.len[st.u[0]] >= P.SPECK_LEN)
      .map((st) => { const S = shapeOf(form.U.pts[st.u[0]]); return pointAt(S, S.L / 2); });
    const costOf = new Map(an.list.map((e) => [e.ch, e.al.cost]));
    const tCost = an.tgt.al.cost;
    const plausible = (ch) => costOf.has(ch) && costOf.get(ch) <= tCost + KP.WINDOW && costOf.get(ch) <= P.RECOG_MAX && explains(an, U, ch);
    // the evidence plus how much better (or worse) C's whole shape fits than T's
    const score = (e) => e.L + (KP.GW * (tCost - costOf.get(e.ch))) / 0.01;
    return { M, mU, byC, plausible, score, extraMid, n: U.n };
  }

  // Can look-alike C be what was written? Its best reading of the drawing leaves none of its own body strokes out, none
  // of the drawn strokes (but specks) unexplained, and joins or breaks no more body strokes than the target's reading:
  // a セ with a weak hook is no せ (a stroke short, or せ's first two strokes joined), a タ with its dot no ク. (The key
  // points tell look-alikes apart; the stroke count and connected writing are the shape match's business.)
  const bodyStruct = (al) => al.steps.filter((st) => (st.type === 'merge' || st.type === 'split' || st.type === 'dup') && !al.T.isMark[st.t[0]]).length;
  function explains(an, U, ch) {
    const e = an.list.find((x) => x.ch === ch);
    if (!e) return false;
    const al = e.al;
    return !al.missing.some((j) => !al.T.isMark[j]) && !al.steps.some((st) => st.type === 'extra' && U.len[st.u[0]] >= P.SPECK_LEN) &&
      bodyStruct(al) <= bodyStruct(an.form);
  }

  // An end hook kept against a look-alike while another look-alike's loop covers it (れ's outward flick against わ, and
  // back), where one of the two ends straight (z) and the other flicks (f): a drawing whose end is straight-ish — from
  // half-way to the flick up to σ beyond z (away from f) — tells neither (rough writing drops flicks, and the inward
  // curl of わ lies beyond); a flick counts for the flicked one, a curl beyond z for the straight one.
  function neutral(x, m, vC) {
    if (!x.skip || x.kind !== 'hook' || m === null || vC === null) return false;
    const sT = Math.abs(x.vT) < KP.SIG.hook, sC = Math.abs(vC) < KP.SIG.hook;
    if (sT === sC) return false;
    const z = sT ? x.vT : vC, f = sT ? vC : x.vT, u = (m - z) * Math.sign(z - f);
    return u > -Math.abs(f - z) / 2 && u < KP.SIG.hook;
  }

  // Does the message of checkpoint x describe the difference T − C (a loop / corner of T that C lacks, or the reverse)?
  function tellable(x, vT, vC) {
    if (x.kind === 'loop' || x.kind === 'corner') return x.has ? vT > vC : vT < vC;
    if (x.kind === 'closure') return x.has ? vT < vC : vT > vC;
    return true;
  }

  // A loop of the target's form (a self-crossing, not an end curl) that the drawing clearly does not make: it turns at
  // least SELF_LOOP σ less than the template there and does not come back onto itself (closure ≥ SELF_OPEN). The loop
  // site, or null. (Calibrated on dev correct / rough-dev roughCorrect / ext-dev drawings vs. loops cut at their
  // crossing: tools/bench/scratch-fix/loopcal.js.)
  function loopMissed(ev, strictness) {
    const th = KP.SELF_LOOP[strictness] || KP.SELF_LOOP.normal, M = ev.M;
    for (let q = 0; q < M.sites.length; q++) {
      const x = M.sites[q];
      if (x.kind !== 'loop' || !x.has || x.curl) continue;
      const m = ev.mU[q];
      if (m === null || (x.vT - m) / KP.SIG.loop < th) continue;
      const cq = M.sites.findIndex((y) => y.kind === 'closure' && y.has && y.j === x.j && Math.abs(y.a - x.a) < 1e-9);
      const c = cq >= 0 ? ev.mU[cq] : null;
      if (c !== null && c < KP.SELF_OPEN) continue;
      return x;
    }
    return null;
  }

  // The look-alike that the key points say was written instead of the (accepted) target, or null.
  function kpBeater(ev, th, vetoed) {
    let best = null;
    for (const e of ev.byC.values()) {
      if (!e.miss || !ev.plausible(e.ch) || (vetoed && vetoed(e.ch))) continue;
      const sc = ev.score(e);
      if (sc >= th && (!best || sc > best.sc)) best = Object.assign({ sc }, e);
    }
    return best;
  }

  // Public form of the checkpoints: what the chart draws and what result.keypoints reports:
  //   [{ id, stroke, x, y, kind, label, critical, against }] in the template's 109 box; with ev also hit / failed.
  // Shown: every critical point, and the template's own loops, corners, hooks, dots, meeting strokes and directions.
  const PUBLIC_KINDS = new Set(['loop', 'corner', 'dot', 'cross', 'direction']);
  function publicPoints(M, ev) {
    const T = M.T, box = T.box || (T.box = bboxOf(T.raw)), sc = Math.max(box.w, box.h) || 1;
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const points = [], failed = [];
    M.sites.forEach((x, q) => {
      const against = [], hide = labelInfo(M, x).hide;
      for (const r of M.rivals) if (r.sep[q] >= KP.CRIT && !against.includes(r.ch) && !hide.has(r.ch)) against.push(r.ch);
      const critical = against.length > 0;
      if (!critical && !(x.has && (PUBLIC_KINDS.has(x.kind) || (x.kind === 'hook' && x.hasHook)))) return;
      const pt = { id: x.pid, stroke: x.j, x: +(x.at[0] * sc + cx).toFixed(1), y: +(x.at[1] * sc + cy).toFixed(1), kind: x.kind === 'closure' ? 'loop' : x.kind, label: kpLabel(M, x), critical, against };
      // hint[C] (chart only, keypoints()): how to write this place so it is not C — the words of the message on a miss;
      // none when they would only repeat the label
      if (critical && !ev) {
        for (const r of M.rivals) {
          if (!(r.sep[q] >= KP.CRIT) || (pt.hint && r.ch in pt.hint)) continue;
          let how = null;
          try { how = kpHow(M, q, r, undefined, true); } catch (e) { how = null; }
          if (how && how !== pt.label + '에 주의해요') (pt.hint || (pt.hint = {}))[r.ch] = how;
        }
      }
      if (ev) {
        const m = ev.mU[q];
        if (m === null) pt.hit = null;
        else if (critical) {
          // missed when the drawing is clearly on the side of a look-alike there
          const dT = kpDist(x.kind, m, x.vT);
          pt.hit = !M.rivals.some((r) => {
            if (!(r.sep[q] >= KP.CRIT) || !(dT >= KP.HIT)) return false;
            if (neutral(x, m, r.v[q])) return false;
            const dC = kpPair(x.kind, m, x.vT, r.v[q])[1];
            return dC <= KP.MATCH_C && (dC - dT) / r.sep[q] <= -KP.MISS_Z;
          });
          if (!pt.hit) failed.push(pt.id);
        } else pt.hit = kpDist(x.kind, m, x.vT) <= KP.HIT_NC;
      }
      // the same words against the same look-alikes twice (キ's third stroke against き: two places where き bends): one
      // point, missed when either place is
      const dup = critical && points.find((p) => p.critical && p.label === pt.label && p.against.join() === pt.against.join());
      if (dup) {
        if (ev && pt.hit === false) dup.hit = false;
        else if (ev && pt.hit === true && dup.hit === null) dup.hit = true;
        return;
      }
      points.push(pt);
    });
    // a stroke that a look-alike has and the target does not (か's dot against カ, シ's second dot against ン, ケ's bar
    // against ク): a point where that stroke would be — the side without the stroke shows the difference too.
    // Judged: missed when the drawing has a stroke of its own there (one the target's reading leaves over).
    const box1 = (p) => ({ x: +(p[0] * sc + cx).toFixed(1), y: +(p[1] * sc + cy).toFixed(1) });
    const done = new Set();
    for (const r of M.rivals) r.extraC.forEach((e, q) => {
      if (done.has(r.ch) || leadText(T.ch, r.ch)) return; // (a pair with a textbook point says it there)
      const at0 = r.extraAt[q], along = r.extraAlong[q];
      // (a stroke the registration put far off the glyph — り's one-stroke form against い — has no place on it; one just
      // beside it — か's dot right of カ — is shown at the glyph's edge)
      if (Math.max(Math.abs(at0[0]), Math.abs(at0[1])) > 0.85) return;
      const at = [Math.max(-0.5, Math.min(0.5, at0[0])), Math.max(-0.5, Math.min(0.5, at0[1]))];
      done.add(r.ch);
      const pt = Object.assign({ id: 'count-' + r.ch, stroke: along >= 0 ? along : nearestStroke(T, at) }, box1(at), {
        kind: 'count', label: extraLabel(M, r, q), critical: true, against: [r.ch] });
      if (!ev) pt.hint = { [r.ch]: extraHow(M, r, T.ch, q) };
      if (ev) {
        pt.hit = !ev.extraMid.some((p) => Math.hypot(p[0] - at0[0], p[1] - at0[1]) <= KP.EXTRA_NEAR);
        if (!pt.hit) failed.push(pt.id);
      }
      points.push(pt);
    });
    // a look-alike with another stroke count that the alignment explains by joining or breaking strokes (や / ヤ, ガ / が,
    // ば / ぼ): the count itself, at the joint ('や는 3획 (ヤ는 2획)'); missed when the drawing has C's count, not T's
    const countsOf = (ch) => (BY_CHAR.get(ch) || []).map((t) => t.n);
    for (const r of M.rivals) {
      if (done.has(r.ch) || r.n === T.n || r.extraC.length || r.missingT.length || !r.structAt.length || leadText(T.ch, r.ch)) continue;
      done.add(r.ch);
      const at = [Math.max(-0.5, Math.min(0.5, r.structAt[0][0])), Math.max(-0.5, Math.min(0.5, r.structAt[0][1]))];
      // (when another form of C has T's count — り in two strokes against い — the count is that of C's joined / split form)
      const how = countsOf(r.ch).includes(T.n) ? josa(r.ch, '를', '을') + (r.n < T.n ? ' 이어 쓰면 ' : ' 떼어 쓰면 ') : josa(r.ch, '는', '은') + ' ';
      const pt = Object.assign({ id: 'count-' + r.ch, stroke: nearestStroke(T, at) }, box1(at), {
        kind: 'count', label: T.ch + josa(T.ch, '는', '은') + ' ' + T.n + '획 (' + r.ch + how + r.n + '획)', critical: true, against: [r.ch] });
      if (ev) {
        pt.hit = !(countsOf(r.ch).includes(ev.n) && !countsOf(T.ch).includes(ev.n));
        if (!pt.hit) failed.push(pt.id);
      }
      points.push(pt);
    }
    // the textbook difference of a classic pair first (さ: 가로획 1개 — き는 2개): judged after the verdict (judge())
    const leads = [];
    for (const [C, d] of leadsOf(T)) {
      const j = d.j === 'last' ? T.n - 1 : d.j;
      if (!(j >= 0 && j < T.n) || T.isMark[j]) continue;
      const S = shapeOf(T.pts[j]);
      const pt = Object.assign({ id: 'lead-' + C, stroke: j }, box1(pointAt(S, d.t * S.L)), { kind: d.kind, label: d.label, critical: true, against: [C] });
      if (!ev) pt.hint = { [C]: d.text };
      if (ev) pt.hit = null;
      leads.push(pt);
    }
    return { points: leads.concat(points), failed };
  }
  function nearestStroke(T, p) {
    let best = 0, bd = Infinity;
    for (let j = 0; j < T.n; j++) {
      if (T.isMark[j]) continue;
      const d = distToLine(p, T.pts[j]);
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  }
  // Distance from point p to polyline pts.
  function distToLine(p, pts) {
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[Math.min(pts.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
    }
    return best;
  }
  // The template stroke a look-alike's extra stroke lies along (ケ's bar on ク's bent stroke), or -1.
  function alongStroke(T, pts) {
    const S = shapeOf(pts);
    let best = -1, bd = KP.ALONG;
    for (let j = 0; j < T.n; j++) {
      if (T.isMark[j]) continue;
      let s = 0;
      for (const p of S.p) s += distToLine(p, T.pts[j]);
      if (s / S.n < bd) { bd = s / S.n; best = j; }
    }
    return best;
  }
  // Label of a look-alike's extra stroke at the target: 'か의 3번째 획(점)이 없음', 'ケ의 2번째 획을 따로 쓰지 않음'.
  function extraLabel(M, r, q) {
    const e = r.extraC[q], w = r.ch + '의 ' + nth(e) + ' 획' + (r.extraDot[q] ? '(점)' : '');
    return r.extraAlong[q] >= 0 ? eul(w) + ' 따로 쓰지 않음' : iga(w) + ' 없음';
  }

  // The textbook difference of classic pairs (docs: the 닮은 글자 tips), as a key point of the target against C: where
  // (stroke j — 'last' = the form's last stroke — at fraction t of its length), its kind, the chart's label and the
  // message's text ('<target>의 포인트: <text>. 지금은 C처럼 보여요.'). It comes first in the chart's 구별 포인트 and, when
  // a drawing is read as C, its text is the key-point message (the measured points stay as they are: the rings show
  // where the drawing went C's way). A pair whose difference is a stroke more or less is named in the words of
  // the tip (가로획 1개 — き는 2개), not as a stroke number.
  const PAIR_LEAD = {
    'さ': { 'き': { j: 0, t: 0.5, kind: 'count', label: '가로획 1개 (き는 2개)', text: '가로획은 1개만 써요(き는 2개)' },
      'ち': { j: 'last', t: 0.55, kind: 'hook', label: '아래 부분: 왼쪽으로 둥글게 돌아 오른쪽이 열림 (ち와 반대)', text: '아래 부분은 왼쪽으로 둥글게 돌려, 오른쪽이 열린 둥근 모양으로 써요(ち와 반대)' } },
    'き': { 'さ': { j: 1, t: 0.5, kind: 'count', label: '가로획 2개 (さ는 1개)', text: '가로획을 2개 써요(さ는 1개)' } },
    'ち': { 'さ': { j: 'last', t: 0.75, kind: 'hook', label: '아래 부분: 오른쪽으로 둥글고 왼쪽이 열림 (さ와 반대)', text: '아래 부분은 つ처럼 오른쪽으로 둥글게 돌아 왼쪽이 열려요(さ와 반대)' } },
    'ぬ': { 'ね': { j: 0, t: 0.5, kind: 'feature', label: '1번째 획: 짧게 비스듬히 (ね는 길고 곧은 세로획)', text: '1번째 획은 짧게 비스듬히 그어요(ね는 길고 곧게 내려 그어요)' } },
    'ね': { 'ぬ': { j: 0, t: 0.5, kind: 'feature', label: '1번째 획: 길고 곧은 세로획 (ぬ는 짧게 비스듬히)', text: '1번째 획은 위에서 아래로 길고 곧게 내려 그어요(ぬ는 짧게 비스듬히 그어요)' } },
    'し': { 'レ': { j: 0, t: 0.78, kind: 'corner', label: '아래를 둥글게 돌림 (レ는 각지게 꺾음)', text: '아래를 각지게 꺾지 말고 둥글게 돌려, 끝은 낮게 살짝만 올려요' } },
    'レ': { 'し': { j: 0, t: 0.72, kind: 'corner', label: '아래에서 각지게 꺾음 (し는 둥글게 돌림)', text: '아래에서 둥글게 돌리지 말고 각지게 꺾어, 오른쪽 위로 높이 올려요' } },
    'あ': { 'お': { j: 2, t: 0.3, kind: 'loop', label: '3번째 획: 세로획을 가로질러 크게 돎 (お는 오른쪽 위에 점)', text: 'お처럼 오른쪽 위에 점을 따로 찍지 않아요. 3번째 획은 세로획을 가로질러 크게 돌려요' } },
    'お': { 'あ': { j: 2, t: 0.5, kind: 'dot', label: '오른쪽 위의 점 (あ에는 없음)', text: '오른쪽 위에 점(3번째 획)을 따로 찍어요(あ에는 점이 없어요)' } },
    'は': { 'ほ': { j: 2, t: 0.06, kind: 'cross', label: '가로획 1개, 세로획이 위로 나옴 (ほ는 가로획 2개)', text: '가로획은 1개만 쓰고, 오른쪽 세로획은 가로획을 뚫고 위로 나오게 써요(ほ는 가로획 2개)' } },
    'ほ': { 'は': { j: 1, t: 0.5, kind: 'count', label: '가로획 2개, 세로획은 위로 안 나옴 (は는 1개)', text: '가로획을 2개 쓰고, 오른쪽 세로획은 위쪽 가로획에서 시작해요(は는 가로획 1개)' } },
    'ク': { 'ケ': { j: 1, t: 0.15, kind: 'corner', label: '2번째 획: 가로로 긋다가 꺾어 내림 (ケ는 가로획을 따로 씀)', text: '2번째 획은 가로로 짧게 긋다가 꺾어서 왼쪽 아래로 길게 내려요(ケ처럼 가로획을 따로 떼어 쓰지 않아요)' } },
    'ケ': { 'ク': { j: 1, t: 0.5, kind: 'count', label: '가로획을 따로 씀 (ク는 2획)', text: '가로획을 따로 긋고, 3번째 획은 가로획 가운데에서 아래로 내려요(ク는 2획)' } },
    'ム': { 'マ': { j: 0, t: 0.62, kind: 'corner', label: '1번째 획: 왼쪽 아래에서 꺾음 (マ는 오른쪽 위에서 꺾음)', text: '1번째 획은 비스듬히 내려 긋다가 왼쪽 아래에서 꺾어 오른쪽으로 그어요(マ처럼 오른쪽 위에서 꺾지 않아요)' } },
    'マ': { 'ム': { j: 0, t: 0.45, kind: 'corner', label: '1번째 획: 오른쪽 위에서 꺾음 (ム는 왼쪽 아래에서 꺾음)', text: '1번째 획은 가로로 긋다가 오른쪽 위에서 꺾어 왼쪽 아래로 내려요(ム처럼 왼쪽 아래에서 꺾지 않아요)' } },
    'れ': { 'わ': { j: 1, t: 0.96, kind: 'hook', label: '2번째 획 끝: 바깥으로 튕김 (わ는 안쪽으로 감음)', text: '2번째 획 끝을 오른쪽 바깥으로 튕겨 올려요(わ는 안쪽으로 둥글게 감아요)' } },
    'わ': { 'れ': { j: 1, t: 0.9, kind: 'hook', label: '2번째 획 끝: 안쪽으로 둥글게 감음 (れ는 바깥으로 튕김)', text: '2번째 획 끝은 튕기지 말고 안쪽으로 둥글게 감아 끝내요(れ는 바깥으로 튕겨요)' } },
  };
  // [C, lead] of a form's character (look-alikes of the character only)
  function leadsOf(T) {
    const L = PAIR_LEAD[T.ch], k = KANA[T.ch];
    return L && k ? Object.entries(L).filter(([C]) => k.confusables.includes(C)) : [];
  }
  const leadText = (target, C) => (PAIR_LEAD[target] && PAIR_LEAD[target][C] && KANA[target] && KANA[target].confusables.includes(C) ? PAIR_LEAD[target][C].text : null);
  // After the verdict: a lead point is missed when the drawing was read as its look-alike, kept when the target was accepted.
  function leadHits(res) {
    const kp = res.keypoints;
    if (!kp || !kp.points) return;
    for (const p of kp.points) {
      if (!/^lead-/.test(p.id)) continue;
      p.hit = res.verdict !== 'wrong' ? true : res.recognized === p.against[0] ? false : null;
      if (p.hit === false && !kp.failed.includes(p.id)) kp.failed.unshift(p.id);
    }
  }

  // Position words for a point of the normalised template frame (위 / 아래 / 왼쪽 / 오른쪽 / 가운데).
  function placeWord(p) {
    const h = p[0] < -0.15 ? '왼쪽' : p[0] > 0.15 ? '오른쪽' : '', v = p[1] < -0.15 ? '위' : p[1] > 0.15 ? '아래' : '';
    return h && v ? h + ' ' + v : h || v || '가운데';
  }
  // A direction (dx, dy; y down) as a place word: 오른쪽 위, 아래, …
  function dirWord(dx, dy) {
    const a = (Math.atan2(dy, dx) * 180) / Math.PI;
    const names = [[0, '오른쪽'], [45, '오른쪽 아래'], [90, '아래'], [135, '왼쪽 아래'], [180, '왼쪽'], [-180, '왼쪽'], [-135, '왼쪽 위'], [-90, '위'], [-45, '오른쪽 위']];
    let best = null, bd = Infinity;
    for (const [d, w] of names) { const e = Math.abs(a - d); if (e < bd) { bd = e; best = w; } }
    return best;
  }
  // Where a dot sits next to another stroke, in words: the main axis (위 / 아래 / 왼쪽 / 오른쪽) unless the direction is
  // clearly diagonal; against a look-alike whose dot lies along the other axis always the main axis (シ's dots one above
  // the other, ツ's side by side).
  const axisWord = (dx, dy) => (Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? '위' : '아래') : dx < 0 ? '왼쪽' : '오른쪽');
  function dotWord(v, vC) {
    if (vC && (Math.abs(v[1]) >= Math.abs(v[0])) !== (Math.abs(vC[1]) >= Math.abs(vC[0]))) return axisWord(v[0], v[1]);
    const a = Math.abs((Math.atan2(v[1], v[0]) * 180) / Math.PI) % 90;
    return a <= 35 || a >= 55 ? axisWord(v[0], v[1]) : dirWord(v[0], v[1]);
  }
  // Korean particles after a word: 받침 → 은/이/을/과, otherwise 는/가/를/와.
  function hasBatchim(word) {
    const w = String(word).replace(/\([^()]*\)$/, ''), c = w.charCodeAt(w.length - 1); // '획(점)' → after 획
    return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 !== 0 : false;
  }
  const eun = (w) => w + (hasBatchim(w) ? '은' : '는');
  const iga = (w) => w + (hasBatchim(w) ? '이' : '가');
  const eul = (w) => w + (hasBatchim(w) ? '을' : '를');
  const gwa = (w) => w + (hasBatchim(w) ? '과' : '와');
  // "2번째 획" ("획" alone for a one-stroke character)
  function strokeName(M, j) {
    let body = 0;
    for (let q = 0; q < M.T.n; q++) if (!M.T.isMark[q]) body++;
    return body === 1 ? '획' : nth(j) + ' 획';
  }
  // "2번째 획(점)" when stroke k is a dot too (シ ツ), else "2번째 획"
  const dotName = (M, k) => strokeName(M, k) + (polyLength(M.T.pts[k]) < KP.DOT_LEN ? '(점)' : '');
  // How template stroke j meets stroke k at a cross checkpoint (value v): 'cross' (an X), 'joinJ' (j ends on k),
  // 'joinK' (k ends on j), 'corner' (both end there) or 'apart'.
  function meetType(v) {
    if (v[4] > 0.06) return 'apart';
    const endJ = Math.min(v[0], v[1]) < 0.05, endK = Math.min(v[2], v[3]) < 0.05;
    return endJ && endK ? 'corner' : endJ ? 'joinJ' : endK ? 'joinK' : 'cross';
  }

  // Short label of a checkpoint (Korean): '2번째 획 끝의 작은 고리', '3번째 획 방향(왼쪽 아래→오른쪽 위)' … A label that reads
  // the same as a point of the look-alike's own form against this character (ち's and さ's '2번째 획의 꺾임(왼쪽 아래)', ラ's and
  // ワ's '2번째 획의 시작 위치(왼쪽 위)') tells nothing in the chart, where the two are shown side by side: it then says more —
  // where the stroke goes after a bend, where a start / end lies against the look-alike, which way an end goes.
  function kpLabel(M, x) {
    return labelInfo(M, x).label;
  }
  // { label, hide: look-alikes the chart does not show this point against } (cached on the site). A start / end that both
  // sides of a pair would describe as lower (or further left …) than the other (ラ's and ワ's 2nd strokes end at the bottom
  // of each glyph; each, registered onto the other, ends higher) is a matter of proportions that no place word tells: the
  // judge still weighs it, the chart does not show it against that look-alike.
  const dirAgainst = (v, vC) => { const dx = v[0] - vC[0], dy = v[1] - vC[1]; return Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? '아래' : '위') : dx > 0 ? '오른쪽' : '왼쪽'; };
  function labelInfo(M, x) {
    if (x.lab) return x.lab;
    const raw = rawLabel(M, x);
    x.lab = { label: raw, hide: new Set() };
    if (!['corner', 'start', 'end', 'hook', 'feature', 'cross'].includes(x.kind) || !x.has) return x.lab;
    const q = M.sites.indexOf(x), T = M.T, clash = [];
    for (const r of M.rivals) {
      if (!(r.sep[q] >= KP.CRIT) || !BY_CHAR.has(r.ch)) continue;
      for (const CT of BY_CHAR.get(r.ch)) {
        const MC = kpModel(CT);
        MC.sites.forEach((y, k) => {
          const rc = MC.rivals.find((z) => z.ch === T.ch && z.sep[k] >= KP.CRIT);
          if (rc && y.kind === x.kind && y.has && rawLabel(MC, y) === raw) clash.push({ r, y, vTC: rc.v[k] });
        });
      }
    }
    if (!clash.length) return x.lab;
    const S = strokeName(M, x.j), own = T.pts[x.j], S0 = shapeOf(own);
    if (x.kind === 'corner') {
      // where the stroke heads after the bend
      const a = pointAt(S0, x.s), b = pointAt(S0, Math.min(S0.L, x.s + 0.15));
      x.lab.label = S + '의 꺾임(' + placeWord(x.at) + '에서 ' + withRo(dirWord(b[0] - a[0], b[1] - a[1])) + ')';
    } else if (x.kind === 'feature') {
      // longer or shorter than the look-alike's (the words of the message), when the look-alikes agree
      const ws = new Set(clash.map((c) => (c.r.v[q] === null ? null : x.vT > c.r.v[q] ? (x.vT > 0 ? strokeName(M, x.k) + '보다 길게' : '조금 더 길게') : (x.vT < 0 ? strokeName(M, x.k) + '보다 짧게' : '조금 더 짧게'))).filter(Boolean));
      if (ws.size === 1) x.lab.label = S + '의 길이(' + [...ws][0] + ')';
    } else if (x.kind === 'cross') {
      // a stroke ending on another: on that stroke's end (a corner, コ) or along it (ユ)
      const t = meetType(x.vT), v = x.vT, K = strokeName(M, x.k);
      if (t === 'joinJ' && v[0] > v[1]) x.lab.label = S + ' 끝이 ' + K + (Math.min(v[2], v[3]) < 0.1 ? ' 끝에' : ' 중간에') + ' 닿음';
      else if (t === 'joinK' && v[2] > v[3]) x.lab.label = K + ' 끝이 ' + S + (Math.min(v[0], v[1]) < 0.1 ? ' 끝에' : ' 중간에') + ' 닿음';
    } else if (x.kind === 'hook') {
      // which way the end goes (round when it turns a lot)
      const e = own[own.length - 1], h = pointAt(S0, Math.max(0, S0.L - 0.1));
      x.lab.label = eun(S) + ' ' + withRo(dirWord(e[0] - h[0], e[1] - h[1])) + (Math.abs(x.vT) >= 0.6 ? ' 둥글게' : '') + ' 끝남';
    } else {
      // start / end: where it lies against the look-alike, unless the look-alike's own point says the same against this one
      const words = new Set();
      for (const c of clash) {
        const vC = c.r.v[q];
        if (!vC || !c.vTC) continue;
        const w = dirAgainst(x.vT, vC);
        if (dirAgainst(c.y.vT, c.vTC) === w) x.lab.hide.add(c.r.ch);
        else words.add(c.r.ch + '보다 ' + w);
      }
      if (words.size === 1) x.lab.label = raw.replace(/\)$/, ', ' + [...words][0] + ')');
    }
    return x.lab;
  }
  function rawLabel(M, x) {
    const S = strokeName(M, x.j), K = x.k !== undefined ? strokeName(M, x.k) : '';
    const own = M.T.pts[x.j];
    // (labels say what the target does, so a negative one reads as an instruction under '놓친 곳': '…은 튕기지 않음')
    switch (x.kind) {
      case 'loop': return x.has ? (x.end ? S + ' 끝의 작은 고리' : S + ' 중간의 고리') : (x.end ? eun(S + ' 끝') + ' 고리 없이 끝남' : S + '에는 고리가 없음');
      case 'closure': return x.has ? S + (x.end ? ' 끝의 고리가 닫힘' : ' 중간의 고리가 닫힘') : (x.end ? eun(S + ' 끝') + ' 고리를 닫지 않음' : S + '에는 닫힌 고리가 없음');
      case 'corner': {
        if (!x.has) return eun(S) + ' ' + placeWord(x.at) + '에서 꺾지 않음';
        // a bend that is a point only because the look-alike's is sharper there (う against ら): a round bend
        const q = M.sites.indexOf(x), vs = M.rivals.filter((r) => r.sep[q] >= KP.CRIT).map((r) => r.v[q]);
        return S + (vs.length && vs.every((v) => v !== null && v > x.vT) ? '의 둥근 굽이(' : '의 꺾임(') + placeWord(x.at) + ')';
      }
      case 'hook': return x.hasHook ? S + ' 끝을 짧게 튕김' : eun(S + ' 끝') + ' 튕기지 않음';
      case 'direction': {
        // against look-alikes that run the same way in words (し and レ: both 왼쪽 위→오른쪽 아래), say how it differs
        const d = directionText(own), q = M.sites.indexOf(x);
        const rs = M.rivals.filter((r) => r.sep[q] >= KP.CRIT && r.v[q] !== null);
        if (d && rs.length && rs.every((r) => dirName(r.v[q]) === d)) {
          const names = [...new Set(rs.map((r) => r.ch))];
          return S + ' 방향(' + d + ', ' + names.join('·') + '보다 ' + steeper(x.vT, rs[0].v[q]) + ')';
        }
        return S + ' 방향' + (d ? '(' + d + ')' : '');
      }
      case 'start': return S + '의 시작 위치(' + placeWord(x.at) + ')';
      case 'end': return S + '의 끝 위치(' + placeWord(x.at) + ')';
      case 'dot': return S + '(점)의 위치: ' + dotName(M, x.k) + ' ' + dotWord(x.vT);
      case 'feature': return S + '의 길이(' + gwa(K) + ' 비교)';
      case 'count': return S + (polyLength(own) < KP.DOT_LEN ? '(점)' : '') + ' 있음';
      case 'cross': {
        // joinJ / joinK: the end of the stroke that touches — its start (v[0] / v[2] = the arc before the meeting point
        // is the short one: the stroke starts on the other one) or its finish
        const t = meetType(x.vT), v = x.vT;
        return t === 'cross' ? gwa(S) + ' ' + K + '의 교차'
          : t === 'joinJ' ? (v[0] <= v[1] ? iga(S) + ' ' + K + '에서 시작함' : S + ' 끝이 ' + K + '에 닿음')
          : t === 'joinK' ? (v[2] <= v[3] ? iga(K) + ' ' + S + '에서 시작함' : K + ' 끝이 ' + S + '에 닿음')
          : t === 'corner' ? gwa(S) + ' ' + K + '이 만나는 모서리' : gwa(S) + ' ' + K + ' 사이의 간격';
      }
    }
    return S;
  }

  // The message of a missed key point: 'ぬ의 포인트: 2번째 획 끝에 작은 고리를 만들어요. 지금은 め처럼 보여요.'
  // m = the drawing's measurement there (undefined: not known). null when the point's message would not tell the target
  // from C — C runs the same way there (レ for し: both go 왼쪽 위→오른쪽 아래), or the drawing already does what the
  // message asks (its strokes 1 and 2 already cross) — unless force (then the plain words of the point).
  function kpMessage(M, q, r, target, m, force) {
    const how = kpHow(M, q, r, m, force);
    return how === null ? null : target + '의 포인트: ' + how + '. 지금은 ' + r.ch + '처럼 보여요.';
  }
  // The instruction part of kpMessage ('2번째 획 끝에 작은 고리를 만들어요'): how to write point q so it is not look-alike r.
  // Also the chart's point.hint[C]. null as for kpMessage.
  function kpHow(M, q, r, m, force) {
    const x = M.sites[q], vT = x.vT, vC = r.v[q], C = r.ch;
    const S = strokeName(M, x.j), K = x.k !== undefined ? strokeName(M, x.k) : '';
    const own = M.T.pts[x.j];
    let how = null;
    switch (x.kind) {
      case 'loop': case 'closure':
        if (x.kind === 'loop' ? vT > vC : vT < vC) how = x.end ? S + ' 끝에 작은 고리를 만들어요' : S + ' 중간에 고리를 만들어요';
        else how = x.end ? S + ' 끝에는 고리를 만들지 않아요' : S + '에는 고리를 만들지 않아요';
        break;
      case 'count':
        how = eul(S + (own.length && polyLength(own) < KP.DOT_LEN ? '(점)' : '')) + ' 빠뜨리지 말고 써요';
        break;
      case 'corner':
        if (vT > vC) how = eul(S) + ' ' + placeWord(x.at) + '에서 꺾어 써요';
        else {
          // (only there: the stroke may bend elsewhere — マ's フ, ぬ's loop)
          const S0 = shapeOf(own), bend = Math.abs(netTurn(S0, x.s - 0.15, x.s + 0.15));
          how = eun(S) + ' ' + placeWord(x.at) + '에서 ' + (bend > 0.6 ? '각지게 꺾지 말고 둥글게 돌려요' : '꺾지 않아요');
        }
        break;
      case 'hook':
        if (x.hasHook && Math.abs(vT) > Math.abs(vC)) {
          const e = own[own.length - 1], h = x.at;
          how = S + ' 끝을 ' + withRo(dirWord(e[0] - h[0], e[1] - h[1])) + ' 짧게 튕겨요';
        } else if (Math.abs(vT) >= 0.6 && Math.sign(vT) !== Math.sign(vC)) {
          // the end curls the other way round than C's (さ against ち): which way it ends
          const S0 = shapeOf(own), e = own[own.length - 1], h = pointAt(S0, Math.max(0, S0.L - 0.1));
          how = S + ' 끝을 ' + withRo(dirWord(e[0] - h[0], e[1] - h[1])) + ' 둥글게 돌려 끝내요';
        } else how = eun(S + ' 끝') + ' 튕기지 않고 그대로 끝내요';
        break;
      case 'direction': {
        const d = directionText(own);
        // C (as aligned) runs the same way, or the drawing already does: no difference to name
        if (!force && (vC === null || dirName(vC) === d || (m !== undefined && m !== null && dirName(m) === d))) return null;
        if (d && vC !== null && dirName(vC) === d) how = eun(S) + ' ' + C + '보다 ' + steeper(vT, vC) + ' 그어요';
        else if (d) { const ab = d.split('→'); how = eun(S) + ' ' + ab[0] + '에서 ' + withRo(ab[1]) + ' 그어요'; }
        break;
      }
      case 'start': case 'end': {
        const dx = vT[0] - vC[0], dy = vT[1] - vC[1];
        const w = Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? '더 아래' : '더 위') : (dx > 0 ? '더 오른쪽' : '더 왼쪽');
        how = x.kind === 'end' ? eul(S) + ' ' + w + '까지 그어요' : eun(S) + ' ' + w + '에서 시작해요';
        break;
      }
      case 'feature':
        how = vT > vC ? (vT > 0 ? eul(S) + ' ' + K + '보다 길게 써요' : eul(S) + ' 조금 더 길게 써요')
          : (vT < 0 ? eul(S) + ' ' + K + '보다 짧게 써요' : eul(S) + ' 조금 더 짧게 써요');
        break;
      case 'dot':
        how = eun(S + '(점)') + ' ' + dotName(M, x.k) + '의 ' + dotWord(vT, vC) + '에 찍어요';
        break;
      case 'cross': {
        const tT = meetType(vT), tC = meetType(vC);
        // the drawing's strokes already meet the way the target's do (お for あ: its strokes 1 and 2 cross as あ's do):
        // the message would ask for what is there
        if (!force && m && m.length === 5 && meetType(m) === tT && tT !== tC) return null;
        if (tT === 'apart') how = gwa(S) + ' ' + eul(K) + ' 떨어뜨려 써요';
        else if (tT === 'cross' && tC !== 'cross') how = iga(S) + ' ' + eul(K) + ' 가로지르게 써요';
        else if (tT !== 'cross' && tC === 'cross') {
          const a = tT === 'joinK' ? K : S, b = tT === 'joinK' ? S : K;
          how = eun(a) + ' ' + eul(b) + ' 가로지르지 않고 ' + b + '에 붙여 써요';
        } else if (tC === 'apart') how = gwa(S) + ' ' + iga(K) + ' 서로 닿게 써요';
        else {
          // the same kind of meeting: the difference is how far a stroke runs past the meeting point
          let best = 0, bd = -1;
          for (let c = 0; c < 4; c++) { const d = Math.abs(vT[c] - vC[c]); if (d > bd) { bd = d; best = c; } }
          const X = best < 2 ? S : K, Y = best < 2 ? K : S, longer = vT[best] > vC[best], after = best % 2 === 1;
          // which way the stroke runs on past the meeting point (template: from the meeting point to that end)
          const xp = M.T.pts[best < 2 ? x.j : x.k], e = after ? xp[xp.length - 1] : xp[0];
          const way = withRo(dirWord(e[0] - x.at[0], e[1] - x.at[1]));
          how = longer ? (after ? X + ' 끝이 ' + Y + ' 밖으로 나오게 ' + way + ' 길게 그어요' : eun(X) + ' ' + Y + '보다 ' + dirWord(e[0] - x.at[0], e[1] - x.at[1]) + '에서 시작해 ' + eul(Y) + ' 지나가요')
            : (after ? eun(X) + ' ' + Y + '에서 멈춰요' : eun(X) + ' ' + Y + '에서 시작해요');
        }
        break;
      }
    }
    if (!how) how = kpLabel(M, x) + '에 주의해요';
    return how;
  }
  // A measured direction (radians, y down) in the words of directionText ('왼쪽 위→오른쪽 아래').
  function dirName(a) {
    return directionText([[0, 0], [Math.cos(a), Math.sin(a)]]);
  }
  // How direction a (radians, y down) differs from b that has the same words: '더 아래쪽으로 기울게' …
  function steeper(a, b) {
    const dx = Math.cos(a) - Math.cos(b), dy = Math.sin(a) - Math.sin(b);
    return Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? '더 아래쪽으로' : '더 위쪽으로') : (dx > 0 ? '더 오른쪽으로' : '더 왼쪽으로');
  }
  // The key-point message for look-alike entry e of an evaluation: the textbook difference of the pair when it has one,
  // else the most telling missed point whose message tells the target from C on this drawing, else the first missed
  // point in its plain words. null when nothing was missed.
  function kpMissMessage(ev, e, target) {
    const lead = leadText(target, e.ch);
    if (lead) return target + '의 포인트: ' + lead + '. 지금은 ' + e.ch + '처럼 보여요.';
    if (!e.miss) return null;
    for (const mi of e.misses) {
      const msg = kpMessage(ev.M, mi.q, e.r, target, ev.mU[mi.q]);
      if (msg) return msg;
    }
    return kpMessage(ev.M, e.miss.q, e.r, target, ev.mU[e.miss.q], true);
  }

  // When the drawing has the look-alike's stroke count and no form of the target has it (シ written as ソ, タ as ク, は as
  // ほ): the stroke the drawing left out ('タ의 포인트: 3번째 획(점)을 빠뜨리지 말고 써요.'), the look-alike's stroke that
  // the target does not have ('ン의 포인트: ン에는 シ의 2번째 획(점)이 없어요.'), else the count ('シ의 포인트: シ는 3획으로
  // 써요.', a target with forms of different counts 'き는 4획 또는 3획으로 써요.'). The textbook difference of a classic pair
  // comes first (さ for き: '가로획을 2개 써요(さ는 1개)'). null when the count does not tell them apart.
  function kpCountMessage(M, C, target, U, st) {
    const counts = (ch) => BY_CHAR.get(ch).map((t) => t.n);
    if (!BY_CHAR.has(C) || counts(target).includes(U.n) || !counts(C).includes(U.n)) return null;
    const lead = leadText(target, C);
    if (lead) return target + '의 포인트: ' + lead + '. 지금은 ' + C + '처럼 보여요.';
    const rs = M.rivals.filter((r) => r.ch === C && r.n === U.n);
    if (U.n < M.T.n && st.missing.length === 1) {
      const q = M.sites.findIndex((x) => x.kind === 'count' && x.j === st.missing[0]), r = rs.find((y) => y.missingT.includes(st.missing[0]));
      if (q >= 0 && r) return kpMessage(M, q, r, target, undefined, true);
    }
    if (U.n > M.T.n) { const r = rs.find((y) => y.extraC.length); if (r) return kpExtraMessage(M, r, target); }
    const ns = [...new Set(counts(target))]; // the first form first (き: 4획 또는 3획)
    return `${target}의 포인트: ${target}${josa(target, '는', '은')} ${ns.join('획 또는 ')}획으로 써요. 지금은 ${C}처럼 보여요.`;
  }

  // When the drawing has a stroke too many and the look-alike has a stroke that T does not: 'カ의 포인트: カ에는 か의 3번째
  // 획(점)이 없어요.' — or, when that stroke of C runs along a stroke of T (ケ's bar on ク's bent stroke), that T writes it in
  // one go: 'ク의 포인트: ケ의 2번째 획처럼 따로 떼어 쓰지 말고, 2번째 획에 이어서 한 번에 써요.'
  function kpExtraMessage(M, r, target) {
    const lead = leadText(target, r.ch);
    if (lead) return target + '의 포인트: ' + lead + '. 지금은 ' + r.ch + '처럼 보여요.';
    return target + '의 포인트: ' + extraHow(M, r, target) + '. 지금은 ' + r.ch + '처럼 보여요.';
  }
  // (q: which of C's extra strokes; the first by default)
  function extraHow(M, r, target, q) {
    q = q || 0;
    const e = r.extraC[q], w = r.ch + '의 ' + nth(e) + ' 획', along = r.extraAlong ? r.extraAlong[q] : -1;
    if (along >= 0) return w + '처럼 따로 떼어 쓰지 말고, ' + strokeName(M, along) + '에 이어서 한 번에 써요';
    return target + '에는 ' + w + (r.extraDot && r.extraDot[q] ? '(점)' : '') + '이 없어요';
  }

  // ---------------------------------------------------------------------------------------------
  // Pair rules (grafted from candidate KP-B, js/recognizer-candidates/KP-B.js; tools/bench/RESULTS.md "Key points")
  // ---------------------------------------------------------------------------------------------
  // For a few directed look-alike pairs whose difference is a position or a proportion that the checkpoints above
  // blur under rough per-stroke noise (ク←ワ, り←い, ヤ←セ), a learnt linear vote on two named measures of the drawing. The measures are
  // KP-B's, taken exactly as there: on the drawing as normalised (before the affine refinement, which would explain a
  // slant away), each template stroke's part as the target's alignment found it, turned to the template's direction,
  // resampled to PR_N points by arc length. score = Σ w_i · clip((x_i − m_i) / s_i, ±PR_Z); the drawing votes for C
  // when score > th × PR_TH[strictness] and C is in contention (cost(C) − cost(T) ≤ g). A joined or broken stroke does
  // not vote. Selected by KP-B's select.js from its own synthetic drawings (66,760, both writers; no benchmark file);
  // the graft keeps only the pairs where the vote, added after the checkpoints, raised the dev rough look-alike
  // rejections without any new rejection of a correct drawing on any dev split (orig, ext, rough, box; normal,
  // lenient, strict). Each measure is also a public key point (merged into the checkpoint of the same kind and stroke
  // against the same look-alike when there is one); `text` is what the message says when that measure decided.
  // Discriminants (all: true; tools/bench/scratch-leak/disc.js): the same vote over 3–5 measures (m = the target's own
  // median, s its spread, w Fisher weights with a ridge, Σ|w| = 1), 'gap' = cost(C) − cost(T) among them; every measure is
  // needed (a joined stroke: no vote) and the rule has one point, pt, and one message. th sits at about the 99.5–100th
  // percentile of the target's own accepted drawings over dev + calibration drawings + the API test's distortion model.
  const PR_N = 40;
  const PR_Z = 6;
  const PR_TH = { lenient: 1.2, normal: 1, strict: 0.85 };
  const PR_SHARP = 0.06; // 'sharp': turning within ±this of arc (character units)
  const PR_END = 0.05;   // 'curl': stops this short of the stroke's ends (a flick of the pen at its very end is no curl)
  const PR_RULES = {
    'ク|std': [{ c: 'ワ', f: ['0.sx', '1.selfS'], m: [0.0173, 0.1374], s: [0.1112, 0.03], w: [-0.546, 0.454], z: [-3.898, 3.237], bz: [-1.949, 1.618], th: 2.438, g: 0.046,
      pts: [{ kind: 'start', j: 0, t: 0, label: '1번째 획의 시작 위치(위)', text: '1번째 획은 더 오른쪽에서 시작해요' },
        { kind: 'feature', j: 1, t: 0.12, label: '2번째 획의 짧은 가로 부분', text: '2번째 획은 가로로 짧게 긋고 꺾어서 왼쪽 아래로 길게 내려요' }] },
      { c: 'ワ', all: true, f: ['0.sx','0.dx','0.dy','gap'], m: [-0.0482,-0.2611,0.4173,0.0676], s: [0.1124,0.1249,0.1176,0.0204], w: [-0.29,0.065,-0.001,-0.644], z: [-3.02,2.27,0.04,-4.05], bz: [-1.51,1.14,0.02,-2.03], th: 2.32, g: 0.08, pt: { kind: 'start', j: 0, t: 0, label: '1번째 획의 시작 위치(위)', text: '1번째 획은 위쪽 가운데에서 시작해 왼쪽 아래로 짧게 비스듬히 그어요(ワ는 왼쪽에서 세로로 내려요)' } }],
    // (KP-B's pair rule り←い on 0-1.dmx and 1.ey: 1.ey's spread is 0.03, so a right stroke ending a little above the bottom of
    // the drawing votes い — natural り with a long left stroke or a medium right one (tools/bench/natural); since い / り became
    // a proportion pair it votes only where り's discriminant finds the drawing い-like too, bandBlocks)
    'り|std': [{ c: 'い', f: ['0-1.dmx', '1.ey'], m: [0.334, 0.5], s: [0.1379, 0.03], w: [0.274, -0.726], z: [3.016, -8.773], bz: [1.508, -4.387], th: 2.747, g: 0.037,
      pts: [{ kind: 'feature', j: 1, t: 0.5, label: '1번째 획과 2번째 획의 간격', text: '2번째 획을 1번째 획에 더 가깝게 써요' },
        { kind: 'end', j: 1, t: 1, label: '2번째 획의 끝 위치(아래)', text: '2번째 획을 더 아래까지 그어요' }] },
      { c: 'い', all: true, f: ['0-1.dmx', '0-1.lr', '1.dx', '0-1.dey'], m: [0.3748, 0.1384, -0.1166, 0.4092], s: [0.1387, 0.2292, 0.1697, 0.2601], w: [0.396, -0.268, 0.288, -0.048], z: [2.63, -2.65, 1.8, -1.37], bz: [1.32, -1.33, 0.9, -0.69], th: 1.9, g: 0.08,
        pt: { kind: 'feature', j: 1, t: 0.5, label: '1번째 획과 2번째 획의 간격', text: '2번째 획은 1번째 획 가까이에서 시작해 아래까지 길게 내려 그어요(い는 2번째 획이 짧고 오른쪽으로 떨어져 있어요)' } }],
    // discriminant (all: true) of い against り (tools/bench/natural/fix/calib-iri.js: natural い incl. edge drawings, dev, private
    // calibration drawings and the API distortion model; th = the 99.8th percentile of い's own drawings)
    'い|std': [{ c: 'り', all: true, f: ['0-1.dmx', '0-1.lr', '1.dx', '0-1.dey'], m: [0.7447, -0.5082, 0.2505, -0.0226], s: [0.0932, 0.2439, 0.0819, 0.1601], w: [-0.304, 0.282, -0.337, 0.076], z: [-3.42, 2.9, -4.46, 3.64], bz: [-1.71, 1.45, -2.23, 1.82], th: 1.83, g: 0.08,
      pt: { kind: 'feature', j: 1, t: 0.5, label: '2번째 획: 짧고 1번째 획과 떨어짐', text: '2번째 획은 1번째 획보다 짧게, 오른쪽으로 떨어뜨려 비스듬히 내려 써요(り는 2번째 획이 1번째 획 가까이에서 길게 내려와요)' } }],
    'ろ|std': [{ c: 'る', all: true, f: ['k0.curl', 'k0.endIn', 'gap'], m: [0.5379, 0.4025, 0.0508], s: [0.0904, 0.2785, 0.0183], w: [0.379, 0.253, -0.368], z: [6.47, 0.86, -4.74], bz: [3.23, 0.43, -2.37], th: 1.75, g: 0.08,
      pt: { kind: 'loop', j: 0, t: 0.92, label: '획 끝은 고리 없이 끝남', text: '끝은 둥글게 돌린 뒤 고리를 만들지 말고 왼쪽으로 빼며 끝내요(る는 끝에 작은 고리를 만들어요)' } }],
    'ヤ|std': [{ c: 'セ', f: ['1.teX', '0-1.eeX'], m: [0.1799, -0.2168], s: [0.2243, 0.1236], w: [0.531, 0.469], z: [3.597, 3.182], bz: [1.798, 1.591], th: 2.655, g: 0.045,
      pts: [{ kind: 'hook', j: 1, t: 1, label: '2번째 획 끝의 방향(아래)', text: '2번째 획 끝은 오른쪽으로 꺾지 않고 아래로 그어요' },
        { kind: 'end', j: 1, t: 1, label: '2번째 획의 끝 위치(아래)', text: '2번째 획은 1번째 획의 끝보다 왼쪽에서 끝내요' }] },
      { c: 'セ', all: true, f: ['1.dx','1.sharp','1.teX','0-1.eeX','gap'], m: [0.2033,0.6675,0.1626,-0.2565,0.0542], s: [0.1736,0.4549,0.2837,0.1679,0.0137], w: [0.045,0.054,0.198,0.202,-0.5], z: [1.9,0.86,2.87,2.39,-6.13], bz: [0.95,0.43,1.44,1.19,-3.07], th: 2.9, g: 0.08, pt: { kind: 'hook', j: 1, t: 1, label: '2번째 획 끝은 튕기지 않음', text: '2번째 획은 비스듬히 곧게 내려 긋고, 아래에서 오른쪽으로 꺾지 않아요(セ는 아래에서 오른쪽으로 꺾어요)' } }],
    // Hand-set one-measure rules for the pairs that still leaked under rough writing (KR-4: コ/ユ, し/レ, ス/ヌ, れ/わ).
    // m = the target's median, s ≈ a quarter of the gap to the look-alike's median; the vote threshold th sits at about
    // the target's 1st percentile (tools/bench/scratch-fix/prcal.js: the reviewers' rough models + dev/test/rough
    // samples), so a correct drawing is not turned down; g keeps it to drawings the look-alike fits about as well.
    'ユ|std': [{ c: 'コ', f: ['0-1.eeX'], m: [0.357], s: [0.07], w: [-1], z: [-3.96], bz: [-1.96], th: 3.6, g: 0.02,
      pts: [{ kind: 'end', j: 1, t: 1, label: '아래 가로획 끝: 세로획보다 오른쪽으로 나옴 (コ는 세로획에서 멈춤)', text: '2번째 획(아래 가로획)은 세로획보다 오른쪽으로 길게 내밀어 그어요(コ는 세로획에서 멈춰요)' }] },
      { c: 'コ', all: true, f: ['0-1.eeX', '0-1.wr', '0-1.rel', '0-1.ssX', 'gap'], m: [0.3433, 0.5824, 0.6516, -0.1943, 0.047], s: [0.104, 0.1405, 0.1076, 0.1647, 0.0177],
        w: [-0.335, 0.063, -0.161, 0.057, -0.383], z: [-2.56, 3.83, 2.22, 1.26, -3.34], bz: [-1.28, 1.91, 1.11, 0.63, -1.67], th: 1.33, g: 0.08,
        pt: { kind: 'end', j: 1, t: 1, label: '아래 가로획 끝: 세로획보다 오른쪽으로 나옴 (コ는 세로획에서 멈춤)', text: '위 가로 부분은 짧게, 아래 가로획은 세로획 양옆으로 길게 내밀어 그어요(コ는 위아래 길이가 비슷하고 세로획에서 멈춰요)' } }],
    'コ|std': [{ c: 'ユ', f: ['0-1.eeX'], m: [0.069], s: [0.07], w: [1], z: [4.04], bz: [2.02], th: 3.73, g: 0,
      pts: [{ kind: 'end', j: 1, t: 1, label: '아래 가로획 끝: 세로획에서 멈춤 (ユ는 오른쪽으로 나옴)', text: '2번째 획(아래 가로획)은 세로획 끝에서 멈추고 밖으로 내밀지 않아요(ユ는 오른쪽으로 나와요)' }] }],
    'し|std': [{ c: 'レ', f: ['0.ey'], m: [0.372], s: [0.1], w: [-1], z: [-4.02], bz: [-2.01], th: 3.12, g: 0.03,
      pts: [{ kind: 'end', j: 0, t: 1, label: '끝을 낮게 살짝만 올림 (レ는 높이 올림)', text: '아래를 각지게 꺾지 말고 둥글게 돌려, 끝은 낮게 살짝만 올려요' }] },
      { c: 'レ', all: true, f: ['0.sharp', '0.ey', 'gap'], m: [0.8671, 0.4003, 0.0348], s: [0.2973, 0.08, 0.065], w: [0.4, -0.492, -0.107], z: [2.32, -5.71, -0.84], bz: [1.16, -2.86, -0.42], th: 2.3, g: 0.08,
        pt: { kind: 'end', j: 0, t: 1, label: '끝을 낮게 살짝만 올림 (レ는 높이 올림)', text: '아래를 각지게 꺾지 말고 둥글게 돌려, 끝은 낮게 살짝만 올려요' } }],
    'レ|std': [{ c: 'し', f: ['0.ey'], m: [-0.028], s: [0.1], w: [1], z: [3.98], bz: [1.99], th: 2.88, g: 0.03,
      pts: [{ kind: 'end', j: 0, t: 1, label: '끝을 높이 올림 (し는 낮게 살짝)', text: '아래에서 각지게 꺾어 오른쪽 위로 높이 올려요(し는 둥글게 돌려 낮게 끝내요)' }] },
      { c: 'し', all: true, f: ['0.sharp','0.ey','gap'], m: [1.7748,-0.0659,0.0254], s: [0.4039,0.1608,0.0283], w: [-0.389,0.52,-0.091], z: [-2.19,2.68,-1.84], bz: [-1.1,1.34,-0.92], th: 1.42, g: 0.08, pt: { kind: 'end', j: 0, t: 1, label: '끝을 높이 올림 (し는 낮게 살짝)', text: '아래에서 각지게 꺾어 오른쪽 위로 높이 올려요(し는 둥글게 돌려 낮게 끝내요)' } }],
    'れ|std': [{ c: 'わ', f: ['1.ex'], m: [0.499], s: [0.08], w: [-1], z: [-4.31], bz: [-2.16], th: 4.36, g: 0.03,
      pts: [{ kind: 'end', j: 1, t: 1, label: '2번째 획 끝: 오른쪽 바깥까지 (わ는 안쪽으로 감음)', text: '2번째 획 끝을 오른쪽 바깥으로 튕겨 올려요(わ는 안쪽으로 둥글게 감아요)' }] }],
    'ス|std': [{ c: 'ヌ', f: ['0-1.dmx'], m: [0.336], s: [0.06], w: [-1], z: [-4.4], bz: [-2.2], th: 3.6, g: 0.03,
      pts: [{ kind: 'start', j: 1, t: 0, label: '2번째 획: 1번째 획 가운데에서 시작 (ヌ는 가로질러 씀)', text: '2번째 획은 1번째 획의 가운데에서 시작해 오른쪽 아래로 짧게 그어요(ヌ처럼 가로지르지 않아요)' }] }],
    'ヌ|std': [{ c: 'ス', f: ['0-1.dmx'], m: [0.064], s: [0.06], w: [1], z: [4.57], bz: [2.28], th: 4.1, g: 0.03,
      pts: [{ kind: 'start', j: 1, t: 0, label: '2번째 획: 1번째 획을 가로질러 씀 (ス는 가운데에서 시작)', text: '2번째 획은 왼쪽 위에서 시작해 1번째 획을 가로질러 오른쪽 아래로 그어요(ス는 1번째 획 가운데에서 시작해요)' }] }],
    // discriminant (all: true) of ア against マ
    'ア|std': [{ c: 'マ', all: true, f: ['1.dx','1.dy','0-1.lr','gap'], m: [-0.2508,0.6397,-0.4897,0.078], s: [0.1305,0.1024,0.2333,0.0206], w: [0.31,-0.036,-0.236,-0.418], z: [3.58,-2.07,-2.85,-6], bz: [1.79,-1.03,-1.42,-3], th: 2.72, g: 0.08, pt: { kind: 'direction', j: 1, t: 0.5, label: '2번째 획 방향(위→아래)', text: '2번째 획은 1번째 획 가운데에서 왼쪽 아래로 길게 내려요(マ는 2번째 획이 짧고 오른쪽 아래로 찍어요)' } }],
    // discriminant (all: true) of メ against ヌ
    'メ|std': [{ c: 'ヌ', all: true, f: ['0.sharp','0.sx','0.dx','gap'], m: [0.6357,0.2951,-0.6593,0.085], s: [0.3925,0.139,0.2189,0.0213], w: [0.229,-0.096,-0.08,-0.595], z: [2.71,-3.48,2.19,-6.51], bz: [1.35,-1.74,1.09,-3.25], th: 2.78, g: 0.08, pt: { kind: 'corner', j: 0, t: 0.2, label: '1번째 획은 오른쪽 위에서 꺾지 않음', text: '1번째 획은 가로로 긋지 말고 오른쪽 위에서 왼쪽 아래로 곧게 비스듬히 그어요(ヌ는 가로로 긋다가 꺾어요)' } }],
    // discriminant (all: true) of モ against も
    'モ|std': [{ c: 'も', all: true, f: ['0-2.ssY','2.sharp','2.teY','gap'], m: [0.0892,1.1317,-0.0065,0.0659], s: [0.1151,0.4191,0.268,0.0162], w: [-0.188,-0.042,-0.204,-0.567], z: [-2.48,0.13,-3.25,-6.41], bz: [-1.24,0.07,-1.62,-3.2], th: 2.73, g: 0.08, pt: { kind: 'start', j: 2, t: 0, label: '3번째 획의 시작 위치(위)', text: '3번째 획은 1번째 획에서 시작해 곧게 내려 긋고, 아래에서 꺾어 오른쪽으로 그어요(も는 세로획이 위로 나오고 아래가 둥글어요)' } }],
  };
  // (a rule against a same-shape twin of the target — none today; り/リ became twins and lost theirs — never votes, vetoes
  // or shows: drawing the twin is right)
  const prRules = (T) => {
    const rules = PR_RULES[T.ch + '|' + T.variantId];
    if (!rules) return null;
    const tw = TWINS.get(T.ch), out = tw && tw.size > 1 ? rules.filter((r) => !tw.has(r.c)) : rules;
    return out.length ? out : null;
  };

  // The per-stroke measures the rules use: start / end / centre, end tangent, and how close the first 30 % of the
  // stroke comes back to a part of itself at least 15 % of its length later (selfS); for the discriminants also the
  // run from start to end (dx, dy), the bounding box (x0 x1 y0 y1, width w), the arc length (len) and the sharpest turn over a short stretch (sharp, rad: a
  // corner, against a round bend).
  function prStroke(pts) {
    const L = polyLength(pts), a = pts[0], b = pts[pts.length - 1];
    const r = L > 1e-6 ? resample(pts, PR_N) : Array.from({ length: PR_N }, () => a.slice());
    let mx = 0, my = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of r) { mx += p[0]; my += p[1]; }
    for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    const o = { sx: a[0], sy: a[1], ex: b[0], ey: b[1], dx: b[0] - a[0], dy: b[1] - a[1], mx: mx / r.length, my: my / r.length, x0, x1, y0, y1, w: x1 - x0, len: L };
    let sharp = 0;
    if (L >= 0.1) {
      const S = shapeOf(pts);
      for (let i = Math.floor(0.2 * S.n); i < Math.floor(0.95 * S.n); i++) sharp = Math.max(sharp, Math.abs(netTurn(S, i * S.h - PR_SHARP, i * S.h + PR_SHARP)));
    }
    o.sharp = sharp;
    const at = (f) => r[Math.round(f * (PR_N - 1))];
    const tx = at(0.96)[0] - at(0.75)[0], ty = at(0.96)[1] - at(0.75)[1], tl = Math.hypot(tx, ty);
    o.teX = tl > 1e-9 ? tx / tl : 0; o.teY = tl > 1e-9 ? ty / tl : 0;
    let best = 1;
    if (L >= 0.1) {
      for (let i = 0; i <= Math.round(0.3 * (PR_N - 1)); i++) for (let j = i + 6; j < PR_N; j++) {
        const d = Math.hypot(r[i][0] - r[j][0], r[i][1] - r[j][1]);
        if (d < best) best = d;
      }
    }
    o.selfS = best;
    return o;
  }
  function prPairOf(A, B) {
    const bw = Math.max(1e-6, B.w);
    return { dmx: B.mx - A.mx, eeX: B.ex - A.ex, ssX: B.sx - A.sx, ssY: B.sy - A.sy, dey: B.ey - A.ey, wr: A.w / bw, rel: (A.ex - B.x0) / bw,
      lr: Math.log(Math.max(B.len, 0.02) / Math.max(A.len, 0.02)),
      // heights (log ratio; a flick at a stroke's foot does not count) and how far B reaches below A's lowest point
      hr: Math.log(Math.max(B.y1 - B.y0, 0.02) / Math.max(A.y1 - A.y0, 0.02)), dby: B.y1 - A.y1 };
  }
  // Measures on the registered drawing (the key points' parts) of template stroke j: 'curl' — how far the stroke turns
  // (turns) after the template's last corner on it, stopping PR_END short of its end (ろ's bowl ends there; る's curls on
  // into its loop); 'endIn' — where it ends across the width of that last part (0 = its left edge, 1 = its right edge).
  function prKp(ctx, j, f) {
    if (!ctx.parts) ctx.parts = partsOf(ctx.al, ctx.U0);
    const A = ctx.parts[j];
    if (!A || A.merge || !(A.S.h > 0)) return NaN;
    const S = A.S, M = kpModel(ctx.al.T);
    let c = null;
    for (const x of M.sites) if (x.kind === 'corner' && x.has && x.j === j && (!c || x.s > c.s)) c = x;
    const sb = c ? A.at(c.s) : 0;
    if (f === 'curl') return netTurn(S, sb + PR_END, S.L - PR_END) / (2 * Math.PI);
    if (f === 'endIn') {
      let x0 = Infinity, x1 = -Infinity;
      for (let i = Math.ceil(sb / S.h); i < S.n; i++) { x0 = Math.min(x0, S.p[i][0]); x1 = Math.max(x1, S.p[i][0]); }
      return x1 > x0 ? (S.p[S.n - 1][0] - x0) / (x1 - x0) : NaN;
    }
    return NaN;
  }
  // The drawing's polyline for each template stroke of an alignment (null = missing), on U0 = the drawing as
  // normalised, in the template's direction; a stroke joined with its neighbour or broken in pieces does not vote,
  // of a stroke drawn twice the copy the alignment kept counts.
  function prContext(al, U0) {
    const T = al.T, U = U0 || al.U, P = new Array(T.n).fill(null), merged = new Array(T.n).fill(0);
    const orient = (pts, st) => (st.rev < st.fwd ? pts.slice().reverse() : pts);
    for (const st of al.steps) {
      if (st.type === 'extra') continue;
      const j = st.t[0];
      if (st.type === 'match') P[j] = orient(U.pts[st.u[0]], st);
      else if (st.type === 'dup') P[j] = orient(U.pts[st.keep], st);
      else if (st.type === 'split') merged[j] = 1;
      else if (st.type === 'merge') merged[j] = merged[st.t[1]] = 1;
    }
    return { P, merged, S: new Array(T.n), Q: new Map(), al, U0: U };
  }
  function prValue(ctx, fid) {
    const kp = /^k(\d+)\.(\w+)$/.exec(fid);
    if (kp) return +kp[1] < ctx.P.length && !ctx.merged[+kp[1]] ? prKp(ctx, +kp[1], kp[2]) : NaN;
    const m = /^(\d+)(?:-(\d+))?\.(\w+)$/.exec(fid), j = +m[1], k = m[2] === undefined ? -1 : +m[2], f = m[3];
    if (j >= ctx.P.length || k >= ctx.P.length || ctx.merged[j] || (k >= 0 && ctx.merged[k])) return NaN;
    const so = (q) => { if (ctx.S[q] === undefined) ctx.S[q] = ctx.P[q] && ctx.P[q].length ? prStroke(ctx.P[q]) : null; return ctx.S[q]; };
    const A = so(j);
    if (!A) return NaN;
    if (k < 0) return A[f];
    const key = j * 64 + k;
    if (!ctx.Q.has(key)) { const B = so(k); ctx.Q.set(key, B ? prPairOf(A, B) : null); }
    const q = ctx.Q.get(key);
    return q ? q[f] : NaN;
  }
  // The rules of the target's form measured on the drawing: null when the form has none. Measured on the target's
  // own alignment (in box mode the form may be a small twin's: then the target's best alignment).
  function prMeasure(an, U, target) {
    if (!KANA[target]) return null;
    let al = an.form;
    if (!prRules(al.T)) { const e = an.list.find((x) => x.ch === target); al = e ? e.al : null; }
    const rules = al && prRules(al.T);
    if (!rules) return null;
    const ctx = prContext(al, U);
    const costOf = (ch) => { const e = an.list.find((x) => x.ch === ch); return e ? e.al.cost : NaN; };
    const sc = rules.map((rule) => {
      let s = 0, best = -Infinity, why = 0, none = false;
      const hits = rule.f.map((fid, i) => {
        // 'gap': how much worse the look-alike's whole shape fits than the target's (cost(C) − cost(T))
        let z = ((fid === 'gap' ? costOf(rule.c) - costOf(al.T.ch) : prValue(ctx, fid)) - rule.m[i]) / rule.s[i];
        if (!isFinite(z)) { if (rule.all) none = true; return null; }
        z = Math.max(-PR_Z, Math.min(PR_Z, z));
        const c = rule.w[i] * z;
        s += c;
        if (c > best) { best = c; why = i; }
        return (z - rule.bz[i]) * Math.sign(rule.z[i]) < 0; // on T's side of the half-way boundary
      });
      // (a discriminant — rule.all — needs every one of its measures: without one it does not vote; its one point rule.pt
      // is on the target's side while the score stays below the threshold)
      if (rule.pt) return { score: none ? -Infinity : s, hits: [none ? null : s <= rule.th], why: 0 };
      return { score: none ? -Infinity : s, hits, why };
    });
    return { T: al.T, rules, sc, ctx };
  }
  // The look-alike the pair rules vote for (accepted shapes only), or null.
  function prVote(pr, costOf, costT, strictness, vetoed) {
    if (!pr) return null;
    const thf = PR_TH[strictness] || PR_TH.normal;
    let vote = null;
    pr.rules.forEach((rule, ri) => {
      const s = pr.sc[ri], margin = s.score - rule.th * thf;
      if (margin <= 0 || !(costOf(rule.c) - costT <= rule.g) || (vetoed && vetoed(rule.c))) return;
      if (!vote || margin > vote.margin) vote = { rule, ri, margin, pt: rule.pt || rule.pts[s.why] };
    });
    return vote;
  }
  // Mutual consistency of the discriminants: look-alike C is not named over target T (not by the shape match, the
  // checkpoints or T's own rules) when C's own discriminant against T (an all: true rule of C's form, c = T) votes T on
  // the drawing, measured on C's alignment — the drawing is then clearly unlike C's own drawings, on T's side: a
  // sharp-cornered レ with a low end is not し, り whose right stroke runs long beside the left is not い (い's rule says り).
  // Without it such a drawing was turned down both as T and as C. The veto protects the target, so strictness works the
  // other way round from a vote: threshold th / PR_TH.strict when strict, th otherwise (lenient does not veto more readily:
  // on dev that let 4 more rough look-alikes through), the shapes within g.
  function prVeto(an, U, T, C, strictness) {
    const e = an.list.find((x) => x.ch === C), t = an.list.find((x) => x.ch === T);
    const rules = e && t ? prRules(e.al.T) : null;
    if (!rules) return false;
    const thf = Math.max(1, 1 / (PR_TH[strictness] || PR_TH.normal)), gap = t.al.cost - e.al.cost;
    let ctx = null;
    for (const rule of rules) {
      if (!rule.all || rule.c !== T || !(gap <= rule.g)) continue;
      if (!ctx) ctx = prContext(e.al, U);
      let s = 0, none = false;
      rule.f.forEach((fid, i) => {
        const z = ((fid === 'gap' ? gap : prValue(ctx, fid)) - rule.m[i]) / rule.s[i];
        if (!isFinite(z)) none = true;
        else s += rule.w[i] * Math.max(-PR_Z, Math.min(PR_Z, z));
      });
      if (!none && s > rule.th * thf) return true;
    }
    return false;
  }
  // Proportion pairs (い / り): the benefit of the doubt for the asked character. い and り differ in their proportions (り: the
  // right stroke long, reaching well below the left one, close to it, sweeping left; い: the right stroke shorter, apart,
  // slanting right), and natural handwriting covers the space between (tools/bench/natural: edge drawings, the い ↔ り
  // continuum). For such a pair look-alike C is named over the asked character T — by the shape match, the checkpoints or
  // T's rules (the り←い pair rule included) — only when C fits clearly better (cost(C) < cost(T) − BAND_GAP) or T's own
  // discriminant against C finds the drawing C-like (score > BAND.TH × th: past T's own drawings' 99th percentile or so;
  // its own vote needs th). An ambiguous drawing is T; one the discriminant cannot measure (a joined or broken stroke) is
  // judged as before. pr = prMeasure() of the drawing.
  // BAND_DEF: C's defining proportions, which the drawing must show before T's discriminant may name C (when C does not
  // fit clearly better). い asked: り is named only when the right stroke is clearly taller than the left (log height ratio
  // 0-1.hr ≥ hr) or reaches clearly below it (0-1.dby ≥ dby) — decision (ii): "り: right stroke clearly much longer and
  // descending well below". Without it an い whose right stroke is about as long as the left, drawn upright or close, was
  // turned down as り (verification set, scratch: core い 4.4 %, い with a right stroke 0.85–1 × the left 45 %, the
  // discriminant's 1.dx and 0-1.dmx reading an upright right stroke as り's); with it 0.3–0.6 % / 8–15 %, clear り for い
  // still 100 % ✕, dev unchanged (OR of the two at 0.1: the AND of them at 0 let a 25 % morph through on dev).
  const BAND_PAIRS = { 'い': ['り'], 'り': ['い'] };
  const BAND_GAP = { lenient: 0.035, normal: 0.03, strict: 0.02 }; // (tools/bench/natural/fix/band-gap.js)
  const BAND = { TH: 0.8 }; // the gate: T's discriminant at this × its th (a vote needs th; tools/bench/natural/fix/band-th.js)
  const BAND_DEF = { 'い': { c: 'り', hr: 0.1, dby: 0.1 } };
  function bandBlocks(an, pr, target, C, strictness) {
    // (the pair of the form the rules were measured on: リ asked and written like り is protected like り)
    if (!pr || !((BAND_PAIRS[target] || []).includes(C) || (BAND_PAIRS[pr.T.ch] || []).includes(C))) return false;
    const e = an.list.find((x) => x.ch === C);
    if (!e || e.al.cost < an.tgt.al.cost - (BAND_GAP[strictness] || BAND_GAP.normal)) return false;
    const dp = BAND_DEF[pr.T.ch];
    if (dp && dp.c === C && pr.ctx) {
      const hr = prValue(pr.ctx, '0-1.hr'), dby = prValue(pr.ctx, '0-1.dby');
      if (isFinite(hr) && isFinite(dby) && hr < dp.hr && dby < dp.dby) return true;
    }
    const ri = pr.rules.findIndex((r) => r.all && r.c === C);
    if (ri < 0 || !isFinite(pr.sc[ri].score)) return false;
    return !(pr.sc[ri].score > BAND.TH * pr.rules[ri].th * Math.min(1, PR_TH[strictness] || PR_TH.normal)); // (lenient: not raised — the band is the leniency)
  }
  // The rules' points merged into a public point list (in place): a measure joins the checkpoint of the same kind on
  // the same stroke that is critical against the same look-alike, or becomes a point of its own. With pr (a judged
  // drawing) the hits are combined (false wins); vote = the point a pair-rule ✕ names, which is then missed.
  function prPublic(T, points, pr, vote) {
    const rules = prRules(T);
    if (!rules) return;
    const box = T.box || (T.box = bboxOf(T.raw)), sc = Math.max(box.w, box.h) || 1;
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    rules.forEach((rule, ri) => (rule.pt ? [rule.pt] : rule.pts).forEach((d, i) => {
      let p = points.find((q) => q.kind === d.kind && q.stroke === d.j && q.against.includes(rule.c));
      if (!p) {
        const base = d.kind + (d.j + 1);
        const at = pointAt(shapeOf(T.pts[d.j]), d.t * polyLength(T.pts[d.j]));
        p = { id: points.some((q) => q.id === base) ? base + '-' + rule.c : base, stroke: d.j, x: +(at[0] * sc + cx).toFixed(1), y: +(at[1] * sc + cy).toFixed(1),
          kind: d.kind, label: d.label, critical: true, against: [rule.c] };
        if (!pr) p.hint = { [rule.c]: d.text };
        if (pr) p.hit = null;
        points.push(p);
      } else if (!pr && !(p.hint && p.hint[rule.c])) (p.hint || (p.hint = {}))[rule.c] = d.text;
      if (!pr) return;
      let h = pr.sc[ri].hits[i];
      if (vote && vote.ri === ri && vote.pt === d) h = false;
      if (h === false) p.hit = false;
      else if (h === true && p.hit === null) p.hit = true;
    }));
  }

  // The keypoints field of a JudgeResult (additive): { ch, variantId, points: [... hit], failed: [ids] }. A drawing
  // judged against another character's form (a same-shape or small / big twin) gets the target's points unjudged.
  function kpResult(ev, target, pr, vote) {
    if (ev.M.T.ch !== target) {
      const s = keypoints(target, ev.M.T.variantId);
      return { ch: target, variantId: s.variantId, points: s.points.map((p) => Object.assign(p, { hit: null })), failed: [] };
    }
    const pub = publicPoints(ev.M, ev);
    if (pr && pr.T === ev.M.T) prPublic(ev.M.T, pub.points, pr, vote);
    return { ch: target, variantId: ev.M.T.variantId, points: pub.points, failed: pub.points.filter((p) => p.hit === false).map((p) => p.id) };
  }

  // KanaRecognizer.keypoints(ch, variantId?) → { ch, variantId, points } (no hit): the chart's '구별 포인트'. Each critical
  // point may carry hint: { [C]: text } — how to write it so it is not look-alike C ('2번째 획 끝에 작은 고리를 만들어요').
  // A hint is left out when another point of the form already says the same against C, and when C's own points say
  // the very same words against this character (さ / ち: '2번째 획을 왼쪽 아래에서 꺾어 써요' on both sides tells nothing):
  // the chart then shows the label.
  const KP_PUBLIC = new Map();
  function formPoints(T) {
    let pts = KP_PUBLIC.get(T);
    if (!pts) {
      pts = publicPoints(kpModel(T), null).points;
      prPublic(T, pts, null, null);
      const seen = {};
      for (const p of pts) if (p.hint) for (const C of Object.keys(p.hint)) {
        const k = C + '|' + p.hint[C];
        if (seen[k]) delete p.hint[C];
        else seen[k] = true;
      }
      KP_PUBLIC.set(T, pts);
    }
    return pts;
  }
  function keypoints(ch, variantId) {
    if (!BY_CHAR.has(ch)) throw new Error('KanaRecognizer.keypoints: unknown character ' + JSON.stringify(ch));
    const list = BY_CHAR.get(ch), T = list.find((t) => t.variantId === variantId) || list[0];
    const points = formPoints(T).map((p) => Object.assign({}, p, { against: p.against.slice() }, p.hint ? { hint: Object.assign({}, p.hint) } : null));
    for (const p of points) {
      if (!p.hint) continue;
      for (const C of Object.keys(p.hint)) {
        const mirror = BY_CHAR.has(C) && BY_CHAR.get(C).some((CT) => formPoints(CT).some((q) => q.hint && q.hint[ch] === p.hint[C]));
        if (mirror) delete p.hint[C];
      }
      if (!Object.keys(p.hint).length) delete p.hint;
    }
    return { ch, variantId: T.variantId, points };
  }

  function judge(strokes, target, opts) {
    opts = opts || {};
    const k = typeof target === 'string' ? info(target) : null;
    if (!k) throw new Error(`KanaRecognizer.judge: unknown target ${JSON.stringify(target)} (not in KANA_DATA.kana or KANA_DATA.extra)`);
    const box = boxOf(opts);
    const U = prepareInput(strokes);
    const res = emptyResult(target, k, U ? U.n : 0);
    if (!U) { res.issues.push({ type: 'shape', message: '아무것도 쓰지 않았어요.' }); return res; }
    res.mapping = new Array(U.n).fill(-1);
    if (U.n > P.MAX_STROKES) {
      res.issues.push({ type: 'count', message: `획이 너무 많아요: ${k.strokeCount}획인데 ${U.n}획으로 썼어요.` });
      res.structure.extra = res.mapping.map((_, i) => i);
      return res;
    }
    const pl = box ? placementOf(U, box) : null;
    const kpX = judgeShape(res, U, target, k, opts, pl);
    if (pl && !markRules(res, U, target, k, pl, box)) sizeRules(res, U, target, k, pl, kpX);
    leadHits(res);
    return res;
  }

  // The judgement of the drawing's shape (and stroke order) into res; pl = its placement in the cell or null.
  // Returns true when an accepted shape was turned into ✕ by a key point (box mode: the size rules still apply).
  function judgeShape(res, U, target, k, opts, pl) {
    const th = P.STRICT[opts.strictness] || P.STRICT.normal;
    const sized = !!pl || !KANA[target];

    const an = analyse(U, target, opts, pl);
    const { list, twins, close, tgt } = an;
    let { form, st } = an;
    res.candidates = candidatesOf(list, pl);
    res.score = +tgt.al.cost.toFixed(4);
    // a reading that needs a stroke turned round or written out of order keeps the stricter thresholds: the extra room for
    // rough writing (accept, margin) is for the drawing written as the target is written (ン for ソ is ソ with a reversed
    // stroke, リ for り …)
    const ordered = !st.reversed.length && !st.orderErrors.length;
    const acc = ordered ? th.accept : th.acceptOrder;
    // key points (판별 포인트) of the target's form, measured on the drawing: the checkpoints and the pair rules
    const pr = prMeasure(an, U, target);
    // a look-alike whose own discriminant against the target says the drawing is the target is not named (prVeto), nor one
    // of a proportion pair (い / り) that the drawing does not clearly show (bandBlocks)
    const vetoes = new Map();
    const vetoed = (c) => {
      if (!vetoes.has(c)) vetoes.set(c, bandBlocks(an, pr, target, c, opts.strictness) || prVeto(an, U, target, c, opts.strictness));
      return vetoes.get(c);
    };
    const beater = tgt.al.cost <= acc ? beaterOf(an, ordered ? th : Object.assign({}, th, { margin: th.marginOrder }), vetoed) : null;
    const ev = kpEvaluate(U, an);
    res.keypoints = kpResult(ev, target, pr, null);
    const shapeOK = tgt.al.cost <= acc && !beater;

    // stray specks (taps, accidental dots) on an otherwise clear target are a count error (△), not ✕. "Clear"
    // is judged on the drawing without them: what the specks themselves cost is taken out again.
    let speckCost = 0;
    for (const i of st.extras) speckCost += P.EXTRA_SPECK * U.w[i] + P.EXTRA_SPECK_ABS * form.T.W;
    const specksOnly = st.extras.length > 0 && st.extras.every((i) => U.len[i] < P.SPECK_LEN) &&
      tgt.al.cost - speckCost / form.T.W <= th.accept * P.COUNT_ACCEPT;
    let missed = null;
    if (shapeOK && !st.missing.length && (!st.extras.length || specksOnly)) {
      missed = missingReading(U, an);
      // an accepted shape that misses a key point of the target where a look-alike explains the drawing better → ✕
      // (the checkpoints first; then, for the few pairs that have one, the pair rule)
      const kb = !missed ? kpBeater(ev, KP.L[opts.strictness] || KP.L.normal, vetoed) : null;
      const pv = !missed && !kb ? prVote(pr, (c) => { const e = list.find((x) => x.ch === c); return e && explains(an, U, c) ? e.al.cost : Infinity; }, tgt.al.cost, opts.strictness, vetoed) : null;
      if (kb || pv) {
        const C = kb ? kb.ch : pv.rule.c;
        res.recognized = C;
        res.confusedWith = k.confusables.includes(C) ? C : null;
        res.crossScript = C === k.pair;
        res.mapping = st.mapping;
        res.structure = publicStructure(st, false);
        res.strokeCount.expected = form.T.n;
        if (pv) res.keypoints = kpResult(ev, target, pr, pv);
        res.issues = [{ type: 'keypoint', message: kb ? kpMissMessage(ev, kb, target) : `${target}의 포인트: ${pv.pt.text}. 지금은 ${C}처럼 보여요.` }];
        if (res.crossScript) res.issues.push({ type: 'script', message: `'${C}'${josa(C, '는', '은')} ${scriptName(C)}예요. ${scriptName(target)} '${target}'${josa(target, '를', '을')} 써야 해요.` });
        return true;
      }
      // a loop of the target's own that the drawing clearly leaves out (ほ / な / ぼ without the loop: no look-alike lacks
      // it, so no key point above asks for it) → ✕, the target with that part missing
      const noLoop = !missed && ev.M.T === form.T ? loopMissed(ev, opts.strictness) : null;
      if (noLoop) {
        res.recognized = target;
        res.mapping = st.mapping;
        res.structure = publicStructure(st, false);
        res.strokeCount.expected = form.T.n;
        const S = strokeName(ev.M, noLoop.j);
        res.issues = [{ type: 'shape', message: `원래 ${noLoop.end ? S + ' 끝에 있는 작은 고리' : S + ' 중간에 있는 고리'}가 빠졌어요. 고리를 작게라도 만들어 써요.` }];
        return true;
      }
      if (!missed) {
        res.recognized = target;
        res.variantId = form.T.variantId;
        res.strokeCount.expected = form.T.n;
        res.mapping = st.mapping;
        res.reversed = st.reversed;
        res.orderErrors = st.orderErrors;
        res.structure = publicStructure(st, true);
        res.issues = structureIssues(st, form, target);
        res.verdict = res.issues.length ? 'order' : 'correct';
        // a near same-shape twin (り/リ) whose form fits the drawing clearly better (TWIN_NOTE): accepted all the same, with a
        // gentle note on how the target's own form differs (never an issue: the grade stays)
        // (り's note is about the flick of its left stroke: not when the drawing has one — a り with a short left stroke and
        // a clear flick fits リ's form better too, and was told to flick)
        const own = list.find((e) => e.ch === target);
        const flick = TWIN_FLICK[target];
        if (form.T.ch !== target && k.twinNote && TWINS.get(target).has(form.T.ch) && own && own.al.cost - form.cost >= P.TWIN_NOTE &&
          (flick === undefined || !(flickRise(U, form, flick) >= P.TWIN_FLICK))) {
          res.notes = [{ type: 'twin', message: k.twinNote }];
        }
        return false;
      }
      // a stroke was left out: explained with the reading that has the missing stroke
      form = missed;
      st = structureOf(missed);
    }

    // ✕ — what was written instead? (mapping, structure and the expected count still describe the drawing
    // against the target's closest form)
    res.mapping = st.mapping;
    res.structure = publicStructure(st, false);
    res.strokeCount.expected = form.T.n;
    let rec = null;
    if (missed) rec = target;
    else {
      // best shape match; among near ties prefer the reading that needs fewer writing mistakes
      let top = list[0];
      let bestEff = Infinity;
      for (const e of list) {
        if (e.al.cost > list[0].al.cost + 3 * P.REC_ERR) break;
        const eff = e.al.cost + P.REC_ERR * mistakes(e === tgt ? st : structureOf(e.al));
        if (eff < bestEff) { bestEff = eff; top = e; }
      }
      rec = top.al.cost <= P.RECOG_MAX ? top.ch : null;
      // the close relative that beat the target, unless that reading names another close relative (ソ written for シ:
      // ン may beat シ by a hair, but ソ is what the strokes say)
      if (beater && close.has(beater.ch) && !(rec && close.has(rec))) rec = beater.ch;
      else if (rec && !twins.has(rec) && !close.has(rec)) {
        // a close relative that is nearly as good is the more useful diagnosis
        const look = list.find((e) => close.has(e.ch) && e.al.cost <= top.al.cost + P.LOOK_REPORT && e.al.cost <= P.RECOG_MAX);
        if (look) rec = look.ch;
      }
    }
    // the shape match named no look-alike (another letter, nothing, or the target itself without a missing stroke):
    // the look-alike with the most key-point evidence is the better diagnosis, if the evidence is for it at all and its
    // shape fits about as well as the target's (the other-script pair, a ゛/゜ relative or a homophone keeps its own
    // explanation)
    // (the other-script pair only gives way to a look-alike that the key points clearly favour and that fits as well)
    const isPair = rec && !twins.has(rec) && (rec === k.pair || (sized && !!k.pair && sizeTwin(rec) === k.pair));
    const explained = rec && !twins.has(rec) && (markRelation(target, rec) || homophone(target, rec));
    // the drawing is rejected: a stroke drawn the other way round now tells too (ソ's long stroke written like ン's)
    const evR = kpEvaluate(U, an, true);
    res.keypoints = kpResult(evR, target, pr, null);
    if (!missed && !(rec && k.confusables.includes(rec)) && !explained) {
      const costOf = (ch) => { const e = list.find((x) => x.ch === ch); return e ? e.al.cost : Infinity; };
      const ref = isPair ? costOf(rec) + KP.NAME_PAIR_WIN : tgt.al.cost + KP.NAME_WIN; // about as close as the pair / the target
      let best = null;
      for (const e of evR.byC.values()) {
        const c = costOf(e.ch), sc = evR.score(e);
        if (!k.confusables.includes(e.ch) || c > ref || c > P.RECOG_MAX || sc < (isPair ? KP.NAME_PAIR_L : KP.NAME_L)) continue;
        if (!best || sc > best.sc) best = { ch: e.ch, sc };
      }
      if (best) rec = best.ch;
    }
    if (rec && twins.has(rec)) rec = target;
    if (rec && rec !== target && sized) rec = bySize(rec, pl, target);
    res.recognized = rec;
    if (rec && rec !== target) {
      if (k.confusables.includes(rec)) {
        res.confusedWith = rec;
        res.issues.push({ type: 'lookalike', message: `'${rec}'${josa(rec, '와', '과')} 헷갈렸어요.` });
        // the key point of the target that the drawing missed, where it looks like the look-alike
        // (a stroke count that only the look-alike has is the clearest point)
        // (a classic pair: its textbook difference)
        const ke = evR.byC.get(rec), lead = leadText(target, rec);
        const km = kpCountMessage(evR.M, rec, target, U, st) || (ke ? kpMissMessage(evR, ke, target) : null) ||
          (lead ? `${target}의 포인트: ${lead}. 지금은 ${rec}처럼 보여요.` : null);
        if (km) res.issues.push({ type: 'keypoint', message: km });
        else if (ke && ke.r.extraC.length && st.extras.length) res.issues.push({ type: 'keypoint', message: kpExtraMessage(evR.M, ke.r, target) });
      }
      if (rec === k.pair || (sized && !!k.pair && sizeTwin(rec) === k.pair)) {
        res.crossScript = true;
        res.issues.push({ type: 'script', message: `'${rec}'${josa(rec, '는', '은')} ${scriptName(rec)}예요. ${scriptName(target)} '${target}'${josa(target, '를', '을')} 써야 해요.` });
      }
      const mark = markRelation(target, rec);
      if (mark) res.issues.push({ type: 'shape', message: mark });
      if (!res.issues.length && homophone(target, rec)) res.issues.push({ type: 'shape', message: homophoneMessage(target, rec) });
      const longV = res.issues.length ? null : longVowelMessage(target, rec);
      if (longV) res.issues.push({ type: 'shape', message: longV });
      if (!res.issues.length) res.issues.push({ type: 'shape', message: `'${target}'보다 '${rec}'에 가까운 모양이에요.` });
    } else if (rec === target) {
      // the right letter, but not acceptable: say what is wrong with it (never only "the count differs"; and never that
      // the count is wrong when another form of the target has it — そ in 1 stroke against its 2-stroke form)
      const okCount = [...twins].some((c) => (BY_CHAR.get(c) || []).some((t) => t.n === U.n));
      if (U.n !== form.T.n && !okCount) res.issues.push({ type: 'count', message: `획수가 달라요: ${form.T.n}획인데 ${U.n}획으로 썼어요.` });
      for (const j of st.missing) {
        res.issues.push({ type: 'shape', message: `원래 ${j + 1}번째 획이 빠졌어요.` + (okCount && U.n !== form.T.n ? ` (${target}${josa(target, '를', '을')} ${form.T.n}획으로 쓸 때의 ${j + 1}번째 획)` : '') });
      }
      for (const is of structureIssues(st, form, target)) if (is.type === 'count' && !/^획수가 달라요/.test(is.message)) res.issues.push(is);
      if (res.issues.every((is) => /^획수가 달라요/.test(is.message))) res.issues.push({ type: 'shape', message: '모양이 많이 달라요. 글자 모양을 다시 확인해 보세요.' });
    } else {
      res.issues.push({ type: 'shape', message: '글자를 알아보기 어려워요.' });
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // Box mode (opts.box = the 원고지 cell, docs/SPEC-words.md D): size and position in the cell
  // ---------------------------------------------------------------------------------------------
  function boxOf(opts) {
    const b = opts.box;
    if (!b || typeof b !== 'object') return null;
    const x = b.x === undefined ? 0 : +b.x, y = b.y === undefined ? 0 : +b.y, w = +b.w, h = +b.h;
    return isFinite(x) && isFinite(y) && isFinite(w) && isFinite(h) && w > 0 && h > 0 ? { x, y, w, h } : null;
  }

  // The drawing's extent in cell units (0..1, y down; a far stray speck left out, as for the normalisation):
  // L = the larger side, cx / cy = the centre.
  const placementOf = (U, box) => placeOf(U.frame, box);
  function placeOf(f, box) {
    const x0 = (f.x0 - box.x) / box.w, x1 = (f.x1 - box.x) / box.w, y0 = (f.y0 - box.y) / box.h, y1 = (f.y1 - box.y) / box.h;
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, L: Math.max(x1 - x0, y1 - y0), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }
  // The same for user stroke i alone.
  function strokePlace(U, i, box) {
    const o = U.org, b = bboxOf([U.pts[i]]);
    return placeOf({ x0: b.x0 * o.s + o.cx, x1: b.x1 * o.s + o.cx, y0: b.y0 * o.s + o.cy, y1: b.y1 * o.s + o.cy }, box);
  }

  // A small kana sits low and is small: the larger the drawing, the lower it must sit (KanjiVG's own small kana
  // are 0.44–0.6 of the cell, centred 0.57–0.67 down; learners write them about half size in the lower left).
  const smallPlaced = (pl) => pl.cy >= BOX.SMALL_TOP && pl.L <= BOX.SMALL_ABS && pl.L + BOX.SMALL_SLOPE * (BOX.SMALL_CY - pl.cy) <= BOX.SMALL_MAX;
  // A big kana reads as its small twin only when it is clearly small and in the lower left (learners write big
  // kana at many sizes: anything else is fine).
  const clearlySmall = (pl) => pl.L <= BOX.TINY_MAX && pl.cy >= BOX.TINY_CY && pl.cx <= BOX.TINY_CX;
  const punctPlaced = (pl) => pl.L <= BOX.PUNCT_MAX && pl.cy >= BOX.PUNCT_CY && pl.cx <= BOX.PUNCT_CX;
  const barPlaced = (pl) => pl.w >= BOX.BAR_MIN && pl.cy >= BOX.BAR_CY[0] && pl.cy <= BOX.BAR_CY[1];

  // A small kana and its big twin have the same shape: name the one the drawing's size says (box mode) or,
  // without a box, the one of the target's kind.
  function bySize(ch, pl, target) {
    const tw = sizeTwin(ch);
    if (!tw) return ch;
    const small = isSmall(ch) ? ch : tw;
    return (pl ? smallPlaced(pl) && pl.L <= BOX.NAME_SMALL : isSmall(target)) ? small : EXTRA[small].big;
  }

  // A stroke as small as a punctuation mark is too small for the stroke matcher (a pixel or two of pen jitter is
  // a large part of it, and its length and turning grow with the jitter): it is classified by its ends and extent
  // instead. '。' = a loop (turns ≥ LOOP_TURN, ends within LOOP_GAP × its bbox diagonal), '、' = a tick (ends ≥
  // TICK_STRAIGHT × the diagonal apart) along the "\" diagonal or upright, ',' = a tick along "/" (a Western
  // comma), 'dash' = a nearly flat tick, 'dot' = a dot or tap, null = anything else (a curve). User stroke i; L =
  // its larger side in cell units.
  function strokeMark(U, i, L) {
    const pts = U.pts[i], a = pts[0], b = pts[pts.length - 1], bb = bboxOf([pts]);
    const diag = Math.hypot(bb.w, bb.h), chord = Math.hypot(b[0] - a[0], b[1] - a[1]), turn = Math.abs(U.turn[i]);
    const loop = turn >= BOX.LOOP_TURN && chord <= BOX.LOOP_GAP * diag;
    if (L <= BOX.DOT_MAX && (pts.length < 8 || !loop)) return 'dot';
    if (loop) return '。';
    if (chord < BOX.TICK_STRAIGHT * diag) return null;
    let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI; // y down; the axis, direction-free
    if (ang < 0) ang += 180;
    return ang >= BOX.TICK_ANGLE[0] && ang <= BOX.TICK_ANGLE[1] ? '、' : ang > BOX.TICK_ANGLE[1] && ang < BOX.TICK_ANGLE[2] ? ',' : 'dash';
  }

  // The mark a drawing is: { mark, main: the user stroke that is the mark, extra: stray dots, pl: the mark's place }
  // or null. One stroke as small as a mark; for a 、 / 。 target also one mark among stray dots (a tap from the
  // neighbouring cell, a pen bounce): the only stroke bigger than a dot, else the first dot in the 、 corner (else
  // the first dot). Two arcs of a 。 are left to the shape judgement (a split, △).
  function markParts(U, target, pl, box) {
    if (U.n === 1) {
      const mark = pl.L <= BOX.PUNCT_MAX ? strokeMark(U, 0, pl.L) : null;
      return mark ? { mark, main: 0, extra: [], pl } : null;
    }
    if ((target !== '、' && target !== '。') || U.n > 4) return null;
    const pls = U.pts.map((_, i) => strokePlace(U, i, box)), dots = [], rest = [];
    pls.forEach((p, i) => (p.L <= BOX.DOT_MAX ? dots : rest).push(i));
    let main = rest.length === 1 ? rest[0] : null;
    if (!rest.length) main = dots.find((i) => punctPlaced(pls[i])) === undefined ? dots[0] : dots.find((i) => punctPlaced(pls[i]));
    if (main === null || pls[main].L > BOX.PUNCT_MAX) return null;
    const mark = strokeMark(U, main, pls[main].L);
    return mark ? { mark, main, extra: dots.filter((i) => i !== main), pl: pls[main] } : null;
  }

  // 、 。 decided by the mark's geometry and place (and any other target drawn as such a mark in the 、 / 。
  // corner: it reads as that mark). Returns true when it decided.
  function markRules(res, U, target, k, pl, box) {
    const parts = markParts(U, target, pl, box);
    if (!parts) return false;
    const { mark, extra } = parts, placed = punctPlaced(parts.pl);
    if (target === '、' || target === '。') {
      const want = target === '、' ? ['、', 'dot'] : ['。'];
      if (want.includes(mark)) {
        if (!placed) return toWrong(res, target, punctMessage(target, parts.pl), 'size');
        // ○, or △ for stray dots beside the mark (a count error, as for a kana)
        const mapping = new Array(U.n).fill(-1), issues = [];
        mapping[parts.main] = 0;
        if (extra.length) issues.push({ type: 'count', message: `획수가 달라요: 1획인데 ${U.n}획으로 썼어요.` });
        for (const i of extra) issues.push({ type: 'count', message: `${nth(i)}로 쓴 작은 점은 '${target}'에 없는 획이에요.` });
        Object.assign(res, {
          verdict: issues.length ? 'order' : 'correct', recognized: target, variantId: k.variants[0].id, confusedWith: null,
          crossScript: false, mapping, reversed: [], orderErrors: [], issues,
          structure: { merged: [], split: [], extra: extra.slice(), specks: extra.slice(), missing: [], misplaced: [] },
        });
        res.strokeCount.expected = 1;
        return true;
      }
      if (target === '、' && mark === ',') return toWrong(res, target, '、는 왼쪽 위에서 오른쪽 아래로 짧게 찍어요. 쉼표(,)와 기울기가 반대예요.', 'shape');
      if (target === '、' && mark === 'dash') return toWrong(res, target, '、는 왼쪽 위에서 오른쪽 아래로 짧게 비스듬히 찍어요.', 'shape');
      if (target === '。' && mark === 'dot') return toWrong(res, null, '。는 점(.)이 아니라 작은 동그라미로 써요.', 'shape');
      const rec = mark === '。' ? '。' : '、';
      return toWrong(res, rec, `'${rec}'${josa(rec, '와', '과')} 헷갈렸어요.`, 'lookalike');
    }
    // a kana target drawn as a small mark in the corner where 、 。 go (small kana and ー have their own rules)
    if (!placed || pl.L > BOX.PUNCT_KANA || isSmall(target) || target === 'ー') return false;
    const rec = mark === '。' ? '。' : '、';
    return toWrong(res, rec, `작게 찍은 '${rec}'처럼 보여요. ${target}${josa(target, '는', '은')} 칸을 채워 크게 써요.`, 'size');
  }

  // Turns res into ✕ with recognized = rec and the one issue given (the shape judgement's mapping / structure stay).
  function toWrong(res, rec, message, type) {
    const k = info(res.target);
    res.verdict = 'wrong';
    res.recognized = rec;
    res.confusedWith = rec && rec !== res.target && (k.confusables.includes(rec) || sizeTwin(res.target) === rec) ? rec : null;
    res.crossScript = false;
    res.reversed = [];
    res.orderErrors = [];
    res.structure.misplaced = [];
    res.issues = [{ type, message }];
    return true;
  }

  // Applied after the shape judgement. A drawing accepted by shape (○/△) becomes ✕ with a 'size' issue when its
  // size or place changes the character: a small kana written big (→ the big twin), a big kana with a small
  // twin written clearly small (→ the small twin), 、 。 not small in the lower left, ー not a wide line through
  // the middle. A rejected drawing gets the same explanation first when it is the target's shape at the wrong
  // size (or a 、 。 out of place); an upright ー is explained.
  // kpX: res is the key-point ✕ of an accepted shape — the size rules below come first (a small ウ is a ゥ, whatever
  // its dot looks like at that size); without a size problem the key-point ✕ stands.
  function sizeRules(res, U, target, k, pl, kpX) {
    if (res.verdict === 'wrong' && !kpX) {
      let rec = null, message = null;
      if (res.recognized === target && isSmall(target) && !smallPlaced(pl)) {
        rec = k.big;
        message = `작은 ${target}${josa(target, '는', '은')} 칸의 왼쪽 아래에 작게 써요.`;
      } else if (res.recognized === target && SMALL_OF.has(target) && clearlySmall(pl)) {
        rec = SMALL_OF.get(target);
        message = `작은 ${rec}처럼 보여요. ${target}${josa(target, '는', '은')} 칸을 채워 크게 써요.`;
      } else if ((target === '、' || target === '。') && !punctPlaced(pl)) {
        message = punctMessage(target, pl);
      } else if (target === 'ー' && U.n === 1 && pl.h >= 0.3 && pl.w <= 0.35 * pl.h) {
        res.issues.push({ type: 'shape', message: '가로쓰기에서는 ー를 가로로 써요.' });
      }
      if (rec) { res.recognized = rec; res.confusedWith = rec; }
      if (message) res.issues.unshift({ type: 'size', message });
      return;
    }
    let rec = target, message = null;
    if (isSmall(target)) {
      if (!smallPlaced(pl)) {
        rec = k.big;
        message = `작은 ${target}${josa(target, '는', '은')} 칸의 왼쪽 아래에 작게 써요. ` +
          (pl.L <= BOX.NAME_SMALL ? '칸의 위쪽에 쓰면 작은 글자로 보이지 않아요.' : `크게 쓰면 ${rec}${josa(rec, '가', '이')} 돼요.`);
      }
    } else if (SMALL_OF.has(target)) {
      if (clearlySmall(pl)) {
        rec = SMALL_OF.get(target);
        message = `작은 ${rec}처럼 보여요. ${target}${josa(target, '는', '은')} 칸을 채워 크게 써요.`;
      }
    } else if (target === '、' || target === '。') {
      if (!punctPlaced(pl)) message = punctMessage(target, pl);
    } else if (target === 'ー') {
      if (!barPlaced(pl)) message = 'ー는 칸 가운데에 가로로 길게 써요.';
    }
    if (message) toWrong(res, rec, message, 'size');
  }

  function punctMessage(target, pl) {
    const m = `${target}는 칸의 왼쪽 아래에 작게 ${target === '、' ? '찍어요' : '써요'}.`;
    return target === '。' && pl.L <= BOX.PUNCT_MAX && pl.cy < 0.5 && pl.cx > 0.5 ? m + ' 오른쪽 위의 작은 동그라미는 반탁점(゜)처럼 보여요.' : m;
  }

  function recognize(strokes, opts) {
    const U = prepareInput(strokes);
    if (!U || U.n > P.MAX_STROKES) return { candidates: [] };
    const box = boxOf(opts || {}), pl = box ? placementOf(U, box) : null;
    const chars = boxPool(poolOf(opts, !!box), pl);
    if (!chars.length) return { candidates: [] };
    return { candidates: candidatesOf(rank(U, chars, null), pl) };
  }

  return {
    judge, recognize, keypoints,
    // tuning / debugging hooks (not part of the API; may change without notice)
    _params: P,
    _internals: { buildTemplates, prepareInput, analyse, align, rank, refine, structureOf, publicStructure, missingReading, closeSet, beaterOf, BY_CHAR, TEMPLATES,
      BOX, XINFO, placementOf, joinOf, joinedRun, flickRise, twinsOf, bySize, KP, kpModel, partsOf, measure, kpDist, strokeFeatures, shapeOf, relation, kpEvaluate, kpBeater, kpPair, inkOn, loopMissed, PAIR_LEAD, prContext, prValue, prMeasure, PR_RULES, PR_TH, prVeto, prVote, bandBlocks, BAND_PAIRS, BAND_GAP, BAND, BAND_DEF, explains },
  };
});
