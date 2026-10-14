import {PluginManager, type Element} from 'sn-plugin-lib';
import {DEFAULT_CONFIG} from './config';
import {createHost, PenTracker, toPageElement} from './host';
import {handlePenUp, withTimeout, type Outcome} from './selector';
import {status} from './status';

const TIMED_OUT: Outcome = {kind: 'failed', reason: 'timed out'};

/** Start listening for strokes. Call once, after PluginManager.init(). */
export function startLoopSelect(): void {
  const pen = new PenTracker();
  pen.start();
  const host = createHost(pen);

  let busy = false;
  PluginManager.registerEventListener('event_pen_up', 1, {
    onMsg(msg: unknown) {
      if (busy || !status.isEnabled() || !Array.isArray(msg)) {
        return;
      }
      busy = true;
      const elements = (msg as Element[]).map(toPageElement);
      // Once we stop waiting, the stroke must not edit the page late.
      let gaveUp = false;
      const work = handlePenUp(elements, host, DEFAULT_CONFIG, () => gaveUp);
      withTimeout(work, DEFAULT_CONFIG.timeoutMs, TIMED_OUT)
        .catch((e: unknown): Outcome => ({kind: 'failed', reason: String(e)}))
        .then(outcome => {
          gaveUp = true;
          status.setLastOutcome(outcome);
          host.release();
          busy = false;
        });
    },
  });
}
