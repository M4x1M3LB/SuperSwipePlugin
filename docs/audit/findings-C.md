# Workstream C: safety of destructive flows and native side

Read-only audit. Facts used below, verified in the SDK typings:
`PluginCommAPI.deletePageElements(numsInPage, page, layer)` and
`insertPageElements(elements, page, layer)` take NO file path: they act on
"the current file", by element number. So the only protection against editing
the wrong file is a path check made by the plugin right before the call.

Guards that already hold (not findings):
- `checkBeforeEdit` (selector.ts:1276) re-checks path and page, honours
  `isCancelled`, waits for pen-up, and resets the lasso before the FIRST
  delete in the loop, bar, line and wave flows.
- `findStoredStroke` (selector.ts:1311) falls back to "newest stroke with the
  same point count (or within 5 %)", but the matched page copy is then
  re-checked with `checkWave` / `findClosedLoop` / `checkStraightLine` /
  `checkVerticalBar` (selector.ts:439-498), so a wrong stroke is only deleted if
  it is itself gesture-shaped with the same count. Not reported.
- Wave and bar flows re-check `penDownCount()` after `checkBeforeEdit`.
- `reloadIfQuiet` (host.ts:~935) refuses to reload if the pen touched the
  screen since the last save started or is down now. `restoreLastErase` and
  `redo` re-check the file path and restore state on failure/throw.
- The undo/redo tap queue has a stuck detector (plugin.ts:~143) and strokes have
  an 8 s abandon (plugin.ts:~210).

### C1. Second delete round can run on a stale read and remove neighbouring ink
- File: src/selector.ts:1034-1050 (`deleteVerified`, `stillThere`) with src/host.ts:~860 (`getPageElements`).
- Category: safety. Severity: med (data loss, low probability, no recovery).
- Scenario: wave erase of strokes #40-55 plus the wave #80. First
  `deletePageElements` succeeds in the device's working copy. `stillThere()` calls
  `saveCurrentNote` and then `getElements`; the README documents that a read can
  see the file before a save has finished ("a reload that reads the file before
  a save has finished brings old strokes back"), and `request()` treats a save that
  returns not-ok as merely a trace line. A stale read still lists the old strokes
  with matching `count@firstPoint`, so `left.length > 0` and the code deletes
  AGAIN using the OLD numbers (`descending(left)`). In the working copy those
  numbers now belong to the elements that shifted down (the 16 strokes after
  the erased line, and whatever sits at #80), which are removed. Nothing is
  remembered for them (see C2). A real phantom stroke (device did not apply the
  delete) and a stale read look identical to the code today.
- Fix: before the second delete, read the page a second time (a save and
  read, only on this rare path) and delete only elements present in BOTH reads
  with the same uuid and number; if the two reads differ, treat as unverified:
  `deleted: true, fileClean: false`, no second delete. Also skip the second
  delete when `saveCurrentNote` failed (return `fileClean: false`).
- Risk: one extra save+read only when the first verification fails; the test
  "still on page after delete ... deleting again" (selector.test.ts, tests
  around 1349-1400) must feed the phantom twice. Behaviour on a genuine phantom
  is unchanged.

### C2. Erased strokes are remembered too late or not at all (restore lost)
- File: src/selector.ts:988-996 (`eraseNextToMark`), 1161-1172 (`deleteSelection`), 1209-1218 (`undoLastStroke`), 1002-1059.
- Category: safety. Severity: med.
- Scenarios:
  1. `deleteVerified` returns `deleted:false` when the SECOND delete or its
     verification fails, after the first delete already removed the targets.
     `eraseNextToMark` returns "could not erase strokes" without
     `rememberErased`; the user's line is gone and Restore has nothing (or restores an
     older erase). Same in `undoLastStroke` (no `keepUndone`, redo impossible).
  2. `deleteSelection` deletes layer by layer but calls `rememberErased` once,
     with only the LARGEST layer group (`largest`, 1166-1171). A selection that
     spans two layers loses the smaller layer's elements for good. If the second
     layer's `deleteVerified` fails, the first layer is deleted and nothing is
     remembered at all.
  3. Any exception after the first delete (a throw out of `stillThere`, trace
     callback, `repaint`) skips `rememberErased`, which sits after `repaint`.
- Fix: call `host.rememberErased` immediately after the first successful
  `deleteElements` (store per call), before the verification and the reload; make
  the host keep a list of groups (one erase = several layers) or merge them,
  and call `keepUndone` right after the first successful delete in undo.
  Restoring elements that turn out to still be on the page would duplicate them,
  so do it only when verification did not show them left.
- Risk: touches Host contract (`rememberErased` multi-layer); tests
  "remembers the erased strokes after the screen is refreshed" (selector.test.ts:1397)
  assumes order (after repaint): relax it. host.test.ts 96-160 cover recycling.

### C3. LasEr Delete fallback by lasso box can delete unselected ink
- File: src/selector.ts:1118-1135 (`deleteSelection`).
- Category: safety. Severity: med (needs a partial id mismatch).
- Scenario: the user selects with the stock freeform lasso (not the plugin's
  rectangle) around a word and taps LasEr Delete. If at least one lasso uuid is
  not found on the page read (`targets.length < wanted.size`), `targets` is
  REPLACED by every element, of ANY layer and type, whose centre is inside
  `lassoBox()`, the bounding rectangle of the freeform lasso. Neighbouring
  strokes inside that rectangle but outside the freeform shape are deleted.
  README says the delete removes "the selection". The 'found by id' targets
  are discarded, not merged, too.
- Fix: keep the id matches and add box matches only when NO id matched
  (`targets.length === 0`), and restrict them to the layers of the selection;
  otherwise report "selected strokes not found".
- Risk: the "falls back to the lasso box when the ids differ" test
  (selector.test.ts:1477) still passes (zero id matches). Partial matches now
  delete fewer elements, with a trace line.

### C4. Undo and LasEr Delete never re-check file/page/pen before deleting
- File: src/selector.ts:1088-1172 (`deleteSelection`), 1175-1222 (`undoLastStroke`), 1034-1050 (second round).
- Category: safety. Severity: med.
- Scenario: both flows read path/page once, then `setLassoBox`/`resetLasso`,
  `getPageElements` (save + read, seconds on a full page), `outline` reads and
  the delete. Nothing re-checks `getCurrentFilePath()` or waits for the pen. If
  the user opens another note (or the host closes it) in that time, 
  `deletePageElements(nums, page, layer)` runs on the NEW current file with
  numbers from the old one: wrong ink deleted in another note, and the
  restore data points to the old note (`restoreLastErase` then refuses it). The
  second delete round (1042-1048) has the same gap in the handlePenUp flows
  (`checkBeforeEdit` runs once before the first delete only). With the pen
  down (palm tap on the overlay while writing), the stroke being written is
  dropped, which `checkBeforeEdit` exists to prevent.
- Fix: run `checkBeforeEdit`-like logic (pen up, path and page equal) in
  `deleteSelection` and `undoLastStroke` just before the first delete, and a
  cheap `getCurrentFilePath/PageNum` equality check just before the second
  delete in `deleteVerified`, returning `deleted:true,fileClean:false` if it
  changed. `checkBeforeEdit` resets the lasso as well, so the explicit
  reset in undo can be replaced.
- Risk: small; adds 2 cheap calls (~ms). undoLastStroke/deleteSelection tests
  (selector.test.ts:1452-1600) need host fakes with a stable path (they likely have).

### C5. Flows are not mutually exclusive; an abandoned flow keeps editing
- File: src/plugin.ts:55-130 (abandon), 143-170 (tap), 230 (`deleteSelection` export); src/selector.ts:1276-1290 (only `isCancelled` check).
- Category: safety. Severity: med.
- Scenarios:
  1. A flow is abandoned after 8 s (`busy.abandon()` sets `abandoned`), but
     `isCancelled` is only read inside `checkBeforeEdit`. A flow already past
     it (in `deleteVerified`: up to 2 saves, 2 reads, 2 deletes and a reload) keeps going
     while the NEW stroke's flow reads and deletes by element number on the same
     page. Interleaved deletes shift numbers: wrong ink can go. Its `repaint`
     can reload the note while the new flow is between a delete and its verify
     (the pen-quiet test uses one shared `savedAt`).
  2. Undo (tap) checks `busy` only at the moment of the tap. A pen stroke
     arriving while the undo runs starts `handle` at once (no `tapping` check
     in `event_pen_up`), so undo and a gesture flow read and delete concurrently.
     LasEr Delete (plugin.ts:230) has no busy/tapping check at all.
- Fix: a single "editing" lock in plugin.ts: `event_pen_up` queues into
  `waiting` while a tap/LasEr Delete runs; taps and LasEr Delete refuse (or
  queue) while a stroke is busy; and `deleteVerified`/`removeAndSelect`/`repaint`
  check `ctx.isCancelled()` before each destructive call and before the reload
  (return failure/skip when abandoned).
- Risk: behaviour change only under overlap. Add tests with `isCancelled`
  flipping mid-`deleteVerified` (fake host in selector.test.ts) and a plugin.ts
  queue test if one exists.

### C6. Pen-up wait ends on timeout with the pen still down; loop/line flows have no pen-down guard
- File: src/selector.ts:1276-1281, src/host.ts:235-243 + 211-218 (`waitForUp`/`wakeWaiters`).
- Category: safety. Severity: low-med.
- Scenario: `waitForPenUp(5000)` resolves after 5 s even if the pen is still
  down (`now - w.since > maxWaitMs`), and `checkBeforeEdit` ignores why it
  resolved. Gesture handled while the user keeps a long stroke going (a long
  diagram line over 5 s): the wave and bar flows then abort on `penDownCount`,
  but `selectInLoop` and `selectBesideLine` do not take `downsAtStart` and go on:
  `removeAndSelect` edits the page while the pen is down, and the stroke being
  written is dropped (the exact thing the comment says the wait avoids). Also
  waiters are only woken by motion events (no timer), so a pen that leaves
  without an UP/CANCEL leaves the wait pending until the next pen event; the
  abandoned-flow guard (`isCancelled`) covers this once it wakes.
- Fix: have `waitForPenUp` resolve to a boolean (still down on timeout) and
  have `checkBeforeEdit` return `ignored: 'pen still down'` when false.
- Risk: a gesture followed by 5 s of continuous writing is no longer acted on
  (it stays ink): README line "wait for the pen to lift" stays true. Host fakes
  in tests return `Promise<void>`; update them.

### C7. A palm or accidental touch on the overlay undoes the last stroke, unrecoverably after the next stroke
- File: android/app/src/main/java/com/superswipe/LaserOverlayModule.java:215-226; src/plugin.ts:187 (`clearRedo`), src/floating.ts:84-90.
- Category: safety. Severity: med.
- Scenario: the button sits 60 dp left of the last stroke, level with its top:
  right where a resting hand is. The touch listener counts every non-stylus
  `ACTION_UP` as a tap, with no check of press length, movement, touch size or
  `ACTION_CANCEL`, so a palm resting on it for seconds, or a finger dragged
  across it, counts as one tap, and 350 ms later `undoLastStroke` deletes the
  newest stroke. If the user keeps writing, `clearRedo()` on the next pen-up
  discards the undone stroke: ink lost, no Restore (undo does not use it).
- Fix: count a tap only for `ACTION_DOWN` -> `ACTION_UP` within ~400 ms, moving
  less than the touch slop, with `getTouchMajor()` under ~ 1.2 cm, ignoring
  CANCEL; or make undo non-destructive by also remembering it for Restore.
- Risk: very low; a slow press no longer counts as a tap. No JS tests (native).

### C8. Overlay lifecycle: dead listener after JS reload, nothing is ever removed, leaks
- File: LaserOverlayModule.java:44-48 (static view), 190-229 (`ensureButton`), 166-179 (`remove`), no `invalidate()`; src/floating.ts:27 (`remove` never called).
- Category: safety. Severity: low-med.
- Scenarios:
  1. The comment says a window from a previous run is "found and reused". But
     `ensureButton` returns early when the static `button` is attached, and
     the touch listener is the OLD module instance's lambda (it captures that
     instance's `taps`, `fireTaps`, `emit`). After a JS context reload the new
     module never receives taps: the button is shown but dead, and every
     emit goes to a destroyed React context (swallowed by `catch`).
  2. No `invalidate()`/`onCatalystInstanceDestroy`: when the plugin stops the
     view stays on screen over other apps (if it was visible), and delayed
     `pendingShow`/`fireTaps` runnables stay posted on the main looper holding
     the old instance.
  3. `remove()` does not cancel `pendingShow`/`fireTaps`; a show posted before
     remove re-creates the window. JS never calls `remove()` anyway.
  4. `ensureButton` assigns the static `button` before `wm.addView`; if
     `addView` throws (permission revoked between `allowed()` and `addView`:
     SecurityException/BadTokenException) `button` is a detached view, then
     `hide()` rejects with `IllegalArgumentException` from `updateViewLayout`
     (caught and rejected: no crash; JS ignores it). Low.
  Already fine: all WindowManager calls run on the main looper; every
  ReactMethod resolves or rejects exactly once; permission and overlay errors
  are caught; double show only updates the layout; double remove is a no-op.
- Fix: keep a `static LaserOverlayModule current`, set in the constructor; the touch
  listener calls `current.onTap()`. Override `invalidate()` to
  `main.post` removal of the view and callbacks (null the statics, clear
  `pendingShow` and `fireTaps`). Cancel both in `remove()`. Assign `button`
  only after `addView` succeeds.
- Risk: low; native only, untested by Jest. Needs a device check.

### C9. Build script can ship a package without (or with a stale) native module, and the manifest is wider than needed
- File: buildPlugin.sh:713-730, 716-717, 685 (`build/generated` never cleaned); AndroidManifest.xml:3.
- Category: safety. Severity: low.
- Scenario: if `buildCustomApkDebug` fails the script logs "APK build failed"
  but continues, zips `build/generated` and exits 0: a release without the
  overlay, or with the `app.npk` / `reactPackages` left over from a previous
  version mixed with new JS (JS calling a native method the old APK lacks:
  `native.hide()` is not a function; caught only in `PenTracker.onMotion`'s try,
  in `FloatingButton` constructor paths it is not). `copy_apk_and_update_config || true`
  hides a missing APK. The "Build conditions not met" branch does the same if the
  Java source scan finds nothing. Separately the manifest requests `INTERNET`
  (no network use in src/; only needed by the debug Metro) and declares no
  `SYSTEM_ALERT_WINDOW`, which is why the settings screen depends on the host's
  declaration (cannot be judged from this repo). `MainActivity` is exported with
  a LAUNCHER filter: required for an RN app shell but unused by the host; low.
- Fix: `rm -f build/generated/app.npk` before building; fail the script
  (non-zero exit, no zip) when the Java sources exist and the APK or the
  `reactPackages` update fails; drop `INTERNET` from the release manifest
  (keep in `debug/AndroidManifest.xml`).
- Risk: build only; confirm the host does not need `INTERNET` for the JS bundle
  (it loads a local bundle). Not covered by tests.

STATUS: complete
