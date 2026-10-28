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
| C | Safety of destructive flows (`selector.ts` erase/delete/undo/repaint, restore in `host.ts`) + native `LaserOverlayModule.java`/manifest | agent (sonnet) | [ ] |

Each writes `docs/audit/findings-<ws>.md`: one entry per finding with
file:line, category (perf/safety), severity (high/med/low), concrete
failure or cost scenario, proposed minimal fix, and risk of the fix.

## Phase 2 — triage (lead)

- [ ] Merge findings into the fix list below, drop unproven or
      out-of-proportion items, order by impact/risk.

## Phase 3 — fixes (file-disjoint batches, gated, one commit per batch)

(filled in by phase 2)

## Phase 4 — verification

- [ ] Full gates, adversarial review of the whole diff, README updated,
      version bump decision noted (no device build in this container).
