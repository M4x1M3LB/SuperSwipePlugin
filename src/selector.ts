/**
 * Pen gestures on NOTE pages, drawn with an ink pen:
 *
 * - Loop to select: a closed loop around existing content is removed and
 *   what it enclosed is lasso-selected.
 * - Margin wave to erase: a sideways wave with 3 bounces or more ("∿∿", a
 *   tilde with an extra bounce), in the margin level with a line of
 *   writing, erases that line and the wave.
 *
 * This module holds the decision logic only. Every device call goes through
 * the `Host` interface (implemented with sn-plugin-lib in host.ts) so the
 * whole flow can be unit-tested with a fake host.
 */

import type {SelectorConfig} from './config';
import {
  boundingBox,
  checkClosedLoop,
  findClosedLoop,
  checkWave,
  findWritingLine,
  fractionInside,
  growPolygon,
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
  /**
   * Reload the note, which repaints the page (deleted strokes otherwise
   * linger on screen). Only call it once the saved file is known to match
   * the page. Implementations must not reload if anything was written since
   * the last save (it would be lost). Returns whether it reloaded.
   */
  reloadIfQuiet(): Promise<boolean>;
  /** Free native element caches (except remembered erased elements). */
  release(): void;
}

export interface Gestures {
  loopSelect: boolean;
  marginErase: boolean;
  /** Repaint the page after an erase (against ghosting). */
  screenRefresh?: boolean;
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
  screenRefresh: boolean;
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
  const gestures = options.gestures ?? {loopSelect: true, marginErase: true};
  const isCancelled = options.isCancelled ?? (() => false);
  const trace = options.trace ?? (() => {});

  const types = penUpElements.map(e => `${e.type}/${e.penType}`).join(', ');
  trace(`pen-up: ${penUpElements.length} element(s) [type/pen ${types}]`);
  const ink = penUpElements.filter(
    e =>
      e.type === STROKE &&
      e.penType !== null &&
      config.triggerPenTypes.includes(e.penType),
  );
  if (ink.length === 0) {
    return {kind: 'ignored', reason: 'not an ink stroke'};
  }

  // Strokes drawn in quick succession arrive together in one event (seen on
  // device), so a gesture may be followed by more writing: look at every
  // stroke, newest first, and take the first gesture.
  //
  // Checked on the pen-up copy, so nothing is read from (or saved to) the
  // page for ordinary writing. The pen-up copy's axes are not guaranteed to
  // match the page's, so a wave running either way passes here; the page
  // copy decides.
  let gesture: PageElement | null = null;
  let points: Pt[] = [];
  let polygon: Pt[] | null = null;
  for (let i = ink.length - 1; i >= 0 && !gesture; i--) {
    const candidate = ink[i];
    const pts = await candidate.outline();
    const label = ink.length > 1 ? `stroke ${i + 1}/${ink.length}` : 'stroke';
    trace(`${label}: pen ${candidate.penType}, ${pts.length} points`);
    if (gestures.marginErase) {
      const wave = checkWave(pts, config.wave, false);
      const swapped = pts.map(p => ({x: p.y, y: p.x}));
      if ('box' in wave || 'box' in checkWave(swapped, config.wave, false)) {
        [gesture, points] = [candidate, pts];
        break;
      }
      trace(`  wave check: ${wave.reason}`);
    }
    if (gestures.loopSelect) {
      const loop = checkClosedLoop(pts, config.loop);
      if ('polygon' in loop) {
        [gesture, points, polygon] = [candidate, pts, loop.polygon];
        break;
      }
      trace(`  loop check: ${loop.reason}`);
    }
  }
  if (!gesture) {
    return {kind: 'ignored', reason: 'not a gesture'};
  }
  trace(polygon ? 'shape: closed loop' : 'shape: wave');

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
    gesture.uuid,
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

  const ctx = {
    host,
    config,
    path,
    page,
    stroke,
    others,
    isCancelled,
    trace,
    screenRefresh: gestures.screenRefresh ?? true,
  };
  if (polygon) {
    const pagePolygon = findClosedLoop(stored, config.loop);
    if (!pagePolygon) {
      return {kind: 'failed', reason: 'loop not recognised in page copy'};
    }
    return selectInLoop(ctx, pagePolygon);
  }

  const checked = checkWave(stored, config.wave);
  if ('reason' in checked) {
    return {kind: 'ignored', reason: `wave on the page: ${checked.reason}`};
  }
  const mark = checked.box;
  trace(
    `wave: ${Math.round(mark.right - mark.left)}×${Math.round(
      mark.bottom - mark.top,
    )} px`,
  );
  return eraseNextToMark(ctx, mark);
}

function fmt(p: Pt | undefined): string {
  return p ? `(${Math.round(p.x)}, ${Math.round(p.y)})` : '(none)';
}

async function selectInLoop(ctx: Context, polygon: Pt[]): Promise<Outcome> {
  const {host, config, path, page, stroke} = ctx;
  // Selection is generous: the loop is grown outward a little, so strokes it
  // grazes or slightly cuts through still count.
  const area = growPolygon(polygon, config.loopMargin);
  const boxes: Box[] = [];
  for (const outline of await outlinesOf(ctx.others)) {
    if (
      outline.length > 0 &&
      fractionInside(outline, area) >= config.minInsideFraction
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
  // One stroke: no need to save and read the page back to check, and no
  // reload (slow, and it would drop the selection). Speed matters here.
  if (!(await host.deleteElements([stroke.numInPage], page, stroke.layerNum))) {
    return {kind: 'failed', reason: 'could not remove loop stroke'};
  }
  ctx.trace('loop stroke removed');

  const rect = padAndClamp(enclosed, config.lassoPadding, size);
  ctx.trace(`lasso: ${rect.left},${rect.top} → ${rect.right},${rect.bottom}`);
  if (!(await host.lassoRect(rect))) {
    return {kind: 'failed', reason: 'could not create lasso selection'};
  }
  return {kind: 'selected', count: boxes.length, rect};
}

/**
 * Erase the line of writing to the right of a margin mark, the strokes
 * touching it (a "t" bar, a descender), and the mark.
 */
async function eraseNextToMark(ctx: Context, mark: Box): Promise<Outcome> {
  const {host, config, path, page, stroke} = ctx;
  const candidates = ctx.others.filter(e => e.type === STROKE);
  const outlines = await outlinesOf(candidates);
  const strokes: {element: PageElement; outline: Pt[]; box: Box}[] = [];
  candidates.forEach((element, i) => {
    const outline = outlines[i];
    if (outline.length > 0) {
      strokes.push({element, outline, box: boundingBox(outline)});
    }
  });
  // The mark has no direction: the line is on whichever side it is.
  // Writing on both sides means the mark is part of the text.
  const boxes = strokes.map(s => s.box);
  const right = findWritingLine(mark, boxes, config.writingLine, 'right');
  const left = findWritingLine(mark, boxes, config.writingLine, 'left');
  const line = 'indices' in right ? right : left;
  if ('reason' in line) {
    const none = 'no writing next to the mark';
    const reasons = [right, left].map(r => ('reason' in r ? r.reason : none));
    const tooClose = reasons.find(r => r.startsWith('mark too close'));
    const reason = reasons.every(r => r === none)
      ? none
      : tooClose ?? 'writing on both sides of the mark, or touching it';
    return {kind: 'ignored', reason};
  }
  ctx.trace(`erasing the line on its ${'indices' in right ? 'right' : 'left'}`);
  const row = line.indices.map(i => strokes[i]);
  ctx.trace(`line of writing: ${row.length} stroke(s)`);

  // Strokes touching the line: a "t" bar, a descender, connected letters.
  const erase = new Set(row);
  for (const s of strokes) {
    if (
      !erase.has(s) &&
      row.some(r =>
        strokesTouch(s.outline, r.outline, config.eraseTouchTolerance),
      )
    ) {
      erase.add(s);
    }
  }
  ctx.trace(`touching: ${erase.size - row.length} more stroke(s)`);
  const erased = [...erase].map(s => s.element);

  const blocked = await checkBeforeEdit(ctx);
  if (blocked) {
    return blocked;
  }
  const removed = await deleteVerified(ctx, [...erased, stroke]);
  if (!removed.deleted) {
    return {kind: 'failed', reason: 'could not erase strokes'};
  }
  host.rememberErased(path, page, stroke.layerNum, erased);
  await repaint(ctx, removed.fileClean);
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
): Promise<{deleted: boolean; fileClean: boolean}> {
  const {host, path, page, stroke} = ctx;
  const signature = async (e: PageElement) => {
    const pts = await e.outline();
    return `${pts.length}@${fmt(pts[0])}`;
  };
  const wanted = new Set(await Promise.all(targets.map(signature)));
  const descending = (els: PageElement[]) =>
    els.map(e => e.numInPage).sort((a, b) => b - a);

  // Saves the page, then reads the file: what is still there.
  const stillThere = async () => {
    const same = (await host.getPageElements(path, page)).filter(
      e => e.type === STROKE && e.layerNum === stroke.layerNum,
    );
    const signatures = await Promise.all(same.map(signature));
    return same.filter((_, i) => wanted.has(signatures[i]));
  };

  if (
    !(await host.deleteElements(descending(targets), page, stroke.layerNum))
  ) {
    return {deleted: false, fileClean: false};
  }
  let left = await stillThere();
  if (left.length > 0) {
    ctx.trace(`still on page after delete: ${left.length}, deleting again`);
    if (!(await host.deleteElements(descending(left), page, stroke.layerNum))) {
      return {deleted: false, fileClean: false};
    }
    left = await stillThere();
  }
  return {deleted: true, fileClean: left.length === 0};
}

/**
 * Repaint the page by reloading the note, but only once the saved file is
 * known to no longer hold the deleted strokes: a reload that reads the file
 * before a save has finished brings old strokes back (seen on device).
 */
async function repaint(ctx: Context, fileClean: boolean): Promise<void> {
  if (!ctx.screenRefresh) {
    return;
  }
  if (!fileClean) {
    ctx.trace('not refreshed: the saved file still had the deleted strokes');
    return;
  }
  ctx.trace(
    (await ctx.host.reloadIfQuiet())
      ? 'screen refreshed (note reloaded)'
      : 'not refreshed: the pen was used since the save',
  );
}

/** How many element outlines to read from the device at once. */
const READ_BATCH = 64;

/**
 * The elements' outlines, read in parallel batches: each read is a call to
 * the device, and waiting for them one by one is slow on a full page.
 */
async function outlinesOf(elements: PageElement[]): Promise<Pt[][]> {
  const result: Pt[][] = [];
  for (let i = 0; i < elements.length; i += READ_BATCH) {
    const batch = elements.slice(i, i + READ_BATCH);
    result.push(...(await Promise.all(batch.map(e => e.outline()))));
  }
  return result;
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
  uuid: string | null,
  pointCount: number,
  trace: (line: string) => void,
): Promise<PageElement | null> {
  const byUuid = elements.find(e => e.uuid === uuid && e.numInPage >= 1);
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
