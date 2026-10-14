/**
 * Pen gestures on NOTE pages, drawn with an ink pen:
 *
 * - Loop to select: a closed loop around existing content is removed and
 *   what it enclosed is lasso-selected.
 * - Line to erase: a straight line that cuts through enough strokes is
 *   removed together with every stroke it cut through.
 *
 * This module holds the decision logic only. Every device call goes through
 * the `Host` interface (implemented with sn-plugin-lib in host.ts) so the
 * whole flow can be unit-tested with a fake host.
 */

import type {SelectorConfig} from './config';
import {
  boundingBox,
  findClosedLoop,
  findStraightLine,
  fractionInside,
  lineCutsStroke,
  padAndClamp,
  unionBoxes,
  type Box,
  type Pt,
  type Segment,
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
  /**
   * All elements on a page. Implementations must make sure the page read
   * includes the stroke that was just drawn (the SDK reads the saved file).
   */
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
  /** Keep these elements around so the erase can be undone later. */
  rememberErased(
    path: string,
    page: number,
    layer: number,
    elements: PageElement[],
  ): void;
  lassoRect(rect: Box): Promise<boolean>;
  /** Force the host to redraw the page (used when no lasso was created). */
  refreshPage(): Promise<void>;
  /** Free native element caches (except remembered erased elements). */
  release(): void;
}

export interface Gestures {
  loopSelect: boolean;
  lineErase: boolean;
}

export type Outcome =
  | {kind: 'ignored'; reason: string}
  | {kind: 'selected'; count: number; rect: Box}
  | {kind: 'erased'; count: number}
  | {kind: 'failed'; reason: string};

const STROKE = 0;

/** Everything both gestures need once a stroke has been recognised. */
interface Context {
  host: Host;
  config: SelectorConfig;
  path: string;
  page: number;
  /** The gesture stroke, as stored on the page. */
  stroke: PageElement;
  /** Other elements on the same page and layer. */
  others: PageElement[];
  isCancelled: () => boolean;
  trace: (line: string) => void;
}

export interface HandleOptions {
  gestures?: Gestures;
  /** Checked right before the page is modified. */
  isCancelled?: () => boolean;
  /** Receives one line per decision, shown on the plugin screen. */
  trace?: (line: string) => void;
}

export async function handlePenUp(
  penUpElements: PageElement[],
  host: Host,
  config: SelectorConfig,
  options: HandleOptions = {},
): Promise<Outcome> {
  const gestures = options.gestures ?? {loopSelect: true, lineErase: true};
  const isCancelled = options.isCancelled ?? (() => false);
  const trace = options.trace ?? (() => {});

  const types = penUpElements.map(e => `${e.type}/${e.penType}`).join(', ');
  trace(`pen-up: ${penUpElements.length} element(s) [type/pen ${types}]`);
  const gesture = [...penUpElements]
    .reverse()
    .find(
      e =>
        e.type === STROKE &&
        e.penType !== null &&
        config.triggerPenTypes.includes(e.penType),
    );
  if (!gesture) {
    return {kind: 'ignored', reason: 'not an ink stroke'};
  }

  const points = await gesture.outline();
  trace(`stroke: pen ${gesture.penType}, ${points.length} points`);
  const polygon = gestures.loopSelect
    ? findClosedLoop(points, config.loop)
    : null;
  const line =
    !polygon && gestures.lineErase
      ? findStraightLine(points, config.line)
      : null;
  if (!polygon && !line) {
    return {kind: 'ignored', reason: 'not a gesture'};
  }
  trace(polygon ? 'shape: closed loop' : 'shape: straight line');

  const path = await host.getCurrentFilePath();
  if (!path || !/\.note$/i.test(path)) {
    return {kind: 'ignored', reason: 'only NOTE files are supported'};
  }
  // The pen-up element is not committed to the page yet, so its page fields
  // may be unset: ask the host which page is showing.
  const page = (await host.getCurrentPageNum()) ?? gesture.pageNum;
  trace(`file: ${path.split('/').pop()}, page ${page}`);

  if (!(await host.ensureFileAccess())) {
    return {kind: 'failed', reason: 'file access not granted'};
  }

  const elements = await host.getPageElements(path, page);
  trace(`page elements: ${elements.length}`);
  const stroke = await findStoredStroke(elements, gesture, points);
  if (!stroke) {
    return {kind: 'failed', reason: 'gesture stroke not found on page'};
  }
  trace(`gesture stroke: #${stroke.numInPage}, layer ${stroke.layerNum}`);
  const others = elements.filter(
    e => e !== stroke && e.layerNum === stroke.layerNum,
  );

  const ctx = {host, config, path, page, stroke, others, isCancelled, trace};
  return polygon ? selectInLoop(ctx, polygon) : eraseAlongLine(ctx, line!);
}

async function selectInLoop(ctx: Context, polygon: Pt[]): Promise<Outcome> {
  const {host, config, path, page, stroke} = ctx;
  const boxes: Box[] = [];
  for (const element of ctx.others) {
    const outline = await element.outline();
    if (
      outline.length > 0 &&
      fractionInside(outline, polygon) >= config.minInsideFraction
    ) {
      boxes.push(boundingBox(outline));
    }
  }
  const enclosed = unionBoxes(boxes);
  ctx.trace(`enclosed: ${boxes.length} element(s)`);
  if (!enclosed) {
    // Plain drawing (an "O", a circle doodle): leave the ink alone.
    return {kind: 'ignored', reason: 'loop encloses nothing'};
  }

  const size = await host.getPageSize(path, page);
  if (!size) {
    return {kind: 'failed', reason: 'page size unavailable'};
  }

  const blocked = await checkBeforeEdit(ctx);
  if (blocked) {
    return blocked;
  }
  if (!(await host.deleteElements([stroke.numInPage], page, stroke.layerNum))) {
    return {kind: 'failed', reason: 'could not remove loop stroke'};
  }

  ctx.trace('loop stroke removed');
  const rect = padAndClamp(enclosed, config.lassoPadding, size);
  ctx.trace(`lasso: ${rect.left},${rect.top} → ${rect.right},${rect.bottom}`);
  if (!(await host.lassoRect(rect))) {
    // Without a lasso the host does not redraw, and the deleted loop stays
    // visible until something else repaints.
    await host.refreshPage();
    return {kind: 'failed', reason: 'could not create lasso selection'};
  }
  return {kind: 'selected', count: boxes.length, rect};
}

async function eraseAlongLine(ctx: Context, line: Segment): Promise<Outcome> {
  const {host, config, path, page, stroke} = ctx;
  const cut: PageElement[] = [];
  for (const element of ctx.others) {
    if (element.type !== STROKE) {
      continue;
    }
    const outline = await element.outline();
    if (lineCutsStroke(outline, line, config.eraseMinCutRatio)) {
      cut.push(element);
    }
  }
  ctx.trace(`cut: ${cut.length} stroke(s)`);
  if (cut.length < config.eraseMinCrossed) {
    // An underline, a divider, a crossed-out letter: leave the ink alone.
    return {kind: 'ignored', reason: `line cuts ${cut.length} strokes`};
  }

  const blocked = await checkBeforeEdit(ctx);
  if (blocked) {
    return blocked;
  }
  const nums = [...cut, stroke].map(e => e.numInPage);
  if (!(await host.deleteElements(nums, page, stroke.layerNum))) {
    return {kind: 'failed', reason: 'could not erase strokes'};
  }
  host.rememberErased(path, page, stroke.layerNum, cut);
  // Deleting without a lasso does not repaint the page.
  await host.refreshPage();
  return {kind: 'erased', count: cut.length};
}

/** Last checks before the page is modified; returns why not to, if any. */
async function checkBeforeEdit(ctx: Context): Promise<Outcome | null> {
  // Editing the page while the pen is down drops the stroke being written.
  await ctx.host.waitForPenUp(ctx.config.penUpWaitMs);
  // The user may have turned the page or switched file while we worked, or
  // the caller may have given up on this stroke (timeout).
  if (
    ctx.isCancelled() ||
    (await ctx.host.getCurrentFilePath()) !== ctx.path ||
    (await ctx.host.getCurrentPageNum()) !== ctx.page
  ) {
    return {kind: 'ignored', reason: 'page changed'};
  }
  return null;
}

/**
 * Find the pen-up stroke in the page's element list. The pen-up element's
 * `numInPage` is not guaranteed to be filled in, so match by uuid first, then
 * by identical first and last points among strokes.
 */
async function findStoredStroke(
  elements: PageElement[],
  gesture: PageElement,
  points: Pt[],
): Promise<PageElement | null> {
  const byUuid = elements.find(
    e => e.uuid === gesture.uuid && e.numInPage >= 1,
  );
  if (byUuid) {
    return byUuid;
  }
  const first = points[0];
  const last = points[points.length - 1];
  // Newest strokes are at the end of the page list, so search backwards.
  for (let i = elements.length - 1; i >= 0; i--) {
    const e = elements[i];
    if (e.type !== STROKE) {
      continue;
    }
    const pts = await e.outline();
    if (
      pts.length > 0 &&
      samePoint(pts[0], first) &&
      samePoint(pts[pts.length - 1], last)
    ) {
      return e;
    }
  }
  return null;
}

function samePoint(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
}
