import {DEFAULT_CONFIG} from '../src/config';
import type {Box, Pt} from '../src/geometry';
import {
  handlePenUp,
  withTimeout,
  type Host,
  type PageElement,
} from '../src/selector';

function ellipse(cx: number, cy: number, rx: number, ry: number, n = 80): Pt[] {
  return Array.from({length: n + 1}, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return {x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a)};
  });
}

/** A short horizontal "word" stroke. */
function word(x: number, y: number, width = 80): Pt[] {
  return Array.from({length: 20}, (_, i) => ({
    x: x + (width * i) / 19,
    y: y + (i % 2) * 6,
  }));
}

let nextNum = 1;
function el(points: Pt[], overrides: Partial<PageElement> = {}): PageElement {
  const num = nextNum++;
  return {
    uuid: `uuid-${num}`,
    type: 0,
    numInPage: num,
    pageNum: 3,
    layerNum: 0,
    penType: 10,
    outline: async () => points,
    ...overrides,
  };
}

interface FakeHost extends Host {
  deleted: number[][];
  lassoed: Box[];
  refreshed: number;
}

function fakeHost(
  page: PageElement[],
  overrides: Partial<Host> = {},
): FakeHost {
  const host: FakeHost = {
    deleted: [],
    lassoed: [],
    refreshed: 0,
    getCurrentFilePath: async () => '/storage/emulated/0/Note/demo.note',
    getCurrentPageNum: async () => 3,
    getPageSize: async () => ({width: 1404, height: 1872}),
    getPageElements: async () => page,
    ensureFileAccess: async () => true,
    waitForPenUp: async () => {},
    deleteElements: async nums => {
      host.deleted.push(nums);
      return true;
    },
    lassoRect: async rect => {
      host.lassoed.push(rect);
      return true;
    },
    refreshPage: async () => {
      host.refreshed++;
    },
    release: () => {},
    ...overrides,
  };
  return host;
}

describe('handlePenUp', () => {
  beforeEach(() => {
    nextNum = 1;
  });

  it('removes the loop and lassoes only what it encloses', async () => {
    const inside1 = el(word(420, 480));
    const inside2 = el(word(520, 520, 60));
    const outside = el(word(1000, 1500));
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([inside1, outside, inside2, loop]);

    const outcome = await handlePenUp([loop], host, DEFAULT_CONFIG);

    expect(outcome).toMatchObject({kind: 'selected', count: 2});
    expect(host.deleted).toEqual([[loop.numInPage]]);
    expect(host.lassoed).toHaveLength(1);
    const rect = host.lassoed[0];
    expect(rect.left).toBeLessThanOrEqual(420);
    expect(rect.right).toBeGreaterThanOrEqual(580);
    expect(rect.right).toBeLessThan(1000);
  });

  it('leaves a loop around empty space as ink', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(1000, 1500)), loop]);

    const outcome = await handlePenUp([loop], host, DEFAULT_CONFIG);

    expect(outcome).toEqual({kind: 'ignored', reason: 'loop encloses nothing'});
    expect(host.deleted).toEqual([]);
  });

  it('ignores open strokes without touching the page', async () => {
    const stroke = el(word(100, 100, 600));
    const getPageElements = jest.fn(async () => [stroke]);
    const host = fakeHost([], {getPageElements});

    expect(await handlePenUp([stroke], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'ignored',
    });
    expect(getPageElements).not.toHaveBeenCalled();
  });

  it('ignores marker and lasso-tool strokes', async () => {
    for (const penType of [11, 4]) {
      const loop = el(ellipse(520, 500, 200, 120), {penType});
      const host = fakeHost([el(word(480, 500)), loop]);
      expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toEqual({
        kind: 'ignored',
        reason: 'not an ink stroke',
      });
    }
  });

  it('only works in NOTE files', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop], {
      getCurrentFilePath: async () => '/storage/emulated/0/Document/book.pdf',
    });
    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'ignored',
    });
    expect(host.deleted).toEqual([]);
  });

  it('ignores elements partly outside the loop and on other layers', async () => {
    const straddling = el(word(650, 500, 300)); // runs well past the right edge
    const otherLayer = el(word(480, 500), {layerNum: 1});
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([straddling, otherLayer, loop]);

    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toMatchObject({
      reason: 'loop encloses nothing',
    });
  });

  it('finds the stored loop by its points when the uuid differs', async () => {
    const loopPoints = ellipse(520, 500, 200, 120);
    const penUp = el(loopPoints, {uuid: 'from-pen-up', numInPage: 0});
    const stored = el(loopPoints, {uuid: 'stored', numInPage: 7});
    const host = fakeHost([el(word(480, 500)), stored]);

    expect(await handlePenUp([penUp], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
    });
    expect(host.deleted).toEqual([[7]]);
  });

  it('does not edit anything when file access is refused', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop], {
      ensureFileAccess: async () => false,
    });

    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'failed',
    });
    expect(host.deleted).toEqual([]);
  });

  it('cancels when the page changed before editing', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop], {
      getCurrentPageNum: async () => 4,
    });

    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'page changed',
    });
    expect(host.deleted).toEqual([]);
  });

  it('does not edit the page once the caller gave up', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop]);

    const outcome = await handlePenUp([loop], host, DEFAULT_CONFIG, () => true);

    expect(outcome).toMatchObject({kind: 'ignored'});
    expect(host.deleted).toEqual([]);
    expect(host.lassoed).toEqual([]);
  });

  it('waits for the pen to lift before editing', async () => {
    const order: string[] = [];
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop], {
      waitForPenUp: async () => {
        order.push('wait');
      },
      deleteElements: async () => {
        order.push('delete');
        return true;
      },
    });
    await handlePenUp([loop], host, DEFAULT_CONFIG);
    expect(order).toEqual(['wait', 'delete']);
  });

  it('refreshes the page when the lasso cannot be created', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop], {
      lassoRect: async () => false,
    });

    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'failed',
    });
    expect(host.refreshed).toBe(1);
  });
});

describe('withTimeout', () => {
  it('returns the fallback when work takes too long', async () => {
    const never = new Promise<string>(() => {});
    expect(await withTimeout(never, 10, 'late')).toBe('late');
  });

  it('returns the result when work finishes in time', async () => {
    expect(await withTimeout(Promise.resolve('done'), 1000, 'late')).toBe(
      'done',
    );
  });
});
