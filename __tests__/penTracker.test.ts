const listeners: {onMsg(msg: unknown): void}[] = [];

jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    registerMotionListener: (_: number, l: {onMsg(msg: unknown): void}) => {
      listeners.push(l);
    },
  },
  PluginCommAPI: {},
  PluginFileAPI: {},
  PluginNoteAPI: {},
}));

import {PenTracker} from '../src/host';

const pen = (action: number) => ({toolType: 2, action, pointers: []});

describe('PenTracker', () => {
  beforeEach(() => {
    listeners.length = 0;
  });

  it('resolves at once when the pen is up', async () => {
    const tracker = new PenTracker();
    tracker.start();
    await expect(tracker.waitForUp(5000)).resolves.toBeUndefined();
  });

  it('waits for the pen-up motion event, without timers', async () => {
    jest.useFakeTimers(); // timers never advance: nothing may depend on them
    const tracker = new PenTracker();
    tracker.start();
    listeners[0].onMsg(pen(0));

    let done = false;
    const wait = tracker.waitForUp(5000).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);

    listeners[0].onMsg(pen(2)); // still writing
    await Promise.resolve();
    expect(done).toBe(false);

    listeners[0].onMsg(pen(1));
    await wait;
    expect(done).toBe(true);
    jest.useRealTimers();
  });

  it('ignores finger touches', async () => {
    const tracker = new PenTracker();
    tracker.start();
    listeners[0].onMsg({toolType: 1, action: 0, pointers: []});
    await expect(tracker.waitForUp(5000)).resolves.toBeUndefined();
  });
});
