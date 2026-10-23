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

/** Outcomes need a rect; redo has none to show. */
const NO_RECT = {left: 0, top: 0, right: 0, bottom: 0};

/** Most strokes kept waiting while another is handled (the newest). */
const MAX_WAITING = 20;

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
  // Abandoned strokes still being handled. They may still read the
  // elements read for them (an erase checking what is left reads a freed
  // element as empty, takes the file for clean and reloads: old strokes
  // come back), so nothing is freed until the last one settles.
  let unsettled = 0;

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

  const handle = (raw: Element[]) => {
    const lines: string[] = [];
    const trace = (line: string) => {
      lines.push(line);
    };
    const startedAt = Date.now();
    let abandoned = false;
    const finish = (outcome: Outcome) => {
      try {
        trace(device.timeLine(Date.now() - startedAt));
      } catch (e) {
        trace(`timing failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      status.setLast(outcome, lines);
    };
    const current = {
      since: startedAt,
      abandon: () => {
        abandoned = true;
        unsettled++;
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
        isCancelled: () => abandoned,
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
        if (abandoned) {
          // A newer stroke owns the host now.
          unsettled--;
          if (unsettled === 0 && !busy) {
            release(waiting, trace);
          }
          return;
        }
        trace(`took ${Date.now() - current.since} ms`);
        finish(outcome);
        busy = null;
        const next = waiting;
        waiting = [];
        // Before the next stroke wraps its elements, so they are not freed.
        if (unsettled === 0) {
          release(next, trace);
        }
        if (next.length > 0) {
          handle(next);
        }
      });
  };

  // The floating undo/redo button: taps run one at a time, never while a
  // stroke is being handled.
  // The undo/redo running, if any: when it started and what it traced.
  let tapping: {since: number; lines: string[]} | null = null;
  const floating = new FloatingButton(
    () => status.gestures().undoButton ?? true,
    count => {
      if (count >= 3) {
        floating.hideByUser();
        return;
      }
      const what = count === 1 ? 'undo' : 'redo';
      if (busy) {
        status.setLast(
          {
            kind: 'ignored',
            reason: `${what} skipped: a stroke is being handled`,
          },
          [`${what} (floating button) skipped: busy`],
        );
        return;
      }
      if (tapping) {
        if (Date.now() - tapping.since < DEFAULT_CONFIG.timeoutMs) {
          status.setLast(
            {
              kind: 'ignored',
              reason: `${what} skipped: the last one is running`,
            },
            [`${what} (floating button) skipped: still running`],
          );
          return;
        }
        // Stuck: report where it stopped, then let this tap run.
        status.setLast(
          {kind: 'failed', reason: 'the last undo/redo never finished'},
          [...tapping.lines, 'never finished'],
        );
      }
      const lines: string[] = [`${what} (floating button)`];
      const trace = (line: string) => {
        lines.push(line);
      };
      const current = {since: Date.now(), lines};
      tapping = current;
      device.setTrace(trace);
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
        .then(outcome => {
          if (tapping !== current) {
            return; // reported as stuck, and a newer tap took over
          }
          trace(`took ${Date.now() - current.since} ms`);
          status.setLast(outcome, lines);
          release([], trace);
          tapping = null;
        });
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
}

/** The lasso toolbar's LasEr Delete button. */
export async function deleteSelection(): Promise<void> {
  if (!host) {
    return;
  }
  const device = host;
  const lines: string[] = [];
  const trace = (line: string) => {
    lines.push(line);
  };
  device.setTrace(trace);
  const outcome = await deleteSelectionFlow(device, DEFAULT_CONFIG, {
    trace,
    screenRefresh: status.gestures().screenRefresh ?? true,
  }).catch(
    (e: unknown): Outcome => ({
      kind: 'failed',
      reason: e instanceof Error ? e.message : String(e),
    }),
  );
  status.setLast(outcome, lines);
}

/** Put back the strokes removed by the last margin-wave erase. */
export async function restoreLastErase(): Promise<string> {
  if (!host) {
    return 'Nothing to restore.';
  }
  return host.restoreLastErase();
}
