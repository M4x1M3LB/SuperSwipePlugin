/**
 * Pure geometry helpers for loop-to-select. No SDK imports so everything here
 * is unit-testable in plain Jest.
 *
 * All coordinates are Android page pixels (sn-plugin-lib > 0.1.65).
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LoopOptions {
  /** Minimum number of sample points for a stroke to be considered. */
  minPoints: number;
  /** Smallest allowed side of the loop's bounding box, in px. */
  minSize: number;
  /** Max gap between where the loop closes, in px... */
  closeGapPx: number;
  /** ...or as a fraction of the stroke length, whichever is larger. */
  closeGapRatio: number;
  /** Fraction of the stroke searched at each end for the closing point. */
  endSearchRatio: number;
  /**
   * The closing points must leave at least this fraction of the stroke in
   * the loop. Without it, two points partway along an open loop can look
   * like the closing pair and leave a sliver that is then rejected.
   */
  minSpanRatio: number;
  /**
   * How far the stroke must turn in total, in degrees. A loop turns about
   * 360° (270° for one stopped at three quarters); an L or a "7" only 90°.
   */
  minTurnDegrees: number;
  /**
   * Polygon area divided by bounding-box area. Rejects strokes that double
   * back on themselves (zig-zags, scribbles) which close but enclose nothing.
   */
  minFillRatio: number;
}

export const DEFAULT_LOOP_OPTIONS: LoopOptions = {
  minPoints: 12,
  minSize: 30,
  closeGapPx: 100,
  closeGapRatio: 0.2,
  endSearchRatio: 0.35,
  minSpanRatio: 0.6,
  minTurnDegrees: 240,
  minFillRatio: 0.3,
};

export function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pathLength(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1], points[i]);
  }
  return total;
}

export function boundingBox(points: Pt[]): Box {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of points) {
    if (p.x < left) {
      left = p.x;
    }
    if (p.y < top) {
      top = p.y;
    }
    if (p.x > right) {
      right = p.x;
    }
    if (p.y > bottom) {
      bottom = p.y;
    }
  }
  return {left, top, right, bottom};
}

export function unionBoxes(boxes: Box[]): Box | null {
  if (boxes.length === 0) {
    return null;
  }
  return boxes.reduce((acc, b) => ({
    left: Math.min(acc.left, b.left),
    top: Math.min(acc.top, b.top),
    right: Math.max(acc.right, b.right),
    bottom: Math.max(acc.bottom, b.bottom),
  }));
}

/** Absolute polygon area (shoelace formula). The polygon is implicitly closed. */
export function polygonArea(polygon: Pt[]): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    sum += (polygon[j].x + polygon[i].x) * (polygon[j].y - polygon[i].y);
  }
  return Math.abs(sum / 2);
}

/**
 * Is `p` inside the polygon (implicitly closed)? Uses the winding number, so
 * a loop drawn twice around something still contains it (with even-odd
 * counting, the second pass would cancel the first).
 */
export function pointInPolygon(p: Pt, polygon: Pt[]): boolean {
  let winding = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y) {
      if (b.y > p.y && side > 0) {
        winding++;
      }
    } else if (b.y <= p.y && side < 0) {
      winding--;
    }
  }
  return winding !== 0;
}

/** Fraction (0..1) of `points` that fall inside `polygon`. */
export function fractionInside(points: Pt[], polygon: Pt[]): number {
  if (points.length === 0) {
    return 0;
  }
  const box = boundingBox(polygon);
  let count = 0;
  for (const p of points) {
    if (
      p.x >= box.left &&
      p.x <= box.right &&
      p.y >= box.top &&
      p.y <= box.bottom &&
      pointInPolygon(p, polygon)
    ) {
      count++;
    }
  }
  return count / points.length;
}

/**
 * Decide whether a stroke is a closed loop and, if so, return the polygon it
 * encloses (with any overshoot past the closing point trimmed off).
 *
 * The closing point is the closest pair (i in the head, j in the tail) of
 * sample points, so a loop that overshoots its start, or starts with a short
 * lead-in, still counts.
 */
export function checkClosedLoop(
  points: Pt[],
  options: LoopOptions = DEFAULT_LOOP_OPTIONS,
): {polygon: Pt[]} | {reason: string} {
  const n = points.length;
  if (n < options.minPoints) {
    return {reason: 'too few points'};
  }

  const box = boundingBox(points);
  if (
    box.right - box.left < options.minSize ||
    box.bottom - box.top < options.minSize
  ) {
    return {reason: 'too small'};
  }

  const length = pathLength(points);
  const maxGap = Math.max(options.closeGapPx, options.closeGapRatio * length);
  const window = Math.max(1, Math.floor(n * options.endSearchRatio));

  let bestI = -1;
  let bestJ = -1;
  let bestGap = Infinity;
  for (let i = 0; i < window; i++) {
    for (let j = n - window; j < n; j++) {
      if (
        j - i < options.minPoints - 1 ||
        j - i < options.minSpanRatio * (n - 1)
      ) {
        continue;
      }
      const gap = distance(points[i], points[j]);
      if (gap < bestGap) {
        bestGap = gap;
        bestI = i;
        bestJ = j;
      }
    }
  }
  if (bestI < 0 || bestGap > maxGap) {
    return {
      reason: `ends ${Math.round(bestGap)} apart (max ${Math.round(maxGap)})`,
    };
  }

  const polygon = points.slice(bestI, bestJ + 1);
  const turned = Math.abs(netTurning(polygon));
  if (turned < options.minTurnDegrees) {
    return {reason: `turns only ${Math.round(turned)}°`};
  }
  const polyBox = boundingBox(polygon);
  const boxArea =
    (polyBox.right - polyBox.left) * (polyBox.bottom - polyBox.top);
  if (boxArea <= 0 || polygonArea(polygon) / boxArea < options.minFillRatio) {
    return {reason: 'encloses too little area'};
  }
  return {polygon};
}

/** `checkClosedLoop`, keeping only the polygon. */
export function findClosedLoop(
  points: Pt[],
  options: LoopOptions = DEFAULT_LOOP_OPTIONS,
): Pt[] | null {
  const result = checkClosedLoop(points, options);
  return 'polygon' in result ? result.polygon : null;
}

/**
 * Total signed change of direction along a path, in degrees, measured on
 * points about 1/40 of its length apart so hand jitter does not count.
 */
export function netTurning(points: Pt[]): number {
  const step = Math.max(2, pathLength(points) / 40);
  const kept = [points[0]];
  for (const p of points) {
    if (distance(kept[kept.length - 1], p) >= step) {
      kept.push(p);
    }
  }
  let total = 0;
  let previous: number | null = null;
  for (let i = 1; i < kept.length; i++) {
    const heading = Math.atan2(
      kept[i].y - kept[i - 1].y,
      kept[i].x - kept[i - 1].x,
    );
    if (previous !== null) {
      let delta = heading - previous;
      while (delta > Math.PI) {
        delta -= 2 * Math.PI;
      }
      while (delta < -Math.PI) {
        delta += 2 * Math.PI;
      }
      total += delta;
    }
    previous = heading;
  }
  return (total * 180) / Math.PI;
}

/**
 * Push every vertex `margin` px further from the polygon's centre: a loop
 * drawn tight around something then still contains it.
 */
export function growPolygon(polygon: Pt[], margin: number): Pt[] {
  const c = polygon.reduce(
    (acc, p) => ({
      x: acc.x + p.x / polygon.length,
      y: acc.y + p.y / polygon.length,
    }),
    {x: 0, y: 0},
  );
  return polygon.map(p => {
    const d = distance(p, c);
    return d === 0
      ? p
      : {
          x: c.x + ((p.x - c.x) * (d + margin)) / d,
          y: c.y + ((p.y - c.y) * (d + margin)) / d,
        };
  });
}

/** Grow a box by `pad` px on every side, then clamp it to the page. */
export function padAndClamp(
  box: Box,
  pad: number,
  page: {width: number; height: number},
): Box {
  return {
    left: Math.max(0, Math.floor(box.left - pad)),
    top: Math.max(0, Math.floor(box.top - pad)),
    right: Math.min(page.width, Math.ceil(box.right + pad)),
    bottom: Math.min(page.height, Math.ceil(box.bottom + pad)),
  };
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

export function segmentsIntersect(p1: Pt, p2: Pt, q1: Pt, q2: Pt): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

function overlapsWithin(a: Box, b: Box, margin: number): boolean {
  return (
    a.left - margin <= b.right &&
    b.left - margin <= a.right &&
    a.top - margin <= b.bottom &&
    b.top - margin <= a.bottom
  );
}

/** Squared distance from `p` to the segment a-b. */
function distanceToSegmentSq(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq),
        );
  const x = a.x + t * dx - p.x;
  const y = a.y + t * dy - p.y;
  return x * x + y * y;
}

/** Is any point of `a` within `tolerance` px of the path of `b`? */
function reaches(a: Pt[], b: Pt[], toleranceSq: number): boolean {
  for (const p of a) {
    if (b.length === 1 && distanceToSegmentSq(p, b[0], b[0]) <= toleranceSq) {
      return true;
    }
    for (let i = 1; i < b.length; i++) {
      if (distanceToSegmentSq(p, b[i - 1], b[i]) <= toleranceSq) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Do two strokes cross or touch? They touch when their paths come within
 * `tolerance` px of each other (handwritten strokes that meet rarely cross
 * exactly).
 */
export function strokesTouch(a: Pt[], b: Pt[], tolerance: number): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  if (!overlapsWithin(boundingBox(a), boundingBox(b), tolerance)) {
    return false;
  }
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      if (segmentsIntersect(a[i - 1], a[i], b[j - 1], b[j])) {
        return true;
      }
    }
  }
  const toleranceSq = tolerance * tolerance;
  return reaches(a, b, toleranceSq) || reaches(b, a, toleranceSq);
}

export interface WaveOptions {
  /** Minimum number of sample points. */
  minPoints: number;
  /**
   * Minimum number of bounces: the stroke turning between up and down. A
   * tilde "~" has 2, so it needs 3 or more to count.
   */
  minBounces: number;
  /** A bounce must turn back by at least this fraction of the wave's height. */
  bounceRatio: number;
  /** Width over height, at least: the wave runs sideways. */
  minAspect: number;
  /** Height over width, at least: flatter is a line, not a wave. */
  minFlatness: number;
  /**
   * Movement backwards along the wave, as a fraction of its width, at most:
   * a wave never goes back on itself (loops and cursive letters do).
   */
  maxBacktrack: number;
  /** Size limits of the mark's width, in px (checked on the page copy). */
  minSize: number;
  maxSize: number;
}

export const DEFAULT_WAVE_OPTIONS: WaveOptions = {
  minPoints: 10,
  minBounces: 3,
  bounceRatio: 0.25,
  minAspect: 1,
  minFlatness: 0.12,
  maxBacktrack: 0.15,
  minSize: 20,
  maxSize: 400,
};

/**
 * Is the stroke a sideways wave with 3 bounces or more (like "∿∿", a tilde
 * with an extra bounce), drawn left to right or right to left? Returns its
 * bounding box, or why not.
 *
 * Only ratios are used, so with `checkSize` false the check works on the
 * pen-up copy, whatever its scale.
 */
export function checkWave(
  points: Pt[],
  options: WaveOptions = DEFAULT_WAVE_OPTIONS,
  checkSize = true,
): {box: Box} | {reason: string} {
  if (points.length < options.minPoints) {
    return {reason: 'too few points'};
  }
  const box = boundingBox(points);
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  if (width < options.minAspect * height) {
    return {reason: 'taller than wide'};
  }
  if (height < options.minFlatness * width) {
    return {reason: 'too flat (a line)'};
  }
  // Sideways progress: little movement against the overall direction.
  const dir = Math.sign(points[points.length - 1].x - points[0].x) || 1;
  let back = 0;
  for (let i = 1; i < points.length; i++) {
    back += Math.max(0, -dir * (points[i].x - points[i - 1].x));
  }
  if (back > options.maxBacktrack * width) {
    return {
      reason: `goes back on itself (${Math.round((100 * back) / width)} %)`,
    };
  }
  // Bounces, with hysteresis so a shaky hand does not add any.
  const turn = options.bounceRatio * height;
  let bounces = 0;
  let going = 0; // +1 down, -1 up, 0 not yet moving
  let extreme = points[0].y;
  for (const p of points) {
    if (going === 0) {
      if (Math.abs(p.y - extreme) >= turn) {
        going = Math.sign(p.y - extreme);
        extreme = p.y;
      }
    } else if ((p.y - extreme) * going > 0) {
      extreme = p.y;
    } else if (Math.abs(p.y - extreme) >= turn) {
      bounces++;
      going = -going;
      extreme = p.y;
    }
  }
  if (bounces < options.minBounces) {
    return {
      reason: `${bounces} bounce(s), needs ${options.minBounces} or more`,
    };
  }
  if (checkSize) {
    if (width < options.minSize) {
      return {reason: 'too small'};
    }
    if (width > options.maxSize) {
      return {reason: `too big (${Math.round(width)} px)`};
    }
  }
  return {box};
}

export interface StraightLineOptions {
  /** Minimum number of sample points. */
  minPoints: number;
  /** Farthest any point may be from the start-end chord, × its length. */
  maxDeviation: number;
  /** Path length over chord length, at most (no back and forth). */
  maxPathRatio: number;
  /** Largest angle from horizontal, in degrees. */
  maxTiltDegrees: number;
}

export const DEFAULT_STRAIGHT_LINE_OPTIONS: StraightLineOptions = {
  minPoints: 5,
  maxDeviation: 0.1,
  maxPathRatio: 1.3,
  maxTiltDegrees: 15,
};

/**
 * Is the stroke a straight horizontal line? Returns its two ends, left one
 * first, or why not. Only ratios and angles are used, so the check works
 * on the pen-up copy (callers try both axes there if those may differ).
 */
export function checkStraightLine(
  points: Pt[],
  options: StraightLineOptions = DEFAULT_STRAIGHT_LINE_OPTIONS,
): {from: Pt; to: Pt} | {reason: string} {
  if (points.length < options.minPoints) {
    return {reason: 'too few points'};
  }
  const a = points[0];
  const b = points[points.length - 1];
  const chord = distance(a, b);
  if (chord <= 0) {
    return {reason: 'no length'};
  }
  const tilt =
    (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
  if (tilt > options.maxTiltDegrees) {
    return {reason: `not horizontal (${Math.round(tilt)}°)`};
  }
  if (pathLength(points) > options.maxPathRatio * chord) {
    return {reason: 'not straight (goes back and forth)'};
  }
  let deviation = 0;
  for (const p of points) {
    deviation = Math.max(deviation, Math.abs(cross(a, b, p)) / chord);
  }
  if (deviation > options.maxDeviation * chord) {
    return {reason: 'not straight (bends)'};
  }
  return a.x <= b.x ? {from: a, to: b} : {from: b, to: a};
}

export interface CornerOptions {
  /** Minimum number of sample points. */
  minPoints: number;
  /** Shortest leg, in px (also a safe floor in the pen-up copy's units). */
  minLeg: number;
  /** Shorter leg over longer leg, at least. */
  minLegRatio: number;
  /** Farthest a leg's points may stray from it, × its length. */
  maxLegDeviation: number;
  /** Largest angle of a leg from its axis, in degrees. */
  maxLegTiltDegrees: number;
}

export const DEFAULT_CORNER_OPTIONS: CornerOptions = {
  minPoints: 5,
  minLeg: 30,
  minLegRatio: 0.2,
  maxLegDeviation: 0.25,
  maxLegTiltDegrees: 30,
};

/** Top-left "┌" or bottom-right "┘" corner of a rectangle. */
export type CornerKind = 'topLeft' | 'bottomRight';

/**
 * Is the stroke a ┌ or ┘ corner: two roughly straight legs, one horizontal
 * and one vertical, meeting at an elbow? Drawn from either end. Returns the
 * corner's kind and its elbow, or why not. Only ratios, angles and a
 * minimum length are used.
 */
export function checkCorner(
  points: Pt[],
  options: CornerOptions = DEFAULT_CORNER_OPTIONS,
): {kind: CornerKind; at: Pt} | {reason: string} {
  if (points.length < options.minPoints) {
    return {reason: 'too few points'};
  }
  const a = points[0];
  const b = points[points.length - 1];
  const chord = distance(a, b);
  if (chord <= 0) {
    return {reason: 'no length'};
  }
  // The elbow: the point farthest from the line between the two ends.
  let k = 0;
  let far = -1;
  points.forEach((p, i) => {
    const d = Math.abs(cross(a, b, p));
    if (d > far) {
      [far, k] = [d, i];
    }
  });
  const elbow = points[k];
  const legs = [points.slice(0, k + 1), points.slice(k)];
  const lengths = legs.map(l => distance(l[0], l[l.length - 1]));
  if (Math.min(...lengths) < options.minLeg) {
    return {reason: 'legs too short'};
  }
  if (Math.min(...lengths) < options.minLegRatio * Math.max(...lengths)) {
    return {reason: 'legs too unequal'};
  }
  for (let i = 0; i < 2; i++) {
    const leg = legs[i];
    const [s, e] = [leg[0], leg[leg.length - 1]];
    const stray = Math.max(...leg.map(p => Math.abs(cross(s, e, p))));
    if (stray / lengths[i] > options.maxLegDeviation * lengths[i]) {
      return {reason: 'legs not straight'};
    }
  }
  // Each leg as a vector away from the elbow.
  const [v1, v2] = [a, b].map(p => ({x: p.x - elbow.x, y: p.y - elbow.y}));
  const tilt = (v: Pt) =>
    (Math.atan2(Math.abs(v.y), Math.abs(v.x)) * 180) / Math.PI;
  const flat = (v: Pt) => tilt(v) <= options.maxLegTiltDegrees;
  const upright = (v: Pt) => tilt(v) >= 90 - options.maxLegTiltDegrees;
  const [h, v] =
    flat(v1) && upright(v2)
      ? [v1, v2]
      : flat(v2) && upright(v1)
      ? [v2, v1]
      : [null, null];
  if (!h || !v) {
    return {reason: 'not a right angle on the axes'};
  }
  if (h.x > 0 && v.y > 0) {
    return {kind: 'topLeft', at: elbow};
  }
  if (h.x < 0 && v.y < 0) {
    return {kind: 'bottomRight', at: elbow};
  }
  return {reason: 'a corner, but only ┌ and ┘ count'};
}

export interface WritingLineOptions {
  /**
   * Strokes belong to the line next to the mark when their vertical centre
   * is within this many mark heights of the mark's centre...
   */
  bandScale: number;
  /** ...and at least this many px, for a small mark. */
  minBandHalf: number;
  /** Minimum gap between the mark and the writing, in px... */
  minGap: number;
  /**
   * ...or this many mark heights, whichever is larger: wider than the space
   * between two words, so a word written next to the line is not a mark.
   */
  minGapRatio: number;
}

export const DEFAULT_WRITING_LINE_OPTIONS: WritingLineOptions = {
  bandScale: 0.9,
  minBandHalf: 36,
  minGap: 20,
  minGapRatio: 0.75,
};

/**
 * The line of writing next to a margin mark, on the given side of it:
 * indices of the boxes whose vertical centre is level with the mark. Refused
 * (with the reason) when there is writing level with the mark on its other
 * side or under it, which means the mark is part of the text, not in the
 * margin.
 */
export function findWritingLine(
  mark: Box,
  boxes: Box[],
  options: WritingLineOptions = DEFAULT_WRITING_LINE_OPTIONS,
  side: 'right' | 'left' = 'right',
): {indices: number[]} | {reason: string} {
  const centre = (mark.top + mark.bottom) / 2;
  const half = Math.max(
    options.minBandHalf,
    options.bandScale * (mark.bottom - mark.top),
  );
  const other = side === 'right' ? 'left' : 'right';
  const gap = Math.max(
    options.minGap,
    options.minGapRatio * (mark.bottom - mark.top),
  );
  const indices: number[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (Math.abs((b.top + b.bottom) / 2 - centre) > half) {
      continue;
    }
    const distanceOut =
      side === 'right' ? b.left - mark.right : mark.left - b.right;
    if (distanceOut < gap) {
      const onOther =
        side === 'right' ? b.right <= mark.left : b.left >= mark.right;
      if (onOther) {
        return {reason: `writing on the ${other} of the mark`};
      }
      return {
        reason:
          distanceOut < 0
            ? 'mark touches the writing'
            : `mark too close to the writing (${Math.round(
                distanceOut,
              )} px, needs ${Math.round(gap)})`,
      };
    }
    indices.push(i);
  }
  return indices.length > 0
    ? {indices}
    : {reason: 'no writing next to the mark'};
}
