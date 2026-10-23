/**
 * The floating undo/redo button (native overlay window, see
 * android/.../LaserOverlayModule.java).
 *
 * - Hidden while the pen touches the screen; when it lifts, shown just right
 *   of the stroke, level with its top (screen px from the motion events).
 * - Finger taps on it, counted natively: 1 undo, 2 redo, 3 hide.
 * - A four-finger tap anywhere shows or hides it again.
 *
 * Without the native module (an older build) or the overlay permission,
 * everything here does nothing.
 */
import {DeviceEventEmitter, NativeModules} from 'react-native';
import type {MotionEvent} from 'sn-plugin-lib';

interface OverlayNative {
  checkPermission(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  showAt(x: number, y: number): Promise<boolean>;
  hide(): Promise<boolean>;
  remove(): Promise<boolean>;
}

const native: OverlayNative | undefined = NativeModules.LaserOverlay;

const TOOL_FINGER = 1;
const TOOL_PEN = 2;
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;
const ACTION_CANCEL = 3;
const ACTION_POINTER_DOWN = 5;

/** Gap between the stroke's right edge and the button, in screen px. */
const GAP = 24;

export function overlayAvailable(): boolean {
  return native !== undefined;
}

export async function overlayAllowed(): Promise<boolean> {
  try {
    return native ? await native.checkPermission() : false;
  } catch {
    return false;
  }
}

export async function requestOverlay(): Promise<void> {
  try {
    await native?.requestPermission();
  } catch {}
}

export class FloatingButton {
  private box: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null = null;
  /** Hidden by three taps (or a four-finger tap) until shown again. */
  private hiddenByUser = false;
  /** A four-finger touch already toggled; wait for all fingers up. */
  private fingersCounted = false;

  constructor(private enabled: () => boolean, onTaps: (count: number) => void) {
    DeviceEventEmitter.addListener(
      'laserOverlayTaps',
      (e: {count?: number}) => {
        if (this.enabled() && typeof e?.count === 'number') {
          onTaps(e.count);
        }
      },
    );
  }

  /** Called for every motion event: cheap unless the pen goes down or up. */
  onMotion(event: MotionEvent | null | undefined): void {
    if (!native || !event) {
      return;
    }
    if (!this.enabled()) {
      if (this.box) {
        this.box = null;
        native.hide().catch(() => {});
      }
      return;
    }
    // Pointer actions carry the pointer index above the low byte.
    const action = event.action % 256;
    if (event.toolType === TOOL_PEN) {
      const {x, y} = event;
      if (action === ACTION_DOWN) {
        this.box = {left: x, top: y, right: x, bottom: y};
        native.hide().catch(() => {});
      } else if (action === ACTION_MOVE && this.box) {
        const b = this.box;
        b.left = Math.min(b.left, x);
        b.right = Math.max(b.right, x);
        b.top = Math.min(b.top, y);
        b.bottom = Math.max(b.bottom, y);
      } else if (action === ACTION_UP || action === ACTION_CANCEL) {
        this.show();
      }
    } else if (event.toolType === TOOL_FINGER) {
      if (
        (action === ACTION_DOWN || action === ACTION_POINTER_DOWN) &&
        event.pointerCount >= 4 &&
        !this.fingersCounted
      ) {
        this.fingersCounted = true;
        this.hiddenByUser = !this.hiddenByUser;
        if (this.hiddenByUser) {
          native.hide().catch(() => {});
        } else {
          this.show();
        }
      } else if (action === ACTION_UP || action === ACTION_CANCEL) {
        this.fingersCounted = false;
      }
    }
  }

  /** Three taps: hide until a four-finger tap. */
  hideByUser(): void {
    this.hiddenByUser = true;
    native?.hide().catch(() => {});
  }

  /** Next to the last stroke, if there is one and it is not hidden. */
  show(): void {
    if (!native || this.hiddenByUser || !this.box) {
      return;
    }
    native.showAt(this.box.right + GAP, this.box.top).catch(() => {});
  }
}
