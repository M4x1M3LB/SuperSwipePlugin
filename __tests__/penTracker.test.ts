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

  it('ignores pen hover events', async () => {
    const now = jest.spyOn(Date, 'now');
    const tracker = new PenTracker();
    tracker.start();
    now.mockReturnValue(1000);
    listeners[0].onMsg(pen(0));
    listeners[0].onMsg(pen(1));
    const savedAt = 2000;
    now.mockReturnValue(3000);
    listeners[0].onMsg(pen(7)); // hovering over the page after the save
    expect(tracker.quietSince(savedAt)).toBe(true);
    expect(tracker.downCount()).toBe(1);
    await expect(tracker.waitForUp(5000)).resolves.toBeUndefined();
    now.mockRestore();
  });

  it('is not quiet after the pen touched the screen since the save', () => {
    const now = jest.spyOn(Date, 'now');
    const tracker = new PenTracker();
    tracker.start();
    now.mockReturnValue(3000);
    listeners[0].onMsg(pen(0));
    listeners[0].onMsg(pen(2));
    listeners[0].onMsg(pen(1));
    expect(tracker.quietSince(2000)).toBe(false);
    expect(tracker.quietSince(4000)).toBe(true);
    now.mockRestore();
  });

  it('ignores finger touches', async () => {
    const tracker = new PenTracker();
    tracker.start();
    listeners[0].onMsg({toolType: 1, action: 0, pointers: []});
    await expect(tracker.waitForUp(5000)).resolves.toBeUndefined();
  });
});
