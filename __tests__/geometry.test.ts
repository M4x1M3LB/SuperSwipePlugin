import {
  DEFAULT_LOOP_OPTIONS,
  findClosedLoop,
  netTurning,
  checkCornerMark,
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

/** A polyline through `corners`, `n` points per segment, slight wobble. */
function path(corners: Pt[], n = 10): Pt[] {
  const pts: Pt[] = [corners[0]];
  for (let c = 1; c < corners.length; c++) {
    const [a, b] = [corners[c - 1], corners[c]];
    for (let i = 1; i <= n; i++) {
      pts.push({
        x: a.x + ((b.x - a.x) * i) / n + (i % 2 ? 0.7 : -0.7),
        y: a.y + ((b.y - a.y) * i) / n,
      });
    }
  }
  return pts;
}

describe('checkCornerMark', () => {
  // A 40 px reverse L: down from (80, 500) to the corner (80, 540), then
  // left to (40, 540).
  const mark = path([
    {x: 80, y: 500},
    {x: 80, y: 540},
    {x: 40, y: 540},
  ]);

  it('recognises a reverse L and returns its box', () => {
    expect(checkCornerMark(mark)).toEqual({
      box: {left: 39.3, top: 500, right: 80.7, bottom: 540},
    });
  });

  it('recognises it drawn the other way (right, then up)', () => {
    expect(checkCornerMark([...mark].reverse())).toHaveProperty('box');
  });

  it('accepts a slightly tilted, uneven one', () => {
    const tilted = path([
      {x: 85, y: 495},
      {x: 78, y: 548},
      {x: 50, y: 543},
    ]);
    expect(checkCornerMark(tilted)).toHaveProperty('box');
  });

  it('rejects a written "L" and a "7" (other corners)', () => {
    const letterL = path([
      {x: 40, y: 500},
      {x: 40, y: 540},
      {x: 70, y: 540},
    ]);
    expect(checkCornerMark(letterL)).toEqual({
      reason: 'not a reverse L (corner must be bottom right)',
    });
    const seven = path([
      {x: 40, y: 500},
      {x: 80, y: 500},
      {x: 60, y: 540},
    ]);
    expect(checkCornerMark(seven)).toHaveProperty('reason');
  });

  it('rejects a straight line, a narrow "v" and a curve', () => {
    expect(
      checkCornerMark(
        path([
          {x: 40, y: 500},
          {x: 120, y: 500},
        ]),
      ),
    ).toHaveProperty('reason');
    expect(
      checkCornerMark(
        path([
          {x: 40, y: 500},
          {x: 50, y: 540},
          {x: 60, y: 500},
        ]),
      ),
    ).toMatchObject({reason: expect.stringContaining('corner angle')});
    expect(checkCornerMark(ellipse(60, 520, 20, 20, 0.5, 20))).toHaveProperty(
      'reason',
    );
  });

  it('rejects legs that are too long or too unequal', () => {
    const big = path([
      {x: 400, y: 100},
      {x: 400, y: 500},
      {x: 100, y: 500},
    ]);
    expect(checkCornerMark(big)).toMatchObject({
      reason: expect.stringContaining('too long'),
    });
    const lopsided = path([
      {x: 80, y: 440},
      {x: 80, y: 540},
      {x: 60, y: 540},
    ]);
    expect(checkCornerMark(lopsided)).toEqual({
      reason: 'one leg much shorter than the other',
    });
  });

  it('checks only the shape when the layout is unknown (any rotation)', () => {
    const rotated = mark.map(p => ({x: 9000 - p.y * 10, y: p.x * 10}));
    expect(checkCornerMark(rotated, undefined, false)).toHaveProperty('box');
    expect(checkCornerMark(rotated)).toHaveProperty('reason');
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
