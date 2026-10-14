/**
 * `Host` implementation backed by sn-plugin-lib.
 */

import {
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

function resultOf<T>(res: unknown): T | null {
  const r = res as Response<T> | null | undefined;
  return r?.success ? r.result ?? null : null;
}

const FILE_PERMISSIONS = [
  'plugin.permission.FILE:READ',
  'plugin.permission.FILE:WRITE',
];

const TOOL_PEN = 2;
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_CANCEL = 3;

/** Tracks whether the EMR pen is currently touching the screen. */
export class PenTracker {
  private down = false;

  start(): void {
    PluginManager.registerMotionListener(2, {
      onMsg: (msg: unknown) => {
        const event = msg as MotionEvent;
        if (event?.toolType !== TOOL_PEN) {
          return;
        }
        if (event.action === ACTION_DOWN) {
          this.down = true;
        } else if (
          event.action === ACTION_UP ||
          event.action === ACTION_CANCEL
        ) {
          this.down = false;
        }
      },
    });
  }

  async waitForUp(maxWaitMs: number): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (this.down && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
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

export function toPageElement(e: Element): PageElement {
  let cached: Promise<Pt[]> | null = null;
  return {
    uuid: e.uuid,
    type: e.type,
    numInPage: e.numInPage,
    pageNum: e.pageNum,
    layerNum: e.layerNum,
    penType: e.stroke ? e.stroke.penType : null,
    outline: () => (cached ??= outlineOf(e).catch(() => [])),
  };
}

/** Make sure FILE:READ and FILE:WRITE are granted, asking the user if needed. */
export async function ensureFileAccess(): Promise<boolean> {
  for (const permission of FILE_PERMISSIONS) {
    if ((await PluginManager.hasPermission(permission)) === 1) {
      continue;
    }
    const choice = await PluginManager.requestPermission(
      permission,
      'SuperSwipe needs file access to remove the loop you drew and select what it encloses.',
    );
    if (choice !== 1 && choice !== 2) {
      return false;
    }
  }
  return true;
}

export function createHost(pen: PenTracker): Host {
  return {
    async getCurrentFilePath() {
      return resultOf<string>(await PluginCommAPI.getCurrentFilePath());
    },

    async getCurrentPageNum() {
      return resultOf<number>(await PluginCommAPI.getCurrentPageNum());
    },

    async getPageSize(path, page) {
      return resultOf<{width: number; height: number}>(
        await PluginFileAPI.getPageSize(path, page),
      );
    },

    async getPageElements(path, page) {
      const elements = resultOf<Element[]>(
        await PluginFileAPI.getElements(page, path),
      );
      return (elements ?? []).map(toPageElement);
    },

    ensureFileAccess,

    waitForPenUp(maxWaitMs) {
      return pen.waitForUp(maxWaitMs);
    },

    async deleteElements(numsInPage, page, layer) {
      return (
        resultOf<boolean>(
          await PluginCommAPI.deletePageElements(numsInPage, page, layer),
        ) === true
      );
    },

    async lassoRect(rect: Box) {
      return (
        resultOf<boolean>(await PluginCommAPI.lassoElements(rect)) === true
      );
    },

    async refreshPage() {
      await PluginNoteAPI.saveCurrentNote();
      await PluginCommAPI.reloadFile();
    },

    release() {
      PluginCommAPI.clearElementCache();
    },
  };
}
