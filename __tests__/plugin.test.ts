let mockTap: (count: number) => void = () => {};
const listeners: {onMsg(msg: unknown): void}[] = [];
jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    registerEventListener: (
      _name: string,
      _id: number,
      l: {onMsg(msg: unknown): void},
    ) => listeners.push(l),
  },
}));
/** Calls in order: 'release <uuids>' and 'handle <elements>'. */
const mockLog: string[] = [];
const mockRelease = jest.fn((pending?: string[]) => {
  mockLog.push(`release ${(pending ?? []).join(',')}`);
});
jest.mock('../src/host', () => ({
  PenTracker: class {
    start() {}
    onEvent() {}
  },
  createHost: () => ({
    setTrace: () => {},
    wrap: (els: unknown[]) => els,
    release: mockRelease,
    timeLine: () => 'time: test',
    pageWasRead: () => false,
    clearRedo: () => {},
    redo: () =>
      new Promise(resolve => {
        edits.push({name: 'redo', finish: () => resolve('Redone.')});
      }),
    restoreLastErase: () =>
      new Promise(resolve => {
        edits.push({name: 'restore', finish: () => resolve('Restored 2.')});
      }),
  }),
}));
jest.mock('../src/floating', () => ({
  FloatingButton: class {
    constructor(_enabled: unknown, onTaps: (count: number) => void) {
      mockTap = onTaps;
    }
    onMotion() {}
    hideByUser() {}
  },
}));
const edits: {name: string; finish: () => void}[] = [];
const calls: {elements: unknown[]; finish: () => void}[] = [];
jest.mock('../src/selector', () => ({
  deleteSelection: () =>
    new Promise(resolve => {
      edits.push({
        name: 'delete',
        finish: () => resolve({kind: 'erased', count: 1, rect: {}}),
      });
    }),
  handlePenUp: (elements: unknown[]) =>
    new Promise(resolve => {
      mockLog.push(
        `handle ${elements
          .map(e => (typeof e === 'string' ? e : (e as {uuid: string}).uuid))
          .join(',')}`,
      );
      calls.push({
        elements,
        finish: () => resolve({kind: 'ignored', reason: 'test'}),
      });
    }),
}));

import {
  deleteSelection,
  restoreLastErase,
  startGestures,
} from '../src/plugin';
import {status} from '../src/status';

const flush = () => new Promise(r => setImmediate(r));

describe('pen-up events', () => {
  beforeEach(() => {
    calls.length = 0;
    edits.length = 0;
    mockLog.length = 0;
    mockRelease.mockClear();
  });

  it('handles strokes that arrive while busy next, instead of dropping them', async () => {
    startGestures();
    const listener = listeners[listeners.length - 1];

    listener.onMsg(['gesture']);
    listener.onMsg(['next gesture']);
    listener.onMsg(['more writing']);
    expect(calls.map(c => c.elements)).toEqual([['gesture']]);

    calls[0].finish();
    await flush();
    expect(calls.map(c => c.elements)).toEqual([
      ['gesture'],
      ['next gesture', 'more writing'],
    ]);

    calls[1].finish();
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('frees what a stroke read before the next one starts, keeping the queued strokes', async () => {
    startGestures();
    const listener = listeners[listeners.length - 1];

    listener.onMsg([{uuid: 'a'}]);
    listener.onMsg([{uuid: 'b'}, {uuid: 'c'}]);
    calls[0].finish();
    await flush();
    expect(mockLog).toEqual(['handle a', 'release b,c', 'handle b,c']);
    // The stroke's trace ends with the time line.
    expect(status.lastTrace()).toEqual([
      expect.stringMatching(/^took \d+ ms$/),
      'time: test',
    ]);
  });

  it('handles the queued stroke at once even when release throws', async () => {
    mockRelease.mockImplementationOnce(() => {
      throw new TypeError('e.recycle is not a function');
    });
    startGestures();
    const listener = listeners[listeners.length - 1];

    listener.onMsg(['gesture']);
    listener.onMsg(['queued']);
    calls[0].finish();
    await flush();
    expect(calls.map(c => c.elements)).toEqual([['gesture'], ['queued']]);
    expect(status.lastOutcome()).toEqual({kind: 'ignored', reason: 'test'});

    // Not stuck: a new stroke is queued behind the running one, and handled.
    listener.onMsg(['later']);
    calls[1].finish();
    await flush();
    expect(calls.map(c => c.elements)).toEqual([
      ['gesture'],
      ['queued'],
      ['later'],
    ]);
  });

  it('frees nothing while an abandoned stroke may still read', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    startGestures();
    const listener = listeners[listeners.length - 1];

    listener.onMsg([{uuid: 'slow'}]);
    now.mockReturnValue(20000); // past the time limit: abandoned
    listener.onMsg([{uuid: 'next'}]);
    expect(status.lastOutcome()).toEqual({kind: 'failed', reason: 'timed out'});
    calls[1].finish();
    await flush();
    expect(mockRelease).not.toHaveBeenCalled();

    calls[0].finish(); // the abandoned one settles, nothing else is busy
    await flush();
    expect(mockRelease).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('frees what an abandoned stroke that never settles was holding back, once it is old', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    startGestures();
    const listener = listeners[listeners.length - 1];

    listener.onMsg([{uuid: 'hung'}]);
    now.mockReturnValue(20000); // abandoned, and never settles
    listener.onMsg([{uuid: 'next'}]);
    now.mockReturnValue(20000 + 3 * 8000 + 1); // long past 3 time limits
    listener.onMsg([{uuid: 'late'}]); // abandons 'next' too
    calls[2].finish();
    await flush();
    // 'next' was abandoned just now and may still read, 'hung' is stale.
    expect(mockRelease).not.toHaveBeenCalled();
    now.mockReturnValue(20000 + 3 * 8000 + 1 + 3 * 8000 + 1);
    listener.onMsg([{uuid: 'last'}]);
    calls[3].finish();
    await flush();
    expect(mockRelease).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('keeps handling strokes when a status listener throws', async () => {
    startGestures();
    const listener = listeners[listeners.length - 1];
    const off = status.subscribe(() => {
      throw new Error('torn down');
    });

    listener.onMsg(['gesture']);
    listener.onMsg(['queued']);
    calls[0].finish();
    await flush();
    expect(calls.map(c => c.elements)).toEqual([['gesture'], ['queued']]);
    expect(status.lastOutcome()).toEqual({kind: 'ignored', reason: 'test'});
    off();
  });
});

describe('the edit lock', () => {
  beforeEach(() => {
    calls.length = 0;
    edits.length = 0;
    mockLog.length = 0;
    mockRelease.mockClear();
  });

  it('queues a stroke arriving during an undo/redo, handling it when that ends', async () => {
    startGestures();
    const listener = listeners[listeners.length - 1];

    mockTap(2); // redo
    listener.onMsg([{uuid: 'a'}]);
    expect(calls).toHaveLength(0);

    edits[0].finish();
    await flush();
    expect(mockLog).toEqual(['release a', 'handle a']);
    calls[0].finish();
    await flush();
  });

  it('refuses a tap while a stroke is handled', async () => {
    startGestures();
    const listener = listeners[listeners.length - 1];

    listener.onMsg(['gesture']);
    mockTap(2);
    expect(edits).toHaveLength(0);
    expect(status.lastOutcome()).toEqual({
      kind: 'ignored',
      reason: 'redo skipped: a stroke is being handled',
    });
    calls[0].finish();
    await flush();
  });

  it('refuses Delete while a stroke is handled, and queues strokes while it runs', async () => {
    startGestures();
    const listener = listeners[listeners.length - 1];

    listener.onMsg(['gesture']);
    await deleteSelection();
    expect(edits).toHaveLength(0);
    expect(status.lastOutcome()).toEqual({
      kind: 'ignored',
      reason: 'a stroke is being handled',
    });
    calls[0].finish();
    await flush();

    const running = deleteSelection();
    await flush();
    listener.onMsg([{uuid: 'q'}]);
    expect(calls).toHaveLength(1);
    await deleteSelection(); // a second Delete is refused
    expect(status.lastOutcome()).toEqual({
      kind: 'ignored',
      reason: 'the last undo/redo is running',
    });
    edits[0].finish();
    await running;
    await flush();
    // Delete releases what it read, then the waiting stroke is handled.
    expect(mockLog.slice(-2)).toEqual(['release q', 'handle q']);
    calls[1].finish();
    await flush();
  });

  it('lets a stroke through when Delete never finishes', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    startGestures();
    const listener = listeners[listeners.length - 1];

    deleteSelection().catch(() => {});
    await flush();
    now.mockReturnValue(20000);
    listener.onMsg(['gesture']);
    expect(calls.map(c => c.elements)).toEqual([['gesture']]);
    calls[0].finish();
    await flush();
    now.mockRestore();
  });

  it('frees nothing when a Delete taken over as stuck ends during a stroke', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    startGestures();
    const listener = listeners[listeners.length - 1];

    const stuck = deleteSelection();
    await flush();
    now.mockReturnValue(20000);
    listener.onMsg(['gesture']); // takes over the stuck Delete
    expect(calls).toHaveLength(1);
    mockRelease.mockClear();

    edits[0].finish(); // the stuck Delete ends while the stroke runs
    await stuck;
    await flush();
    expect(mockRelease).not.toHaveBeenCalled();

    calls[0].finish();
    await flush();
    expect(mockRelease).toHaveBeenCalled();
    now.mockRestore();
  });

  it('lets an undo/redo through when a stroke is stuck', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    startGestures();
    const listener = listeners[listeners.length - 1];

    listener.onMsg(['gesture']);
    now.mockReturnValue(20000);
    mockTap(2); // redo: the stroke is abandoned, the redo runs
    expect(edits.map(e => e.name)).toEqual(['redo']);
    edits[0].finish();
    await flush();
    calls[0].finish();
    await flush();
    now.mockRestore();
  });

  it('runs Restore under the lock: refused during a stroke, strokes wait for it', async () => {
    startGestures();
    const listener = listeners[listeners.length - 1];

    listener.onMsg(['gesture']);
    expect(await restoreLastErase()).toBe(
      'Busy with another edit: try again in a moment.',
    );
    calls[0].finish();
    await flush();

    const running = restoreLastErase();
    listener.onMsg([{uuid: 'r'}]);
    expect(calls).toHaveLength(1); // waits for the restore
    edits[edits.length - 1].finish();
    expect(await running).toBe('Restored 2.');
    await flush();
    expect(mockLog.slice(-1)).toEqual(['handle r']);
    calls[1].finish();
    await flush();
  });
});
