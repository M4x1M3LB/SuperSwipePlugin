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
  },
  createHost: () => ({
    setTrace: () => {},
    wrap: (els: unknown[]) => els,
    release: mockRelease,
    timeLine: () => 'time: test',
    pageWasRead: () => false,
  }),
}));
const calls: {elements: unknown[]; finish: () => void}[] = [];
jest.mock('../src/selector', () => ({
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

import {startGestures} from '../src/plugin';
import {status} from '../src/status';

const flush = () => new Promise(r => setImmediate(r));

describe('pen-up events', () => {
  beforeEach(() => {
    calls.length = 0;
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
});
