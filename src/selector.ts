/**
 * Pen gestures on NOTE pages, drawn with an ink pen:
 *
 * - Loop to select: a closed loop around existing content is removed and
 *   what it enclosed is lasso-selected.
 * - Scribble to erase: a back-and-forth scribble over words erases the
 *   scribble and every stroke it went over (and the strokes touching those).
 *
 * Speed matters: everything runs on the page as the host holds it in memory
 * (last element, lasso), without saving or re-reading the note file. The
 * slower file-based path is only a fallback.
 *
 * This module holds the decision logic only. Every device call goes through
 * the `Host` interface (implemented with sn-plugin-lib in host.ts) so the
 * whole flow can be unit-tested with a fake host.
 */

import type {SelectorConfig} from './config';
import {
  boundingBox,
  findClosedLoop,
  findScribble,
  fractionInside,
  padAndClamp,
  strokesTouch,
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
  /** The newest element of the current page, as held in memory. */
  getLastElement(): Promise<PageElement | null>;
  /**
   * All elements on a page, read from the note file (saved first). Slow:
   * only used when the in-memory lookups fail.
   */
  getPageElements(path: string, page: number): Promise<PageElement[]>;
  /** Make sure FILE:READ and FILE:WRITE are granted, asking if needed. */
  ensureFileAccess(): Promise<boolean>;
  /** Resolve once the pen is off the screen, or after `maxWaitMs`. */
  waitForPenUp(maxWaitMs: number): Promise<void>;
  /** Lasso-select the elements in a rectangle (page pixels). */
  lassoRect(rect: Box): Promise<boolean>;
  getLassoElements(): Promise<PageElement[]>;
  /** Delete the lasso-selected elements (keeps the undo history). */
  deleteLassoElements(): Promise<boolean>;
  /** Remove the lasso selection, leaving the elements alone. */
  clearLasso(): Promise<void>;
  /** Delete by number (clears the page's undo history). */
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
  /** Force the host to redraw the page (used when no lasso was created). */
  refreshPage(): Promise<void>;
  /** Free native element caches (except remembered erased elements). */
  release(): void;
}

export interface Gestures {
  loopSelect: boolean;
  scribbleErase: boolean;
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
  size: {width: number; height: number};
  /** The gesture stroke, as stored on the page. */
  stroke: PageElement;
  /** Its points, in page pixels. */
  points: Pt[];
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
  const gestures = options.gestures ?? {loopSelect: true, scribbleErase: true};
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

  const penUpPoints = await gesture.outline();
  trace(`stroke: pen ${gesture.penType}, ${penUpPoints.length} points`);
  const isLoop =
    gestures.loopSelect && findClosedLoop(penUpPoints, config.loop) !== null;
  const isScribble =
    !isLoop &&
    gestures.scribbleErase &&
    findScribble(penUpPoints, config.scribble) !== null;
  if (!isLoop && !isScribble) {
    return {kind: 'ignored', reason: 'not a gesture'};
  }
  trace(isLoop ? 'shape: closed loop' : 'shape: scribble');

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
  const size = await host.getPageSize(path, page);
  if (!size) {
    return {kind: 'failed', reason: 'page size unavailable'};
  }

  const stroke = await findGestureStroke(
    host,
    path,
    page,
    gesture,
    penUpPoints.length,
    trace,
  );
  if (!stroke) {
    return {kind: 'failed', reason: 'gesture stroke not found on page'};
  }
  // The pen-up copy and the page copy of a stroke are not guaranteed to use
  // the same coordinates, so work from the page copy, like everything else.
  const points = await stroke.outline();
  trace(
    `gesture stroke: #${stroke.numInPage}, layer ${stroke.layerNum}; ` +
      `first point pen-up ${fmt(penUpPoints[0])}, page ${fmt(points[0])}`,
  );

  const ctx: Context = {
    host,
    config,
    path,
    page,
    size,
    stroke,
    points,
    isCancelled,
    trace,
  };
  if (isLoop) {
    const polygon = findClosedLoop(points, config.loop);
    if (!polygon) {
      return {kind: 'failed', reason: 'loop not recognised in page copy'};
    }
    return selectInLoop(ctx, polygon);
  }
  if (!findScribble(points, config.scribble)) {
    return {kind: 'failed', reason: 'scribble not recognised in page copy'};
  }
  return eraseUnderScribble(ctx);
}

async function selectInLoop(ctx: Context, polygon: Pt[]): Promise<Outcome> {
  const {host, config, page, stroke} = ctx;
  const blocked = await checkBeforeEdit(ctx);
  if (blocked) {
    return blocked;
  }
  const nearby = await gatherNear(ctx, boundingBox(polygon));
  const boxes: Box[] = [];
  for (const element of nearby) {
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

  // The only way to remove one stroke while keeping what it surrounds.
  if (!(await host.deleteElements([stroke.numInPage], page, stroke.layerNum))) {
    return {kind: 'failed', reason: 'could not remove loop stroke'};
  }
  ctx.trace('loop stroke removed');
  const rect = padAndClamp(enclosed, config.lassoPadding, ctx.size);
  ctx.trace(`lasso: ${rect.left},${rect.top} → ${rect.right},${rect.bottom}`);
  if (!(await host.lassoRect(rect))) {
    // Without a lasso the host does not redraw, and the deleted loop stays
    // visible until something else repaints.
    await host.refreshPage();
    return {kind: 'failed', reason: 'could not create lasso selection'};
  }
  return {kind: 'selected', count: boxes.length, rect};
}

async function eraseUnderScribble(ctx: Context): Promise<Outcome> {
  const {host, config, path, page, stroke, points} = ctx;
  const blocked = await checkBeforeEdit(ctx);
  if (blocked) {
    return blocked;
  }
  const nearby: {element: PageElement; outline: Pt[]}[] = [];
  for (const element of await gatherNear(ctx, boundingBox(points))) {
    if (element.type === STROKE) {
      nearby.push({element, outline: await element.outline()});
    }
  }
  const tolerance = config.eraseTouchTolerance;
  const covered = nearby.filter(n =>
    strokesTouch(n.outline, points, tolerance),
  );
  ctx.trace(`scribbled over: ${covered.length} stroke(s)`);
  if (covered.length === 0) {
    // Shading or hatching on empty paper: leave the ink alone.
    return {kind: 'ignored', reason: 'scribble covers nothing'};
  }

  // The rest of each word: strokes that cross or touch a covered stroke.
  const erase = new Set(covered);
  if (config.eraseTouching) {
    for (const n of nearby) {
      if (
        !erase.has(n) &&
        covered.some(c => strokesTouch(n.outline, c.outline, tolerance))
      ) {
        erase.add(n);
      }
    }
    ctx.trace(`touching: ${erase.size - covered.length} more stroke(s)`);
  }
  const erased = [...erase].map(n => n.element);
  const targets = [...erased, stroke];

  // Fast path: lasso exactly these strokes and delete the selection. This
  // keeps the undo history and makes the host redraw the area.
  const box = unionBoxes([
    boundingBox(points),
    ...[...erase].map(n => boundingBox(n.outline)),
  ])!;
  const rect = padAndClamp(box, config.lassoPadding, ctx.size);
  if (await host.lassoRect(rect)) {
    const selected = await host.getLassoElements();
    if (sameElements(selected, targets)) {
      if (await host.deleteLassoElements()) {
        ctx.trace('deleted with lasso (undo kept)');
        host.rememberErased(path, page, stroke.layerNum, erased);
        return {kind: 'erased', count: erased.length};
      }
    } else {
      ctx.trace(
        `lasso would take ${selected.length} element(s), ` +
          `not the ${targets.length} wanted: deleting by number`,
      );
    }
    await host.clearLasso();
  }

  // Precise path: delete by number, newest first so removing one never
  // shifts the numbers of the others.
  const nums = targets.map(e => e.numInPage).sort((a, b) => b - a);
  if (!(await host.deleteElements(nums, page, stroke.layerNum))) {
    return {kind: 'failed', reason: 'could not erase strokes'};
  }
  host.rememberErased(path, page, stroke.layerNum, erased);
  // Deleting without a lasso does not repaint the page.
  await host.refreshPage();
  return {kind: 'erased', count: erased.length};
}

/**
 * Elements around `box` on the gesture's layer, other than the gesture
 * itself. Uses a temporary lasso (in memory, fast); falls back to reading the
 * page file.
 */
async function gatherNear(ctx: Context, box: Box): Promise<PageElement[]> {
  const {host, config, stroke} = ctx;
  const area = padAndClamp(box, config.gatherMargin, ctx.size);
  let elements: PageElement[];
  if (await host.lassoRect(area)) {
    elements = await host.getLassoElements();
    await host.clearLasso();
    ctx.trace(`nearby (lasso): ${elements.length} element(s)`);
  } else {
    elements = await host.getPageElements(ctx.path, ctx.page);
    ctx.trace(`nearby (page file): ${elements.length} element(s)`);
  }
  return elements.filter(
    e =>
      e.layerNum === stroke.layerNum &&
      e.uuid !== stroke.uuid &&
      e.numInPage !== stroke.numInPage,
  );
}

function sameElements(a: PageElement[], b: PageElement[]): boolean {
  const key = (e: PageElement) => e.numInPage;
  const wanted = new Set(b.map(key));
  return a.length === wanted.size && a.every(e => wanted.has(key(e)));
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

function fmt(p: Pt | undefined): string {
  return p ? `(${Math.round(p.x)}, ${Math.round(p.y)})` : '(none)';
}

/** How many of the newest page strokes to consider as the gesture. */
const RECENT_STROKES = 10;

function closeCount(count: number, wanted: number): boolean {
  return Math.abs(count - wanted) <= Math.max(2, wanted * 0.05);
}

/**
 * Find the gesture stroke as committed to the page.
 *
 * The pen-up element is not committed yet: its uuid and numInPage may differ
 * from the page copy, and its coordinates may be in another system. What
 * survives is the sample count, and the gesture is the newest stroke on the
 * page. Fast path: the page's last element, from memory. Fallback: the page
 * file, matching by uuid, else the newest stroke with the same number of
 * points, else the newest one within 5 % of it.
 */
async function findGestureStroke(
  host: Host,
  path: string,
  page: number,
  gesture: PageElement,
  pointCount: number,
  trace: (line: string) => void,
): Promise<PageElement | null> {
  const last = await host.getLastElement();
  if (last && last.type === STROKE && last.numInPage >= 1) {
    const count = (await last.outline()).length;
    if (closeCount(count, pointCount)) {
      trace('gesture stroke: last element');
      return last;
    }
    trace(`last element has ${count} points, not ${pointCount}`);
  }

  const elements = await host.getPageElements(path, page);
  trace(`page elements: ${elements.length}`);
  const byUuid = elements.find(
    e => e.uuid === gesture.uuid && e.numInPage >= 1,
  );
  if (byUuid) {
    return byUuid;
  }
  const recent = elements
    .filter(e => e.type === STROKE && e.numInPage >= 1)
    .sort((a, b) => b.numInPage - a.numInPage)
    .slice(0, RECENT_STROKES);
  const counts = await Promise.all(
    recent.map(async e => (await e.outline()).length),
  );
  const exact = recent.findIndex((_, i) => counts[i] === pointCount);
  if (exact >= 0) {
    return recent[exact];
  }
  const close = recent.findIndex((_, i) => closeCount(counts[i], pointCount));
  if (close >= 0) {
    return recent[close];
  }
  const seen = recent.map((e, i) => `#${e.numInPage}:${counts[i]}`).join(' ');
  trace(`no page stroke with ${pointCount} points; newest: ${seen || 'none'}`);
  return null;
}
