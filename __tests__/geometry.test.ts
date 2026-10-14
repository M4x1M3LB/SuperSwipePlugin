import {
  DEFAULT_LOOP_OPTIONS,
  findClosedLoop,
  netTurning,
  checkStraightLine,
  checkVerticalBar,
  findBlockBesideBar,
  trimEnds,
  checkWave,
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

/** A sideways wave: `span` radians of a sine, `amp` px up and down. */
function wave(
  left: number,
  cy: number,
  width: number,
  amp: number,
  span = 3 * Math.PI,
  n = 60,
): Pt[] {
  return Array.from({length: n + 1}, (_, i) => {
    const t = i / n;
    return {x: left + width * t, y: cy - amp * Math.sin(span * t)};
  });
}

describe('checkWave', () => {
  it('recognises a tilde with an extra bounce', () => {
    expect(checkWave(wave(10, 520, 60, 12))).toEqual({
      box: expect.objectContaining({left: 10, right: 70}),
    });
  });

  it('accepts it right to left, upside down, and with more bounces', () => {
    expect(checkWave(wave(10, 520, 60, 12).reverse())).toHaveProperty('box');
    expect(checkWave(wave(10, 520, 60, -12))).toHaveProperty('box');
    expect(checkWave(wave(10, 520, 100, 12, 6 * Math.PI, 120))).toHaveProperty(
      'box',
    );
  });

  it('tolerates a shaky hand', () => {
    const shaky = wave(10, 520, 60, 12).map((p, i) => ({
      x: p.x,
      y: p.y + ((i * 7) % 3) - 1,
    }));
    expect(checkWave(shaky)).toHaveProperty('box');
  });

  it('rejects a plain tilde', () => {
    expect(checkWave(wave(10, 520, 60, 12, 2 * Math.PI))).toEqual({
      reason: '2 bounce(s), needs 3 or more',
    });
  });

  it('rejects loops, lines and tall strokes', () => {
    expect(checkWave(ellipse(60, 520, 30, 12))).toMatchObject({
      reason: expect.stringContaining('goes back'),
    });
    expect(checkWave(line({x: 0, y: 500}, {x: 200, y: 505}))).toEqual({
      reason: 'too flat (a line)',
    });
    expect(checkWave(line({x: 0, y: 0}, {x: 0, y: 200}))).toEqual({
      reason: 'taller than wide',
    });
  });

  it('checks size on the page copy only', () => {
    const big = wave(0, 500, 600, 100);
    expect(checkWave(big)).toEqual({reason: 'too big (600 px)'});
    expect(checkWave(big, undefined, false)).toHaveProperty('box');
    expect(checkWave(wave(0, 500, 12, 3))).toEqual({reason: 'too small'});
  });
});

describe('checkStraightLine', () => {
  it('accepts a horizontal line either way, with a little wobble', () => {
    const wobbly = line({x: 100, y: 800}, {x: 900, y: 815}).map((p, i) => ({
      x: p.x,
      y: p.y + (i % 3) * 3,
    }));
    expect(checkStraightLine(wobbly)).toEqual({
      from: expect.objectContaining({x: 100}),
      to: expect.objectContaining({x: 900}),
    });
    expect(checkStraightLine([...wobbly].reverse())).toMatchObject({
      from: {x: 100},
    });
  });

  it('accepts a hand-drawn line: bowed, tilted, shaky', () => {
    // Bows 60 px over 800 px (7.5 %), rises 13°, shakes ±6 px.
    const hand = Array.from({length: 81}, (_, i) => {
      const t = i / 80;
      return {
        x: 100 + 800 * t,
        y: 800 - 185 * t - 60 * Math.sin(Math.PI * t) + ((i * 7) % 13) - 6,
      };
    });
    expect(checkStraightLine(hand)).toHaveProperty('from');
  });

  it('rejects slanted, bent and back-and-forth strokes', () => {
    expect(checkStraightLine(line({x: 0, y: 0}, {x: 400, y: 200}))).toEqual({
      reason: 'not horizontal (27°)',
    });
    expect(
      checkStraightLine([
        ...line({x: 0, y: 0}, {x: 200, y: 60}),
        ...line({x: 200, y: 60}, {x: 400, y: 0}),
      ]),
    ).toEqual({reason: 'not straight (bends)'});
    expect(
      checkStraightLine([
        ...line({x: 0, y: 0}, {x: 400, y: 0}),
        ...line({x: 400, y: 4}, {x: 100, y: 4}),
        ...line({x: 100, y: 8}, {x: 500, y: 8}),
      ]),
    ).toEqual({reason: 'not straight (goes back and forth)'});
  });
});

describe('checkVerticalBar', () => {
  it('accepts |, [ and a gentle (, drawn up or down', () => {
    const bar = line({x: 70, y: 500}, {x: 72, y: 700});
    expect(checkVerticalBar(bar)).toHaveProperty('box');
    expect(checkVerticalBar([...bar].reverse())).toHaveProperty('box');
    const bracket = [
      ...line({x: 90, y: 500}, {x: 70, y: 500}, 8),
      ...line({x: 70, y: 500}, {x: 70, y: 700}),
      ...line({x: 70, y: 700}, {x: 90, y: 700}, 8),
    ];
    expect(checkVerticalBar(bracket)).toHaveProperty('box');
    const paren = Array.from({length: 41}, (_, i) => ({
      x: 80 - 20 * Math.sin((Math.PI * i) / 40),
      y: 500 + 5 * i,
    }));
    expect(checkVerticalBar(paren)).toHaveProperty('box');
  });

  it('accepts a leaning, shaky bar', () => {
    const shaky = line({x: 70, y: 500}, {x: 120, y: 700}).map((p, i) => ({
      x: p.x + ((i * 7) % 9) - 4,
      y: p.y,
    }));
    expect(checkVerticalBar(shaky)).toHaveProperty('box');
  });

  it('rejects horizontal lines, L shapes and loops', () => {
    expect(
      checkVerticalBar(line({x: 0, y: 500}, {x: 300, y: 505})),
    ).toMatchObject({reason: expect.stringContaining('not vertical')});
    const l = [
      ...line({x: 70, y: 500}, {x: 70, y: 700}),
      ...line({x: 70, y: 700}, {x: 150, y: 700}, 15),
    ];
    expect(checkVerticalBar(l)).toHaveProperty('reason');
    expect(checkVerticalBar(ellipse(100, 600, 30, 100))).toHaveProperty(
      'reason',
    );
  });

  it('trims the ends of a stroke', () => {
    const trimmed = trimEnds(line({x: 0, y: 0}, {x: 0, y: 100}, 100), 0.1);
    expect(trimmed[0].y).toBeCloseTo(10, 0);
    expect(trimmed[trimmed.length - 1].y).toBeCloseTo(90, 0);
  });
});

describe('findBlockBesideBar', () => {
  const bar = {left: 68, top: 495, right: 72, bottom: 705};
  const box = (left: number, top: number, w = 30, h = 40) => ({
    left,
    top,
    right: left + w,
    bottom: top + h,
  });
  /** Three lines of four words, 80 px apart, from x = left. */
  const lines = (left: number, tops = [500, 580, 660]) =>
    tops.flatMap(t => [0, 40, 80, 120].map(dx => box(left + dx, t)));

  it('takes the lines level with the bar, on its side', () => {
    const boxes = [box(100, 420), ...lines(100), box(100, 740)];
    expect(findBlockBesideBar(bar, boxes, 1404)).toEqual({
      indices: Array.from({length: 12}, (_, i) => i + 1),
      side: 'right',
    });
  });

  it('stops at an empty gutter (a second column)', () => {
    const boxes = [...lines(100), ...lines(800)];
    expect(findBlockBesideBar(bar, boxes, 1404)).toMatchObject({
      indices: Array.from({length: 12}, (_, i) => i),
    });
  });

  it('refuses dividers, bars in the text, axes and brackets', () => {
    expect(findBlockBesideBar(bar, [...lines(100), box(0, 500)], 1404)).toEqual(
      {
        reason: 'writing on both sides of the bar',
      },
    );
    expect(findBlockBesideBar(bar, [box(55, 580)], 1404)).toEqual({
      reason: 'bar runs through the writing',
    });
    expect(findBlockBesideBar(bar, [box(100, 580)], 1404)).toEqual({
      reason: 'too little writing beside the bar (an axis?)',
    });
    expect(
      findBlockBesideBar(bar, [...lines(100), box(300, 495, 10, 210)], 1404),
    ).toEqual({reason: 'a bracket or border faces the bar'});
    expect(findBlockBesideBar(bar, [box(500, 580, 30, 160)], 1404)).toEqual({
      reason: 'writing too far from the bar (428 px)',
    });
    expect(findBlockBesideBar(bar, [box(400, 1500)], 1404)).toEqual({
      reason: 'no writing beside the bar',
    });
  });
});

describe('findWritingLine', () => {
  const mark = {left: 30, top: 500, right: 70, bottom: 540};
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
    ).toEqual({reason: 'writing on the right of the wave'});
    expect(findWritingLine(right, [box(380, 500)], undefined, 'left')).toEqual({
      reason: 'wave touches the writing',
    });
  });

  it('refuses when there is writing on the left of the wave', () => {
    expect(findWritingLine(mark, [box(0, 500, 20), box(100, 500)])).toEqual({
      reason: 'writing on the left of the wave',
    });
  });

  it('refuses a mark touching the writing (a written "x")', () => {
    expect(findWritingLine(mark, [box(65, 500)])).toEqual({
      reason: 'wave touches the writing',
    });
  });

  it('needs a gap of 0.75 × the mark height from the writing', () => {
    // Mark 40 px tall: the writing must start 30 px or more after it.
    expect(findWritingLine(mark, [box(100, 500)])).toEqual({indices: [0]});
    expect(findWritingLine(mark, [box(90, 500)])).toEqual({
      reason: 'wave too close to the writing (20 px, needs 30)',
    });
  });

  it('refuses a mark with nothing next to it', () => {
    expect(findWritingLine(mark, [box(100, 700)])).toEqual({
      reason: 'no writing next to the wave',
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
