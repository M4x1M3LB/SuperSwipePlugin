/**
 * Repaint the note page without touching its data.
 *
 * After strokes are deleted outside a lasso, the device keeps them in its
 * screen buffer and they show again where the pen passes (ghosting). Opening
 * the plugin view and closing it again makes the host repaint the page under
 * it (measured on device by the author of the Snap plugin). The view shows a
 * fully transparent screen meanwhile (see App.tsx).
 *
 * Reloading the note would repaint too, but is never used: a reload that
 * reads the file before a save has finished brings old strokes back.
 */

import {PluginManager} from 'sn-plugin-lib';

/** How long the transparent view stays open, in ms. */
export const BLINK_MS = 250;

type Listener = () => void;

let blinking = false;
let done: (() => void) | null = null;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach(l => l());
}

export function isBlinking(): boolean {
  return blinking;
}

export function subscribeBlink(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Open the transparent view; resolves once it has been closed again, by
 * `endBlink` (called from the view after BLINK_MS, or on any tap).
 */
export async function blink(): Promise<void> {
  if (blinking) {
    return;
  }
  blinking = true;
  const closed = new Promise<void>(resolve => {
    done = resolve;
  });
  notify();
  try {
    await PluginManager.showPluginView();
  } catch {
    endBlink();
  }
  await closed;
}

/** Close the transparent view (safe to call more than once). */
export function endBlink(): void {
  if (!blinking) {
    return;
  }
  blinking = false;
  notify();
  PluginManager.closePluginView().catch(() => {});
  done?.();
  done = null;
}
