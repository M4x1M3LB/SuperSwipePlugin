# Efficiency & safety audit — plan and progress

Goal: gestures trigger almost instantly, without blocking other plugins or
the device, with no loss of capability, and as safe as possible to use
(no lost ink, no crashes, no stuck state).

**Resuming after an interruption:** read this file top to bottom. Every
phase records its status here and every finished step is committed and
pushed on `claude/inspiring-goldberg-xr0tmt`. Pick up at the first
unchecked box. Findings live in `docs/audit/findings-*.md`.

## Gates (every change, before commit)

`npx jest && npx tsc --noEmit && npx eslint src __tests__ App.tsx index.js`
must pass. No test may be skipped, deleted or loosened to get green.
Gesture thresholds and README-documented behaviour stay unchanged unless a
finding says why (then README is updated in the same commit).

Baseline (2026-10-28, 2baf1fd): 163 tests pass, typecheck and lint clean.

## Phase 1 — audit (read-only, parallel)

| WS | Scope | Owner | Status |
| --- | --- | --- | --- |
| A | JS hot path: `plugin.ts` queue, `selector.ts` `handlePenUp` pre-checks, `geometry.ts` algorithmic cost | agent (sonnet) | [x] |
| B | Device I/O: `host.ts` (PenTracker, reads, release/recycle, timings, permissions), `floating.ts`, `status.ts` | agent (sonnet) | [x] |
| C | Safety of destructive flows (`selector.ts` erase/delete/undo/repaint, restore in `host.ts`) + native `LaserOverlayModule.java`/manifest | agent (sonnet) | [x] |

Each writes `docs/audit/findings-<ws>.md`: one entry per finding with
file:line, category (perf/safety), severity (high/med/low), concrete
failure or cost scenario, proposed minimal fix, and risk of the fix.

## Phase 2 — triage (lead)

- [x] Merge findings into the fix list below, drop unproven or
      out-of-proportion items, order by impact/risk.

## Phase 3 — fixes (file-disjoint batches, gated, one commit per batch)

Accepted (verified against code by the lead). Batches own disjoint files and
run in parallel, each in its own git worktree on its own branch; the lead
merges each into `claude/inspiring-goldberg-xr0tmt` after re-running gates.

| Batch | Findings | Files owned | Model | Status |
| --- | --- | --- | --- | --- |
| 1 Edit safety | C1 (2nd delete only if two reads agree / save ok), C2 (remember erased right after the delete, all layers; undo keeps undone early), C3 (box fallback only when no id matched, same layers), C4 (undo & LasEr Delete: pen-up + path/page check before delete; path check before 2nd delete), C5-selector (`isCancelled` before every destructive call and the reload), C6 (`waitForPenUp` -> boolean, refuse while down), B2 (wake waiters on any event), B3 (keep element being redone), B6 | `src/selector.ts`, `src/host.ts`, their tests | opus | [ ] |
| 2 Queue & lock | C5-plugin + B4 (one edit lock: strokes queue while undo/redo/LasEr Delete runs; those refuse while a stroke is busy; LasEr Delete releases), B1 (stale abandoned flows stop blocking release), B9 (listener throws cannot leave `busy` set) | `src/plugin.ts`, `src/status.ts`, `__tests__/plugin.test.ts`, `__tests__/status.test.ts` | sonnet | [ ] |
| 3 Loop speed | A1 (y-bucketed edge index for containment, identical results) | `src/geometry.ts`, `__tests__/geometry.test.ts` | sonnet | [ ] |
| 4 Native & build | C7 (tap = short press, little movement, no CANCEL), C8 (current-module tap routing, `invalidate()` cleanup, cancel pending in `remove()`, assign view after `addView`), C9 (build fails hard; clear stale `app.npk`), B5 (`armed` flag: no hide() when nothing shown) | `android/**/LaserOverlayModule.java`, `buildPlugin.sh`, `src/floating.ts`, `__tests__/floating.test.ts` | sonnet | [ ] |
| 5 Read savings (after 1) | A2 (outline reads stop at first refusal, newest first), A3 (start reads in parallel with page-copy outline), B7-page-size (cache per path#page) | `src/selector.ts`, `src/host.ts` | sonnet | [ ] |

Rejected / deferred, with reason:
- A4, A5: microseconds on real handwriting; not worth the code.
- B7 permission TTL: "this time only" is the user's choice to be asked; caching it weakens that.
- B8: needs device trace data first (READ_POOL / closure cost unmeasured).
- C9 INTERNET permission: cannot verify on device that the host does not need it; leave.

## Phase 4 — verification

- [ ] Full gates, adversarial review of the whole diff, README updated,
      version bump decision noted (no device build in this container).
