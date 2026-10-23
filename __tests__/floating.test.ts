const mockNative = {
  checkPermission: jest.fn(async () => true),
  requestPermission: jest.fn(async () => true),
  showLeftOf: jest.fn(async () => true),
  hide: jest.fn(async () => true),
  remove: jest.fn(async () => true),
};
const mockTapListeners: ((e: {count: number}) => void)[] = [];
jest.mock('react-native', () => ({
  NativeModules: {LaserOverlay: mockNative},
  DeviceEventEmitter: {
    addListener: (_name: string, l: (e: {count: number}) => void) =>
      mockTapListeners.push(l),
  },
}));

// Required after the mocks exist (an import would be hoisted above them).

const {FloatingButton} =
  require('../src/floating') as typeof import('../src/floating');

const pen = (action: number, x: number, y: number) =>
  ({action, x, y, toolType: 2, pointerCount: 1} as never);
const fingers = (action: number, pointerCount: number) =>
  ({action, x: 0, y: 0, toolType: 1, pointerCount} as never);

describe('FloatingButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTapListeners.length = 0;
  });

  it('hides while the pen is down, then shows left of the stroke 3 s later', () => {
    const button = new FloatingButton(
      () => true,
      () => {},
    );
    button.onMotion(pen(0, 100, 300));
    expect(mockNative.hide).toHaveBeenCalledTimes(1);
    button.onMotion(pen(2, 400, 280));
    button.onMotion(pen(2, 250, 340));
    expect(mockNative.showLeftOf).not.toHaveBeenCalled();
    button.onMotion(pen(1, 250, 340));
    expect(mockNative.showLeftOf).toHaveBeenCalledWith(100, 280, 60, 3000);
  });

  it('passes finger taps on, and stays hidden after three taps', () => {
    const taps: number[] = [];
    const button = new FloatingButton(
      () => true,
      n => taps.push(n),
    );
    mockTapListeners[0]({count: 2});
    expect(taps).toEqual([2]);

    button.hideByUser();
    button.onMotion(pen(0, 100, 300));
    button.onMotion(pen(1, 120, 310));
    expect(mockNative.showLeftOf).not.toHaveBeenCalled();
  });

  it('shows or hides it again with a four-finger tap', () => {
    const button = new FloatingButton(
      () => true,
      () => {},
    );
    button.onMotion(pen(0, 100, 300));
    button.onMotion(pen(1, 120, 310));
    expect(mockNative.showLeftOf).toHaveBeenCalledTimes(1);

    button.onMotion(fingers(0, 1));
    button.onMotion(fingers(261, 2));
    button.onMotion(fingers(517, 3));
    button.onMotion(fingers(773, 4)); // fourth finger down: hide
    button.onMotion(fingers(773, 4)); // same touch: no second toggle
    expect(mockNative.hide).toHaveBeenCalledTimes(2);
    button.onMotion(fingers(1, 1)); // all up

    button.onMotion(fingers(773, 4)); // again: show by the last stroke
    expect(mockNative.showLeftOf).toHaveBeenCalledTimes(2);
  });

  it('does nothing when switched off', () => {
    const taps: number[] = [];
    const button = new FloatingButton(
      () => false,
      n => taps.push(n),
    );
    button.onMotion(pen(0, 100, 300));
    button.onMotion(pen(1, 120, 310));
    mockTapListeners[0]({count: 1});
    expect(mockNative.showLeftOf).not.toHaveBeenCalled();
    expect(taps).toEqual([]);
  });
});
