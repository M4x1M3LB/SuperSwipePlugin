import {
  DEFAULT_LOOP_OPTIONS,
  findClosedLoop,
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
