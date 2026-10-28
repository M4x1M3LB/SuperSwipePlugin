import {PluginManager, type Element} from 'sn-plugin-lib';
import {DEFAULT_CONFIG} from './config';
import {createHost, PenTracker, type DeviceHost} from './host';
import {FloatingButton} from './floating';
import {
  deleteSelection as deleteSelectionFlow,
  handlePenUp,
  undoLastStroke,
  type Outcome,
} from './selector';
import {status} from './status';

let host: DeviceHost | null = null;
/** The toolbar Delete, once gestures have started (it shares their lock). */
let runDelete: (() => Promise<void>) | null = null;

/** Outcomes need a rect; redo has none to show. */
const NO_RECT = {left: 0, top: 0, right: 0, bottom: 0};

/** Most strokes kept waiting while another is handled (the newest). */
const MAX_WAITING = 20;

/** An abandoned stroke this many time limits old counts as settled. */
const STALE_FACTOR = 3;

/** Start listening for strokes. Call once, after PluginManager.init(). */
export function startGestures(): void {
  const pen = new PenTracker();
  pen.start();
  const device = createHost(pen);
  host = device;

  // The stroke being handled, if any. Timers cannot be trusted (the host may
  // pause them once the plugin view has been shown), so a stroke that is
  // still busy after the time limit is abandoned when the next one arrives.
  let busy: {since: number; abandon: () => void} | null = null;
  // Strokes that arrived while another was being handled. They are handled
  // next, together (newest first), not dropped: a gesture is often drawn
  // right after a stroke that made us read the page.
  let waiting: Element[] = [];
  // Abandoned strokes still being handled, with when they were abandoned.
  // They may still read the elements read for them (an erase checking what
  // is left reads a freed element as empty, takes the file for clean and
  // reloads: old strokes come back), so nothing is freed until the last one
  // settles. One that never settles (a lost SDK promise) must not block
  // that forever: after a while it counts as settled.
  const abandoned = new Map<number, number>();
  let nextId = 0;
  const settled = () => {
    const now = Date.now();
    abandoned.forEach((at, id) => {
      if (now - at > STALE_FACTOR * DEFAULT_CONFIG.timeoutMs) {
        abandoned.delete(id);
      }
    });
    return abandoned.size === 0;
  };
  // The undo/redo or LasEr Delete running, if any: what it is, when it
  // started and what it traced. With `busy` it is the one edit lock: a
  // stroke arriving meanwhile waits, and these refuse while a stroke runs.
  let tapping: {what: string; since: number; lines: string[]} | null = null;

  /** Free what was read so far; never lets a failure stop the queue. */
  const release = (pending: Element[], trace: (line: string) => void) => {
    try {
      device.release(
        pending
          .map(e => e?.uuid)
          .filter((uuid): uuid is string => typeof uuid === 'string'),
      );
    } catch (e) {
      trace(`release failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** An edit finished: free what was read, then handle the waiting strokes. */
  const handOver = (trace: (line: string) => void) => {
    const next = waiting;
    waiting = [];
    // Before the next stroke wraps its elements, so they are not freed.
    if (settled()) {
      release(next, trace);
    }
    if (next.length > 0) {
      handle(next);
    }
  };

  const handle = (raw: Element[]) => {
    const lines: string[] = [];
    const trace = (line: string) => {
      lines.push(line);
    };
    const startedAt = Date.now();
    const id = nextId++;
    let isAbandoned = false;
    const finish = (outcome: Outcome) => {
      try {
        trace(device.timeLine(Date.now() - startedAt));
      } catch (e) {
        trace(`timing failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        status.setLast(outcome, lines);
      } catch (e) {
        trace(`status failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const current = {
      since: startedAt,
      abandon: () => {
        isAbandoned = true;
        abandoned.set(id, Date.now());
        trace('abandoned: took too long');
        finish({kind: 'failed', reason: 'timed out'});
      },
    };
    busy = current;
    device.setTrace(trace);

    let flow: Promise<Outcome>;
    try {
      flow = handlePenUp(device.wrap(raw), device, DEFAULT_CONFIG, {
        gestures: status.gestures(),
        isCancelled: () => isAbandoned,
        trace,
        // Time spent waiting for the user's answer does not count.
        keepAlive: () => {
          current.since = Date.now();
        },
      });
    } catch (e) {
      flow = Promise.reject(e);
    }
    flow
      .catch(
        (e: unknown): Outcome => ({
          kind: 'failed',
          reason: e instanceof Error ? e.message : String(e),
        }),
      )
      .then(outcome => {
        if (isAbandoned) {
          // A newer stroke owns the host now.
          abandoned.delete(id);
          if (settled() && !busy && !tapping) {
            release(waiting, trace);
          }
          return;
        }
        try {
          trace(`took ${Date.now() - current.since} ms`);
          finish(outcome);
        } finally {
          busy = null;
          handOver(trace);
        }
      });
  };

  /**
   * Take the edit lock for an undo/redo or Delete, or say why not: never
   * while a stroke is handled or another of these runs (unless that one
   * is stuck: it is reported and this one goes ahead).
   */
  const begin = (
    what: string,
    reasonOf: (why: string) => string,
  ): {what: string; since: number; lines: string[]} | null => {
    const skip = (why: string, line: string) => {
      status.setLast({kind: 'ignored', reason: reasonOf(why)}, [
        `${what} skipped: ${line}`,
      ]);
      return null;
    };
    if (busy) {
      return skip('a stroke is being handled', 'busy');
    }
    if (tapping) {
      if (Date.now() - tapping.since < DEFAULT_CONFIG.timeoutMs) {
        return skip('the last undo/redo is running', 'still running');
      }
      // Stuck: report where it stopped, then let this one run.
      status.setLast(
        {kind: 'failed', reason: `the last ${tapping.what} never finished`},
        [...tapping.lines, 'never finished'],
      );
    }
    const current = {what, since: Date.now(), lines: [what]};
    tapping = current;
    device.setTrace(line => {
      current.lines.push(line);
    });
    return current;
  };

  /** Report an undo/redo or Delete, unless it was superseded as stuck. */
  const end = (current: {since: number; lines: string[]}, outcome: Outcome) => {
    if (tapping !== current) {
      return; // reported as stuck, and a newer one took over
    }
    const trace = (line: string) => {
      current.lines.push(line);
    };
    try {
      trace(`took ${Date.now() - current.since} ms`);
      status.setLast(outcome, current.lines);
    } finally {
      tapping = null;
      handOver(trace);
    }
  };

  // The floating undo/redo button: taps run one at a time, never while a
  // stroke is being handled.
  const floating = new FloatingButton(
    () => status.gestures().undoButton ?? true,
    count => {
      if (count >= 3) {
        floating.hideByUser();
        return;
      }
      const what = count === 1 ? 'undo' : 'redo';
      const current = begin(`${what} (floating button)`, why =>
        why === 'a stroke is being handled'
          ? `${what} skipped: a stroke is being handled`
          : `${what} skipped: the last one is running`,
      );
      if (!current) {
        return;
      }
      current.what = what;
      const trace = (line: string) => {
        current.lines.push(line);
      };
      const action: Promise<Outcome> =
        count === 1
          ? undoLastStroke(device, DEFAULT_CONFIG, {
              trace,
              screenRefresh: status.gestures().screenRefresh ?? true,
            })
          : device
              .redo()
              .then(
                (message): Outcome =>
                  message === 'Redone.'
                    ? {kind: 'selected', count: 1, rect: NO_RECT}
                    : {kind: 'ignored', reason: message},
              );
      action
        .catch(
          (e: unknown): Outcome => ({
            kind: 'failed',
            reason: e instanceof Error ? e.message : String(e),
          }),
        )
        .then(outcome => end(current, outcome));
    },
  );
  pen.onEvent(event => floating.onMotion(event));

  PluginManager.registerEventListener('event_pen_up', 1, {
    onMsg(msg: unknown) {
      status.countPenUp();
      // New writing: what was undone can no longer be redone.
      device.clearRedo();
      const gestures = status.gestures();
      if (
        !(
          gestures.loopSelect ||
          gestures.marginErase ||
          gestures.lineSelect ||
          gestures.barSelect
        ) ||
        !Array.isArray(msg)
      ) {
        return;
      }
      const incoming = [...waiting, ...(msg as Element[])].slice(-MAX_WAITING);
      waiting = [];
      if (tapping && Date.now() - tapping.since < DEFAULT_CONFIG.timeoutMs) {
        waiting = incoming; // handled when the undo/redo or Delete is done
        return;
      }
      if (busy) {
        if (Date.now() - busy.since < DEFAULT_CONFIG.timeoutMs) {
          waiting = incoming;
          return;
        }
        busy.abandon();
      }
      handle(incoming);
    },
  });

  runDelete = async () => {
    // Refused like a tap while a stroke or undo/redo runs.
    const current = begin('delete', why => why);
    if (!current) {
      return;
    }
    const trace = (line: string) => {
      current.lines.push(line);
    };
    let outcome: Outcome;
    try {
      outcome = await deleteSelectionFlow(device, DEFAULT_CONFIG, {
        trace,
        screenRefresh: status.gestures().screenRefresh ?? true,
      });
    } catch (e) {
      outcome = {
        kind: 'failed',
        reason: e instanceof Error ? e.message : String(e),
      };
    }
    end(current, outcome);
  };
}

/** The lasso toolbar's LasEr Delete button. */
export async function deleteSelection(): Promise<void> {
  await runDelete?.();
}

/** Put back the strokes removed by the last margin-wave erase. */
export async function restoreLastErase(): Promise<string> {
  if (!host) {
    return 'Nothing to restore.';
  }
  return host.restoreLastErase();
}
