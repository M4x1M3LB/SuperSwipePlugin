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

  it('reports a failure when the lasso cannot be created', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop], {
      lassoRect: async () => false,
    });

    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'failed',
    });
  });
});

describe('handlePenUp: loop range', () => {
  beforeEach(() => {
    nextNum = 1;
  });

  it('selects a word the loop grazes or slightly cuts through', async () => {
    // Loop spans x 320..720; the word runs 15 px past its right edge.
    const grazed = el(word(640, 500, 95));
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([grazed, loop]);

    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
      count: 1,
    });
  });

  it('selects a word at least half inside the loop', async () => {
    const half = el(word(660, 500, 100)); // x 660..760, loop edge at 720
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([half, loop]);

    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
    });
  });

  it('accepts a small loop whose ends stay 80 px apart', async () => {
    // A 120 x 100 px loop stopped at three quarters: ends ~82 px apart.
    // Accepted from 0.0.7 on (previously limited to 60 px).
    const open = Array.from({length: 61}, (_, i) => {
      const a = (i / 80) * 2 * Math.PI;
      return {x: 520 + 60 * Math.cos(a), y: 500 + 50 * Math.sin(a)};
    });
    const loop = el(open);
    const host = fakeHost([el(word(505, 495, 30)), loop]);

    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
    });
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

describe('handlePenUp: margin ✕ to erase', () => {
  beforeEach(() => {
    nextNum = 1;
  });

  /** Four letters side by side, 40 px apart, top at y=top. */
  function row(top = 500): PageElement[] {
    return [100, 140, 180, 220].map(x => el(letter(x, top)));
  }

  /** The two strokes of a 40 px ✕ centred on (60, 520), in the margin. */
  const down = straight({x: 40, y: 500}, {x: 80, y: 540}, 12);
  const up = straight({x: 40, y: 540}, {x: 80, y: 500}, 12);

  /** Draw the ✕: the second stroke arrives `delay` ms after the first. */
  function cross(
    host: ReturnType<typeof fakeHost>,
    second: PageElement,
    delay = 500,
  ) {
    return handlePenUp([second], host, DEFAULT_CONFIG, {
      previous: {points: down, at: 1000},
      now: 1000 + delay,
    });
  }

  it('erases the line of writing next to the ✕, and the ✕', async () => {
    const above = row(420);
    const letters = row(500);
    const below = row(580);
    const first = el(down);
    const second = el(up);
    const host = fakeHost([...above, ...letters, ...below, first, second]);

    expect(await cross(host, second)).toEqual({kind: 'erased', count: 4});
    // Newest first, so no removal shifts the numbers of the others.
    expect(host.deleted).toEqual([[14, 13, 8, 7, 6, 5]]);
    expect(await host.getPageElements('', 3)).toEqual([...above, ...below]);
    expect(host.remembered).toEqual([letters]);
  });

  it('takes the whole line: dots, far words, touching strokes', async () => {
    const letters = row(500);
    const dot = el([
      {x: 150, y: 488},
      {x: 151, y: 489},
    ]);
    const farWord = el(word(600, 512));
    // A descender reaching down from the last letter (centre below the band).
    const descender = el(straight({x: 245, y: 541}, {x: 242, y: 600}, 6));
    const first = el(down);
    const second = el(up);
    const host = fakeHost([...letters, dot, farWord, descender, first, second]);

    expect(await cross(host, second)).toEqual({kind: 'erased', count: 7});
    expect(await host.getPageElements('', 3)).toEqual([]);
  });

  it('leaves a written "x" alone: writing on its left', async () => {
    const before = el(word(-60 + 60, 515, 25)); // x 0..25, left of the ✕
    const letters = row(500);
    const first = el(down);
    const second = el(up);
    const host = fakeHost([before, ...letters, first, second]);

    expect(await cross(host, second)).toEqual({
      kind: 'ignored',
      reason: 'writing on the left of the mark',
    });
    expect(host.deleted).toEqual([]);
  });

  it('leaves a ✕ with nothing next to it as ink', async () => {
    const first = el(down);
    const second = el(up);
    const host = fakeHost([...row(700), first, second]);

    expect(await cross(host, second)).toEqual({
      kind: 'ignored',
      reason: 'no writing next to the mark',
    });
  });

  it('says in the trace why a stroke pair is not a ✕', async () => {
    const first = el(down);
    const second = el(straight({x: 40, y: 505}, {x: 80, y: 535}, 12));
    const host = fakeHost([...row(500), first, second]);
    const lines: string[] = [];

    await handlePenUp([second], host, DEFAULT_CONFIG, {
      previous: {points: down, at: 0},
      now: 100,
      trace: l => lines.push(l),
    });
    expect(lines.join('\n')).toContain('✕ check: strokes too parallel');
  });

  it('needs both strokes within 2 seconds', async () => {
    const first = el(down);
    const second = el(up);
    const host = fakeHost([...row(500), first, second]);

    expect(await cross(host, second, 2500)).toEqual({
      kind: 'ignored',
      reason: 'not a gesture',
    });
  });

  it('does not touch the page for a lone short stroke', async () => {
    const stroke = el(up);
    const host = fakeHost([...row(500), stroke]);
    const getPageElements = jest.spyOn(host, 'getPageElements');

    expect(await handlePenUp([stroke], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'not a gesture',
    });
    expect(getPageElements).not.toHaveBeenCalled();
  });

  it('remembers each stroke for the next one', async () => {
    const stroke = el(up);
    const host = fakeHost([stroke]);
    const remember = jest.fn();

    await handlePenUp([stroke], host, DEFAULT_CONFIG, {remember});
    expect(remember).toHaveBeenCalledWith(up);
  });

  it('respects the per-gesture switches', async () => {
    const first = el(down);
    const second = el(up);
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([...row(), first, second, loop]);
    const off = {
      gestures: {loopSelect: false, marginErase: false},
      previous: {points: down, at: 0},
      now: 100,
    };

    for (const g of [second, loop]) {
      expect(await handlePenUp([g], host, DEFAULT_CONFIG, off)).toEqual({
        kind: 'ignored',
        reason: 'not a gesture',
      });
    }
    expect(host.deleted).toEqual([]);
  });
});
