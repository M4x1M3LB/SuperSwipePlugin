import {DEFAULT_CONFIG} from '../src/config';
import {boundingBox, type Box, type Pt} from '../src/geometry';
import {handlePenUp, type Host, type PageElement} from '../src/selector';

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

/** A handwritten letter: a zig-zag 30 px wide and 40 px tall. */
function letter(x: number, y: number): Pt[] {
  return [0, 1, 2, 3, 4, 5, 6].map(i => ({
    x: x + i * 5,
    y: y + (i % 2 === 0 ? 0 : 40),
  }));
}

/** Back and forth between x0 and x1, `passes` times, around height y. */
function scribble(x0: number, x1: number, y: number, passes = 5): Pt[] {
  const pts: Pt[] = [];
  for (let p = 0; p < passes; p++) {
    const [from, to] = p % 2 ? [x1, x0] : [x0, x1];
    for (let i = 0; i <= 10; i++) {
      pts.push({x: from + ((to - from) * i) / 10, y: y + p * 4});
    }
  }
  return pts;
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

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.right <= outer.right &&
    inner.bottom <= outer.bottom
  );
}

interface FakeHost extends Host {
  /** What is on the page now. */
  page(): PageElement[];
  deleted: number[][];
  lassoed: Box[];
  lassoDeletes: number;
  refreshed: number;
  remembered: PageElement[][];
}

/**
 * Simulates the device: a lasso selects the elements whose box lies inside
 * the rectangle; deleting by number removes elements one at a time in the
 * order given, renumbering the page after each removal.
 */
function fakeHost(
  initial: PageElement[],
  overrides: Partial<Host> = {},
): FakeHost {
  let current = [...initial];
  let selection: PageElement[] = [];
  const boxes = new Map<PageElement, Box>();
  const boxOf = async (e: PageElement) => {
    if (!boxes.has(e)) {
      boxes.set(e, boundingBox(await e.outline()));
    }
    return boxes.get(e)!;
  };
  const remove = (gone: PageElement) => {
    const num = gone.numInPage;
    current = current.filter(e => e !== gone);
    current.forEach(e => {
      if (e.numInPage > num) {
        e.numInPage--;
      }
    });
  };

  const host: FakeHost = {
    page: () => current,
    deleted: [],
    lassoed: [],
    lassoDeletes: 0,
    refreshed: 0,
    remembered: [],
    getCurrentFilePath: async () => '/storage/emulated/0/Note/demo.note',
    getCurrentPageNum: async () => 3,
    getPageSize: async () => ({width: 1404, height: 1872}),
    getLastElement: async () =>
      current.reduce<PageElement | null>(
        (a, e) => (!a || e.numInPage > a.numInPage ? e : a),
        null,
      ),
    getPageElements: async () => current,
    ensureFileAccess: async () => true,
    waitForPenUp: async () => {},
    lassoRect: async rect => {
      host.lassoed.push(rect);
      selection = [];
      for (const e of current) {
        if (contains(rect, await boxOf(e))) {
          selection.push(e);
        }
      }
      return true;
    },
    getLassoElements: async () => selection,
    deleteLassoElements: async () => {
      host.lassoDeletes++;
      selection.forEach(remove);
      selection = [];
      return true;
    },
    clearLasso: async () => {
      selection = [];
    },
    deleteElements: async nums => {
      host.deleted.push(nums);
      for (const num of nums) {
        const target = current.find(e => e.numInPage === num);
        if (target) {
          remove(target);
        }
      }
      return true;
    },
    rememberErased: (_path, _page, _layer, elements) => {
      host.remembered.push(elements);
    },
    refreshPage: async () => {
      host.refreshed++;
    },
    release: () => {},
    ...overrides,
  };
  return host;
}

beforeEach(() => {
  nextNum = 1;
});

describe('loop to select', () => {
  it('removes the loop and lassoes only what it encloses', async () => {
    const inside1 = el(word(420, 480));
    const inside2 = el(word(520, 520, 60));
    const outside = el(word(1000, 1500));
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([inside1, outside, inside2, loop]);

    const outcome = await handlePenUp([loop], host, DEFAULT_CONFIG);

    expect(outcome).toMatchObject({kind: 'selected', count: 2});
    expect(host.deleted).toEqual([[4]]);
    expect(host.page()).toEqual([inside1, outside, inside2]);
    const rect = host.lassoed[host.lassoed.length - 1];
    expect(rect.left).toBeLessThanOrEqual(420);
    expect(rect.right).toBeGreaterThanOrEqual(580);
    expect(rect.right).toBeLessThan(1000);
  });

  it('leaves a loop around empty space as ink', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(1000, 1500)), loop]);

    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'loop encloses nothing',
    });
    expect(host.deleted).toEqual([]);
  });

  it('ignores elements partly outside the loop and on other layers', async () => {
    const straddling = el(word(650, 500, 300));
    const otherLayer = el(word(480, 500), {layerNum: 1});
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([straddling, otherLayer, loop]);

    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toMatchObject({
      reason: 'loop encloses nothing',
    });
  });

  it('refreshes the page when the lasso cannot be created', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop]);
    const realLasso = host.lassoRect;
    let calls = 0;
    host.lassoRect = rect =>
      ++calls === 1 ? realLasso(rect) : Promise.resolve(false);

    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'failed',
    });
    expect(host.refreshed).toBe(1);
  });
});

describe('scribble to erase', () => {
  /** "the cat": four letters on a row, 40 px apart, top at y=500. */
  function row(): PageElement[] {
    return [100, 140, 180, 220].map(x => el(letter(x, 500)));
  }

  it('erases the scribble and what it covers, with the lasso', async () => {
    const letters = row();
    const other = el(letter(100, 800));
    const scrib = el(scribble(95, 260, 510));
    const host = fakeHost([...letters, other, scrib]);

    const outcome = await handlePenUp([scrib], host, DEFAULT_CONFIG);

    expect(outcome).toEqual({kind: 'erased', count: 4});
    expect(host.lassoDeletes).toBe(1);
    expect(host.deleted).toEqual([]); // undo history kept
    expect(host.refreshed).toBe(0);
    expect(host.page()).toEqual([other]);
    expect(host.remembered).toEqual([letters]);
  });

  it('also erases strokes touching a covered one (rest of the word)', async () => {
    const letters = row();
    // A connector from the end of the last letter, up and away to the right.
    const tail = el([
      {x: 252, y: 500},
      {x: 300, y: 470},
      {x: 330, y: 460},
    ]);
    // An "i" dot 15 px above the row: not touching, so it stays.
    const dot = el([
      {x: 150, y: 485},
      {x: 151, y: 486},
    ]);
    const scrib = el(scribble(95, 250, 510));
    const host = fakeHost([...letters, tail, dot, scrib]);

    const outcome = await handlePenUp([scrib], host, DEFAULT_CONFIG);

    expect(outcome).toEqual({kind: 'erased', count: 5});
    expect(host.page()).toEqual([dot]);
  });

  it('deletes by number when the lasso would take more than wanted', async () => {
    const letters = row();
    // An "i" dot inside the area the lasso has to cover, not touched.
    const dot = el([
      {x: 175, y: 515},
      {x: 176, y: 516},
    ]);
    const scrib = el(scribble(95, 260, 500, 5).map(p => ({...p, y: p.y + 30})));
    const host = fakeHost([...letters, dot, scrib]);
    const lines: string[] = [];

    const outcome = await handlePenUp([scrib], host, DEFAULT_CONFIG, {
      trace: l => lines.push(l),
    });

    expect(outcome).toEqual({kind: 'erased', count: 4});
    expect(host.lassoDeletes).toBe(0);
    // Newest first, so no removal shifts the numbers of the others.
    expect(host.deleted).toEqual([[6, 4, 3, 2, 1]]);
    expect(host.page()).toEqual([dot]);
    expect(host.refreshed).toBe(1);
    expect(lines.join('\n')).toContain('deleting by number');
  });

  it('leaves a scribble on empty paper as ink', async () => {
    const scrib = el(scribble(95, 260, 900));
    const host = fakeHost([...row(), scrib]);

    expect(await handlePenUp([scrib], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'scribble covers nothing',
    });
    expect(host.page()).toHaveLength(5);
  });

  it('respects the per-gesture switches', async () => {
    const scrib = el(scribble(95, 260, 510));
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([...row(), scrib, loop]);
    const off = {gestures: {loopSelect: false, scribbleErase: false}};

    for (const g of [scrib, loop]) {
      expect(await handlePenUp([g], host, DEFAULT_CONFIG, off)).toEqual({
        kind: 'ignored',
        reason: 'not a gesture',
      });
    }
    expect(host.page()).toHaveLength(6);
  });
});

describe('both gestures', () => {
  it('ignores open strokes without touching the page', async () => {
    const arc = Array.from({length: 40}, (_, i) => ({
      x: 500 + 200 * Math.cos((i / 39) * Math.PI),
      y: 500 + 200 * Math.sin((i / 39) * Math.PI),
    }));
    const stroke = el(arc);
    const host = fakeHost([stroke]);
    const getLastElement = jest.spyOn(host, 'getLastElement');

    expect(await handlePenUp([stroke], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'ignored',
    });
    expect(getLastElement).not.toHaveBeenCalled();
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
    expect(host.page()).toHaveLength(2);
  });

  it('does not edit anything when file access is refused', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop], {
      ensureFileAccess: async () => false,
    });
    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'failed',
    });
    expect(host.lassoed).toEqual([]);
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
    expect(host.lassoed).toEqual([]);
  });

  it('does not edit the page once the caller gave up', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop]);

    expect(
      await handlePenUp([loop], host, DEFAULT_CONFIG, {
        isCancelled: () => true,
      }),
    ).toMatchObject({kind: 'ignored'});
    expect(host.lassoed).toEqual([]);
  });

  it('waits for the pen to lift before any lasso or delete', async () => {
    const order: string[] = [];
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop], {
      waitForPenUp: async () => {
        order.push('wait');
      },
    });
    const realLasso = host.lassoRect;
    host.lassoRect = rect => {
      order.push('lasso');
      return realLasso(rect);
    };
    await handlePenUp([loop], host, DEFAULT_CONFIG);
    expect(order[0]).toBe('wait');
  });
});

describe('finding the gesture stroke', () => {
  it('uses the last element from memory, without reading the page file', async () => {
    const before = el(word(480, 500));
    const pagePoints = ellipse(520, 500, 200, 120);
    // Pen-up copy: other uuid, not numbered, other coordinates.
    const penUp = el(
      pagePoints.map(p => ({x: 20000 - p.y * 11, y: p.x * 11})),
      {uuid: 'pen-up', numInPage: 0, pageNum: undefined as unknown as number},
    );
    const stored = el(pagePoints);
    const host = fakeHost([before, stored]);
    const getPageElements = jest.spyOn(host, 'getPageElements');
    const lines: string[] = [];

    expect(
      await handlePenUp([penUp], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toMatchObject({
      kind: 'selected',
      count: 1,
    });
    expect(getPageElements).not.toHaveBeenCalled();
    expect(host.deleted).toEqual([[3]]);
  });

  it('falls back to the page file when the last element is another one', async () => {
    const before = el(word(480, 500));
    const pagePoints = ellipse(520, 500, 200, 120);
    const penUp = el(pagePoints, {uuid: 'pen-up', numInPage: 0});
    const stored = el(pagePoints);
    const newer = el(word(1000, 1500));
    const host = fakeHost([before, stored, newer]);
    const lines: string[] = [];

    expect(
      await handlePenUp([penUp], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toMatchObject({kind: 'selected'});
    expect(host.deleted).toEqual([[3]]);
    expect(lines).toContain('last element has 20 points, not 81');
  });

  it('explains in the trace when the gesture stroke is missing', async () => {
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
});
