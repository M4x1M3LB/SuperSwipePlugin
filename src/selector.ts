/**
 * Pen gestures on NOTE pages, drawn with an ink pen:
 *
 * - Loop to select: a closed loop around existing content is removed and
 *   what it enclosed is lasso-selected.
 * - Margin wave to erase: a sideways wave with 5 bounces or more ("∿∿∿"),
 *   in the margin level with a line of
 *   writing, erases that line and the wave.
 * - Line to select: a straight horizontal line, a few words long or more,
 *   clear of the writing, selects everything above or below it (asking
 *   which when there is writing on both sides).
 * - Margin bar to select: a vertical stroke in the margin beside some lines
 *   selects the block of writing level with it.
 *
 * This module holds the decision logic only. Every device call goes through
 * the `Host` interface (implemented with sn-plugin-lib in host.ts) so the
 * whole flow can be unit-tested with a fake host.
 */

import type {SelectorConfig} from './config';
import {
  boundingBox,
  checkClosedLoop,
  checkStraightLine,
  checkVerticalBar,
  findBlockBesideBar,
  distance,
  findClosedLoop,
  checkWave,
  findWritingLine,
  growPolygon,
  insideAtLeast,
  overlapsWithin,
  padAndClamp,
  strokesTouch,
  unionBoxes,
  type Box,
  type LoopOptions,
  type Pt,
  type WaveOptions,
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
  /**
   * How many points `outline()` has, without reading them (optional; when
   * missing, `outline()` is read instead).
   */
  pointCount?(): Promise<number>;
  /** The first point of `outline()`, without reading the rest (optional). */
  firstPoint?(): Promise<Pt | undefined>;
}

export interface PageSize {
  width: number;
  height: number;
}

export interface Host {
  getCurrentFilePath(): Promise<string | null>;
  getCurrentPageNum(): Promise<number | null>;
  getPageSize(path: string, page: number): Promise<PageSize | null>;
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
   * Remember which strokes are on a page after a gesture (null to forget),
   * so the next gesture can tell whether some were removed outside the
   * plugin.
   */
  rememberPage(
    content: {path: string; page: number; uuids: string[]} | null,
  ): void;
  lastPage(): {path: string; page: number; uuids: string[]} | null;
  /** Close a lasso box left open on the page, if any. */
  closeLasso(): Promise<void>;
  /**
   * Remember the strokes a gesture just selected (null to forget), so the
   * next gesture can tell whether they were deleted with the lasso toolbar.
   */
  rememberSelection(
    selection: {path: string; page: number; uuids: string[]} | null,
  ): void;
  lastSelection(): {path: string; page: number; uuids: string[]} | null;
  /** How many times the pen has touched the screen so far. */
  penDownCount(): number;
  /** Ask the user which side of a line to select; null if unanswered. */
  askAboveOrBelow(): Promise<'above' | 'below' | null>;
  /**
   * Reload the note, which repaints the page (deleted strokes otherwise
   * linger on screen). Only call it once the saved file is known to match
   * the page. Implementations must not reload if anything was written since
   * the last save (it would be lost). Returns whether it reloaded.
   */
  reloadIfQuiet(): Promise<boolean>;
  /**
   * Save the note, read the page back (so the save has landed), then reload
   * the note: the device drops any stale copy of the page, and nothing
   * written is lost since it was just saved. Returns whether it reloaded.
   */
  saveAndReload(path: string, page: number): Promise<boolean>;
  /**
   * Free the native caches of the elements read so far, except remembered
   * erased elements and the elements with these uuids (strokes still
   * waiting to be handled).
   */
  release(pendingUuids?: string[]): void;
}

export interface Gestures {
  loopSelect: boolean;
  marginErase: boolean;
  lineSelect?: boolean;
  barSelect?: boolean;
  /** Repaint the page after an erase (against ghosting). */
  screenRefresh?: boolean;
}

export type Outcome =
  | {kind: 'ignored'; reason: string}
  | {kind: 'selected'; count: number; rect: Box}
  | {kind: 'erased'; count: number}
  | {kind: 'failed'; reason: string};

const STROKE = 0;

const NO_WRITING = 'no writing next to the wave';

/** Everything a gesture needs once its stroke has been recognised. */
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
  /**
   * Strokes were removed outside the plugin since its last gesture: the
   * device's copy of the page may still hold them, and the plugin's next
   * edit would write them back. Reload the note before editing.
   */
  resync: boolean;
  /** The page size, when already read or being read. */
  size?: Promise<PageSize | null>;
}

export interface HandleOptions {
  gestures?: Gestures;
  /** Checked right before the page is modified. */
  isCancelled?: () => boolean;
  /** Receives one line per decision, shown on the plugin screen. */
  trace?: (line: string) => void;
  /** Called after waiting on the user, so that time is not held against us. */
  keepAlive?: () => void;
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
  const keepAlive = options.keepAlive ?? (() => {});

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
  // Where a wave was found in the event: one followed by more strokes is a
  // letter ("m", "w") with the rest of the word coming.
  let waveIndex = -1;
  let points: Pt[] = [];
  let polygon: Pt[] | null = null;
  // A line or a bar: the pen-up copy may be turned a quarter, so which one
  // is decided on the page copy. Which check it passed here, and its
  // length in page px.
  let straight: {kind: 'line' | 'bar'; length: number; index: number} | null =
    null;
  const downsAtStart = host.penDownCount();
  // Every stroke's points are read at once (newest first): each read is a
  // round trip to the device.
  const readsFrom = Date.now();
  let readsDone = 0;
  let readsDoneAt = readsFrom;
  const reads: Promise<Pt[]>[] = new Array(ink.length);
  for (let i = ink.length - 1; i >= 0; i--) {
    reads[i] = ink[i].outline();
    reads[i].then(
      () => {
        readsDone++;
        readsDoneAt = Date.now();
      },
      () => {},
    );
  }
  for (let i = ink.length - 1; i >= 0 && !gesture; i--) {
    const candidate = ink[i];
    const pts = await reads[i];
    const label = ink.length > 1 ? `stroke ${i + 1}/${ink.length}` : 'stroke';
    trace(`${label}: pen ${candidate.penType}, ${pts.length} points`);
    // Its size, once. Measured in page px: a pen-up copy in the digitiser's
    // units (EMR, larger than any page) is scaled down first.
    const n = pts.length;
    const box = boundingBox(pts);
    const w = box.right - box.left;
    const h = box.bottom - box.top;
    const unit = penUpUnit(box, config);
    const span = n > 0 ? Math.max(w, h) / unit : 0;
    if (span < MIN_GESTURE_PX) {
      // A dot, a closed letter: no page rule could pass. (Keeps a
      // "wave check:" line, the first check, for the stroke history.)
      trace(
        `  wave check: too small for any gesture (~${Math.round(span)} px)`,
      );
      continue;
    }
    if (gestures.marginErase) {
      const wave = checkWave(pts, config.wave, false);
      if (
        'box' in wave ||
        (swappedWaveMayPass(n, w, h, config.wave) &&
          'box' in checkWave(swapAxes(pts), config.wave, false))
      ) {
        [gesture, points] = [candidate, pts];
        waveIndex = i;
        break;
      }
      trace(`  wave check: ${wave.reason}`);
    }
    if (gestures.loopSelect) {
      const loop = checkClosedLoop(
        pts,
        unit === 1 ? config.loop : loopFor(config.loop, unit),
      );
      if ('polygon' in loop) {
        [gesture, points, polygon] = [candidate, pts, loop.polygon];
        break;
      }
      trace(
        `  loop check: ${
          loop.reason === 'too small'
            ? `too small on the page (~${Math.round(
                Math.min(w, h) / unit,
              )} px, needs ${config.loop.minSize})`
            : loop.reason
        }`,
      );
    }
    const barOn = gestures.barSelect ?? true;
    const lineOn = gestures.lineSelect ?? true;
    if (!barOn && !lineOn) {
      continue;
    }
    // Long enough, so a dash, a "t" bar or an "l" never makes us read the
    // page. In page px, and turned back a quarter (the SDK's PointUtils:
    // page x and y are EMR y and x).
    const upright = unit === 1 ? pts : swapAxes(pts);
    if (barOn) {
      const bar = checkVerticalBar(upright, config.bar);
      const length = 'box' in bar ? (bar.box.bottom - bar.box.top) / unit : 0;
      if ('box' in bar && length >= config.barMinPenUpLength) {
        [gesture, points] = [candidate, pts];
        straight = {kind: 'bar', length, index: i};
        break;
      }
      trace(
        `  bar check: ${
          'box' in bar
            ? `too short (${Math.round(length)} px, needs ${
                config.barMinPenUpLength
              })`
            : bar.reason
        }`,
      );
    }
    if (lineOn) {
      const line = checkStraightLine(upright, config.straightLine);
      const length = 'from' in line ? distance(line.from, line.to) / unit : 0;
      if ('from' in line && length >= config.lineMinPenUpLength) {
        [gesture, points] = [candidate, pts];
        straight = {kind: 'line', length, index: i};
        break;
      }
      trace(
        `  line check: ${
          'from' in line
            ? `too short (${Math.round(length)} px, needs ${
                config.lineMinPenUpLength
              })`
            : line.reason
        }`,
      );
    }
  }
  if (ink.length > 1) {
    trace(
      `pen-up points: ${ink.length} strokes read together, ${readsDone} in ${
        readsDoneAt - readsFrom
      } ms`,
    );
  }
  if (!gesture) {
    return {kind: 'ignored', reason: 'not a gesture'};
  }
  const isStraight = straight !== null;
  trace(
    polygon
      ? 'shape: closed loop'
      : isStraight
      ? 'shape: line or bar'
      : 'shape: wave',
  );

  if (waveIndex >= 0 && waveIndex < ink.length - 1) {
    trace('wave: followed in the same burst (no page read)');
    return {kind: 'ignored', reason: 'wave followed by more writing'};
  }
  if (waveIndex >= 0 && host.penDownCount() !== downsAtStart) {
    trace('wave: pen down again (no page read)');
    return {kind: 'ignored', reason: 'kept writing after the wave'};
  }

  // A bar followed by more writing is ink (a brace and its label): the
  // page check would refuse it, so do not read the page for it.
  const barCandidate = straight?.kind === 'bar' ? straight : null;
  if (barCandidate && barCandidate.index < ink.length - 1) {
    // Later ink strokes in the same event are written after the bar.
    trace('bar: followed in the same burst (no page read)');
    return {kind: 'ignored', reason: 'bar followed by more writing'};
  }
  const keptWriting = () => {
    if (barCandidate && host.penDownCount() !== downsAtStart) {
      trace('bar: pen down again (no page read)');
      return true;
    }
    return false;
  };
  if (keptWriting()) {
    return {kind: 'ignored', reason: 'kept writing after the bar'};
  }

  const [path, pageNum] = await Promise.all([
    host.getCurrentFilePath(),
    host.getCurrentPageNum(),
  ]);
  if (!path || !/\.note$/i.test(path)) {
    return {kind: 'ignored', reason: 'only NOTE files are supported'};
  }
  // The pen-up element is not committed to the page yet, so its page fields
  // may be unset: ask the host which page is showing.
  const page = pageNum ?? gesture.pageNum;
  trace(`file: ${path.split('/').pop()}, page ${page}`);

  if (!(await host.ensureFileAccess())) {
    return {kind: 'failed', reason: 'file access not granted'};
  }

  // A line or a bar needs the page size anyway: read it now, before the
  // save, and refuse what is too short or too long for this page without
  // reading the page. (Not while saving: the save writes the file.)
  let size: Promise<PageSize | null> | undefined;
  if (straight) {
    const known = await readPageSize(host, path, page, trace);
    if (known) {
      const refused = preCheckStraight(straight, known, config);
      if (refused) {
        trace(
          `pre-check on page size ${known.width}x${known.height}: ${refused} (no page read)`,
        );
        return {kind: 'ignored', reason: refused};
      }
      size = Promise.resolve(known);
    }
    if (keptWriting()) {
      return {kind: 'ignored', reason: 'kept writing after the bar'};
    }
  }

  const readFrom = Date.now();
  // A selection left open (possibly one the user deleted from) is closed
  // before the page is saved and read.
  await host.closeLasso();
  const elements = await host.getPageElements(path, page);
  checkLastSelection(host, path, page, elements, trace);
  const resync = changedOutside(host, path, page, elements, trace);
  trace(
    `page elements: ${elements.length} (saved and read in ${
      Date.now() - readFrom
    } ms)`,
  );
  if (polygon) {
    // Needed once the loop is known to enclose something: read it while
    // the strokes are read.
    size = readPageSize(host, path, page, trace);
  }
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

  const ctx: Context = {
    host,
    config,
    path,
    page,
    stroke,
    others,
    isCancelled,
    trace,
    screenRefresh: gestures.screenRefresh ?? true,
    resync,
    size,
  };
  if (isStraight) {
    const line = checkStraightLine(stored, config.straightLine);
    if ('from' in line && (gestures.lineSelect ?? true)) {
      return selectBesideLine(ctx, stored, line, keepAlive);
    }
    const bar = checkVerticalBar(stored, config.bar);
    if ('box' in bar && (gestures.barSelect ?? true)) {
      return selectBesideBar(ctx, bar.box, downsAtStart);
    }
    return {
      kind: 'ignored',
      reason: `on the page, not a line (${
        'reason' in line ? line.reason : 'switched off'
      }) nor a bar (${'reason' in bar ? bar.reason : 'switched off'})`,
    };
  }
  if (polygon) {
    const pagePolygon = findClosedLoop(stored, config.loop);
    if (!pagePolygon) {
      return {kind: 'failed', reason: 'loop not recognised in page copy'};
    }
    return selectInLoop(ctx, pagePolygon);
  }

  const checked = checkWave(stored, config.wave);
  if ('reason' in checked) {
    // A wobbly line can pass for a wave until its size is known on the
    // page (a wave is at most 400 px wide): then it is tried as a line.
    const line =
      gestures.lineSelect ?? true
        ? checkStraightLine(stored, config.straightLine)
        : null;
    if (line && 'from' in line) {
      trace(`wave on the page: ${checked.reason}, trying a line`);
      return selectBesideLine(ctx, stored, line, keepAlive);
    }
    // Likewise a wobbly bar ("taller than wide" for a wave).
    const bar =
      gestures.barSelect ?? true ? checkVerticalBar(stored, config.bar) : null;
    if (bar && 'box' in bar) {
      trace(`wave on the page: ${checked.reason}, trying a bar`);
      return selectBesideBar(ctx, bar.box, downsAtStart);
    }
    return {kind: 'ignored', reason: `wave on the page: ${checked.reason}`};
  }
  const mark = checked.box;
  trace(
    `wave: ${Math.round(mark.right - mark.left)}×${Math.round(
      mark.bottom - mark.top,
    )} px`,
  );
  const erased = await eraseNextToMark(ctx, mark, downsAtStart);
  if (
    erased.kind !== 'ignored' ||
    erased.reason !== NO_WRITING ||
    !(gestures.lineSelect ?? true)
  ) {
    return erased;
  }
  // A wobbly line under 400 px can pass for a wave: with no writing level
  // with it, it is tried as a line. A wave beside writing is never affected.
  const line = checkStraightLine(stored, config.straightLine);
  if (!('from' in line)) {
    return erased;
  }
  trace('no writing next to the wave, trying a line');
  const selected = await selectBesideLine(ctx, stored, line, keepAlive);
  return selected.kind === 'ignored' &&
    selected.reason.startsWith('line too short')
    ? erased
    : selected;
}

/**
 * The pen-up copy's unit, in page px: 1, or the digitiser's (EMR) scale
 * when its coordinates (here: its bounding box) are larger than any page
 * can be.
 */
function penUpUnit(box: Box, config: SelectorConfig): number {
  return Math.max(box.right, box.bottom) > config.maxPagePx
    ? config.emrPerPx
    : 1;
}

/**
 * Pen-up sizes are compared with the page rules with this much slack (the
 * two copies may differ a little). Lower it if a device trace ever shows a
 * real loop refused as "too small on the page".
 */
const PEN_UP_SLACK = 0.9;

/**
 * Below this size, in page px, no gesture can pass on the page: 0.9 × the
 * smallest page rule (a wave is at least 20 px wide; a loop needs 30 px per
 * side, a line 168 px, a bar 100 px).
 */
const MIN_GESTURE_PX = 18;

let loopOptionsCache: {
  base: LoopOptions;
  unit: number;
  options: LoopOptions;
} | null = null;

/** Loop options for a pen-up copy in `unit`s: only the size rule scales. */
function loopFor(base: LoopOptions, unit: number): LoopOptions {
  if (loopOptionsCache?.base !== base || loopOptionsCache.unit !== unit) {
    loopOptionsCache = {
      base,
      unit,
      options: {...base, minSize: base.minSize * unit * PEN_UP_SLACK},
    };
  }
  return loopOptionsCache.options;
}

function swapAxes(points: Pt[]): Pt[] {
  return points.map(p => ({x: p.y, y: p.x}));
}

/**
 * Could `checkWave` pass on the copy with swapped axes? The same tests it
 * starts with, on the swapped box (width h, height w).
 */
function swappedWaveMayPass(
  n: number,
  w: number,
  h: number,
  wave: WaveOptions,
): boolean {
  return (
    n >= wave.minPoints &&
    !(h < wave.minAspect * w) &&
    !(w < wave.minFlatness * h)
  );
}

/**
 * A line or bar measured on the pen-up copy that the page's own rules
 * (selectBesideLine, selectBesideBar) would refuse on a page this size;
 * with some slack, and the page's rules taken on either side of the page.
 * Returns the refusal, in the page check's words, or null.
 */
function preCheckStraight(
  straight: {kind: 'line' | 'bar'; length: number},
  size: PageSize,
  config: SelectorConfig,
): string | null {
  const shortSide = Math.min(size.width, size.height);
  const longSide = Math.max(size.width, size.height);
  const length = straight.length;
  if (straight.kind === 'line') {
    const needed = Math.max(
      config.lineMinPenUpLength,
      config.lineMinWidthRatio * shortSide,
    );
    return length < PRE_CHECK_SHORT * needed
      ? `line too short (${Math.round(length)} px, needs ${Math.round(needed)})`
      : null;
  }
  const needed = Math.max(
    config.barMinPx,
    config.barMinHeightRatio * shortSide,
  );
  if (length < PRE_CHECK_SHORT * needed) {
    return `bar too short (${Math.round(length)} px, needs ${Math.round(
      needed,
    )})`;
  }
  if (length > PRE_CHECK_LONG * config.barMaxHeightRatio * longSide) {
    return 'bar too long (a page rule?)';
  }
  return null;
}

/** Slack of the pre-checks on the page size: 5 % either way. */
const PRE_CHECK_SHORT = 0.95;
const PRE_CHECK_LONG = 1.05;

/** Read the page size, tracing it. */
function readPageSize(
  host: Host,
  path: string,
  page: number,
  trace: (line: string) => void,
): Promise<PageSize | null> {
  const from = Date.now();
  const read = host.getPageSize(path, page).then(size => {
    trace(
      size
        ? `page size: read ${size.width}x${size.height} (${
            Date.now() - from
          } ms)`
        : 'page size: unavailable',
    );
    return size;
  });
  // Started ahead for a loop, it may not be awaited if the flow stops
  // early: never an unhandled rejection.
  read.catch(() => {});
  return read;
}

/** The page size: the one already read or being read, or read now. */
function pageSizeOf(ctx: Context): Promise<PageSize | null> {
  return ctx.size ?? readPageSize(ctx.host, ctx.path, ctx.page, ctx.trace);
}

function fmt(p: Pt | undefined): string {
  return p ? `(${Math.round(p.x)}, ${Math.round(p.y)})` : '(none)';
}

async function selectInLoop(ctx: Context, polygon: Pt[]): Promise<Outcome> {
  const {config} = ctx;
  // Selection is generous: the loop is grown outward a little, so strokes it
  // grazes or slightly cuts through still count.
  const area = growPolygon(polygon, config.loopMargin);
  const areaBox = boundingBox(area);
  // An element entirely outside the area's box has nothing inside it.
  const skipOutside = config.minInsideFraction > 0;
  const boxes: Box[] = [];
  for (const outline of await outlinesOf(ctx.others)) {
    if (outline.length === 0) {
      continue;
    }
    const box = boundingBox(outline);
    if (
      skipOutside &&
      (box.right < areaBox.left ||
        box.left > areaBox.right ||
        box.bottom < areaBox.top ||
        box.top > areaBox.bottom)
    ) {
      continue;
    }
    if (insideAtLeast(outline, area, config.minInsideFraction, areaBox)) {
      boxes.push(box);
    }
  }
  const enclosed = unionBoxes(boxes);
  ctx.trace(`enclosed: ${boxes.length} element(s)`);
  if (!enclosed) {
    // Plain drawing (an "O", a circle doodle): leave the ink alone.
    return {kind: 'ignored', reason: 'loop encloses nothing'};
  }

  const size = await pageSizeOf(ctx);
  if (!size) {
    return {kind: 'failed', reason: 'page size unavailable'};
  }

  const blocked = await checkBeforeEdit(ctx);
  if (blocked) {
    return blocked;
  }
  const rect = padAndClamp(enclosed, config.lassoPadding, size);
  const failed = await removeAndSelect(ctx, rect, 'loop stroke');
  return failed ?? {kind: 'selected', count: boxes.length, rect};
}

/**
 * Select the block of writing beside a margin bar: level with it, on its
 * one side, out to the first empty gutter. The bar is removed.
 */
async function selectBesideBar(
  ctx: Context,
  bar: Box,
  downsAtStart: number,
): Promise<Outcome> {
  const {host, config, stroke} = ctx;
  // The pen count only grows: once it changed, the outcome is decided.
  const keptWriting: Outcome = {
    kind: 'ignored',
    reason: 'kept writing after the bar',
  };
  if (host.penDownCount() !== downsAtStart) {
    return keptWriting;
  }
  const size = await pageSizeOf(ctx);
  if (!size) {
    return {kind: 'failed', reason: 'page size unavailable'};
  }
  const height = bar.bottom - bar.top;
  const minHeight = Math.max(
    config.barMinPx,
    config.barMinHeightRatio * size.height,
  );
  ctx.trace(`bar: ${Math.round(height)} px tall at x ${Math.round(bar.left)}`);
  if (height < minHeight) {
    return {
      kind: 'ignored',
      reason: `bar too short (${Math.round(height)} px, needs ${Math.round(
        minHeight,
      )})`,
    };
  }
  if (height > config.barMaxHeightRatio * size.height) {
    return {kind: 'ignored', reason: 'bar too long (a page rule?)'};
  }
  // Writing after the bar means it was ink (a brace and its label).
  if (
    ctx.others.some(e => e.type === STROKE && e.numInPage > stroke.numInPage)
  ) {
    return {kind: 'ignored', reason: 'bar followed by more writing'};
  }

  const outline = await stroke.outline();
  const outlines = await outlinesOf(ctx.others);
  if (host.penDownCount() !== downsAtStart) {
    return keptWriting;
  }
  const barBox = boundingBox(outline);
  const boxes: Box[] = [];
  for (let i = 0; i < outlines.length; i++) {
    const pts = outlines[i];
    if (pts.length === 0) {
      continue;
    }
    const box = boundingBox(pts);
    if (strokesTouch(outline, pts, config.eraseTouchTolerance, barBox, box)) {
      return {kind: 'ignored', reason: 'bar touches the writing'};
    }
    boxes.push(box);
  }
  const block = findBlockBesideBar(bar, boxes, size.width, config.block);
  if ('reason' in block) {
    return {kind: 'ignored', reason: block.reason};
  }
  const chosen = block.indices.map(i => boxes[i]);
  ctx.trace(`block on the ${block.side}: ${chosen.length} element(s)`);

  const blocked = await checkBeforeEdit(ctx);
  if (blocked) {
    return blocked;
  }
  if (host.penDownCount() !== downsAtStart) {
    return keptWriting;
  }
  // Stretched over where the bar was, so the device repaints that strip:
  // nothing level with the bar sits there.
  const union = unionBoxes(chosen)!;
  const stretched =
    block.side === 'right'
      ? {...union, left: Math.min(union.left, bar.left)}
      : {...union, right: Math.max(union.right, bar.right)};
  const rect = padAndClamp(stretched, config.lassoPadding, size);
  const failed = await removeAndSelect(ctx, rect, 'bar');
  return failed ?? {kind: 'selected', count: chosen.length, rect};
}

/**
 * Select everything above or below a separator line: the side with writing,
 * or the side the user picks when there is writing on both.
 */
async function selectBesideLine(
  ctx: Context,
  outline: Pt[],
  line: {from: Pt; to: Pt},
  keepAlive: () => void,
): Promise<Outcome> {
  const {host, config} = ctx;
  const size = await pageSizeOf(ctx);
  if (!size) {
    return {kind: 'failed', reason: 'page size unavailable'};
  }
  const length = line.to.x - line.from.x;
  ctx.trace(`line: ${Math.round(length)} px at y ${Math.round(line.from.y)}`);
  const minLength = config.lineMinWidthRatio * size.width;
  if (length < minLength) {
    return {
      kind: 'ignored',
      reason: `line too short (${Math.round(length)} px, needs ${Math.round(
        minLength,
      )})`,
    };
  }

  const lineY = (line.from.y + line.to.y) / 2;
  const lineBox = boundingBox(outline);
  const outlines = await outlinesOf(ctx.others);
  const above: Box[] = [];
  const below: Box[] = [];
  for (let i = 0; i < outlines.length; i++) {
    const pts = outlines[i];
    if (pts.length === 0) {
      continue;
    }
    const box = boundingBox(pts);
    if (strokesTouch(outline, pts, config.eraseTouchTolerance, lineBox, box)) {
      return {kind: 'ignored', reason: 'line crosses the writing'};
    }
    // Writing just above the line, in its span: an underline (drawn
    // further below the letters than writing comes above a separator).
    // Just below it, in its span: writing under a rule. Level with it,
    // beside it: a blank after a label ("Name: ___") or an arrow.
    const overlaps = box.right > lineBox.left && box.left < lineBox.right;
    const gap = Math.max(box.top - lineBox.bottom, lineBox.top - box.bottom);
    const clearance =
      overlaps && box.bottom <= lineBox.top
        ? config.lineUnderlineClearance
        : config.lineClearance;
    if (gap < clearance) {
      return {
        kind: 'ignored',
        reason: overlaps
          ? `writing ${Math.round(gap)} px from the line (an underline?)`
          : 'writing level with the line (a blank or an arrow?)',
      };
    }
    ((box.top + box.bottom) / 2 < lineY ? above : below).push(box);
  }
  ctx.trace(`above: ${above.length}, below: ${below.length}`);
  if (above.length === 0 && below.length === 0) {
    return {kind: 'ignored', reason: 'nothing above or below the line'};
  }

  let side: 'above' | 'below' | null;
  if (above.length === 0 || below.length === 0) {
    side = above.length > 0 ? 'above' : 'below';
  } else {
    if (ctx.isCancelled()) {
      return {kind: 'ignored', reason: 'page changed'};
    }
    side = await host.askAboveOrBelow();
    keepAlive();
    ctx.trace(`asked: ${side ?? 'no answer'}`);
    if (!side) {
      return {kind: 'ignored', reason: 'no side chosen'};
    }
  }
  const chosen = side === 'above' ? above : below;
  const enclosed = unionBoxes(chosen)!;

  const blocked = await checkBeforeEdit(ctx);
  if (blocked) {
    return blocked;
  }
  ctx.trace(`selecting ${side}`);
  const rect = padAndClamp(enclosed, config.lassoPadding, size);
  const failed = await removeAndSelect(ctx, rect, 'line');
  return failed ?? {kind: 'selected', count: chosen.length, rect};
}

/**
 * Erase the line of writing beside a margin wave (on whichever side the
 * writing is), the strokes
 * touching it (a "t" bar, a descender), and the mark.
 */
async function eraseNextToMark(
  ctx: Context,
  mark: Box,
  downsAtStart: number,
): Promise<Outcome> {
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
    const none = NO_WRITING;
    const reasons = [right, left].map(r => ('reason' in r ? r.reason : none));
    const tooClose = reasons.find(r => r.startsWith('wave too close'));
    const reason = reasons.every(r => r === none)
      ? none
      : tooClose ?? 'writing on both sides of the wave, or touching it';
    return {kind: 'ignored', reason};
  }
  ctx.trace(`erasing the line on its ${'indices' in right ? 'right' : 'left'}`);
  const row = line.indices.map(i => strokes[i]);
  ctx.trace(`line of writing: ${row.length} stroke(s)`);

  // Strokes touching the line: a "t" bar, a descender, connected letters.
  const erase = new Set(row);
  const tolerance = config.eraseTouchTolerance;
  const rowBox = unionBoxes(row.map(r => r.box))!;
  for (const s of strokes) {
    if (erase.has(s) || !overlapsWithin(s.box, rowBox, tolerance)) {
      continue;
    }
    if (
      row.some(
        r =>
          overlapsWithin(s.box, r.box, tolerance) &&
          strokesTouch(s.outline, r.outline, tolerance, s.box, r.box),
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
  // The pen touched the screen again: the wave was a letter ("m", "w")
  // and the word goes on.
  if (host.penDownCount() !== downsAtStart) {
    return {kind: 'ignored', reason: 'kept writing after the wave'};
  }
  const removed = await deleteVerified(ctx, [...erased, stroke]);
  if (!removed.deleted) {
    return {kind: 'failed', reason: 'could not erase strokes'};
  }
  forgetRemoved(ctx, [...erased, stroke]);
  await repaint(ctx, removed.fileClean);
  // After the reload: recycling the previous erase's strokes never goes
  // ahead of it.
  host.rememberErased(path, page, stroke.layerNum, erased);
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
  // Point count and first point: the targets' outlines are already read.
  const targetOutlines = await Promise.all(targets.map(e => e.outline()));
  const wanted = new Set(
    targetOutlines.map(pts => `${pts.length}@${fmt(pts[0])}`),
  );
  const wantedCounts = new Set(targetOutlines.map(pts => pts.length));
  const descending = (els: PageElement[]) =>
    els.map(e => e.numInPage).sort((a, b) => b - a);

  // Saves the page, then reads the file: what is still there. Only the
  // point counts are read, and the first point of strokes whose count
  // matches a target's.
  const stillThere = async () => {
    const same = (await host.getPageElements(path, page)).filter(
      e => e.type === STROKE && e.layerNum === stroke.layerNum,
    );
    const counts = await Promise.all(same.map(pointCountOf));
    let firstReads = 0;
    const signatures = await Promise.all(
      same.map(async (e, i) => {
        const count = counts[i];
        if (!wantedCounts.has(count)) {
          return null;
        }
        if (count === 0) {
          return `0@${fmt(undefined)}`;
        }
        firstReads++;
        return `${count}@${fmt(await firstPointOf(e))}`;
      }),
    );
    ctx.trace(
      `verify: ${same.length} strokes sized, ${firstReads} first points read`,
    );
    return same.filter((_, i) => {
      const signature = signatures[i];
      return signature !== null && wanted.has(signature);
    });
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
 * Diagnostic for deleted selections coming back: how many of the strokes
 * the last gesture selected on this page are still saved in the note. If
 * they were deleted with the lasso toolbar and are still saved, the device
 * did not keep that delete. Forgets the selection once checked.
 */
function checkLastSelection(
  host: Host,
  path: string,
  page: number,
  elements: PageElement[],
  trace: (line: string) => void,
): void {
  const last = host.lastSelection();
  if (!last || last.path !== path || last.page !== page) {
    return;
  }
  host.rememberSelection(null);
  const present = new Set(elements.map(e => e.uuid));
  const kept = last.uuids.filter(u => present.has(u)).length;
  trace(`last selection: ${kept} of ${last.uuids.length} still in the note`);
}

/**
 * Remove the gesture stroke (one delete, no reload: speed matters), then
 * lasso `rect`, and remember what was selected. Returns the failure, if any.
 */
async function removeAndSelect(
  ctx: Context,
  rect: Box,
  name: string,
): Promise<Outcome | null> {
  const {host, path, page, stroke} = ctx;
  if (!(await host.deleteElements([stroke.numInPage], page, stroke.layerNum))) {
    return {kind: 'failed', reason: `could not remove the ${name}`};
  }
  forgetRemoved(ctx, [stroke]);
  ctx.trace(`${name} removed`);
  ctx.trace(`lasso: ${rect.left},${rect.top} → ${rect.right},${rect.bottom}`);
  if (!(await host.lassoRect(rect))) {
    return {kind: 'failed', reason: 'could not create lasso selection'};
  }
  // What the lasso holds: the elements whose box meets it.
  const outlines = await outlinesOf(ctx.others);
  const uuids = ctx.others
    .filter((_, i) => {
      if (outlines[i].length === 0) {
        return false;
      }
      const b = boundingBox(outlines[i]);
      return (
        b.left <= rect.right &&
        b.right >= rect.left &&
        b.top <= rect.bottom &&
        b.bottom >= rect.top
      );
    })
    .map(e => e.uuid);
  host.rememberSelection({path, page, uuids});
  return null;
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

/** Most element outlines being read from the device at once. */
const READ_POOL = 64;

/**
 * The elements' outlines, in their order. Each read is a call to the
 * device, and waiting for them one by one is slow on a full page: up to
 * READ_POOL are in flight, and the next starts as soon as one finishes.
 */
export async function outlinesOf(elements: PageElement[]): Promise<Pt[][]> {
  const result: Pt[][] = new Array(elements.length);
  let next = 0;
  const worker = async () => {
    while (next < elements.length) {
      const i = next++;
      result[i] = await elements[i].outline();
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(READ_POOL, elements.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return result;
}

/** The element's point count, without reading its points if possible. */
function pointCountOf(e: PageElement): Promise<number> {
  return e.pointCount ? e.pointCount() : e.outline().then(pts => pts.length);
}

/** The element's first point, without reading the rest if possible. */
function firstPointOf(e: PageElement): Promise<Pt | undefined> {
  return e.firstPoint ? e.firstPoint() : e.outline().then(pts => pts[0]);
}

/** Last checks before the page is modified; returns why not to, if any. */
async function checkBeforeEdit(ctx: Context): Promise<Outcome | null> {
  // Editing the page while the pen is down drops the stroke being written.
  await ctx.host.waitForPenUp(ctx.config.penUpWaitMs);
  // The user may have turned the page or switched file while we worked, or
  // the caller may have given up on this stroke (timeout).
  if (ctx.isCancelled()) {
    return {kind: 'ignored', reason: 'page changed'};
  }
  const [path, page] = await Promise.all([
    ctx.host.getCurrentFilePath(),
    ctx.host.getCurrentPageNum(),
  ]);
  if (path !== ctx.path || page !== ctx.page) {
    return {kind: 'ignored', reason: 'page changed'};
  }
  if (ctx.resync) {
    // The file was just saved and read, so it is right: reloading makes
    // the device drop its stale copy before the plugin edits the page.
    if (!(await ctx.host.saveAndReload(ctx.path, ctx.page))) {
      return {kind: 'ignored', reason: 'could not reload the note first'};
    }
    ctx.trace('note reloaded before editing');
    ctx.resync = false;
  }
  return null;
}

/**
 * Were strokes removed from this page outside the plugin since its last
 * gesture (lasso delete, eraser)? Then remember the page as it is now.
 */
function changedOutside(
  host: Host,
  path: string,
  page: number,
  elements: PageElement[],
  trace: (line: string) => void,
): boolean {
  const last = host.lastPage();
  const now = elements.map(e => e.uuid);
  host.rememberPage({path, page, uuids: now});
  if (!last || last.path !== path || last.page !== page) {
    return false;
  }
  const present = new Set(now);
  const gone = last.uuids.filter(u => !present.has(u)).length;
  if (gone > 0) {
    trace(`page changed outside the plugin: ${gone} stroke(s) removed`);
  }
  return gone > 0;
}

/** The plugin removed these strokes: not a change made outside it. */
function forgetRemoved(ctx: Context, removed: PageElement[]): void {
  const last = ctx.host.lastPage();
  if (last) {
    const gone = new Set(removed.map(e => e.uuid));
    ctx.host.rememberPage({
      ...last,
      uuids: last.uuids.filter(u => !gone.has(u)),
    });
  }
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
  // Only the counts: the points are read for the match alone.
  const counts = await Promise.all(recent.map(pointCountOf));
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
