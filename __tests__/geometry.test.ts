import {
  DEFAULT_LOOP_OPTIONS,
  findClosedLoop,
  netTurning,
  checkSpiral,
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

  it('does not take a reverse L or a "7" for a loop', () => {
    // Small enough that the ends are within the closing distance.
    const corner = [
      ...line({x: 80, y: 500}, {x: 80, y: 540}, 10),
      ...line({x: 80, y: 540}, {x: 40, y: 540}, 10),
    ];
    expect(findClosedLoop(corner)).toBeNull();
    expect(netTurning(corner)).toBeCloseTo(90, -1);
  });

  it('measures how far a loop turns', () => {
    // Sampled paths miss the final turn back to the start: a bit under 360°.
    expect(netTurning(ellipse(500, 500, 200, 120))).toBeGreaterThan(320);
    const threeQuarters = netTurning(ellipse(500, 500, 200, 120, 0.75));
    expect(threeQuarters).toBeGreaterThan(240);
    expect(threeQuarters).toBeLessThan(290);
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

/** A spiral around (cx, cy): radius r0 → r1 over `turns` turns. */
function spiral(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  turns: number,
  n = 120,
): Pt[] {
  return Array.from({length: n + 1}, (_, i) => {
    const t = i / n;
    const a = t * turns * 2 * Math.PI;
    const r = r0 + (r1 - r0) * t;
    return {x: cx + r * Math.cos(a), y: cy + r * Math.sin(a)};
  });
}

describe('checkSpiral', () => {
  it('recognises a snail shell drawn from the inside out', () => {
    expect(checkSpiral(spiral(60, 520, 3, 20, 2))).toEqual({
      box: expect.objectContaining({}),
    });
  });

  it('recognises it from the outside in, and the other way round', () => {
    const outsideIn = spiral(60, 520, 20, 3, 2);
    expect(checkSpiral(outsideIn)).toHaveProperty('box');
    const mirrored = outsideIn.map(p => ({x: 120 - p.x, y: p.y}));
    expect(checkSpiral(mirrored)).toHaveProperty('box');
  });

  it('accepts a quick one-and-a-half turn spiral', () => {
    expect(checkSpiral(spiral(60, 520, 4, 18, 1.6, 50))).toHaveProperty('box');
  });

  it('rejects a single loop and a loop drawn twice (no growth)', () => {
    expect(checkSpiral(ellipse(60, 520, 20, 20))).toMatchObject({
      reason: expect.stringContaining('turns'),
    });
    expect(checkSpiral(ellipse(60, 520, 20, 18, 2, 120))).toMatchObject({
      reason: expect.stringContaining('does not grow'),
    });
  });

  it('rejects writing-like strokes', () => {
    expect(checkSpiral(line({x: 0, y: 0}, {x: 200, y: 0}))).toHaveProperty(
      'reason',
    );
    expect(checkSpiral(ellipse(60, 520, 20, 20, 0.5))).toHaveProperty('reason');
  });

  it('checks size on the page copy only', () => {
    const big = spiral(500, 500, 20, 200, 2);
    expect(checkSpiral(big)).toMatchObject({
      reason: expect.stringContaining('too big'),
    });
    expect(checkSpiral(big, undefined, false)).toHaveProperty('box');
    expect(checkSpiral(spiral(60, 520, 1, 6, 2))).toEqual({
      reason: 'too small',
    });
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

  it('takes the strokes on the left of a right-margin mark', () => {
    const right = {left: 400, top: 500, right: 440, bottom: 540};
    const boxes = [box(100, 500), box(300, 505), box(100, 580)];
    expect(findWritingLine(right, boxes, undefined, 'left')).toEqual({
      indices: [0, 1],
    });
    expect(
      findWritingLine(right, [box(100, 500), box(500, 500)], undefined, 'left'),
    ).toEqual({reason: 'writing on the right of the mark'});
    expect(findWritingLine(right, [box(380, 500)], undefined, 'left')).toEqual({
      reason: 'mark touches the writing',
    });
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
