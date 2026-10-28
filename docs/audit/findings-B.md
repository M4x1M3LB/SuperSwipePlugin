# Findings B: device I/O (host.ts, floating.ts, status.ts, wiring)

Per-motion-event path checked: `PenTracker.onMotion` and `FloatingButton.onMotion` are O(1), allocation-free on MOVE (one `box` object on DOWN), and make no bridge call except `hide()` on DOWN and `showLeftOf()` on UP/CANCEL. `status` listeners exist only while the view is mounted. `registerMotionListener`, `registerEventListener` and the `DeviceEventEmitter` listener are each registered once. No finding there beyond B5, B6.

### B1. One hung abandoned flow disables all native-element release for the session
- src/plugin.ts:92-99 (`unsettled--`, release only when 0), 120-123 (`if (unsettled === 0) release(next)`); src/host.ts:1052-1066.
- Category: safety (native memory leak), severity: med-high.
- Scenario: stroke A is abandoned after 8 s (`abandon()` does `unsettled++`) while one of its SDK promises never resolves (saveCurrentNote or getElements while the note view changes; `waitForUp` with no events, see B2). Its `.then` never runs, so `unsettled` stays at 1 forever. From then on `release()` is never called by the pen-up path. Every later stroke's `getPageElements` (whole page, repeatedly in `stillThere`) is pushed into `fetched` and recycled never. Native element cache and the JS `fetched` array grow with every gesture stroke until the plugin is killed.
- Fix: stamp each abandoned flow (`abandonedAt`) and treat flows older than e.g. 3x `timeoutMs` as settled when deciding to release (no timer needed: compare `Date.now()` at the next stroke). Or `Map<id, abandonedAt>` instead of a counter and drop stale ids in the pen-up handler.
- Risk: after 24 s a truly slow old flow could read a freed element (the README-documented reason for waiting is the "old strokes come back" reload; 24 s of hang makes that remote). Covered by plugin/selector abandon tests; add a test that a never-settling abandoned flow does not block release.

### B2. `waitForUp` can hang indefinitely: hover and finger events never wake waiters
- src/host.ts:173-205 (early `return` at 179 for non-pen and at 185-192 for hover before `wakeWaiters`), 235-243 (no timer).
- Category: safety (hang -> `busy` stuck), severity: med.
- Scenario: a margin-wave erase calls `waitForPenUp(5000)`. If the pen ACTION_UP motion event was missed (view switching, another plugin/overlay consumed it), `down` stays true. After that only hover events (7/9/10) or finger events arrive; they return before `wakeWaiters`, so the waiter and its `maxWaitMs` are never evaluated. The flow hangs until a touch event; meanwhile `busy` is set, floating undo/redo taps report "skipped: a stroke is being handled", and by B1 it can poison release.
- Fix: call `if (this.waiters.length > 0) this.wakeWaiters(Date.now())` at the very top of `onMotion` (any event, any tool, before the early returns). `isUp` already treats a pen silent for >1 s as up.
- Risk: low; hover events do not change `lastEventAt`, so a pen truly down and still sends no hover. Tests: PenTracker waiter tests in __tests__ (add one for hover/finger waking).

### B3. A concurrent stroke's `release()` can recycle an element that redo is about to insert
- src/host.ts:946-965 (`undone.pop()` removes it from `undone` before two awaits) vs 1052-1065 (`keep` includes `undone`, `erased`, `restoring` but not the popped element).
- Category: safety, severity: low-med.
- Scenario: user taps twice on the floating button (redo). `redo()` pops `last`, awaits `getCurrentFilePath()` then `insertPageElements([last.element])` (hundreds of ms). The tap handler only checks `busy` when the tap starts. The user draws a loop meanwhile; `pen_up` -> `handle()` -> finish -> `device.release(...)`. `last.element` is in `fetched` (it came from a wrapped element), is not in `undone` any more, so it is recycled before the insert. The insert gets a freed native element: failure, an empty stroke, or a crash depending on the firmware.
- Fix: a `redoing: Element | null` variable (like `restoring`) set at pop, cleared at the end in `finally`, and added to the `keep` set in `release()`. Also the `undone.push(last)` paths should go through the same cleanup.
- Risk: none for behaviour. Tests: host redo tests (add: release during redo keeps the element).

### B4. Toolbar Delete never releases what it reads; races stroke release
- src/plugin.ts:243-262 (`deleteSelection` has no `release`); src/selector.ts:1094-1111 (`lassoUuids` + whole-page `getPageElements` are wrapped into `fetched`); src/plugin.ts:210-222 (pen-up handler returns before `handle()` when all four gestures are off).
- Category: safety (native leak) + concurrency, severity: low-med.
- Scenario 1: with the four gesture toggles off (a valid state) only Delete/undo are used; the Delete press wraps the whole page and nothing calls `release`, so the page's native element caches stay until some stroke is handled later. Each press adds a page's worth. (The undo tap path does call `release([], ...)`.)
- Scenario 2: `deleteSelection` does not check `busy`; a stroke finishing concurrently calls `release()` and recycles the elements Delete is using; and both call `setTrace`, which replaces the shared `trace`/`timings`, so one flow's trace/timings lines land in the other's log.
- Fix: in `deleteSelection`, skip with an "ignored: a stroke is being handled" outcome when `busy` (same as the taps) and call `release([], trace)` in a `finally`; share one `tapping`/`busy` guard.
- Risk: Delete pressed during a stroke is now refused (it is a user tap, can be repeated). Tests: plugin tests for deleteSelection.

### B5. `FloatingButton` makes two bridge calls per ordinary pen stroke
- src/floating.ts:101-102 (`hide()` on every pen DOWN), 119-120 and 147-151 (`showLeftOf()` on every UP).
- Category: perf, severity: low.
- Scenario: handwriting at several strokes per second sends `hide()` (native `removeCallbacks` + view hide on the main thread, LaserOverlayModule.java:147-150) and `showLeftOf` (re-posts a 3 s delayed show, :117-140) for each stroke, each with a promise allocated and a UI-thread hop, even when the button is already hidden and nothing is pending.
- Fix: keep `armed: boolean` (set when `showLeftOf` was sent, cleared when `hide` was sent, or on the three-tap path); on DOWN send `hide()` only if `armed`. `showLeftOf` must stay per UP because the position changes.
- Risk: if the button is shown by native (delay elapsed) `armed` must remain true until hide: set it on show, never clear it by time. Tests: floating tests that count native calls.

### B6. `wakeWaiters` allocates a new array on every pen event while waiting
- src/host.ts:211-219 (`this.waiters.filter(...)`), called per MOVE at :202-204.
- Category: perf, severity: low.
- Scenario: during `waitForPenUp` (up to 5 s) every pen MOVE (hundreds per second) allocates a filtered array. Only during an erase wait, so small.
- Fix: in-place compaction loop (write index) and resolve collected waiters; or skip when `isUp` is false and no waiter has `now - since > maxWaitMs` (track the min deadline).
- Risk: none.

### B7. Permission check repeats on every stroke unless both are "always"; page size is re-read per straight stroke
- src/host.ts:853-865 (`fileAccessOk = access.granted && access.always`); src/host.ts:825-829 and src/selector.ts:657 (`getPageSize` per bar/line stroke).
- Category: perf, severity: low.
- Scenario: if the user chose "this time only" (state 1) the two `hasPermission` round-trips run before every gesture stroke (traced as a list of `hasPermission` times) and also come before the cheap page-size pre-check refusal (selector.ts:400 before :405). Each straight stroke also pays one `getPageSize` round-trip for a value that is constant per (path, page).
- Fix: cache the granted result for a short TTL (e.g. 60 s) when state is 1 (still cleared by `fileCallFailed`); cache page size per `path#page` in `createHost` (small Map, cleared on `reloadFile`, bounded to e.g. 8 entries).
- Risk: the permission TTL changes when a revoked "this time only" permission is noticed (a later file call failure clears it anyway); a page size cache can be stale if the user changes template/orientation (clear on file path change and keep it short-lived). Tests: host and selector pre-check tests.

### B8. `READ_POOL = 64` puts up to 64 simultaneous native calls on the bridge; per-element closures built for the whole page
- src/selector.ts:1232-1261 (pool of 64, each element 2 sequential calls), src/host.ts:675-782 (`toPageElement` builds about 12 closures + 3 promise slots + a WeakMap entry for every element of the page, before any is needed).
- Category: perf, severity: low (needs device measurement; the repo trace "points: N elements, M calls in X ms" supports it).
- Scenario: a gesture on a page with 1500 strokes: 1500 wrappers built (about 18k closures) plus 1500 `recycleElement` bridge calls in `release` (host.ts:493-506, no batch API exists), and up to 64 concurrent `opElementPointData` calls queued on the single native module thread, delaying calls from other plugins' requests in the same host.
- Fix: make `PageElement` a small class with prototype methods (state lazily created per field) instead of closures; tune `READ_POOL` from the measured trace (16-32 is usually enough to hide latency). Only if trace data from the device shows queueing.
- Risk: behaviour-neutral if the semantics of memoised promises are kept. Tests: selector/host element tests.

### B9. A throwing status listener leaves `busy` set; exceptions escape callbacks
- src/status.ts:20-22 (`notify` has no try/catch around each listener); src/plugin.ts:100-110 (`finish(outcome)` and `busy = null` are in the same `.then`; a throw in `finish` skips `busy = null`, `waiting` hand-over and `release`), src/floating.ts:62-69 (`onTaps` unprotected inside the emitter callback).
- Category: safety, severity: low.
- Scenario: the settings view is open, a React `setTick` listener throws during unmount/teardown: `status.setLast` throws inside the `.then`, `busy` stays set until the next stroke abandons it (8 s), queued strokes in `waiting` are not handled, `release` is skipped.
- Fix: wrap each listener call in try/catch in `notify`; move `busy = null; ...` before `finish` or put `finish` in try/finally.
- Risk: none.

STATUS: complete
