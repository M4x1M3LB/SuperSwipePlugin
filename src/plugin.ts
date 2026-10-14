import {PluginManager, type Element} from 'sn-plugin-lib';
import {DEFAULT_CONFIG} from './config';
import {createHost, PenTracker, type DeviceHost} from './host';
import {handlePenUp, type Outcome} from './selector';
import {status} from './status';

let host: DeviceHost | null = null;

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

  const handle = (raw: Element[]) => {
    const lines: string[] = [];
    const trace = (line: string) => {
      lines.push(line);
    };
    let abandoned = false;
    const current = {
      since: Date.now(),
      abandon: () => {
        abandoned = true;
        trace('abandoned: took too long');
        status.setLast({kind: 'failed', reason: 'timed out'}, lines);
      },
    };
    busy = current;
    device.setTrace(trace);

    const elements = device.wrap(raw);
    handlePenUp(elements, device, DEFAULT_CONFIG, {
      gestures: status.gestures(),
      isCancelled: () => abandoned,
      trace,
      // Time spent waiting for the user's answer does not count.
      keepAlive: () => {
        current.since = Date.now();
      },
    })
      .catch(
        (e: unknown): Outcome => ({
          kind: 'failed',
          reason: e instanceof Error ? e.message : String(e),
        }),
      )
      .then(outcome => {
        if (busy !== current) {
          return; // abandoned; a newer stroke owns the host now
        }
        trace(`took ${Date.now() - current.since} ms`);
        status.setLast(outcome, lines);
        device.release();
        busy = null;
        if (waiting.length > 0) {
          const next = waiting;
          waiting = [];
          handle(next);
        }
      });
  };

  PluginManager.registerEventListener('event_pen_up', 1, {
    onMsg(msg: unknown) {
      status.countPenUp();
      const gestures = status.gestures();
      if (
        !(gestures.loopSelect || gestures.marginErase || gestures.lineSelect) ||
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

/** Put back the strokes removed by the last line-erase. */
export async function restoreLastErase(): Promise<string> {
  if (!host) {
    return 'Nothing to restore.';
  }
  return host.restoreLastErase();
}
