/**
 * `Host` implementation backed by sn-plugin-lib.
 */

import {
  NativeUIUtils,
  PluginCommAPI,
  PluginFileAPI,
  PluginManager,
  PluginNoteAPI,
  type Element,
  type MotionEvent,
} from 'sn-plugin-lib';
import type {Box, Pt} from './geometry';
import type {Host, PageElement} from './selector';

interface Response<T> {
  success: boolean;
  result?: T | null;
  error?: {code: number; message: string} | null;
}

type Trace = (line: string) => void;

/** Unwrap an APIResponse, tracing failures with their error code. */
async function call<T>(
  name: string,
  request: () => Promise<unknown>,
  trace: Trace,
): Promise<T | null> {
  try {
    const r = (await request()) as Response<T> | null | undefined;
    if (r?.success) {
      return r.result ?? null;
    }
    trace(
      `${name} failed: ${r?.error?.message ?? 'no result'} (code ${
        r?.error?.code ?? '?'
      })`,
    );
  } catch (e) {
    trace(`${name} threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  return null;
}

const FILE_PERMISSIONS = [
  'plugin.permission.FILE:READ',
  'plugin.permission.FILE:WRITE',
];

const TOOL_PEN = 2;
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_CANCEL = 3;

/** A pen that sent no motion event for this long is treated as lifted. */
const PEN_STALE_MS = 1000;

/**
 * Tracks whether the EMR pen is currently touching the screen.
 *
 * Waiting is driven by motion events, not timers: once the plugin view has
 * been shown, the host may stop running the plugin's timers.
 */
export class PenTracker {
  private down = false;
  private lastEventAt = 0;
  private waiters: {since: number; maxWaitMs: number; resolve: () => void}[] =
    [];

  start(): void {
    PluginManager.registerMotionListener(1, {
      onMsg: (msg: unknown) => {
        const event = msg as MotionEvent;
        if (event?.toolType !== TOOL_PEN) {
          return;
        }
        this.lastEventAt = Date.now();
        if (event.action === ACTION_DOWN) {
          this.down = true;
        } else if (
          event.action === ACTION_UP ||
          event.action === ACTION_CANCEL
        ) {
          this.down = false;
        }
        this.wakeWaiters();
      },
    });
  }

  private isUp(): boolean {
    return !this.down || Date.now() - this.lastEventAt > PEN_STALE_MS;
  }

  private wakeWaiters(): void {
    const now = Date.now();
    this.waiters = this.waiters.filter(w => {
      if (this.isUp() || now - w.since > w.maxWaitMs) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  /** Has the pen stayed off the screen since `time` (Date.now() ms)? */
  quietSince(time: number): boolean {
    return !this.down && this.lastEventAt < time;
  }

  waitForUp(maxWaitMs: number): Promise<void> {
    if (this.isUp()) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.waiters.push({since: Date.now(), maxWaitMs, resolve});
    });
  }
}

function rectCorners(
  left: number,
  top: number,
  right: number,
  bottom: number,
): Pt[] {
  return [
    {x: left, y: top},
    {x: right, y: top},
    {x: right, y: bottom},
    {x: left, y: bottom},
    {x: (left + right) / 2, y: (top + bottom) / 2},
  ];
}

async function readAll<T>(
  accessor:
    | {
        size(): Promise<number>;
        getRange(start: number, count: number): Promise<T[]>;
      }
    | null
    | undefined,
): Promise<T[]> {
  if (!accessor) {
    return [];
  }
  const size = await accessor.size();
  return size > 0 ? accessor.getRange(0, size) : [];
}

/** Points that describe where an element sits on the page. */
async function outlineOf(e: Element): Promise<Pt[]> {
  if (e.stroke) {
    return readAll<Pt>(e.stroke.points);
  }
  if (e.geometry) {
    const g = e.geometry;
    if (g.points?.length) {
      return g.points;
    }
    if (g.ellipseCenterPoint) {
      const c = g.ellipseCenterPoint;
      const r = Math.max(g.ellipseMajorAxisRadius, g.ellipseMinorAxisRadius);
      return Array.from({length: 8}, (_, i) => ({
        x: c.x + r * Math.cos((i * Math.PI) / 4),
        y: c.y + r * Math.sin((i * Math.PI) / 4),
      }));
    }
  }
  if (e.textBox?.textRect) {
    const r = e.textBox.textRect;
    return rectCorners(r.left, r.top, r.right, r.bottom);
  }
  if (e.picture?.rect) {
    const r = e.picture.rect;
    return rectCorners(r.left, r.top, r.right, r.bottom);
  }
  const framed = e.title ?? e.link;
  if (framed) {
    return rectCorners(
      framed.X,
      framed.Y,
      framed.X + framed.width,
      framed.Y + framed.height,
    );
  }
  if (e.fiveStar?.points?.length) {
    return e.fiveStar.points;
  }
  const contours = await readAll<Pt[]>(e.contoursSrc);
  return contours.flat();
}

/** The SDK element behind each PageElement, for write calls and recycling. */
const rawElements = new WeakMap<PageElement, Element>();

export function toPageElement(e: Element): PageElement {
  let cached: Promise<Pt[]> | null = null;
  const wrapped: PageElement = {
    uuid: e.uuid,
    type: e.type,
    numInPage: e.numInPage,
    pageNum: e.pageNum,
    layerNum: e.layerNum,
    penType: e.stroke ? e.stroke.penType : null,
    outline: () => (cached ??= outlineOf(e).catch(() => [])),
  };
  rawElements.set(wrapped, e);
  return wrapped;
}

function recycleAll(elements: Element[]): void {
  for (const e of elements) {
    e.recycle().catch(() => {});
  }
}

/** Make sure FILE:READ and FILE:WRITE are granted, asking the user if needed. */
export async function ensureFileAccess(): Promise<boolean> {
  try {
    return await requestFileAccess();
  } catch {
    return false;
  }
}

async function requestFileAccess(): Promise<boolean> {
  for (const permission of FILE_PERMISSIONS) {
    if ((await PluginManager.hasPermission(permission)) === 1) {
      continue;
    }
    const choice = await PluginManager.requestPermission(
      permission,
      'SuperSwipe needs file access to remove gesture strokes, select what a loop encloses and erase what a line crosses.',
    );
    if (choice !== 1 && choice !== 2) {
      return false;
    }
  }
  return true;
}

interface ErasedStrokes {
  path: string;
  page: number;
  layer: number;
  elements: Element[];
}

export interface DeviceHost extends Host {
  /** Where SDK failures are reported while handling a stroke. */
  setTrace(trace: Trace): void;
  /** Wrap SDK elements so they are tracked and released with the others. */
  wrap(elements: Element[]): PageElement[];
  /** Put the strokes from the last line-erase back. Returns a message. */
  restoreLastErase(): Promise<string>;
}

export function createHost(pen: PenTracker): DeviceHost {
  // Elements read while handling the current stroke; freed in release().
  let fetched: Element[] = [];
  // Strokes removed by the last line-erase, kept in the native cache so
  // insertPageElements can put them back.
  let erased: ErasedStrokes | null = null;

  let trace: Trace = () => {};
  // When the note was last saved, for reloadIfQuiet.
  let savedAt = 0;

  const wrap = (elements: Element[]) => {
    fetched.push(...elements);
    return elements.map(toPageElement);
  };

  return {
    wrap,

    setTrace(t) {
      trace = t;
    },

    getCurrentFilePath() {
      return call<string>(
        'getCurrentFilePath',
        () => PluginCommAPI.getCurrentFilePath(),
        trace,
      );
    },

    getCurrentPageNum() {
      return call<number>(
        'getCurrentPageNum',
        () => PluginCommAPI.getCurrentPageNum(),
        trace,
      );
    },

    getPageSize(path, page) {
      return call<{width: number; height: number}>(
        'getPageSize',
        () => PluginFileAPI.getPageSize(path, page),
        trace,
      );
    },

    async getPageElements(path, page) {
      // getElements reads the note file: save first so it contains the
      // stroke that was just drawn.
      savedAt = Date.now();
      await call(
        'saveCurrentNote',
        () => PluginNoteAPI.saveCurrentNote(),
        trace,
      );
      const elements = await call<Element[]>(
        'getElements',
        () => PluginFileAPI.getElements(page, path),
        trace,
      );
      return wrap(elements ?? []);
    },

    ensureFileAccess,

    waitForPenUp(maxWaitMs) {
      return pen.waitForUp(maxWaitMs);
    },

    async deleteElements(numsInPage, page, layer) {
      const ok = await call<boolean>(
        'deletePageElements',
        () => PluginCommAPI.deletePageElements(numsInPage, page, layer),
        trace,
      );
      return ok === true;
    },

    rememberErased(path, page, layer, elements) {
      if (erased) {
        recycleAll(erased.elements);
      }
      const raw = elements
        .map(e => rawElements.get(e))
        .filter((e): e is Element => e !== undefined);
      erased = {path, page, layer, elements: raw};
    },

    async restoreLastErase() {
      if (!erased) {
        return 'Nothing to restore.';
      }
      if ((await this.getCurrentFilePath()) !== erased.path) {
        return 'Open the note the strokes were erased from, then try again.';
      }
      const {page, layer, elements} = erased;
      const ok = await call<boolean>(
        'insertPageElements',
        () => PluginCommAPI.insertPageElements(elements, page, layer),
        trace,
      );
      if (ok !== true) {
        return 'Could not restore the erased strokes.';
      }
      recycleAll(elements);
      erased = null;
      return `Restored ${elements.length} strokes on page ${page + 1}.`;
    },

    async reloadIfQuiet() {
      // Anything written since the last save would be lost by the reload.
      if (!pen.quietSince(savedAt)) {
        return false;
      }
      const reloaded = await call<unknown>(
        'reloadFile',
        () => PluginCommAPI.reloadFile(),
        trace,
      );
      return reloaded !== null && reloaded !== false;
    },

    async lassoRect(rect: Box) {
      const ok = await call<boolean>(
        'lassoElements',
        () => PluginCommAPI.lassoElements(rect),
        trace,
      );
      return ok === true;
    },

    async askAboveOrBelow() {
      // The device's own two-button dialog. Its result is not documented:
      // taken as true for the right button (as for an OK button on the
      // right); the raw value is traced so a swap is easy to spot.
      try {
        const right = await NativeUIUtils.showRattaDialog(
          'Select everything above or below the line?',
          'Above',
          'Below',
          true,
        );
        trace(`dialog returned ${String(right)}`);
        return right === true ? 'below' : right === false ? 'above' : null;
      } catch (e) {
        trace(`dialog threw: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },

    release() {
      const keep = new Set(erased?.elements);
      recycleAll(fetched.filter(e => !keep.has(e)));
      fetched = [];
    },
  };
}
