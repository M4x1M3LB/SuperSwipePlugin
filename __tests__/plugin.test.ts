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
jest.mock('../src/host', () => ({
  PenTracker: class {
    start() {}
  },
  createHost: () => ({
    setTrace: () => {},
    wrap: (els: unknown[]) => els,
    release: () => {},
  }),
}));
const calls: {elements: unknown[]; finish: () => void}[] = [];
jest.mock('../src/selector', () => ({
  handlePenUp: (elements: unknown[]) =>
    new Promise(resolve => {
      calls.push({
        elements,
        finish: () => resolve({kind: 'ignored', reason: 'test'}),
      });
    }),
}));

import {startGestures} from '../src/plugin';

const flush = () => new Promise(r => setImmediate(r));

describe('pen-up events', () => {
  it('handles strokes that arrive while busy next, instead of dropping them', async () => {
    startGestures();
    const [listener] = listeners;

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
});
