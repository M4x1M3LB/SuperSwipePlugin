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
      reason: 'writing on both sides of the mark, or touching it',
    });
    expect(host.deleted).toEqual([]);
  });

  it('leaves a wave with nothing next to it as ink', async () => {
    const mark = el(leftShell);
    const host = fakeHost([...row(700), mark]);

    expect(await handlePenUp([mark], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'no writing next to the mark',
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
      reason: 'mark too close to the writing (10 px, needs 20)',
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
    const host = fakeHost([...row(), mark, loop]);
    const off = {gestures: {loopSelect: false, marginErase: false}};

    for (const g of [mark, loop]) {
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

    // 350 px: worth a look, but under 30 % of the 1404 px page.
    const short = el(straight({x: 100, y: 800}, {x: 450, y: 800}));
    const host3 = fakeHost([el(word(100, 600)), short]);
    expect(await handlePenUp([short], host3, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'line too short (350 px, needs 421)',
    });
  });

  it('erases with a flat wave that is too short to be a line', async () => {
    // 360 x 60 px, 3 bounces: within a line's bend, too short for one.
    const flat = Array.from({length: 121}, (_, i) => ({
      x: 40 + 3 * i,
      y: 520 - 30 * Math.sin((3 * Math.PI * i) / 120),
    }));
    const mark = el(flat);
    const letters = [500, 540, 580].map(x => el(letter(x, 500)));
    const host = fakeHost([...letters, mark]);
    const lines: string[] = [];

    expect(
      await handlePenUp([mark], host, DEFAULT_CONFIG, {
        trace: l => lines.push(l),
      }),
    ).toEqual({kind: 'erased', count: 3});
    expect(lines).toContain('too short for a line, trying a wave');
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

describe('handlePenUp: corners to select', () => {
  beforeEach(() => {
    nextNum = 1;
  });

  const topLeft = (x: number, y: number) =>
    el([
      ...straight({x, y: y + 60}, {x, y}, 10),
      ...straight({x, y}, {x: x + 60, y}, 10),
    ]);
  const bottomRight = (x: number, y: number) =>
    el([
      ...straight({x: x - 60, y}, {x, y}, 10),
      ...straight({x, y}, {x, y: y - 60}, 10),
    ]);

  it('selects what the ┌ and ┘ enclose, removing both', async () => {
    const inside = [el(word(450, 450)), el(word(600, 600))];
    const outside = el(word(1000, 1500));
    const tl = topLeft(400, 400);
    const br = bottomRight(800, 700);
    const host = fakeHost([...inside, outside, tl, br]);

    expect(await handlePenUp([br], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
      count: 2,
    });
    expect(host.deleted).toEqual([[5, 4]]);
    expect(host.calls).toEqual(['delete', 'lasso']);
    const rect = host.lassoed[0];
    expect(rect.left).toBeGreaterThan(440);
    expect(rect.right).toBeLessThan(700);
  });

  it('works in either order', async () => {
    const inside = el(word(450, 450));
    const br = bottomRight(800, 700);
    const tl = topLeft(400, 400);
    const host = fakeHost([inside, br, tl]);

    expect(await handlePenUp([tl], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'selected',
      count: 1,
    });
  });

  it('leaves a lone corner as ink, waiting for its partner', async () => {
    const tl = topLeft(400, 400);
    const host = fakeHost([el(word(450, 450)), tl]);

    expect(await handlePenUp([tl], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'corner without its partner (yet)',
    });
    expect(host.deleted).toEqual([]);
  });

  it('ignores a ┘ that is not below and right of the ┌', async () => {
    const tl = topLeft(400, 400);
    const br = bottomRight(380, 900); // left of the ┌
    const host = fakeHost([el(word(450, 450)), tl, br]);

    expect(await handlePenUp([br], host, DEFAULT_CONFIG)).toMatchObject({
      kind: 'ignored',
    });
  });

  it('leaves an empty rectangle as ink', async () => {
    const tl = topLeft(400, 400);
    const br = bottomRight(800, 700);
    const host = fakeHost([el(word(1000, 1500)), tl, br]);

    expect(await handlePenUp([br], host, DEFAULT_CONFIG)).toEqual({
      kind: 'ignored',
      reason: 'rectangle encloses nothing',
    });
  });
});
