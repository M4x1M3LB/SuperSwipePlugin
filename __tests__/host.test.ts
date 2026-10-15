/**
 * The device host against plain SDK-shaped objects, as the bridge delivers
 * them (no Element prototype, so no recycle() method).
 */
const mockRecycle = jest.fn();
const mockInsert = jest.fn();
const mockCurrentPath = jest.fn();
const mockHasPermission = jest.fn();
const mockRequestPermission = jest.fn();
const mockSave = jest.fn();
const mockGetElements = jest.fn();
const mockGetLassoRect = jest.fn();
const mockSetLassoBoxState = jest.fn();
const mockDeleteLasso = jest.fn();
const mockReload = jest.fn();

jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    registerMotionListener: () => {},
    hasPermission: (p: string) => mockHasPermission(p),
    requestPermission: (p: string, d: string) => mockRequestPermission(p, d),
  },
  PluginCommAPI: {
    recycleElement: (uuid: string) => mockRecycle(uuid),
    getCurrentFilePath: () => mockCurrentPath(),
    insertPageElements: (...args: unknown[]) => mockInsert(...args),
    getLassoRect: () => mockGetLassoRect(),
    setLassoBoxState: (state: number) => mockSetLassoBoxState(state),
    deleteLassoElements: () => mockDeleteLasso(),
    reloadFile: () => mockReload(),
  },
  PluginFileAPI: {
    getElements: (...args: unknown[]) => mockGetElements(...args),
  },
  PluginNoteAPI: {saveCurrentNote: () => mockSave()},
  NativeUIUtils: {},
  ElementPointDataType: {STROKE_SAMPLE_POINT: 2},
  ElementPointOperationType: {GET_LIST_SIZE: 0, GET_POINT_BY_INDEX: 2},
}));

import type {Element} from 'sn-plugin-lib';
import type {Pt} from '../src/geometry';
import {
  DirectPointReader,
  PenTracker,
  Timings,
  createHost,
  type PointApi,
} from '../src/host';

const ok = <T>(result: T) => ({success: true, result});

/** A stroke as getElements or event_pen_up deliver it. */
function sdkStroke(uuid: string, points: Pt[] = [{x: 1, y: 2}]) {
  const accessor = {
    size: jest.fn(async () => (points.length > 0 ? points.length : -1)),
    getRange: jest.fn(async (start: number, count: number) =>
      points.slice(start, start + count),
    ),
  };
  const element = {
    uuid,
    type: 0,
    numInPage: 1,
    pageNum: 0,
    layerNum: 0,
    stroke: {penType: 10, points: accessor},
  } as unknown as Element;
  return {element, accessor};
}

const strokes = (...uuids: string[]) => uuids.map(u => sdkStroke(u).element);

beforeEach(() => {
  jest.clearAllMocks();
  mockRecycle.mockImplementation(() => {});
});

describe('release', () => {
  it('frees each element once by uuid, keeping erased and pending strokes', () => {
    const host = createHost(new PenTracker(), {pointApi: null});
    const [, b] = host.wrap(strokes('a', 'b', 'c', 'd'));
    host.wrap(strokes('a')); // read again: the same native element
    host.rememberErased('/n.note', 0, 0, [b]);

    expect(() => host.release(['c'])).not.toThrow();
    expect(mockRecycle.mock.calls).toEqual([['a'], ['d']]);

    // Nothing left to free.
    host.release();
    expect(mockRecycle).toHaveBeenCalledTimes(2);
  });

  it('never throws, even when the native call does', () => {
    mockRecycle.mockImplementation(() => {
      throw new Error('native');
    });
    const host = createHost(new PenTracker(), {pointApi: null});
    host.wrap(strokes('a', 'b'));
    expect(() => host.release()).not.toThrow();
    expect(mockRecycle).toHaveBeenCalledTimes(2);
  });

  it('frees the previous erase when a new one is remembered', () => {
    const host = createHost(new PenTracker(), {pointApi: null});
    const [a, b] = host.wrap(strokes('a', 'b'));
    host.rememberErased('/n.note', 0, 0, [a]);
    expect(() => host.rememberErased('/n.note', 0, 0, [b])).not.toThrow();
    expect(mockRecycle.mock.calls).toEqual([['a']]);
  });

  it('restores once, then has nothing left to restore', async () => {
    mockCurrentPath.mockResolvedValue(ok('/n.note'));
    mockInsert.mockResolvedValue(ok(true));
    const host = createHost(new PenTracker(), {pointApi: null});
    const [a] = host.wrap(strokes('a'));
    host.rememberErased('/n.note', 2, 0, [a]);
    host.release();
    expect(mockRecycle).not.toHaveBeenCalled(); // kept for the restore

    expect(await host.restoreLastErase()).toBe('Restored 1 strokes on page 3.');
    expect(await host.restoreLastErase()).toBe('Nothing to restore.');
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockRecycle.mock.calls).toEqual([['a']]);
  });

  it('keeps the strokes being restored when a stroke ends meanwhile', async () => {
    let answer!: (v: unknown) => void;
    mockCurrentPath.mockReturnValue(new Promise(r => (answer = r)));
    mockInsert.mockResolvedValue(ok(true));
    const host = createHost(new PenTracker(), {pointApi: null});
    const [a] = host.wrap(strokes('a'));
    host.rememberErased('/n.note', 0, 0, [a]);

    const restored = host.restoreLastErase();
    host.release(); // the erase's own stroke ends now
    expect(mockRecycle).not.toHaveBeenCalled();
    answer(ok('/n.note'));
    expect(await restored).toBe('Restored 1 strokes on page 1.');
    expect(mockRecycle.mock.calls).toEqual([['a']]);
  });

  it('keeps the erase when reading the file path throws', async () => {
    mockCurrentPath.mockRejectedValueOnce(new Error('native'));
    mockInsert.mockResolvedValue(ok(true));
    const host = createHost(new PenTracker(), {pointApi: null});
    const [a] = host.wrap(strokes('a'));
    host.rememberErased('/n.note', 0, 0, [a]);
    await host.restoreLastErase().catch(() => {});
    mockCurrentPath.mockResolvedValue(ok('/n.note'));
    expect(await host.restoreLastErase()).toBe('Restored 1 strokes on page 1.');
  });

  it('keeps the erase when the restore fails', async () => {
    mockCurrentPath.mockResolvedValue(ok('/n.note'));
    mockInsert.mockResolvedValue({
      success: false,
      error: {code: 1, message: 'x'},
    });
    const host = createHost(new PenTracker(), {pointApi: null});
    const [a] = host.wrap(strokes('a'));
    host.rememberErased('/n.note', 0, 0, [a]);

    expect(await host.restoreLastErase()).toBe(
      'Could not restore the erased strokes.',
    );
    mockInsert.mockResolvedValue(ok(true));
    expect(await host.restoreLastErase()).toBe('Restored 1 strokes on page 1.');
  });
});

describe('save and reload', () => {
  it('saves, reads the page back, then reloads', async () => {
    const order: string[] = [];
    mockSave.mockImplementationOnce(async () => {
      order.push('save');
      return ok(true);
    });
    mockGetElements.mockImplementationOnce(async () => {
      order.push('read');
      return ok([]);
    });
    mockReload.mockImplementationOnce(async () => {
      order.push('reload');
      return ok(true);
    });
    const host = createHost(new PenTracker(), {pointApi: null});
    expect(await host.saveAndReload('/n.note', 2)).toBe(true);
    expect(order).toEqual(['save', 'read', 'reload']);
  });
});

describe('lasso', () => {
  it('closes a lasso box left open, and only then', async () => {
    const host = createHost(new PenTracker(), {pointApi: null});
    mockGetLassoRect.mockResolvedValueOnce(
      ok({left: 10, top: 10, right: 200, bottom: 90}),
    );
    mockSetLassoBoxState.mockResolvedValue(ok(true));
    await host.closeLasso();
    expect(mockSetLassoBoxState.mock.calls).toEqual([[2]]);

    mockGetLassoRect.mockResolvedValueOnce({success: false, result: null});
    await host.closeLasso();
    expect(mockSetLassoBoxState).toHaveBeenCalledTimes(1);
  });

  it('deletes the selection through the plugin API', async () => {
    const host = createHost(new PenTracker(), {pointApi: null});
    mockDeleteLasso.mockResolvedValueOnce(ok(true));
    expect(await host.deleteSelection()).toBe(true);
    mockDeleteLasso.mockResolvedValueOnce({success: false, result: null});
    expect(await host.deleteSelection()).toBe(false);
  });
});

describe('file access', () => {
  it('checks both permissions at once and caches "always allow"', async () => {
    const pending: ((v: number) => void)[] = [];
    mockHasPermission.mockImplementation(
      () => new Promise<number>(resolve => pending.push(resolve)),
    );
    const lines: string[] = [];
    const host = createHost(new PenTracker(), {pointApi: null});
    host.setTrace(l => lines.push(l));

    const first = host.ensureFileAccess();
    await Promise.resolve();
    expect(mockHasPermission).toHaveBeenCalledTimes(2); // in parallel
    pending.forEach(resolve => resolve(2));
    expect(await first).toBe(true);
    expect(await host.ensureFileAccess()).toBe(true);
    expect(mockHasPermission).toHaveBeenCalledTimes(2);
    expect(mockRequestPermission).not.toHaveBeenCalled();
    expect(lines).toEqual([
      'file access: READ=2 WRITE=2',
      'file access: cached',
    ]);
  });

  it('counts "this time only" as granted, without caching it', async () => {
    mockHasPermission.mockResolvedValue(1);
    const host = createHost(new PenTracker(), {pointApi: null});
    expect(await host.ensureFileAccess()).toBe(true);
    expect(await host.ensureFileAccess()).toBe(true);
    expect(mockHasPermission).toHaveBeenCalledTimes(4);
    expect(mockRequestPermission).not.toHaveBeenCalled();
  });

  it('asks only for what is missing, and never caches an answer', async () => {
    mockHasPermission.mockImplementation(async (p: string) =>
      p.endsWith('READ') ? 2 : 0,
    );
    mockRequestPermission.mockResolvedValue(2);
    const host = createHost(new PenTracker(), {pointApi: null});
    expect(await host.ensureFileAccess()).toBe(true);
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    expect(mockRequestPermission.mock.calls[0][0]).toBe(
      'plugin.permission.FILE:WRITE',
    );
    await host.ensureFileAccess();
    expect(mockHasPermission).toHaveBeenCalledTimes(4);

    mockRequestPermission.mockResolvedValue(0);
    expect(await host.ensureFileAccess()).toBe(false);
  });

  it('checks again after a file call fails', async () => {
    mockHasPermission.mockResolvedValue(2);
    mockSave.mockResolvedValue({
      success: false,
      error: {code: 2, message: 'denied'},
    });
    mockGetElements.mockResolvedValue(ok([]));
    const lines: string[] = [];
    const host = createHost(new PenTracker(), {pointApi: null});
    host.setTrace(l => lines.push(l));

    await host.ensureFileAccess();
    await host.getPageElements('/n.note', 0);
    expect(lines).toContain(
      'file access cache cleared after saveCurrentNote failed',
    );
    await host.ensureFileAccess();
    expect(mockHasPermission).toHaveBeenCalledTimes(4);
  });
});

describe('timings', () => {
  it('ends the trace with one time line and knows when the page was read', async () => {
    mockSave.mockResolvedValue(ok(true));
    mockGetElements.mockResolvedValue(ok(strokes('a', 'b')));
    const host = createHost(new PenTracker(), {pointApi: null});
    host.setTrace(() => {});
    expect(host.pageWasRead()).toBe(false);

    const elements = await host.getPageElements('/n.note', 0);
    await Promise.all(elements.map(e => e.outline()));
    expect(host.pageWasRead()).toBe(true);
    const line = host.timeLine(42);
    expect(line).toMatch(
      /^time: 42 ms in all; saveCurrentNote \d+, getElements \d+ \(2 el\), points: 2 elements, 4 calls in \d+ ms \(2 pts, \d+ ms summed\)/,
    );
    expect(line).not.toContain('check:');

    host.setTrace(() => {});
    expect(host.pageWasRead()).toBe(false);
    expect(host.timeLine(0)).toBe(
      'time: 0 ms in all; no SDK calls (ms of parallel calls summed)',
    );
  });
});

describe('direct point reads', () => {
  const pts = [
    {x: 1, y: 2},
    {x: 3, y: 4},
    {x: 5, y: 6},
  ];

  /** A native module answering from `points`, or as `answer` says. */
  function api(answer?: (op: number, index: number[]) => unknown): PointApi & {
    opElementPointData: jest.Mock;
  } {
    return {
      opElementPointData: jest.fn(
        async (_uuid: string, type: number, op: number, index: number[]) => {
          expect(type).toBe(2);
          if (answer) {
            return answer(op, index);
          }
          return op === 0 ? pts.length : pts.slice(index[0], index[1] + 1);
        },
      ),
    };
  }

  it('reads stroke points straight from the native module', async () => {
    const native = api();
    const lines: string[] = [];
    const host = createHost(new PenTracker(), {pointApi: native});
    host.setTrace(l => lines.push(l));
    const {element, accessor} = sdkStroke('a', pts);
    const [stroke] = host.wrap([element]);

    expect(await stroke.pointCount!()).toBe(3);
    expect(await stroke.outline()).toEqual(pts);
    expect(
      native.opElementPointData.mock.calls.map(c => c.slice(2, 4)),
    ).toEqual([
      [0, []],
      [2, [0, 2]],
    ]);
    expect(accessor.size).not.toHaveBeenCalled();
    expect(lines).toEqual(['points: direct']);
  });

  it('reads the first point alone with one range call', async () => {
    const native = api();
    const host = createHost(new PenTracker(), {pointApi: native});
    const [stroke] = host.wrap([sdkStroke('a', pts).element]);
    expect(await stroke.firstPoint!()).toEqual({x: 1, y: 2});
    expect(
      native.opElementPointData.mock.calls.map(c => c.slice(2, 4)),
    ).toEqual([[2, [0, 0]]]);
  });

  it('gives no points for an empty stroke, as the SDK does', async () => {
    const host = createHost(new PenTracker(), {
      pointApi: api(op => (op === 0 ? 0 : null)),
    });
    const [stroke] = host.wrap([sdkStroke('a', []).element]);
    expect(await stroke.outline()).toEqual([]);
  });

  it('falls back to the accessor on a null result, without turning off', async () => {
    let cached = false;
    const native = api((op, index) =>
      cached ? (op === 0 ? 3 : pts.slice(index[0], index[1] + 1)) : null,
    );
    const lines: string[] = [];
    const host = createHost(new PenTracker(), {pointApi: native});
    host.setTrace(l => lines.push(l));
    for (let k = 0; k < 5; k++) {
      const {element, accessor} = sdkStroke(`u${k}`, pts);
      const [stroke] = host.wrap([element]);
      expect(await stroke.outline()).toEqual(pts);
      expect(accessor.getRange).toHaveBeenCalled();
    }
    expect(lines).toEqual(['points: SDK accessor (fallback: size: no result)']);

    cached = true;
    const {element, accessor} = sdkStroke('later', pts);
    const [stroke] = host.wrap([element]);
    expect(await stroke.outline()).toEqual(pts);
    expect(accessor.getRange).not.toHaveBeenCalled();
  });

  it('counts once with the accessor, then reads exactly that range', async () => {
    for (const pointApi of [null, api(() => null)]) {
      const host = createHost(new PenTracker(), {pointApi});
      const {element, accessor} = sdkStroke('a', pts);
      const [stroke] = host.wrap([element]);
      expect(await stroke.outline()).toEqual(pts);
      expect(accessor.size).toHaveBeenCalledTimes(1);
      expect(accessor.getRange).toHaveBeenCalledTimes(1);
      expect(accessor.getRange).toHaveBeenCalledWith(0, 3);
    }
  });

  it('asks the accessor again when its size threw', async () => {
    const host = createHost(new PenTracker(), {pointApi: null});
    const {element, accessor} = sdkStroke('a', pts);
    accessor.size.mockRejectedValueOnce(new Error('boom'));
    const [stroke] = host.wrap([element]);
    expect(await stroke.outline()).toEqual(pts);
    expect(accessor.size).toHaveBeenCalledTimes(2);
  });

  it('keeps range strikes across good sizes, but a good range resets them', async () => {
    const timings = new Timings();
    let badRange = true;
    const reader = new DirectPointReader(
      api((op, index) =>
        op === 0
          ? 3
          : badRange
          ? [{x: 1, y: 2}]
          : pts.slice(index[0], index[1] + 1),
      ),
    );
    await reader.range('a', 3, timings);
    await reader.count('a', timings); // a good size does not clear it
    await reader.range('a', 3, timings);
    badRange = false;
    expect(await reader.range('a', 3, timings)).toMatchObject({ok: true});
    badRange = true;
    await reader.range('a', 3, timings);
    await reader.range('a', 3, timings);
    expect(reader.disabledReason()).toBeNull(); // never 3 in a row
    await reader.range('a', 3, timings);
    expect(reader.disabledReason()).toContain('turned off');
  });

  it('turns itself off after 3 bad results in a row', async () => {
    const native = api(
      (op, index) => (op === 0 ? 3 : [{x: 1, y: 2}].slice(index[0])), // too few points
    );
    const lines: string[] = [];
    const host = createHost(new PenTracker(), {pointApi: native});
    host.setTrace(l => lines.push(l));
    for (let k = 0; k < 3; k++) {
      const [stroke] = host.wrap([sdkStroke(`u${k}`, pts).element]);
      expect(await stroke.outline()).toEqual(pts); // from the accessor
    }
    // Sizes were read directly, the points from the accessor.
    expect(lines).toEqual([
      'points: direct',
      'points: SDK accessor (fallback: points: 1 of 3)',
    ]);
    const calls = native.opElementPointData.mock.calls.length;

    const [stroke] = host.wrap([sdkStroke('later', pts).element]);
    expect(await stroke.outline()).toEqual(pts);
    expect(native.opElementPointData.mock.calls.length).toBe(calls);
  });

  it('counts thrown errors and wrong shapes as bad results', async () => {
    const reader = new DirectPointReader(
      api(op => {
        if (op === 0) {
          throw new Error('boom');
        }
        return null;
      }),
    );
    const timings = new Timings();
    expect(await reader.count('a', timings)).toEqual({
      ok: false,
      reason: 'size threw: boom',
    });
    expect(await reader.count('a', timings)).toMatchObject({ok: false});
    expect(reader.disabledReason()).toBeNull();
    expect(await reader.count('a', timings)).toMatchObject({ok: false});
    expect(reader.disabledReason()).toContain('turned off after 3 bad results');

    const shapes = new DirectPointReader(api(() => 'three'));
    expect(await shapes.count('a', timings)).toEqual({
      ok: false,
      reason: 'size gave a string',
    });
    expect(
      await new DirectPointReader(api(() => [{x: 1, y: 'two'}])).range(
        'a',
        1,
        timings,
      ),
    ).toEqual({ok: false, reason: 'points: 1 of 1'});
  });

  it('is off without a native module', async () => {
    const lines: string[] = [];
    const host = createHost(new PenTracker(), {pointApi: null});
    host.setTrace(l => lines.push(l));
    const [stroke] = host.wrap([sdkStroke('a', pts).element]);
    expect(await stroke.outline()).toEqual(pts);
    expect(lines).toEqual([
      'points: SDK accessor (fallback: no native module)',
    ]);
  });
});
