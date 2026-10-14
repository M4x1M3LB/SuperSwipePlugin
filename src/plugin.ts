import {PluginManager, type Element} from 'sn-plugin-lib';
import {DEFAULT_CONFIG} from './config';
import {createHost, PenTracker, type DeviceHost} from './host';
import {handlePenUp, withTimeout, type Outcome} from './selector';
import {status} from './status';

const TIMED_OUT: Outcome = {kind: 'failed', reason: 'timed out'};

let host: DeviceHost | null = null;

/** Start listening for strokes. Call once, after PluginManager.init(). */
export function startGestures(): void {
  const pen = new PenTracker();
  pen.start();
  const device = createHost(pen);
  host = device;

  let busy = false;
  PluginManager.registerEventListener('event_pen_up', 1, {
    onMsg(msg: unknown) {
      const {loopSelect, lineErase} = status.gestures();
      if (busy || (!loopSelect && !lineErase) || !Array.isArray(msg)) {
        return;
      }
      busy = true;
      const elements = device.wrap(msg as Element[]);
      // Once we stop waiting, the stroke must not edit the page late.
      let gaveUp = false;
      const work = handlePenUp(
        elements,
        device,
        DEFAULT_CONFIG,
        status.gestures(),
        () => gaveUp,
      );
      withTimeout(work, DEFAULT_CONFIG.timeoutMs, TIMED_OUT)
        .catch((e: unknown): Outcome => ({kind: 'failed', reason: String(e)}))
        .then(outcome => {
          gaveUp = true;
          status.setLastOutcome(outcome);
          device.release();
          busy = false;
        });
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
