/**
 * `Host` implementation backed by sn-plugin-lib.
 */

import {
  NativeModules,
  TurboModuleRegistry,
  type TurboModule,
} from 'react-native';
import {
  ElementPointDataType,
  ElementPointOperationType,
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

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * How long the SDK calls made while handling one stroke took, for the
 * trace: wall-clock ms from Date.now() only (no timers).
 */
export class Timings {
  private calls = new Map<string, {count: number; ms: number}>();
  /** getPageElements calls: each a save and a whole page read. */
  pageReads = 0;
  /** Elements those reads returned. */
  elementsRead = 0;
  // Point reads: elements read, native calls, points, ms summed over the
  // calls (they run in parallel) and ms with at least one call in flight.
  private pointElements = 0;
  private pointCalls = 0;
  private points = 0;
  private pointMs = 0;
  private pointWallMs = 0;
  private inFlight = 0;
  private wallFrom = 0;

  add(name: string, ms: number): void {
    const stat = this.calls.get(name);
    if (stat) {
      stat.count++;
      stat.ms += ms;
    } else {
      this.calls.set(name, {count: 1, ms});
    }
  }

  /** Count an element whose points are read (once per element). */
  pointElement(): void {
    this.pointElements++;
  }

  /** Time one native point call; `count` gives how many points it returned. */
  async pointCall<T>(
    read: () => Promise<T>,
    count: (result: T) => number,
  ): Promise<T> {
    const from = Date.now();
    if (this.inFlight++ === 0) {
      this.wallFrom = from;
    }
    try {
      const result = await read();
      this.points += count(result);
      return result;
    } finally {
      const now = Date.now();
      this.pointCalls++;
      this.pointMs += now - from;
      if (--this.inFlight === 0) {
        this.pointWallMs += now - this.wallFrom;
      }
    }
  }

  /** One line for the end of the stroke's trace. Never contains "check:". */
  line(totalMs: number): string {
    const parts: string[] = [];
    for (const [name, stat] of this.calls) {
      let part = `${name} ${stat.ms}`;
      if (stat.count > 1) {
        part += ` (${stat.count} calls)`;
      }
      if (name === 'getElements') {
        part += ` (${this.elementsRead} el)`;
      }
      parts.push(part);
    }
    if (this.pointCalls > 0) {
      parts.push(
        `points: ${this.pointElements} elements, ${this.pointCalls} calls in ${
          this.pointWallMs
        } ms (${kilo(this.points)} pts, ${this.pointMs} ms summed)`,
      );
    }
    return `time: ${totalMs} ms in all; ${
      parts.length > 0 ? parts.join(', ') : 'no SDK calls'
    } (ms of parallel calls summed)`;
  }
}

function kilo(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

const FILE_PERMISSIONS = [
  'plugin.permission.FILE:READ',
  'plugin.permission.FILE:WRITE',
];
const FILE_PERMISSION_NAMES = ['READ', 'WRITE'];

/** hasPermission: 0 not granted, 1 this time only, 2 always. */
const ALWAYS_ALLOWED = 2;

const TOOL_PEN = 2;
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;
const ACTION_CANCEL = 3;

/** How many undone strokes redo can put back. */
const MAX_UNDONE = 20;

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
  private downs = 0;
  private lastDownAt = 0;
  private lastEventAt = 0;
  private waiters: {since: number; maxWaitMs: number; resolve: () => void}[] =
    [];
  private listener: ((event: MotionEvent | null | undefined) => void) | null =
    null;

  /** Also pass every motion event (pen and finger) to `listener`. */
  onEvent(listener: (event: MotionEvent | null | undefined) => void): void {
    this.listener = listener;
  }

  /** Listen for the whole session: down state and quietSince need it. */
  start(): void {
    PluginManager.registerMotionListener(1, {
      onMsg: (msg: unknown) => this.onMotion(msg as MotionEvent | null),
    });
  }

  private onMotion(event: MotionEvent | null | undefined): void {
    if (this.listener) {
      try {
        this.listener(event);
      } catch {}
    }
    if (event?.toolType !== TOOL_PEN) {
      return;
    }
    const action = event.action;
    // Hover (7, 9, 10) and anything else that is not a touch: the pen is
    // not on the screen, and nothing written.
    if (
      action !== ACTION_DOWN &&
      action !== ACTION_UP &&
      action !== ACTION_MOVE &&
      action !== ACTION_CANCEL
    ) {
      return;
    }
    const now = Date.now();
    this.lastEventAt = now;
    if (action === ACTION_DOWN) {
      this.down = true;
      this.downs++;
      this.lastDownAt = Date.now();
    } else if (action === ACTION_UP || action === ACTION_CANCEL) {
      this.down = false;
    }
    if (this.waiters.length > 0) {
      this.wakeWaiters(now);
    }
  }

  private isUp(now: number): boolean {
    return !this.down || now - this.lastEventAt > PEN_STALE_MS;
  }

  private wakeWaiters(now: number): void {
    this.waiters = this.waiters.filter(w => {
      if (this.isUp(now) || now - w.since > w.maxWaitMs) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  /** How many times the pen has touched the screen so far. */
  downCount(): number {
    return this.downs;
  }

  /**
   * Has the pen stayed off the screen since `time` (Date.now() ms)? Only
   * touching counts: hovering writes nothing (and hover events would
   * otherwise block a reload whenever the pen is near the screen).
   */
  quietSince(time: number): boolean {
    return this.isUp(Date.now()) && this.lastDownAt < time;
  }

  waitForUp(maxWaitMs: number): Promise<void> {
    const now = Date.now();
    if (this.isUp(now)) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.waiters.push({since: now, maxWaitMs, resolve});
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

interface Accessor<T> {
  size(): Promise<number>;
  getRange(start: number, count: number): Promise<T[]>;
}

/** All items of an SDK accessor (size, then one range read). */
async function readAll<T>(
  accessor: Accessor<T> | null | undefined,
  timings: Timings,
): Promise<T[]> {
  if (!accessor) {
    return [];
  }
  const size = await timings.pointCall(
    () => accessor.size(),
    () => 0,
  );
  return size > 0
    ? timings.pointCall(
        () => accessor.getRange(0, size),
        items => items?.length ?? 0,
      )
    : [];
}

/** Points that describe where an element sits on the page (SDK accessors). */
async function outlineOf(e: Element, timings: Timings): Promise<Pt[]> {
  if (e.stroke) {
    return readAll<Pt>(e.stroke.points, timings);
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
  const contours = await readAll<Pt[]>(e.contoursSrc, timings);
  return contours.flat();
}

/** The native call behind the SDK's ElementDataAccessor. */
export interface PointApi {
  opElementPointData(
    uuid: string,
    type: number,
    opType: number,
    index: number[],
    subIndex: number[],
    newValues: object[],
  ): Promise<unknown>;
}

/** The native module the SDK registers (NativePluginAPI.ts), if any. */
function nativePointApi(): PointApi | null {
  try {
    const api = (TurboModuleRegistry.get<TurboModule>('NativePluginAPI') ??
      NativeModules?.NativePluginAPI) as unknown as PointApi | null;
    return api && typeof api.opElementPointData === 'function' ? api : null;
  } catch {
    return null;
  }
}

/** The SDK's ids for reading stroke sample points (read-only ops only). */
function pointOps(): {sample: number; size: number; byIndex: number} | null {
  const sample = ElementPointDataType?.STROKE_SAMPLE_POINT;
  const size = ElementPointOperationType?.GET_LIST_SIZE;
  const byIndex = ElementPointOperationType?.GET_POINT_BY_INDEX;
  return typeof sample === 'number' &&
    typeof size === 'number' &&
    typeof byIndex === 'number'
    ? {sample, size, byIndex}
    : null;
}

type Direct<T> = {ok: true; value: T} | {ok: false; reason: string};

/** Bad results in a row after which direct reads stop for the session. */
const MAX_STRIKES = 3;

function isPointList(data: unknown, n: number): data is Pt[] {
  if (!Array.isArray(data) || data.length !== n) {
    return false;
  }
  for (const p of data) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') {
      return false;
    }
  }
  return true;
}

/**
 * Stroke sample points read straight from the native module: the same two
 * read-only calls the SDK's accessor makes (list size, then a range), without
 * its per-point cache and checks. Not documented, so every result is checked
 * and anything unexpected falls back to the accessor; after MAX_STRIKES bad
 * results in a row it is turned off (a good result of the same call resets
 * its count; the off switch lasts for the session). A null result (the stroke is no longer
 * cached natively) falls back without counting against it.
 *
 * Re-verify after any sn-plugin-lib or firmware upgrade.
 */
export class DirectPointReader {
  // Bad results in a row, per call (a broken range read must not hide
  // behind good size reads).
  private strikes = {size: 0, range: 0};
  private off: string | null;
  private readonly ops = pointOps();

  constructor(private readonly api: PointApi | null) {
    this.off = !api
      ? 'no native module'
      : !this.ops
      ? 'no point op ids in the SDK'
      : null;
  }

  /** Why direct reads are off, or null while they are on. */
  disabledReason(): string | null {
    return this.off;
  }

  private strike(op: 'size' | 'range', reason: string): Direct<never> {
    if (++this.strikes[op] >= MAX_STRIKES) {
      this.off = `turned off after ${MAX_STRIKES} bad results (${reason})`;
    }
    return {ok: false, reason};
  }

  private call(
    uuid: string,
    opType: number,
    index: number[],
    timings: Timings,
  ): Promise<unknown> {
    return timings.pointCall(
      () =>
        this.api!.opElementPointData(
          uuid,
          this.ops!.sample,
          opType,
          index,
          [],
          [],
        ),
      result => (Array.isArray(result) ? result.length : 0),
    );
  }

  /** How many sample points the stroke has (0 for none). */
  async count(uuid: string, timings: Timings): Promise<Direct<number>> {
    if (this.off) {
      return {ok: false, reason: this.off};
    }
    let n: unknown;
    try {
      n = await this.call(uuid, this.ops!.size, [], timings);
    } catch (e) {
      return this.strike('size', `size threw: ${message(e)}`);
    }
    if (n === null || n === undefined) {
      return {ok: false, reason: 'size: no result'};
    }
    if (typeof n !== 'number') {
      return this.strike('size', `size gave a ${typeof n}`);
    }
    this.strikes.size = 0;
    // As the SDK: anything but a positive count reads as no points.
    return {ok: true, value: Number.isInteger(n) && n > 0 ? n : 0};
  }

  /** The first `n` sample points (n ≥ 1, at most the stroke's count). */
  async range(
    uuid: string,
    n: number,
    timings: Timings,
  ): Promise<Direct<Pt[]>> {
    if (this.off) {
      return {ok: false, reason: this.off};
    }
    let data: unknown;
    try {
      data = await this.call(uuid, this.ops!.byIndex, [0, n - 1], timings);
    } catch (e) {
      return this.strike('range', `points threw: ${message(e)}`);
    }
    if (data === null || data === undefined) {
      return {ok: false, reason: 'points: no result'};
    }
    if (!isPointList(data, n)) {
      return this.strike(
        'range',
        `points: ${
          Array.isArray(data) ? `${data.length} of ${n}` : typeof data
        }`,
      );
    }
    this.strikes.range = 0;
    return {ok: true, value: data};
  }
}

/** Free native element caches, once per uuid. */
function recycleAll(elements: (Element | null | undefined)[]): void {
  const seen = new Set<string>();
  for (const e of elements) {
    const uuid = e?.uuid;
    if (!uuid || seen.has(uuid)) {
      continue;
    }
    seen.add(uuid);
    try {
      // Elements from the bridge are plain objects: no recycle() method.
      PluginCommAPI.recycleElement(uuid);
    } catch {}
  }
}

const PERMISSION_REASON =
  'LasEr needs file access to remove gesture strokes, select what a loop encloses, what lies above or below a line or beside a margin bar, and erase a line of writing next to a margin wave.';

function granted(state: unknown): boolean {
  return typeof state === 'number' && state >= 1;
}

/**
 * Check FILE:READ and FILE:WRITE together, then ask for any not granted,
 * one at a time. `always` when both were already granted for good.
 */
async function checkFileAccess(
  trace: Trace,
  time: <T>(name: string, run: () => Promise<T>) => Promise<T> = (_, run) =>
    run(),
): Promise<{granted: boolean; always: boolean}> {
  const states = await Promise.all(
    FILE_PERMISSIONS.map(p =>
      time('hasPermission', () => PluginManager.hasPermission(p)),
    ),
  );
  trace(
    `file access: ${FILE_PERMISSION_NAMES.map(
      (name, i) => `${name}=${String(states[i])}`,
    ).join(' ')}`,
  );
  for (let i = 0; i < FILE_PERMISSIONS.length; i++) {
    if (granted(states[i])) {
      continue;
    }
    const choice = await time('requestPermission', () =>
      PluginManager.requestPermission(FILE_PERMISSIONS[i], PERMISSION_REASON),
    );
    if (choice !== 1 && choice !== 2) {
      return {granted: false, always: false};
    }
  }
  return {
    granted: true,
    always: states.every(state => state === ALWAYS_ALLOWED),
  };
}

/**
 * Make sure FILE:READ and FILE:WRITE are granted, asking the user if needed.
 * Never cached (the plugin screen's button).
 */
export async function ensureFileAccess(): Promise<boolean> {
  try {
    return (await checkFileAccess(() => {})).granted;
  } catch {
    return false;
  }
}

interface ErasedStrokes {
  path: string;
  page: number;
  layer: number;
  elements: Element[];
}

export interface DeviceHost extends Host {
  /**
   * Where SDK failures are reported while handling a stroke. Also starts
   * that stroke's timings.
   */
  setTrace(trace: Trace): void;
  /** Wrap SDK elements so they are tracked and released with the others. */
  wrap(elements: Element[]): PageElement[];
  /** Put the strokes from the last margin-wave erase back. Returns a message. */
  restoreLastErase(): Promise<string>;
  /** The stroke's "time:" trace line. */
  timeLine(totalMs: number): string;
  /** Did handling the stroke read the page (save and getElements)? */
  pageWasRead(): boolean;
}

const STROKE = 0;

/** The SDK element behind each PageElement, for write calls and recycling. */
const rawElements = new WeakMap<PageElement, Element>();

export function createHost(
  pen: PenTracker,
  deps: {pointApi?: PointApi | null} = {},
): DeviceHost {
  // Elements read while handling the current stroke; freed in release().
  let fetched: Element[] = [];
  // Strokes removed by the floating button's undo, newest last, for redo.
  let undone: {path: string; page: number; layer: number; element: Element}[] =
    [];
  // Strokes removed by the last margin-wave erase, kept in the native cache so
  // insertPageElements can put them back.
  let erased: ErasedStrokes | null = null;
  // The erase being restored: still needed by insertPageElements.
  let restoring: ErasedStrokes | null = null;

  let trace: Trace = () => {};
  let timings = new Timings();
  // Which way points were read for this stroke, traced once each.
  let tracedDirect = false;
  let tracedFallback = false;
  // When the note was last saved, for reloadIfQuiet.
  let savedAt = 0;
  // Both file permissions were "always allow" at the last check: no need to
  // ask again until a file call fails.
  let fileAccessOk = false;

  const reader = new DirectPointReader(
    deps.pointApi !== undefined ? deps.pointApi : nativePointApi(),
  );

  const time = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const t = timings;
    const from = Date.now();
    try {
      return await run();
    } finally {
      t.add(name, Date.now() - from);
    }
  };

  /** Run an SDK call, unwrapping its APIResponse and tracing failures. */
  const request = async <T>(
    name: string,
    run: () => Promise<unknown>,
  ): Promise<{ok: boolean; result: T | null}> => {
    try {
      const r = (await time(name, run)) as Response<T> | null | undefined;
      if (r?.success) {
        return {ok: true, result: r.result ?? null};
      }
      trace(
        `${name} failed: ${r?.error?.message ?? 'no result'} (code ${
          r?.error?.code ?? '?'
        })`,
      );
    } catch (e) {
      trace(`${name} threw: ${message(e)}`);
    }
    return {ok: false, result: null};
  };

  const call = async <T>(name: string, run: () => Promise<unknown>) =>
    (await request<T>(name, run)).result;

  /** A file call failed: check the permissions again next time. */
  const fileCallFailed = (name: string) => {
    if (fileAccessOk) {
      fileAccessOk = false;
      trace(`file access cache cleared after ${name} failed`);
    }
  };

  const notePointsPath = (fallback: string | null) => {
    if (fallback === null) {
      if (!tracedDirect) {
        tracedDirect = true;
        trace('points: direct');
      }
    } else if (!tracedFallback) {
      tracedFallback = true;
      trace(`points: SDK accessor (fallback: ${fallback})`);
    }
  };

  const toPageElement = (e: Element): PageElement => {
    // Stroke sample points: read directly when possible.
    const accessor: Accessor<Pt> | null =
      e.type === STROKE && e.stroke ? e.stroke.points : null;
    let count: Promise<number> | null = null;
    let first: Promise<Pt | undefined> | null = null;
    let outline: Promise<Pt[]> | null = null;
    let counted = false;
    const touch = () => {
      if (!counted) {
        counted = true;
        timings.pointElement();
      }
    };

    // Whether the count came from the accessor (which then has it).
    let countedByAccessor = false;
    // The accessor's size threw: the count is unknown, not zero.
    let countFailed = false;
    const readCount = async (): Promise<number> => {
      touch();
      const direct = await reader.count(e.uuid, timings);
      if (direct.ok) {
        notePointsPath(null);
        return direct.value;
      }
      countedByAccessor = true;
      notePointsPath(direct.reason);
      return Math.max(
        0,
        await timings.pointCall(
          () => accessor!.size(),
          () => 0,
        ),
      );
    };

    const readOutline = async (): Promise<Pt[]> => {
      touch();
      if (!accessor) {
        return outlineOf(e, timings);
      }
      const n = await pointCount();
      if (n === 0) {
        // An unknown count gets the accessor's full read (it asks again).
        return countFailed ? readAll(accessor, timings) : [];
      }
      const direct = await reader.range(e.uuid, n, timings);
      if (direct.ok) {
        notePointsPath(null);
        return direct.value;
      }
      notePointsPath(direct.reason);
      // The accessor's own read: its size, then the range (its size is
      // already known when it gave the count).
      return countedByAccessor
        ? timings.pointCall(
            () => accessor.getRange(0, n),
            items => items?.length ?? 0,
          )
        : readAll(accessor, timings);
    };

    const readFirst = async (): Promise<Pt | undefined> => {
      touch();
      const direct = await reader.range(e.uuid, 1, timings);
      if (direct.ok) {
        notePointsPath(null);
        return direct.value[0];
      }
      notePointsPath(direct.reason);
      const head = await timings.pointCall(
        () => accessor!.getRange(0, 1),
        items => items?.length ?? 0,
      );
      return head?.[0];
    };

    const pointCount = (): Promise<number> =>
      (count ??= accessor
        ? readCount().catch(() => {
            countFailed = true;
            countedByAccessor = false;
            return 0;
          })
        : getOutline().then(pts => pts.length));
    const getOutline = (): Promise<Pt[]> =>
      (outline ??= readOutline().catch(() => []));
    const firstPoint = (): Promise<Pt | undefined> =>
      (first ??=
        accessor && !outline
          ? readFirst().catch(() => undefined)
          : getOutline().then(pts => pts[0]));

    const wrapped: PageElement = {
      uuid: e.uuid,
      type: e.type,
      numInPage: e.numInPage,
      pageNum: e.pageNum,
      layerNum: e.layerNum,
      penType: e.stroke ? e.stroke.penType : null,
      outline: getOutline,
      pointCount,
      firstPoint,
    };
    rawElements.set(wrapped, e);
    return wrapped;
  };

  const wrap = (elements: Element[]) => {
    const kept: Element[] = [];
    for (const e of elements) {
      if (e) {
        fetched.push(e);
        kept.push(e);
      }
    }
    return kept.map(toPageElement);
  };

  return {
    wrap,

    setTrace(t) {
      trace = t;
      timings = new Timings();
      tracedDirect = false;
      tracedFallback = false;
    },

    timeLine(totalMs) {
      return timings.line(totalMs);
    },

    pageWasRead() {
      return timings.pageReads > 0;
    },

    getCurrentFilePath() {
      return call<string>('getCurrentFilePath', () =>
        PluginCommAPI.getCurrentFilePath(),
      );
    },

    getCurrentPageNum() {
      return call<number>('getCurrentPageNum', () =>
        PluginCommAPI.getCurrentPageNum(),
      );
    },

    getPageSize(path, page) {
      return call<{width: number; height: number}>('getPageSize', () =>
        PluginFileAPI.getPageSize(path, page),
      );
    },

    async getPageElements(path, page) {
      timings.pageReads++;
      // getElements reads the note file: save first so it contains the
      // stroke that was just drawn.
      savedAt = Date.now();
      const saved = await request('saveCurrentNote', () =>
        PluginNoteAPI.saveCurrentNote(),
      );
      if (!saved.ok) {
        fileCallFailed('saveCurrentNote');
      }
      const read = await request<Element[]>('getElements', () =>
        PluginFileAPI.getElements(page, path),
      );
      if (!read.ok) {
        fileCallFailed('getElements');
      }
      const elements = Array.isArray(read.result) ? read.result : [];
      timings.elementsRead += elements.length;
      return wrap(elements);
    },

    async ensureFileAccess() {
      if (fileAccessOk) {
        trace('file access: cached');
        return true;
      }
      try {
        const access = await checkFileAccess(trace, time);
        fileAccessOk = access.granted && access.always;
        return access.granted;
      } catch (e) {
        trace(`file access check threw: ${message(e)}`);
        return false;
      }
    },

    waitForPenUp(maxWaitMs) {
      return pen.waitForUp(maxWaitMs);
    },

    async deleteElements(numsInPage, page, layer) {
      const ok = await call<boolean>('deletePageElements', () =>
        PluginCommAPI.deletePageElements(numsInPage, page, layer),
      );
      if (ok !== true) {
        fileCallFailed('deletePageElements');
      }
      return ok === true;
    },

    rememberErased(path, page, layer, elements) {
      const previous = erased;
      const raw = elements
        .map(e => rawElements.get(e))
        .filter((e): e is Element => e !== undefined);
      erased = {path, page, layer, elements: raw};
      if (previous) {
        const keep = new Set(raw.map(e => e.uuid));
        recycleAll(previous.elements.filter(e => !keep.has(e.uuid)));
      }
    },

    async restoreLastErase() {
      const target = erased;
      if (!target) {
        return 'Nothing to restore.';
      }
      // Taken now, so a second tap meanwhile finds nothing to restore.
      erased = null;
      restoring = target;
      const putBack = () => {
        restoring = null;
        if (erased === null) {
          erased = target;
        } else {
          recycleAll(target.elements); // a newer erase replaced it
        }
      };
      let done = false;
      try {
        if ((await this.getCurrentFilePath()) !== target.path) {
          return 'Open the note the strokes were erased from, then try again.';
        }
        const {page, layer, elements} = target;
        const ok = await call<boolean>('insertPageElements', () =>
          PluginCommAPI.insertPageElements(elements, page, layer),
        );
        if (ok !== true) {
          fileCallFailed('insertPageElements');
          return 'Could not restore the erased strokes.';
        }
        done = true;
        restoring = null;
        recycleAll(elements);
        return `Restored ${elements.length} strokes on page ${page + 1}.`;
      } finally {
        if (!done) {
          putBack(); // also on a throw: the strokes stay restorable
        }
      }
    },

    keepUndone(path, page, layer, element) {
      const raw = rawElements.get(element);
      if (!raw) {
        return;
      }
      undone.push({path, page, layer, element: raw});
      // A bounded history: the oldest is freed.
      while (undone.length > MAX_UNDONE) {
        recycleAll([undone.shift()!.element]);
      }
    },

    async redo() {
      const last = undone.pop();
      if (!last) {
        return 'Nothing to redo.';
      }
      if ((await this.getCurrentFilePath()) !== last.path) {
        undone.push(last);
        return 'Open the note the stroke was undone in, then try again.';
      }
      const ok = await call<boolean>('insertPageElements', () =>
        PluginCommAPI.insertPageElements([last.element], last.page, last.layer),
      );
      if (ok !== true) {
        undone.push(last);
        fileCallFailed('insertPageElements');
        return 'Could not redo the stroke.';
      }
      recycleAll([last.element]);
      return 'Redone.';
    },

    clearRedo() {
      if (undone.length > 0) {
        recycleAll(undone.map(u => u.element));
        undone = [];
      }
    },

    async reloadIfQuiet() {
      // Anything written since the last save would be lost by the reload.
      if (!pen.quietSince(savedAt)) {
        return false;
      }
      const reloaded = await call<unknown>('reloadFile', () =>
        PluginCommAPI.reloadFile(),
      );
      const ok = reloaded !== null && reloaded !== false;
      if (!ok) {
        fileCallFailed('reloadFile');
      }
      return ok;
    },

    async lassoUuids() {
      const held = await call<Element[]>('getLassoElements', () =>
        PluginCommAPI.getLassoElements(),
      );
      if (!Array.isArray(held)) {
        return null;
      }
      // Tracked so they are freed with the others.
      return wrap(held).map(e => e.uuid);
    },

    async lassoBox() {
      const r = await call<Box>('getLassoRect', () =>
        PluginCommAPI.getLassoRect(),
      );
      return r && r.right > r.left && r.bottom > r.top ? r : null;
    },

    async resetLasso() {
      return this.setLassoBox('remove');
    },

    async setLassoBox(state) {
      const code = {show: 0, hide: 1, remove: 2}[state];
      const r = await call<boolean>('setLassoBoxState', () =>
        PluginCommAPI.setLassoBoxState(code),
      );
      return r === true ? 'ok' : 'failed';
    },

    penDownCount() {
      return pen.downCount();
    },

    async lassoRect(rect: Box) {
      const ok = await call<boolean>('lassoElements', () =>
        PluginCommAPI.lassoElements(rect),
      );
      if (ok !== true) {
        fileCallFailed('lassoElements');
      }
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
        trace(`dialog threw: ${message(e)}`);
        return null;
      }
    },

    release(pendingUuids = []) {
      // Swapped out first: elements wrapped from here on are not freed.
      const old = fetched;
      fetched = [];
      const keep = new Set<string>(pendingUuids);
      for (const kept of [erased, restoring]) {
        for (const e of kept?.elements ?? []) {
          keep.add(e.uuid);
        }
      }
      for (const u of undone) {
        keep.add(u.element.uuid);
      }
      recycleAll(old.filter(e => !keep.has(e.uuid)));
    },
  };
}
