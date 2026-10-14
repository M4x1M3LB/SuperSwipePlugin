import {DEFAULT_CONFIG} from '../src/config';
import type {Box, Pt} from '../src/geometry';
import {
  handlePenUp,
  outlinesOf,
  type Host,
  type PageElement,
} from '../src/selector';

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
  const e: PageElement = {
    uuid: `uuid-${num}`,
    type: 0,
    numInPage: num,
    pageNum: 3,
    layerNum: 0,
    penType: 10,
    outline: async () => points,
    ...overrides,
  };
  // As the device host: the count and first point without the rest.
  e.pointCount ??= async () => (await e.outline()).length;
  e.firstPoint ??= async () => (await e.outline())[0];
  return e;
}

/** An element without pointCount/firstPoint (hosts that only read outlines). */
function plainEl(points: Pt[]): PageElement {
  const e = el(points);
  delete e.pointCount;
  delete e.firstPoint;
  return e;
}

const flush = () => new Promise(r => setImmediate(r));

interface FakeHost extends Host {
  deleted: number[][];
  lassoed: Box[];
  remembered: PageElement[][];
  /** Calls in order: 'delete', 'reload', 'lasso', 'ask'. */
  calls: string[];
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
    calls: [],
    getCurrentFilePath: async () => '/storage/emulated/0/Note/demo.note',
    getCurrentPageNum: async () => 3,
    getPageSize: async () => ({width: 1404, height: 1872}),
    getPageElements: async () => current,
    ensureFileAccess: async () => true,
    waitForPenUp: async () => {},
    deleteElements: async nums => {
      host.calls.push('delete');
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
    reloadIfQuiet: async () => {
      host.calls.push('reload');
      return true;
    },
    rememberErased: (_path, _page, _layer, elements) => {
      host.remembered.push(elements);
    },
    lassoRect: async rect => {
      host.calls.push('lasso');
      host.lassoed.push(rect);
      return true;
    },
    penDownCount: () => 0,
    askAboveOrBelow: async () => {
      host.calls.push('ask');
      return 'below';
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

  it('selects right after removing the loop: no check, no reload', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop]);
    let reads = 0;
    const read = host.getPageElements;
    host.getPageElements = (...args) => {
      reads++;
      return read(...args);
    };

    await handlePenUp([loop], host, DEFAULT_CONFIG);
    expect(host.calls).toEqual(['delete', 'lasso']);
    expect(reads).toBe(1);
  });

  it('finds a loop followed by more writing in the same pen-up event', async () => {
    // Quick strokes arrive together: the loop is not the last one.
    const inside = el(word(480, 500));
    const loop = el(ellipse(520, 500, 200, 120));
    const after = el(word(900, 1200));
    const host = fakeHost([inside, loop, after]);

    expect(
      await handlePenUp([loop, after], host, DEFAULT_CONFIG),
    ).toMatchObject({kind: 'selected', count: 1});
    expect(host.deleted).toEqual([[loop.numInPage]]);
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

describe('handlePenUp: margin wave to erase', () => {
  beforeEach(() => {
    nextNum = 1;
  });

  /** Four letters side by side (x 100..250), 40 px apart, top at y=top. */
  function row(top = 500): PageElement[] {
    return [100, 140, 180, 220].map(x => el(letter(x, top)));
  }

  /** A 60 x 24 px wave with 3 bounces from x = left, level with the row. */
  function wave(left: number, span = 3 * Math.PI): Pt[] {
    return Array.from({length: 61}, (_, i) => ({
      x: left + i,
      y: 520 - 12 * Math.sin((span * i) / 60),
    }));
  }
  // The writing must start 20 px or more away.
  const leftShell = wave(10); // x 10..70, before the row (x 100..250)
  const rightShell = wave(280); // x 280..340, after the row

  it('in the left margin, erases the line on its right, and itself', async () => {
    const above = row(420);
    const letters = row(500);
    const below = row(580);
    const mark = el(leftShell);
    const host = fakeHost([...above, ...letters, ...below, mark]);
    const lines: string[] = [];

    expect(
      await handlePenUp([mark], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toEqual({kind: 'erased', count: 4});
    // Newest first, so no removal shifts the numbers of the others.
    expect(host.deleted).toEqual([[13, 8, 7, 6, 5]]);
    expect(await host.getPageElements('', 3)).toEqual([...above, ...below]);
    expect(host.remembered).toEqual([letters]);
    expect(lines).toContain('erasing the line on its right');
  });

  it('in the right margin, erases the line on its left, and itself', async () => {
    const above = row(420);
    const letters = row(500);
    const mark = el(rightShell);
    const host = fakeHost([...above, ...letters, mark]);
    const lines: string[] = [];

    expect(
      await handlePenUp([mark], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toEqual({kind: 'erased', count: 4});
    expect(await host.getPageElements('', 3)).toEqual(above);
    expect(lines).toContain('erasing the line on its left');
  });

  it('refreshes the screen after erasing a line', async () => {
    const mark = el(leftShell);
    const host = fakeHost([...row(500), mark]);

    await handlePenUp([mark], host, DEFAULT_CONFIG);
    expect(host.calls).toEqual(['delete', 'reload']);
  });

  it('does not reload while the saved file still has the deleted strokes', async () => {
    const mark = el(leftShell);
    const host = fakeHost([...row(500), mark]);
    // The device "forgets" the deletion: the file keeps the strokes.
    host.deleteElements = async nums => {
      host.calls.push('delete');
      host.deleted.push(nums);
      return true;
    };
    const lines: string[] = [];

    await handlePenUp([mark], host, DEFAULT_CONFIG, {
      trace: l => lines.push(l),
    });
    expect(host.calls).not.toContain('reload');
    expect(lines).toContain(
      'not refreshed: the saved file still had the deleted strokes',
    );
  });

  it('does not refresh the screen when that is switched off', async () => {
    const mark = el(leftShell);
    const host = fakeHost([...row(500), mark]);

    await handlePenUp([mark], host, DEFAULT_CONFIG, {
      gestures: {loopSelect: true, marginErase: true, screenRefresh: false},
    });
    expect(host.calls).toEqual(['delete']);
  });

  it('takes the whole line: dots, far words, touching strokes', async () => {
    const letters = row(500);
    const dot = el([
      {x: 150, y: 488},
      {x: 151, y: 489},
    ]);
    const farWord = el(word(600, 512));
    const descender = el(straight({x: 245, y: 541}, {x: 242, y: 600}, 6));
    const mark = el(leftShell);
    const host = fakeHost([...letters, dot, farWord, descender, mark]);

    expect(await handlePenUp([mark], host, DEFAULT_CONFIG)).toEqual({
      kind: 'erased',
      count: 7,
    });
    expect(await host.getPageElements('', 3)).toEqual([]);
  });

  it('is found before the loop check', async () => {
    const lines: string[] = [];
    const mark = el(leftShell);
    await handlePenUp([mark], fakeHost([...row(500), mark]), DEFAULT_CONFIG, {
      trace: l => lines.push(l),
    });
    expect(lines).toContain('shape: wave');
  });

  it('leaves a wave inside a line of writing alone', async () => {
    const mark = el(wave(100)); // between two words
    const host = fakeHost([el(word(0, 515, 25)), el(word(260, 515, 40)), mark]);

    expect(await handlePenUp([mark], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'writing on both sides of the wave, or touching it',
    });
    expect(host.deleted).toEqual([]);
  });

  it('leaves a wave with nothing next to it as ink', async () => {
    const mark = el(leftShell);
    const host = fakeHost([...row(700), mark]);

    expect(await handlePenUp([mark], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'no writing next to the wave',
    });
  });

  it('a circle drawn twice around a word is still a loop', async () => {
    const twice = Array.from({length: 161}, (_, i) => {
      const a = (i / 80) * 2 * Math.PI;
      return {x: 520 + 200 * Math.cos(a), y: 500 + 120 * Math.sin(a)};
    });
    const loop = el(twice);
    const host = fakeHost([el(word(480, 500)), loop]);

    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
    });
  });

  it('says in the trace why a stroke is not a wave', async () => {
    const stroke = el(word(100, 100, 200));
    const lines: string[] = [];
    await handlePenUp([stroke], fakeHost([stroke]), DEFAULT_CONFIG, {
      trace: l => lines.push(l),
    });
    expect(lines.join('\n')).toContain('wave check:');
  });

  it('leaves a wave written too close to the line alone', async () => {
    const mark = el(wave(30)); // x 30..90, 10 px before the row
    const host = fakeHost([...row(500), mark]);

    expect(await handlePenUp([mark], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'wave too close to the writing (10 px, needs 20)',
    });
    expect(host.deleted).toEqual([]);
  });

  it('leaves a plain tilde as ink', async () => {
    const tilde = el(wave(10, 2 * Math.PI));
    const host = fakeHost([...row(500), tilde]);

    expect(await handlePenUp([tilde], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'not a gesture',
    });
  });

  it('finds a wave whose pen-up copy has its axes swapped', async () => {
    const mark = el(leftShell);
    const penUp = el(leftShell.map(p => ({x: p.y, y: p.x})));
    penUp.uuid = mark.uuid;
    const host = fakeHost([...row(500), mark]);

    expect(await handlePenUp([penUp], host, DEFAULT_CONFIG)).toEqual({
      kind: 'erased',
      count: 4,
    });
  });

  it('respects the per-gesture switches', async () => {
    const mark = el(leftShell);
    const loop = el(ellipse(520, 500, 200, 120));
    const line = el(straight({x: 100, y: 900}, {x: 700, y: 902}));
    const host = fakeHost([...row(), mark, loop, line]);
    const off = {
      gestures: {loopSelect: false, marginErase: false, lineSelect: false},
    };

    for (const g of [mark, loop, line]) {
      expect(await handlePenUp([g], host, DEFAULT_CONFIG, off)).toEqual({
        kind: 'ignored',
        reason: 'not a gesture',
      });
    }
    expect(host.deleted).toEqual([]);
  });
});

describe('handlePenUp: line to select above or below', () => {
  beforeEach(() => {
    nextNum = 1;
  });

  const separator = () => el(straight({x: 100, y: 800}, {x: 1000, y: 802}));

  it('asks, then removes the line and selects the side picked', async () => {
    const above = [el(word(100, 600)), el(word(300, 700))];
    const below = [el(word(100, 900)), el(word(300, 1000))];
    const line = separator();
    const host = fakeHost([...above, ...below, line]);
    let kept = 0;

    const outcome = await handlePenUp([line], host, DEFAULT_CONFIG, {
      keepAlive: () => kept++,
    });
    expect(outcome).toMatchObject({kind: 'selected', count: 2});
    expect(host.calls).toEqual(['ask', 'delete', 'lasso']);
    expect(host.deleted).toEqual([[5]]);
    expect(host.lassoed[0].top).toBeGreaterThan(890);
    expect(kept).toBe(1);

    host.askAboveOrBelow = async () => 'above';
    const line2 = separator();
    const host2 = fakeHost([...above, ...below, line2]);
    host2.askAboveOrBelow = host.askAboveOrBelow;
    await handlePenUp([line2], host2, DEFAULT_CONFIG);
    expect(host2.lassoed[0].bottom).toBeLessThan(720);
  });

  it('does not ask when there is writing on one side only', async () => {
    const line = separator();
    const host = fakeHost([el(word(100, 600)), line]);

    expect(await handlePenUp([line], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
      count: 1,
    });
    expect(host.calls).toEqual(['delete', 'lasso']);
  });

  it('does nothing when the dialog is not answered', async () => {
    const line = separator();
    const host = fakeHost([el(word(100, 600)), el(word(100, 900)), line]);
    host.askAboveOrBelow = async () => null;

    expect(await handlePenUp([line], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'no side chosen',
    });
    expect(host.deleted).toEqual([]);
  });

  it('leaves underlines, strike-throughs and short lines as ink', async () => {
    const underline = el(straight({x: 100, y: 615}, {x: 600, y: 615}));
    const host = fakeHost([el(word(100, 600)), underline]);
    expect(await handlePenUp([underline], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'ignored',
      reason: expect.stringContaining('an underline'),
    });

    const strike = el(straight({x: 50, y: 603}, {x: 600, y: 603}));
    const host2 = fakeHost([el(word(100, 600)), strike]);
    expect(await handlePenUp([strike], host2, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'line crosses the writing',
    });

    // 200 px: worth a look, but under 12 % of a 1920 px page.
    const short = el(straight({x: 100, y: 800}, {x: 300, y: 800}));
    const host3 = fakeHost([el(word(100, 600)), short]);
    host3.getPageSize = async () => ({width: 1920, height: 2560});
    expect(await handlePenUp([short], host3, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'line too short (200 px, needs 230)',
    });
  });

  it('takes a wobbly line for a line, even when it passes for a wave', async () => {
    // 800 x 110 px, 3 bounces: wave-shaped, but far too wide for a wave.
    const wobbly = Array.from({length: 121}, (_, i) => ({
      x: 100 + (800 * i) / 120,
      y: 800 - 55 * Math.sin((3 * Math.PI * i) / 120),
    }));
    const line = el(wobbly);
    const host = fakeHost([el(word(100, 600)), line]);
    const lines: string[] = [];

    expect(
      await handlePenUp([line], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toMatchObject({kind: 'selected', count: 1});
    expect(lines).toContain(
      'wave on the page: too big (800 px), trying a line',
    );
  });

  it('takes a short line: 12 % of the page is enough', async () => {
    const line = el(straight({x: 100, y: 800}, {x: 275, y: 806}));
    const host = fakeHost([el(word(100, 600)), line]);

    expect(await handlePenUp([line], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
      count: 1,
    });
  });

  it('never reads the page for a line under 168 px, in any units', async () => {
    const short = el(straight({x: 100, y: 800}, {x: 260, y: 800}));
    // The same 160 px line as the digitiser reports it: turned a quarter
    // and 8.45 times larger (EMR units).
    const emr = el(
      straight(
        {x: 800 * 8.45, y: 1300 * 8.45},
        {x: 800 * 8.45, y: 1140 * 8.45},
      ),
    );
    for (const stroke of [short, emr]) {
      const host = fakeHost([stroke]);
      let reads = 0;
      host.getPageElements = async () => {
        reads++;
        return [stroke];
      };
      const lines: string[] = [];
      expect(
        await handlePenUp([stroke], host, DEFAULT_CONFIG, {
          trace: l => lines.push(l),
        }),
      ).toEqual({kind: 'ignored', reason: 'not a gesture'});
      expect(reads).toBe(0);
      expect(lines).toContain('  line check: too short (160 px, needs 168)');
    }
  });

  it('takes a short wobbly line for a line when nothing is level with it', async () => {
    // 260 x 32 px with 3 bounces: passes for a wave, but has no writing
    // beside it to erase.
    const wobbly = Array.from({length: 61}, (_, i) => ({
      x: 100 + (260 * i) / 60,
      y: 800 - 16 * Math.sin((3 * Math.PI * i) / 60),
    }));
    const line = el(wobbly);
    const host = fakeHost([el(word(100, 600)), line]);
    const lines: string[] = [];

    expect(
      await handlePenUp([line], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toMatchObject({kind: 'selected', count: 1});
    expect(lines).toContain('no writing next to the wave, trying a line');
  });

  it('leaves a blank after a label as ink ("Name: ____")', async () => {
    const blank = el(straight({x: 220, y: 606}, {x: 480, y: 606}));
    const host = fakeHost([el(word(100, 400)), el(word(100, 600, 100)), blank]);

    expect(await handlePenUp([blank], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'writing level with the line (a blank or an arrow?)',
    });
    expect(host.deleted).toEqual([]);
  });

  it('leaves an underline drawn a little low as ink', async () => {
    // 26 px under the phrase: more than 20, less than 40.
    const underline = el(straight({x: 95, y: 632}, {x: 330, y: 632}));
    const host = fakeHost([el(word(100, 600, 220)), underline]);

    expect(await handlePenUp([underline], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'ignored',
      reason: expect.stringContaining('an underline'),
    });
    expect(host.deleted).toEqual([]);
  });

  it('never reads the page for a dash', async () => {
    const dash = el(straight({x: 100, y: 800}, {x: 140, y: 800}));
    const host = fakeHost([dash]);
    let reads = 0;
    host.getPageElements = async () => {
      reads++;
      return [dash];
    };

    await handlePenUp([dash], host, DEFAULT_CONFIG);
    expect(reads).toBe(0);
  });
});

describe('handlePenUp: margin bar to select a block', () => {
  beforeEach(() => {
    nextNum = 1;
  });

  /** Lines of four letters (x 100..250), 80 px apart. */
  const rows = (tops: number[], x = 100) =>
    tops.flatMap(t => [0, 40, 80, 120].map(dx => el(letter(x + dx, t))));
  const bar = (x: number, top = 495, bottom = 705) =>
    el(straight({x, y: top}, {x: x + 3, y: bottom}));

  it('in the left margin, selects the lines beside it and removes it', async () => {
    const before = rows([420]);
    const block = rows([500, 580, 660]);
    const after = rows([740]);
    const mark = bar(70);
    const host = fakeHost([...before, ...block, ...after, mark]);
    const lines: string[] = [];

    expect(
      await handlePenUp([mark], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toMatchObject({kind: 'selected', count: 12});
    expect(host.deleted).toEqual([[21]]);
    expect(host.calls).toEqual(['delete', 'lasso']);
    const rect = host.lassoed[0];
    expect(rect.left).toBeLessThanOrEqual(70); // over where the bar was
    expect(rect.top).toBeGreaterThan(470);
    expect(rect.bottom).toBeLessThan(720);
    expect(lines).toContain('block on the right: 12 element(s)');
  });

  it('in the right margin, selects the lines on its left', async () => {
    const block = rows([500, 580, 660]);
    const mark = bar(300);
    const host = fakeHost([...block, mark]);
    const lines: string[] = [];

    expect(
      await handlePenUp([mark], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toMatchObject({
      kind: 'selected',
      count: 12,
    });
  });

  it('takes a [ drawn bottom to top', async () => {
    const block = rows([500, 580, 660]);
    const bracket = el([
      ...straight({x: 90, y: 705}, {x: 70, y: 705}, 6),
      ...straight({x: 70, y: 705}, {x: 72, y: 495}),
      ...straight({x: 72, y: 495}, {x: 90, y: 495}, 6),
    ]);
    const host = fakeHost([...block, bracket]);

    expect(await handlePenUp([bracket], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
      count: 12,
    });
  });

  it('leaves a column divider, a bar touching writing and a short bar as ink', async () => {
    const columns = [...rows([500, 580, 660]), ...rows([500, 580, 660], 400)];
    const divider = bar(300);
    const host = fakeHost([...columns, divider]);
    expect(await handlePenUp([divider], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'writing on both sides of the bar',
    });

    const block = rows([500, 580, 660]);
    const touching = bar(98);
    const host2 = fakeHost([...block, touching]);
    expect(await handlePenUp([touching], host2, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'bar touches the writing',
    });

    const two = rows([500, 580]);
    const short = bar(70, 500, 605); // 105 px: under 6 % of 1872
    const host3 = fakeHost([...two, short]);
    expect(await handlePenUp([short], host3, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'bar too short (105 px, needs 112)',
    });
    for (const h of [host, host2, host3]) {
      expect(h.deleted).toEqual([]);
    }
  });

  it('never reads the page for an "l" or a "1"', async () => {
    const l = el(straight({x: 300, y: 500}, {x: 302, y: 560}));
    const host = fakeHost([l]);
    let reads = 0;
    host.getPageElements = async () => {
      reads++;
      return [l];
    };

    expect(await handlePenUp([l], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'not a gesture',
    });
    expect(reads).toBe(0);
  });

  it('leaves a bar as ink when more writing follows it', async () => {
    const block = rows([500, 580, 660]);
    const mark = bar(70);
    const label = el(letter(20, 600));
    const host = fakeHost([...block, mark, label]);

    expect(await handlePenUp([mark, label], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'bar followed by more writing',
    });

    let downs = 0;
    const block2 = rows([500, 580, 660]);
    const host2 = fakeHost([...block2, bar(70)]);
    host2.penDownCount = () => downs;
    host2.waitForPenUp = async () => {
      downs++; // the pen touched the screen again meanwhile
    };
    const mark2 = (await host2.getPageElements('', 3)).slice(-1)[0];
    expect(await handlePenUp([mark2], host2, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'kept writing after the bar',
    });
    expect(host2.deleted).toEqual([]);
  });

  it('can be switched off', async () => {
    const block = rows([500, 580, 660]);
    const mark = bar(70);
    const host = fakeHost([...block, mark]);

    expect(
      await handlePenUp([mark], host, DEFAULT_CONFIG, {
        gestures: {loopSelect: true, marginErase: true, barSelect: false},
      }),
    ).toEqual({kind: 'ignored', reason: 'not a gesture'});
  });
});

describe('handlePenUp: no page read for what cannot be a gesture', () => {
  beforeEach(() => {
    nextNum = 1;
  });

  /** A host that records whether the page or the file was asked for. */
  function watchedHost(page: PageElement[]) {
    const getPageElements = jest.fn(async () => page);
    const getCurrentFilePath = jest.fn(
      async () => '/storage/emulated/0/Note/demo.note',
    );
    const host = fakeHost(page, {getPageElements, getCurrentFilePath});
    return {host, getPageElements, getCurrentFilePath};
  }

  it('leaves a closed letter in EMR units alone', async () => {
    // A 20 px "o" as the digitiser reports it: 8.45 × larger, turned a
    // quarter. A loop on the pen-up copy, but under 30 px on the page.
    const o = el(
      ellipse(500, 500, 10, 10).map(p => ({x: p.y * 8.45, y: p.x * 8.45})),
    );
    const {host, getPageElements, getCurrentFilePath} = watchedHost([o]);
    const lines: string[] = [];

    expect(
      await handlePenUp([o], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toEqual({kind: 'ignored', reason: 'not a gesture'});
    expect(getPageElements).not.toHaveBeenCalled();
    expect(getCurrentFilePath).not.toHaveBeenCalled();
    expect(lines).toContain(
      '  loop check: too small on the page (~20 px, needs 30)',
    );
  });

  it('leaves a tiny wavy scribble alone', async () => {
    // 15 x 6 px with 3 bounces: a wave on the pen-up copy, too small for
    // any gesture on the page (a wave is at least 20 px wide).
    const scribble = el(
      Array.from({length: 31}, (_, i) => ({
        x: 300 + i / 2,
        y: 500 - 3 * Math.sin((3 * Math.PI * i) / 30),
      })),
    );
    const {host, getPageElements, getCurrentFilePath} = watchedHost([
      el(word(100, 500)),
      scribble,
    ]);
    const lines: string[] = [];

    expect(
      await handlePenUp([scribble], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toEqual({kind: 'ignored', reason: 'not a gesture'});
    expect(getPageElements).not.toHaveBeenCalled();
    expect(getCurrentFilePath).not.toHaveBeenCalled();
    // One line, and still a "wave check:" for the stroke history.
    expect(lines.filter(l => l.startsWith('  '))).toEqual([
      '  wave check: too small for any gesture (~15 px)',
    ]);
  });

  it('refuses a line too short for the page from its size alone', async () => {
    const short = el(straight({x: 100, y: 800}, {x: 300, y: 800}));
    const {host, getPageElements} = watchedHost([el(word(100, 600)), short]);
    host.getPageSize = async () => ({width: 1920, height: 2560});
    const lines: string[] = [];

    expect(
      await handlePenUp([short], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toEqual({kind: 'ignored', reason: 'line too short (200 px, needs 230)'});
    expect(getPageElements).not.toHaveBeenCalled();
    expect(lines).toContain(
      'pre-check on page size 1920x2560: line too short (200 px, needs 230) (no page read)',
    );
    expect(lines.filter(l => l.includes('check:'))).not.toContainEqual(
      expect.stringContaining('pre-check'),
    );
  });

  it('refuses a bar longer than a page rule from the page size alone', async () => {
    const rule = el(straight({x: 70, y: 100}, {x: 73, y: 1600}));
    const {host, getPageElements} = watchedHost([el(word(100, 600)), rule]);

    expect(await handlePenUp([rule], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'bar too long (a page rule?)',
    });
    expect(getPageElements).not.toHaveBeenCalled();
  });

  it('reads the page size again after the save when it was unavailable before', async () => {
    const line = el(straight({x: 100, y: 800}, {x: 1000, y: 802}));
    const host = fakeHost([el(word(100, 600)), line]);
    const getPageSize = jest
      .fn<Promise<{width: number; height: number} | null>, [string, number]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({width: 1404, height: 1872});
    host.getPageSize = getPageSize;

    expect(await handlePenUp([line], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
      count: 1,
    });
    expect(getPageSize).toHaveBeenCalledTimes(2);
  });

  it('leaves a bar followed by more writing in the same burst without any host call', async () => {
    const block = [100, 140, 180, 220].flatMap(x =>
      [500, 580, 660].map(y => el(letter(x, y))),
    );
    const mark = el(straight({x: 70, y: 495}, {x: 73, y: 705}));
    const label = el(letter(20, 600));
    const {host, getPageElements, getCurrentFilePath} = watchedHost([
      ...block,
      mark,
      label,
    ]);
    const lines: string[] = [];

    expect(
      await handlePenUp([mark, label], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toEqual({kind: 'ignored', reason: 'bar followed by more writing'});
    expect(getCurrentFilePath).not.toHaveBeenCalled();
    expect(getPageElements).not.toHaveBeenCalled();
    expect(lines).toContain('bar: followed in the same burst (no page read)');
  });

  it('leaves a bar alone without reading the page once the pen is down again', async () => {
    const mark = el(straight({x: 70, y: 495}, {x: 73, y: 705}));
    const {host, getPageElements} = watchedHost([el(letter(100, 600)), mark]);
    let downs = 0;
    host.penDownCount = () => downs;
    host.getCurrentFilePath = async () => {
      downs++; // the pen touches the screen while we look
      return '/storage/emulated/0/Note/demo.note';
    };
    const lines: string[] = [];

    expect(
      await handlePenUp([mark], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toEqual({kind: 'ignored', reason: 'kept writing after the bar'});
    expect(getPageElements).not.toHaveBeenCalled();
    expect(lines).toContain('bar: pen down again (no page read)');
  });

  it('stops a bar as soon as the pen is down again, before reading the writing', async () => {
    const block = [100, 140, 180, 220].map(x => el(letter(x, 600)));
    const outlines = block.map(b => jest.spyOn(b, 'outline'));
    const mark = el(straight({x: 70, y: 495}, {x: 73, y: 705}));
    const host = fakeHost([...block, mark]);
    let downs = 0;
    host.penDownCount = () => downs;
    const read = host.getPageElements;
    host.getPageElements = async (...args) => {
      downs++; // during the save
      return read(...args);
    };

    expect(await handlePenUp([mark], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'kept writing after the bar',
    });
    for (const outline of outlines) {
      expect(outline).not.toHaveBeenCalled();
    }
  });
});

describe('handlePenUp: fewer and parallel device calls', () => {
  beforeEach(() => {
    nextNum = 1;
  });

  it('reads the points of every stroke of a burst at once, newest first', async () => {
    let open!: () => void;
    const gate = new Promise<void>(r => (open = r));
    const started: number[] = [];
    const strokes = [0, 1, 2].map(i => {
      const pts = letter(100, 300 + 100 * i);
      return el(pts, {
        outline: async () => {
          started.push(i);
          await gate;
          return pts;
        },
      });
    });

    const outcome = handlePenUp(strokes, fakeHost([]), DEFAULT_CONFIG);
    expect(started).toEqual([2, 1, 0]);
    open();
    expect(await outcome).toEqual({kind: 'ignored', reason: 'not a gesture'});
  });

  it('reads the page size once for a line, before the save', async () => {
    const line = el(straight({x: 100, y: 800}, {x: 1000, y: 802}));
    const host = fakeHost([el(word(100, 600)), line]);
    const order: string[] = [];
    const size = host.getPageSize;
    host.getPageSize = (...args) => {
      order.push('size');
      return size(...args);
    };
    const read = host.getPageElements;
    host.getPageElements = (...args) => {
      order.push('read');
      return read(...args);
    };

    expect(await handlePenUp([line], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
    });
    expect(order).toEqual(['size', 'read']);
  });

  it('reads the page size once for a loop, after the save', async () => {
    const loop = el(ellipse(520, 500, 200, 120));
    const host = fakeHost([el(word(480, 500)), loop]);
    const order: string[] = [];
    const size = host.getPageSize;
    host.getPageSize = (...args) => {
      order.push('size');
      return size(...args);
    };
    const read = host.getPageElements;
    host.getPageElements = (...args) => {
      order.push('read');
      return read(...args);
    };

    expect(await handlePenUp([loop], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
    });
    expect(order).toEqual(['read', 'size']);
  });

  it('finds the gesture on the page by point counts, reading only its points', async () => {
    // The stored copy is not a loop, so the flow stops before reading
    // the other strokes for the selection.
    const loopPoints = ellipse(520, 500, 200, 120);
    const penUp = el(loopPoints, {uuid: 'from-pen-up', numInPage: 0});
    const words = [100, 200, 300].map(y => {
      const pts = word(100, y);
      // As the device host: the count alone, without the points.
      return el(pts, {pointCount: async () => pts.length});
    });
    const reads = words.map(w => jest.spyOn(w, 'outline'));
    const counts = words.map(w => jest.spyOn(w, 'pointCount' as 'outline'));
    const stored = el(straight({x: 100, y: 900}, {x: 900, y: 900}, 80), {
      numInPage: 4,
    });
    const host = fakeHost([...words, stored]);

    expect(await handlePenUp([penUp], host, DEFAULT_CONFIG)).toEqual({
      kind: 'failed',
      reason: 'loop not recognised in page copy',
    });
    for (const read of reads) {
      expect(read).not.toHaveBeenCalled();
    }
    for (const count of counts) {
      expect(count).toHaveBeenCalled();
    }
  });

  it('checks the erase with point counts, reading first points only for matching counts', async () => {
    const letters = [100, 140, 180, 220].map(x => el(letter(x, 500)));
    const words = [el(word(100, 800)), el(word(100, 900)), el(word(100, 1000))];
    const firsts = words.map(w => jest.spyOn(w, 'firstPoint' as 'outline'));
    const mark = el(
      Array.from({length: 61}, (_, i) => ({
        x: 10 + i,
        y: 520 - 12 * Math.sin((3 * Math.PI * i) / 60),
      })),
    );
    const host = fakeHost([...letters, ...words, mark]);
    const lines: string[] = [];

    expect(
      await handlePenUp([mark], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toEqual({kind: 'erased', count: 4});
    expect(lines).toContain('verify: 3 strokes sized, 0 first points read');
    for (const first of firsts) {
      expect(first).not.toHaveBeenCalled();
    }
    expect(host.calls).toEqual(['delete', 'reload']);
  });

  it('still verifies the erase on hosts that only read outlines', async () => {
    const letters = [100, 140, 180, 220].map(x => plainEl(letter(x, 500)));
    const mark = plainEl(
      Array.from({length: 61}, (_, i) => ({
        x: 10 + i,
        y: 520 - 12 * Math.sin((3 * Math.PI * i) / 60),
      })),
    );
    const host = fakeHost([...letters, plainEl(word(100, 800)), mark]);
    // The device "forgets" the deletion: the file keeps the strokes.
    host.deleteElements = async nums => {
      host.calls.push('delete');
      host.deleted.push(nums);
      return true;
    };

    expect(await handlePenUp([mark], host, DEFAULT_CONFIG)).toEqual({
      kind: 'erased',
      count: 4,
    });
    expect(host.calls).toEqual(['delete', 'delete']); // found and retried
  });

  it('remembers the erased strokes after the screen is refreshed', async () => {
    const letters = [100, 140, 180, 220].map(x => el(letter(x, 500)));
    const mark = el(
      Array.from({length: 61}, (_, i) => ({
        x: 10 + i,
        y: 520 - 12 * Math.sin((3 * Math.PI * i) / 60),
      })),
    );
    const host = fakeHost([...letters, mark]);
    host.rememberErased = () => {
      host.calls.push('remember');
    };

    await handlePenUp([mark], host, DEFAULT_CONFIG);
    expect(host.calls).toEqual(['delete', 'reload', 'remember']);
  });
});

describe('outlinesOf', () => {
  it('keeps at most 64 reads in flight, starting the next as each finishes', async () => {
    let inFlight = 0;
    let started = 0;
    let most = 0;
    const pending: (() => void)[] = [];
    const elements = Array.from({length: 200}, (_, i) =>
      el([], {
        outline: () => {
          started++;
          most = Math.max(most, ++inFlight);
          return new Promise<Pt[]>(resolve =>
            pending.push(() => {
              inFlight--;
              resolve([{x: i, y: 0}]);
            }),
          );
        },
      }),
    );

    const result = outlinesOf(elements);
    await flush();
    expect(started).toBe(64);
    pending.shift()!(); // one finishes: the next starts, no batch barrier
    await flush();
    expect(started).toBe(65);
    while (pending.length > 0) {
      pending.shift()!();
      await flush();
    }
    const outlines = await result;
    expect(most).toBe(64);
    expect(outlines.map(o => o[0].x)).toEqual(elements.map((_, i) => i));
  });
});
