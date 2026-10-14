import {DEFAULT_CONFIG} from '../src/config';
import type {Box, Pt} from '../src/geometry';
import {handlePenUp, type Host, type PageElement} from '../src/selector';

function ellipse(cx: number, cy: number, rx: number, ry: number, n = 80): Pt[] {
  return Array.from({length: n + 1}, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return {x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a)};
  });
}

/** A handwritten letter: a zig-zag 30 px wide and 40 px tall. */
function letter(x: number, y: number): Pt[] {
  return [0, 1, 2, 3, 4, 5, 6].map(i => ({
    x: x + i * 5,
    y: y + (i % 2 === 0 ? 0 : 40),
  }));
}

/** A straight pen line with a little hand wobble. */
function straight(from: Pt, to: Pt, n = 30): Pt[] {
  return Array.from({length: n + 1}, (_, i) => ({
    x: from.x + ((to.x - from.x) * i) / n,
    y: from.y + ((to.y - from.y) * i) / n + (i % 3) - 1,
  }));
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
  remembered: PageElement[][];
}

function fakeHost(
  page: PageElement[],
  overrides: Partial<Host> = {},
): FakeHost {
  // Behaves like the device is suspected to: elements are removed one at a
  // time in the order given, and the page is renumbered after each removal.
  let current = [...page];
  const host: FakeHost = {
    deleted: [],
    lassoed: [],
    refreshed: 0,
    remembered: [],
    getCurrentFilePath: async () => '/storage/emulated/0/Note/demo.note',
    getCurrentPageNum: async () => 3,
    getPageSize: async () => ({width: 1404, height: 1872}),
    getPageElements: async () => current,
    ensureFileAccess: async () => true,
    waitForPenUp: async () => {},
    deleteElements: async nums => {
      host.deleted.push(nums);
      for (const num of nums) {
        const target = current.find(e => e.numInPage === num);
        if (!target) {
          continue;
        }
        current = current.filter(e => e !== target);
        current.forEach(e => {
          if (e.numInPage > num) {
            e.numInPage--;
          }
        });
      }
      return true;
    },
    rememberErased: (_path, _page, _layer, elements) => {
      host.remembered.push(elements);
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
    const arc = Array.from({length: 40}, (_, i) => ({
      x: 500 + 200 * Math.cos((i / 39) * Math.PI),
      y: 500 + 200 * Math.sin((i / 39) * Math.PI),
    }));
    const stroke = el(arc);
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
      // Page 3 when the stroke arrives, page 4 by the time we would edit.
      getCurrentPageNum: jest
        .fn<Promise<number | null>, []>()
        .mockResolvedValueOnce(3)
        .mockResolvedValue(4),
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

    const outcome = await handlePenUp([loop], host, DEFAULT_CONFIG, {
      isCancelled: () => true,
    });

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
    });
    const realDelete = host.deleteElements;
    host.deleteElements = (nums, page, layer) => {
      order.push('delete');
      return realDelete(nums, page, layer);
    };
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

describe('handlePenUp: device quirks', () => {
  beforeEach(() => {
    nextNum = 1;
  });

  it('uses the page that is showing when the pen-up element has none', async () => {
    const points = ellipse(520, 500, 200, 120);
    // As delivered by event_pen_up: not committed yet, no page fields.
    const penUp = el(points, {
      uuid: 'pen-up',
      numInPage: 0,
      pageNum: undefined as unknown as number,
    });
    const stored = el(points, {numInPage: 9});
    const host = fakeHost([el(word(480, 500)), stored]);
    const getPageElements = jest.spyOn(host, 'getPageElements');

    expect(await handlePenUp([penUp], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
    });
    expect(getPageElements).toHaveBeenCalledWith(expect.any(String), 3);
    expect(host.deleted).toEqual([[9]]);
  });

  it('finds the saved stroke when its coordinates differ from the pen-up copy', async () => {
    const pagePoints = ellipse(520, 500, 200, 120);
    // Pen-up copy in another coordinate system (rotated and scaled, like EMR).
    const penUpPoints = pagePoints.map(p => ({
      x: 20000 - p.y * 11,
      y: p.x * 11,
    }));
    const penUp = el(penUpPoints, {uuid: 'pen-up', numInPage: 0});
    const olderSameCount = el(ellipse(100, 1500, 60, 60), {numInPage: 2});
    const stored = el(pagePoints, {numInPage: 7});
    const host = fakeHost([olderSameCount, el(word(480, 500)), stored]);

    expect(await handlePenUp([penUp], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
      count: 1,
    });
    // Newest stroke with the same point count, and selection computed from
    // the page copy's coordinates.
    expect(host.deleted).toEqual([[7]]);
    expect(host.lassoed[0].left).toBeGreaterThan(400);
  });

  it('accepts a saved copy with a few points more or less', async () => {
    const points = ellipse(520, 500, 200, 120, 100);
    const penUp = el(points, {uuid: 'pen-up', numInPage: 0});
    const stored = el(points.slice(0, -3), {numInPage: 4});
    const host = fakeHost([el(word(480, 500)), stored]);

    expect(await handlePenUp([penUp], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
    });
    expect(host.deleted).toEqual([[4]]);
  });

  it('explains in the trace when the saved stroke is missing', async () => {
    const penUp = el(ellipse(520, 500, 200, 120), {
      uuid: 'pen-up',
      numInPage: 0,
    });
    const host = fakeHost([el(word(480, 500), {numInPage: 3})]);
    const lines: string[] = [];

    expect(
      await handlePenUp([penUp], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toMatchObject({kind: 'failed'});
    expect(lines.join('\n')).toContain('newest: #3:20');
  });

  it('traces each step', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop]);
    const lines: string[] = [];

    await handlePenUp([loop], host, DEFAULT_CONFIG, {
      trace: l => lines.push(l),
    });

    expect(lines).toEqual(
      expect.arrayContaining([
        'shape: closed loop',
        'enclosed: 1 element(s)',
        'loop stroke removed',
      ]),
    );
  });
});

describe('handlePenUp: line to erase', () => {
  beforeEach(() => {
    nextNum = 1;
  });

  /** Four letters side by side, 40 px apart, top at y=500. */
  function row(): PageElement[] {
    return [100, 140, 180, 220].map(x => el(letter(x, 500)));
  }

  it('erases the strokes a line cuts through, and the line', async () => {
    const letters = row();
    const other = el(letter(100, 800));
    const line = el(straight({x: 80, y: 520}, {x: 280, y: 520}));
    const host = fakeHost([...letters, other, line]);

    const outcome = await handlePenUp([line], host, DEFAULT_CONFIG);

    expect(outcome).toEqual({kind: 'erased', count: 4});
    // Newest first, so no removal shifts the numbers of the others.
    expect(host.deleted).toEqual([[6, 4, 3, 2, 1]]);
    expect(await host.getPageElements('', 3)).toEqual([other]);
    expect(host.remembered).toEqual([letters]);
    expect(host.refreshed).toBe(1);
  });

  it('erases the rest of each word: strokes crossing or touching a cut one', async () => {
    const letters = row();
    // A "t" bar above the line, crossing the first letter but not cut.
    const bar = el(straight({x: 95, y: 505}, {x: 135, y: 505}, 8));
    // A connector that starts 2 px from the end of the last letter.
    const tail = el([
      {x: 252, y: 502},
      {x: 262, y: 490},
      {x: 272, y: 480},
    ]);
    // An "i" dot 15 px above the row: not touching, so it stays.
    const dot = el([
      {x: 150, y: 485},
      {x: 151, y: 486},
    ]);
    const line = el(straight({x: 80, y: 520}, {x: 280, y: 520}));
    const host = fakeHost([...letters, bar, tail, dot, line]);
    const lines: string[] = [];

    const outcome = await handlePenUp([line], host, DEFAULT_CONFIG, {
      trace: l => lines.push(l),
    });

    expect(outcome).toEqual({kind: 'erased', count: 6});
    expect(lines).toContain('touching: 2 more stroke(s)');
    expect(await host.getPageElements('', 3)).toEqual([dot]);
  });

  it('only erases cut strokes when touching is turned off', async () => {
    const letters = row();
    const bar = el(straight({x: 95, y: 505}, {x: 135, y: 505}, 8));
    const line = el(straight({x: 80, y: 520}, {x: 280, y: 520}));
    const host = fakeHost([...letters, bar, line]);

    const outcome = await handlePenUp([line], host, {
      ...DEFAULT_CONFIG,
      eraseTouching: false,
    });

    expect(outcome).toEqual({kind: 'erased', count: 4});
    expect(await host.getPageElements('', 3)).toEqual([bar]);
  });

  it('deletes again what the first delete left on the page', async () => {
    const letters = row();
    const line = el(straight({x: 80, y: 520}, {x: 280, y: 520}));
    const host = fakeHost([...letters, line]);
    const realDelete = host.deleteElements;
    let calls = 0;
    host.deleteElements = async (nums, page, layer) => {
      calls++;
      // First call: the device silently skips the newest element (the line).
      return realDelete(calls === 1 ? nums.slice(1) : nums, page, layer);
    };
    const lines: string[] = [];

    const outcome = await handlePenUp([line], host, DEFAULT_CONFIG, {
      trace: l => lines.push(l),
    });

    expect(outcome).toMatchObject({kind: 'erased'});
    expect(calls).toBe(2);
    expect(lines).toContain('still on page after delete: 1, deleting again');
    expect(await host.getPageElements('', 3)).toEqual([]);
  });

  it('leaves the line as ink when it cuts fewer than 3 strokes', async () => {
    const letters = row().slice(0, 2);
    const line = el(straight({x: 80, y: 520}, {x: 280, y: 520}));
    const host = fakeHost([...letters, line]);

    expect(await handlePenUp([line], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'line cuts 2 strokes',
    });
    expect(host.deleted).toEqual([]);
  });

  it('does not erase on an underline that clips the letters', async () => {
    const letters = row();
    const underline = el(straight({x: 80, y: 537}, {x: 280, y: 537}));
    const host = fakeHost([...letters, underline]);

    expect(await handlePenUp([underline], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'ignored',
    });
    expect(host.deleted).toEqual([]);
  });

  it('only erases strokes, not text boxes or pictures', async () => {
    const letters = row().slice(0, 2);
    const textBox = el(letter(260, 500), {type: 500, penType: null});
    const line = el(straight({x: 80, y: 520}, {x: 320, y: 520}));
    const host = fakeHost([...letters, textBox, line]);

    expect(await handlePenUp([line], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'ignored',
    });
  });

  it('respects the per-gesture switches', async () => {
    const line = el(straight({x: 80, y: 520}, {x: 280, y: 520}));
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([...row(), line, loop]);
    const off = {gestures: {loopSelect: false, lineErase: false}};

    expect(await handlePenUp([line], host, DEFAULT_CONFIG, off)).toEqual({
      kind: 'ignored',
      reason: 'not a gesture',
    });
    expect(await handlePenUp([loop], host, DEFAULT_CONFIG, off)).toEqual({
      kind: 'ignored',
      reason: 'not a gesture',
    });
    expect(host.deleted).toEqual([]);
  });
});
