/**
 * Loop-to-select: when the user draws a closed loop around existing content
 * with an ink pen, remove the loop stroke and lasso-select what it enclosed.
 *
 * This module holds the decision logic only. Every device call goes through
 * the `Host` interface (implemented with sn-plugin-lib in host.ts) so the
 * whole flow can be unit-tested with a fake host.
 */

import type {SelectorConfig} from './config';
import {
  boundingBox,
  findClosedLoop,
  fractionInside,
  padAndClamp,
  unionBoxes,
  type Box,
  type Pt,
} from './geometry';

export interface PageElement {
  uuid: string;
  type: number;
  /** 1-based index of the element within its page. */
  numInPage: number;
  pageNum: number;
  layerNum: number;
  /** Pen type for strokes, null for other element types. */
  penType: number | null;
  /** Points describing where the element sits on the page. */
  outline(): Promise<Pt[]>;
}

export interface Host {
  getCurrentFilePath(): Promise<string | null>;
  getCurrentPageNum(): Promise<number | null>;
  getPageSize(
    path: string,
    page: number,
  ): Promise<{width: number; height: number} | null>;
  getPageElements(path: string, page: number): Promise<PageElement[]>;
  /** Make sure FILE:READ and FILE:WRITE are granted, asking if needed. */
  ensureFileAccess(): Promise<boolean>;
  /** Resolve once the pen is off the screen, or after `maxWaitMs`. */
  waitForPenUp(maxWaitMs: number): Promise<void>;
  deleteElements(
    numsInPage: number[],
    page: number,
    layer: number,
  ): Promise<boolean>;
  lassoRect(rect: Box): Promise<boolean>;
  /** Force the host to redraw the page (used when no lasso was created). */
  refreshPage(): Promise<void>;
  /** Free native element caches. */
  release(): void;
}

export type Outcome =
  | {kind: 'ignored'; reason: string}
  | {kind: 'selected'; count: number; rect: Box}
  | {kind: 'failed'; reason: string};

const STROKE = 0;

export async function handlePenUp(
  penUpElements: PageElement[],
  host: Host,
  config: SelectorConfig,
  isCancelled: () => boolean = () => false,
): Promise<Outcome> {
  const loop = [...penUpElements]
    .reverse()
    .find(
      e =>
        e.type === STROKE &&
        e.penType !== null &&
        config.triggerPenTypes.includes(e.penType),
    );
  if (!loop) {
    return {kind: 'ignored', reason: 'not an ink stroke'};
  }

  const loopPoints = await loop.outline();
  const polygon = findClosedLoop(loopPoints, config.loop);
  if (!polygon) {
    return {kind: 'ignored', reason: 'not a closed loop'};
  }

  const path = await host.getCurrentFilePath();
  if (!path || !/\.note$/i.test(path)) {
    return {kind: 'ignored', reason: 'only NOTE files are supported'};
  }
  const page = loop.pageNum;

  if (!(await host.ensureFileAccess())) {
    return {kind: 'failed', reason: 'file access not granted'};
  }

  const elements = await host.getPageElements(path, page);
  const stored = await findStoredLoop(elements, loop, loopPoints);
  if (!stored) {
    return {kind: 'failed', reason: 'loop stroke not found on page'};
  }

  const boxes: Box[] = [];
  for (const element of elements) {
    if (element === stored || element.layerNum !== stored.layerNum) {
      continue;
    }
    const outline = await element.outline();
    if (
      outline.length > 0 &&
      fractionInside(outline, polygon) >= config.minInsideFraction
    ) {
      boxes.push(boundingBox(outline));
    }
  }
  const enclosed = unionBoxes(boxes);
  if (!enclosed) {
    // Plain drawing (an "O", a circle doodle): leave the ink alone.
    return {kind: 'ignored', reason: 'loop encloses nothing'};
  }

  const size = await host.getPageSize(path, page);
  if (!size) {
    return {kind: 'failed', reason: 'page size unavailable'};
  }

  // Editing the page while the pen is down drops the stroke being written.
  await host.waitForPenUp(config.penUpWaitMs);

  // The user may have turned the page or switched file while we worked, or
  // the caller may have given up on this stroke (timeout).
  if (
    isCancelled() ||
    (await host.getCurrentFilePath()) !== path ||
    (await host.getCurrentPageNum()) !== page
  ) {
    return {kind: 'ignored', reason: 'page changed'};
  }

  if (!(await host.deleteElements([stored.numInPage], page, stored.layerNum))) {
    return {kind: 'failed', reason: 'could not remove loop stroke'};
  }

  const rect = padAndClamp(enclosed, config.lassoPadding, size);
  if (!(await host.lassoRect(rect))) {
    // Without a lasso the host does not redraw, and the deleted loop stays
    // visible until something else repaints.
    await host.refreshPage();
    return {kind: 'failed', reason: 'could not create lasso selection'};
  }
  return {kind: 'selected', count: boxes.length, rect};
}

/**
 * Find the pen-up stroke in the page's element list. The pen-up element's
 * `numInPage` is not guaranteed to be filled in, so match by uuid first, then
 * by identical first and last points among strokes.
 */
async function findStoredLoop(
  elements: PageElement[],
  loop: PageElement,
  loopPoints: Pt[],
): Promise<PageElement | null> {
  const byUuid = elements.find(e => e.uuid === loop.uuid);
  if (byUuid) {
    return byUuid;
  }
  const first = loopPoints[0];
  const last = loopPoints[loopPoints.length - 1];
  // Newest strokes are at the end of the page list, so search backwards.
  for (let i = elements.length - 1; i >= 0; i--) {
    const e = elements[i];
    if (e.type !== STROKE || e.penType !== loop.penType) {
      continue;
    }
    const pts = await e.outline();
    if (
      pts.length === loopPoints.length &&
      samePoint(pts[0], first) &&
      samePoint(pts[pts.length - 1], last)
    ) {
      return e;
    }
  }
  return null;
}

function samePoint(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
