import {
  DEFAULT_LOOP_OPTIONS,
  findClosedLoop,
  checkCrossMark,
  findCrossMark,
  findWritingLine,
  strokesTouch,
  fractionInside,
  padAndClamp,
  pointInPolygon,
  polygonArea,
  unionBoxes,
  type Pt,
} from '../src/geometry';

/** Hand-drawn-ish ellipse: `turns` of a full revolution, starting at angle 0. */
function ellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  turns = 1,
  n = 80,
): Pt[] {
  return Array.from({length: n + 1}, (_, i) => {
    const a = (i / n) * turns * 2 * Math.PI;
    return {x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a)};
  });
}

function line(from: Pt, to: Pt, n = 40): Pt[] {
  return Array.from({length: n + 1}, (_, i) => ({
    x: from.x + ((to.x - from.x) * i) / n,
    y: from.y + ((to.y - from.y) * i) / n,
  }));
}

describe('findClosedLoop', () => {
  it('accepts a full ellipse', () => {
    expect(findClosedLoop(ellipse(500, 500, 200, 120))).not.toBeNull();
  });

  it('accepts a loop that overshoots its start and trims the overshoot', () => {
    const points = ellipse(500, 500, 200, 120, 1.15);
    const polygon = findClosedLoop(points);
    expect(polygon).not.toBeNull();
    expect(polygon!.length).toBeLessThan(points.length);
  });

  it('accepts a loop that stops a little short of its start', () => {
    expect(findClosedLoop(ellipse(500, 500, 200, 120, 0.93))).not.toBeNull();
  });

  it('does not mistake two points along an open loop for its ends', () => {
    // Three quarters of a 120 x 100 px loop: ends ~82 px apart.
    const open = ellipse(520, 500, 60, 50, 0.75, 80);
    expect(findClosedLoop(open)).not.toBeNull();
    // Without the span rule, a sliver between two mid-stroke points wins.
    expect(
      findClosedLoop(open, {...DEFAULT_LOOP_OPTIONS, minSpanRatio: 0}),
    ).toBeNull();
  });

  it('rejects an open arc', () => {
    expect(findClosedLoop(ellipse(500, 500, 200, 120, 0.6))).toBeNull();
  });

  it('rejects a straight line', () => {
    expect(findClosedLoop(line({x: 0, y: 0}, {x: 600, y: 300}))).toBeNull();
  });

  it('rejects a line drawn there and back (closes but encloses nothing)', () => {
    const there = line({x: 100, y: 100}, {x: 700, y: 400});
    const back = line({x: 700, y: 410}, {x: 100, y: 110});
    expect(findClosedLoop([...there, ...back])).toBeNull();
  });

  it('rejects a tiny loop such as a handwritten "o"', () => {
    expect(findClosedLoop(ellipse(100, 100, 12, 12))).toBeNull();
  });

  it('rejects strokes with too few points', () => {
    const few = ellipse(
      500,
      500,
      200,
      120,
      1,
      DEFAULT_LOOP_OPTIONS.minPoints - 2,
    );
    expect(findClosedLoop(few)).toBeNull();
  });
});

describe('polygon helpers', () => {
  const square: Pt[] = [
    {x: 0, y: 0},
    {x: 100, y: 0},
    {x: 100, y: 100},
    {x: 0, y: 100},
  ];

  it('computes area', () => {
    expect(polygonArea(square)).toBe(10000);
  });

  it('tests point containment', () => {
    expect(pointInPolygon({x: 50, y: 50}, square)).toBe(true);
    expect(pointInPolygon({x: 150, y: 50}, square)).toBe(false);
  });

  it('computes the fraction of points inside', () => {
    const pts = [
      {x: 10, y: 10},
      {x: 20, y: 20},
      {x: 200, y: 200},
      {x: 30, y: 30},
    ];
    expect(fractionInside(pts, square)).toBe(0.75);
    expect(fractionInside([], square)).toBe(0);
  });

  it('pads and clamps a box to the page', () => {
    expect(
      padAndClamp({left: 2, top: 10, right: 98, bottom: 195}, 4, {
        width: 100,
        height: 200,
      }),
    ).toEqual({left: 0, top: 6, right: 100, bottom: 199});
  });

  it('unions boxes', () => {
    expect(unionBoxes([])).toBeNull();
    expect(
      unionBoxes([
        {left: 10, top: 10, right: 20, bottom: 20},
        {left: 5, top: 15, right: 30, bottom: 18},
      ]),
    ).toEqual({left: 5, top: 10, right: 30, bottom: 20});
  });
});

/** One stroke of a ✕, from `a` to `b`, with a little hand wobble. */
function bar(a: Pt, b: Pt, n = 12): Pt[] {
  return Array.from({length: n + 1}, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / n + (i % 2 ? 0.8 : -0.8),
    y: a.y + ((b.y - a.y) * i) / n,
  }));
}

describe('findCrossMark', () => {
  // A 40 px ✕ centred on (60, 520).
  const down = bar({x: 40, y: 500}, {x: 80, y: 540});
  const up = bar({x: 40, y: 540}, {x: 80, y: 500});

  it('recognises a ✕ and returns its box', () => {
    expect(findCrossMark(down, up)).toEqual({
      left: 39.2,
      top: 500,
      right: 79.2,
      bottom: 540,
    });
  });

  it('recognises a "+" too (any two strokes crossing at a clear angle)', () => {
    const h = bar({x: 40, y: 520}, {x: 80, y: 520});
    const v = bar({x: 60, y: 500}, {x: 60, y: 540});
    expect(findCrossMark(h, v)).not.toBeNull();
  });

  it('rejects strokes that meet at their ends (a "v", an "L")', () => {
    const v1 = bar({x: 40, y: 500}, {x: 60, y: 540});
    const v2 = bar({x: 60, y: 540}, {x: 80, y: 500});
    expect(findCrossMark(v1, v2)).toBeNull();
  });

  it('rejects strokes that do not cross, or nearly parallel ones', () => {
    expect(
      findCrossMark(down, bar({x: 140, y: 540}, {x: 180, y: 500})),
    ).toBeNull();
    expect(
      findCrossMark(down, bar({x: 42, y: 498}, {x: 78, y: 542})),
    ).toBeNull();
  });

  it('rejects curved strokes, and strokes too long or too unequal', () => {
    expect(findCrossMark(ellipse(60, 520, 20, 20, 0.5, 12), up)).toBeNull();
    const long = bar({x: 0, y: 300}, {x: 400, y: 700});
    const longUp = bar({x: 0, y: 700}, {x: 400, y: 300});
    expect(findCrossMark(long, longUp)).toBeNull();
    const tiny = bar({x: 55, y: 525}, {x: 65, y: 515});
    expect(findCrossMark(long, tiny)).toBeNull();
  });

  it('says why two strokes are not a ✕', () => {
    const v1 = bar({x: 40, y: 500}, {x: 60, y: 540});
    const v2 = bar({x: 60, y: 540}, {x: 80, y: 500});
    expect(checkCrossMark(v1, v2)).toEqual({
      reason: 'strokes do not cross in their middles (at 100 % and 0 %)',
    });
    expect(checkCrossMark(ellipse(60, 520, 20, 20, 0.5, 12), up)).toEqual({
      reason: 'first stroke not straight or too short',
    });
    const flat = bar({x: 40, y: 515}, {x: 80, y: 525});
    expect(checkCrossMark(down, flat)).toMatchObject({
      reason: expect.stringContaining('too parallel'),
    });
  });

  it('accepts a quick, slightly curved ✕ crossing off-centre', () => {
    // Bowed by 5 px, crossing at about a third of each stroke.
    const bowed = (a: Pt, b: Pt) =>
      Array.from({length: 13}, (_, i) => ({
        x: a.x + ((b.x - a.x) * i) / 12 + 5 * Math.sin((Math.PI * i) / 12),
        y: a.y + ((b.y - a.y) * i) / 12,
      }));
    const one = bowed({x: 40, y: 500}, {x: 90, y: 550});
    const two = bowed({x: 40, y: 530}, {x: 90, y: 480});
    expect(findCrossMark(one, two)).not.toBeNull();
  });

  it('checks only the shape when asked (any scale or rotation)', () => {
    const scale = (pts: Pt[]) =>
      pts.map(p => ({x: 9000 - p.y * 10, y: p.x * 10}));
    expect(
      findCrossMark(scale(down), scale(up), undefined, false),
    ).not.toBeNull();
    expect(findCrossMark(scale(down), scale(up))).toBeNull(); // too big as px
  });
});

describe('findWritingLine', () => {
  const mark = {left: 40, top: 500, right: 80, bottom: 540};
  const box = (left: number, top: number, w = 30, h = 40) => ({
    left,
    top,
    right: left + w,
    bottom: top + h,
  });

  it('takes the strokes level with the mark, on its right', () => {
    const boxes = [
      box(100, 500), // level
      box(140, 505), // level
      box(400, 495), // level, far right: same line
      box(100, 580), // next line down
      box(100, 420), // line above
    ];
    expect(findWritingLine(mark, boxes)).toEqual({indices: [0, 1, 2]});
  });

  it('refuses when there is writing on the left of the mark', () => {
    expect(findWritingLine(mark, [box(0, 500, 20), box(100, 500)])).toEqual({
      reason: 'writing on the left of the mark',
    });
  });

  it('refuses a mark touching the writing (a written "x")', () => {
    expect(findWritingLine(mark, [box(75, 500)])).toEqual({
      reason: 'mark touches the writing',
    });
  });

  it('refuses a mark with nothing next to it', () => {
    expect(findWritingLine(mark, [box(100, 700)])).toEqual({
      reason: 'no writing next to the mark',
    });
  });
});

describe('strokesTouch', () => {
  const stem: Pt[] = [
    {x: 100, y: 100},
    {x: 100, y: 160},
  ];

  it('detects strokes that cross', () => {
    const tBar = [
      {x: 80, y: 120},
      {x: 120, y: 120},
    ];
    expect(strokesTouch(stem, tBar, 4)).toBe(true);
  });

  it('detects strokes that meet within the tolerance', () => {
    const joined = [
      {x: 103, y: 160},
      {x: 130, y: 140},
    ];
    expect(strokesTouch(stem, joined, 4)).toBe(true);
  });

  it('ignores strokes further apart than the tolerance', () => {
    const dot = [
      {x: 100, y: 85},
      {x: 101, y: 86},
    ];
    expect(strokesTouch(stem, dot, 4)).toBe(false);
    expect(strokesTouch(stem, [], 4)).toBe(false);
  });
});
