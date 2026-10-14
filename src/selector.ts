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
  strokesTouch,
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
  const stroke = await findStoredStroke(
    elements,
    gesture,
    points.length,
    trace,
  );
  if (!stroke) {
    return {kind: 'failed', reason: 'gesture stroke not found on page'};
  }
  // The pen-up copy and the page copy of a stroke are not guaranteed to use
  // the same coordinates, so work from the page copy, like everything else.
  const stored = await stroke.outline();
  trace(
    `gesture stroke: #${stroke.numInPage}, layer ${stroke.layerNum}, ` +
      `${stored.length} points; first point pen-up ${fmt(points[0])}, ` +
      `page ${fmt(stored[0])}`,
  );
  const others = elements.filter(
    e => e !== stroke && e.layerNum === stroke.layerNum,
  );

  const ctx = {host, config, path, page, stroke, others, isCancelled, trace};
  if (polygon) {
    const pagePolygon = findClosedLoop(stored, config.loop);
    if (!pagePolygon) {
      return {kind: 'failed', reason: 'loop not recognised in page copy'};
    }
    return selectInLoop(ctx, pagePolygon);
  }
  const pageLine = findStraightLine(stored, config.line);
  if (!pageLine) {
    return {kind: 'failed', reason: 'line not recognised in page copy'};
  }
  return eraseAlongLine(ctx, pageLine);
}

function fmt(p: Pt | undefined): string {
  return p ? `(${Math.round(p.x)}, ${Math.round(p.y)})` : '(none)';
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
  if (!(await deleteVerified(ctx, [stroke]))) {
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
  const strokes: {element: PageElement; outline: Pt[]}[] = [];
  for (const element of ctx.others) {
    if (element.type === STROKE) {
      strokes.push({element, outline: await element.outline()});
    }
  }
  const cut = strokes.filter(s =>
    lineCutsStroke(s.outline, line, config.eraseMinCutRatio),
  );
  ctx.trace(`cut: ${cut.length} stroke(s)`);
  if (cut.length < config.eraseMinCrossed) {
    // An underline, a divider, a crossed-out letter: leave the ink alone.
    return {kind: 'ignored', reason: `line cuts ${cut.length} strokes`};
  }

  // The rest of each word: strokes that cross or touch a cut stroke.
  const erase = new Set(cut);
  if (config.eraseTouching) {
    for (const s of strokes) {
      if (
        !erase.has(s) &&
        cut.some(c =>
          strokesTouch(s.outline, c.outline, config.eraseTouchTolerance),
        )
      ) {
        erase.add(s);
      }
    }
    ctx.trace(`touching: ${erase.size - cut.length} more stroke(s)`);
  }
  const erased = [...erase].map(s => s.element);

  const blocked = await checkBeforeEdit(ctx);
  if (blocked) {
    return blocked;
  }
  if (!(await deleteVerified(ctx, [...erased, stroke]))) {
    return {kind: 'failed', reason: 'could not erase strokes'};
  }
  host.rememberErased(path, page, stroke.layerNum, erased);
  // Deleting without a lasso does not repaint the page.
  await host.refreshPage();
  return {kind: 'erased', count: erased.length};
}

/**
 * Delete page elements, newest first so removing one never shifts the
 * numbers of the others, then re-read the page and delete again whatever
 * is still there (matched by point count and first point, as numbers may
 * have changed).
 */
async function deleteVerified(
  ctx: Context,
  targets: PageElement[],
): Promise<boolean> {
  const {host, path, page, stroke} = ctx;
  const signature = async (e: PageElement) => {
    const pts = await e.outline();
    return `${pts.length}@${fmt(pts[0])}`;
  };
  const wanted = new Set(await Promise.all(targets.map(signature)));
  const descending = (els: PageElement[]) =>
    els.map(e => e.numInPage).sort((a, b) => b - a);

  if (
    !(await host.deleteElements(descending(targets), page, stroke.layerNum))
  ) {
    return false;
  }
  const after = await host.getPageElements(path, page);
  const left: PageElement[] = [];
  for (const e of after) {
    if (
      e.type === STROKE &&
      e.layerNum === stroke.layerNum &&
      wanted.has(await signature(e))
    ) {
      left.push(e);
    }
  }
  if (left.length === 0) {
    return true;
  }
  ctx.trace(`still on page after delete: ${left.length}, deleting again`);
  return host.deleteElements(descending(left), page, stroke.layerNum);
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

/** How many of the newest page strokes to consider as the gesture. */
const RECENT_STROKES = 10;

/**
 * Find the pen-up stroke in the page's element list.
 *
 * The pen-up element is not committed yet: its uuid and numInPage may differ
 * from the page copy, and its coordinates may be in another system. What
 * survives is the sample count, and the gesture is the newest stroke on the
 * page. So: match by uuid if possible, else the newest stroke with the same
 * number of points, else the newest one within 5 % of it.
 */
async function findStoredStroke(
  elements: PageElement[],
  gesture: PageElement,
  pointCount: number,
  trace: (line: string) => void,
): Promise<PageElement | null> {
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
  const tolerance = Math.max(2, pointCount * 0.05);
  const close = recent.findIndex(
    (_, i) => Math.abs(counts[i] - pointCount) <= tolerance,
  );
  if (close >= 0) {
    return recent[close];
  }
  const seen = recent.map((e, i) => `#${e.numInPage}:${counts[i]}`).join(' ');
  trace(`no page stroke with ${pointCount} points; newest: ${seen || 'none'}`);
  return null;
}
