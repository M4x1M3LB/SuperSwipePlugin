# Findings A — JS hot path (plugin.ts queue, selector.ts handlePenUp, geometry.ts)

Method: read the code paths, then micro-benchmarked the compiled
`geometry.ts` with node (scripts in the session scratchpad, not in the
repo). Numbers are one machine's wall time; the device CPU is several times
slower, so read them as relative cost.

Overall: the per-stroke pen-up checks (bbox, wave, loop, bar, line) are
cheap. Measured on one ordinary pen-up stroke: 0.01-0.04 ms at 200 points,
0.2-0.5 ms at 1000, at most ~4 ms at 3000 (the loop check's closing-pair
search, only for stroke that are loop-sized). Nothing there is worth
touching. The real JS cost is after the page is read.

### A1. Loop containment does O(points x polygon vertices) work in one blocking chunk
- src/selector.ts:690-709 (`selectInLoop`), src/geometry.ts:190-218 (`insideAtLeast`), :132-148 (`pointInPolygon`)
- category: perf; severity: med
- Scenario: a loop whose grown polygon has V vertices (the polygon is the raw
  sample points of the loop stroke, typically 150-600, plus no decimation)
  is tested against every element whose box meets the loop's box. Each
  point scans all V edges. All outlines are only processed after the last
  read has arrived, so it is one synchronous task.
  Measured (2000 strokes x 200 points, all inside the loop, early exit at
  50 % already included): V=100: 73 ms; V=400: 327 ms; V=1500: 1130 ms.
  Linear in enclosed strokes: about 0.16 ms per enclosed stroke at V=400, so
  a loop around 100 strokes is ~16 ms, a "select the whole page" loop
  0.3 s (device: several x that), during which no other plugin/JS runs.
- Fix (exact, no threshold change): build once per loop a y-bucket index of
  the edges (edges listed under each y-band they span; `pointInPolygon` then
  only visits the edges of the point's band, which are the only ones that
  can change the winding number). Prototype: 400 000 points, V=400:
  686 ms -> 13.7 ms (50x), 0 mismatches against `pointInPolygon` on all
  400 000 points. `insideAtLeast(points, polygon, fraction, polygonBox)`
  could take the prebuilt index as an optional extra argument (or build it
  lazily inside when `polygon.length` is large), keeping its signature
  compatible.
  Optional second step: compute `boundingBox`/containment as each outline
  arrives (inside `outlinesOf`'s workers) and drop the outline, so CPU work
  overlaps the native reads and 400 k Pt objects are not held at once. The
  plain bbox pass alone costs ~3 ms for 2000x200, so this is minor once the
  containment is fixed.
- Risk: low. Same boolean results (winding rule untouched, tested by
  fuzz against the old function). Covered by `__tests__/geometry.test.ts`
  (`insideAtLeast` agrees with `fractionInside`, early exits; `pointInPolygon`)
  and the selector loop tests. Add a randomised equivalence test.

### A2. Line/bar checks read every outline before looking for the cheap refusal
- src/selector.ts:777 and :849 (`outlinesOf(ctx.others)` then refusal loop), :1248 (`outlinesOf`)
- category: perf (device I/O ahead of a cheap rejection); severity: med
- Scenario: a line >=168 px and >=12 % of the page width is read against the
  page (README: documented, the page read itself must stay: it clears undo
  history). Underlines and strike-throughs are the most common outcome of
  that and are refused ("line crosses the writing", "writing N px from the
  line (an underline?)", "bar touches the writing"). Today all `others`
  outlines (page: ~2000 strokes = ~4000 native calls: count + range each) are
  read first, in element order, and only then is the first one checked.
  The offending stroke is nearly always among the most recently written ones
  (the text just underlined / struck through), but they are read in
  page order, at the back of the queue, and nothing stops the remaining
  reads once a refusal is certain.
- Fix: let `outlinesOf` take an optional visitor that is called as each
  outline arrives and may return "stop" (workers then stop starting new
  reads; reads already in flight finish). Order the reads newest-first
  (`numInPage` descending) for the line/bar flows. The refusal needs only
  the first offending element, whichever it is. Keep the full read for the
  accepted case (all boxes needed) and for wave/loop flows.
  Expected saving for a refused underline: all but the first ~64 (the pool
  size) + a few reads, i.e. from ~2000 element reads to ~64-130 on a full page.
  I could not measure the device read cost here (see workstream B's timings
  `points: N in X ms`); it scales linearly with the elements skipped.
- Risk: low-med. The refusal reason string may name a different offending
  stroke than the first one in page order (the outcome kind `ignored` and the
  README behaviour are the same). Tests asserting exact reasons with several
  offenders would need a look: `__tests__/selector.test.ts` ~788-800 (underline,
  strike-through), ~901 (low underline), and the `outlinesOf` describe at
  ~1415 (must keep order of the returned array).

### A3. Loop flow: the second device round trip is serial and the page-copy outline is awaited before the others are requested
- src/selector.ts:441-452 (`await stroke.outline()`), :691 (`outlinesOf(ctx.others)` later, inside `selectInLoop`)
- category: perf; severity: low
- Scenario: for a closed loop, after `findStoredStroke` the code reads the
  gesture's page outline (one round trip, to re-run `findClosedLoop` on the
  page copy), and only then starts the ~2000 other reads. The loop already
  passed on the pen-up copy, so the page-copy check fails only in the
  unusual disagreement case. Starting `outlinesOf(others)` immediately (and
  awaiting both) saves one bridge round trip (a few ms to tens of ms) on
  every loop gesture.
- Fix: for `polygon` only, kick off `outlinesOf(others)` right after
  `others` is computed, before `await stroke.outline()`, pass the promise
  through `Context` (like `size`), and attach `.catch(() => {})` as
  `readPageSize` does. Do not do it for line/bar/wave: those often refuse
  on `stored` or the page size first, so the reads would be wasted.
- Risk: low. In the "loop not recognised in page copy" failure the reads were
  wasted (rare). No behaviour change otherwise. Covered by the selector loop
  tests and the "loop not recognised" test if one exists.

### A4. Burst: older strokes' outlines are all requested up front
- src/selector.ts:239-251
- category: perf; severity: low
- Scenario: after a slow handle (a page read takes seconds), up to 20
  strokes wait and are handled as one burst. `ink[i].outline()` is started
  for every one (2 native calls each, up to 40) before the newest is
  examined. When the newest is the gesture (the usual reason someone
  draws right after writing), the other reads are still queued natively when
  `saveCurrentNote`/`getElements` is issued, so the page read can queue
  behind them. One-stroke events (the normal case) are unaffected.
- Fix: start the newest 2-3 reads immediately and request each further older
  stroke only when the scan reaches within 2 of it (simple sliding window).
  Ordinary-writing bursts keep ~full overlap; a found gesture leaves at most 2
  wasted reads.
- Risk: low. The "pen-up points: N strokes read together" trace line changes
  meaning slightly (host test/selector tests that assert it, if any, need
  updating). Only worth doing together with other changes in that block.

### A5. `strokesTouch` is O(a x b) three times, with no spatial culling
- src/geometry.ts:287-318 (`strokesTouch`, `reaches`), used at selector.ts:792, :871 (line/bar vs every box-overlapping stroke) and :950-954 (wave erase "touching" pass)
- category: perf; severity: low
- Scenario: only reached for pairs whose boxes already overlap within 4 px.
  Cost for two long near-parallel strokes (worst case, boxes overlap but they
  do not touch): 200x200 pts: 1 ms; 1000x1000: 17.6 ms; 3000x3000: 174 ms.
  A wave-erase with a 40-stroke row and 60 neighbouring strokes of 200
  points each: 27 ms. Typical handwriting (small boxes) costs microseconds.
- Fix (exact): skip a-segments/points that lie outside the other stroke's box
  grown by `tolerance` (a crossing or a point within tolerance cannot be
  there). Helps long-vs-short pairs (line vs letter), not parallel-equal-extent
  ones; for those a uniform grid would be needed (not worth the code).
- Risk: low; geometry.test.ts `strokesTouch` blocks cover it. Only do it if
  A1/A2 are done and a trace shows the wave/line phase is slow.

### Checked, no action (do not "optimise")
- Pen-up per-stroke checks (selector.ts:253-352): `boundingBox`, `checkWave`,
  `checkClosedLoop`, `checkVerticalBar`/`swapAxes`, `checkStraightLine`
  recompute bboxes/path length and allocate (`swapAxes`, `trimEnds`,
  `map`), but total 0.01-0.5 ms per stroke up to 1000 points (benchmarked),
  against a device read of the same stroke that is orders of magnitude
  slower. Cheap-first order is already right (size gate, wave, loop, bar,
  line; ordinary words are rejected by the 18 px / aspect / 30 px gates before
  `closingPair`'s O(0.12 n^2) runs: a 3000-point word is 0.01 ms).
- `closingPair` is quadratic only for loop-sized strokes: 3000 pts = 3.8 ms,
  would be ~45 ms at 10 000 points (not seen in practice).
- `findStoredStroke` (selector.ts:1311): `find` by uuid, else a filter+sort of
  <=2000 elements and 10 count reads in parallel: < 1 ms JS.
- Sequential awaits in the pre-page phase: `getCurrentFilePath` and
  `getCurrentPageNum` are already parallel, `ensureFileAccess` is cached, and
  the page size for line/bar is read BEFORE the save on purpose (comment at
  selector.ts:398-401: not while saving); for a loop it is started after the
  save and overlaps the point reads. Do not move them.
- `checkBeforeEdit` (selector.ts:1288): `waitForPenUp`, the path/page check and
  `resetLasso` are ordered on purpose (reset must be on the right page, and
  must precede the edit); running them in parallel would change behaviour.
- The page read itself (`saveCurrentNote` + `getElements`) before any
  gesture is certain: required, README documents that it clears undo history
  and the pre-checks (dash/short line/bar followed by writing/pen down again,
  size pre-check) already skip it whenever they can.
- plugin.ts queue: `[...waiting, ...msg].slice(-20)` is 20 elements at most;
  `status.setLast`/`summarise`/`release` per stroke are O(trace lines);
  a stroke waits behind the current one at most until it finishes or
  `timeoutMs` (keepAlive resets it only while the user is answering a dialog),
  and then all waiting strokes are handled together, newest first. No
  head-of-line problem beyond the one in-flight stroke; making the new stroke
  analyse concurrently with an in-flight pure-read stroke would save only
  one device round trip and is not worth the added state.

STATUS: complete
