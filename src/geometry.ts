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

export interface SpiralOptions {
  /** Minimum number of sample points. */
  minPoints: number;
  /** How far the stroke must turn in total, in degrees (540 = 1½ turns). */
  minTurnDegrees: number;
  /**
   * The outer end must be at least this many times further from the centre
   * than the inner end: a spiral grows, a loop drawn twice does not.
   */
  minGrowth: number;
  /** Fraction of the points at each end used to measure its distance. */
  endFraction: number;
  /** Size limits of the spiral's box, in px (checked on the page copy). */
  minSize: number;
  maxSize: number;
}

export const DEFAULT_SPIRAL_OPTIONS: SpiralOptions = {
  minPoints: 15,
  minTurnDegrees: 540,
  minGrowth: 2,
  endFraction: 0.15,
  minSize: 20,
  maxSize: 300,
};

/**
 * Is the stroke a spiral (a snail shell), drawn from the inside out or from
 * the outside in, either way round? Returns its bounding box, or why not.
 *
 * Turning and growth do not depend on the coordinate system, rotation or
 * scale, so with `checkSize` false the check works on the pen-up copy.
 */
export function checkSpiral(
  points: Pt[],
  options: SpiralOptions = DEFAULT_SPIRAL_OPTIONS,
  checkSize = true,
): {box: Box} | {reason: string} {
  if (points.length < options.minPoints) {
    return {reason: 'too few points'};
  }
  const turned = Math.abs(netTurning(points));
  if (turned < options.minTurnDegrees) {
    return {
      reason: `turns ${Math.round(turned)}° (needs ${options.minTurnDegrees}°)`,
    };
  }
  const centre = points.reduce(
    (acc, p) => ({
      x: acc.x + p.x / points.length,
      y: acc.y + p.y / points.length,
    }),
    {x: 0, y: 0},
  );
  const k = Math.max(1, Math.floor(points.length * options.endFraction));
  const meanDistance = (pts: Pt[]) =>
    pts.reduce((sum, p) => sum + distance(p, centre), 0) / pts.length;
  const a = meanDistance(points.slice(0, k));
  const b = meanDistance(points.slice(points.length - k));
  const growth = Math.max(a, b) / Math.max(1e-9, Math.min(a, b));
  if (growth < options.minGrowth) {
    return {reason: `does not grow like a spiral (×${growth.toFixed(1)})`};
  }
  const box = boundingBox(points);
  if (checkSize) {
    const size = Math.max(box.right - box.left, box.bottom - box.top);
    if (size < options.minSize) {
      return {reason: 'too small'};
    }
    if (size > options.maxSize) {
      return {reason: `too big (${Math.round(size)} px)`};
    }
  }
  return {box};
}

export interface WritingLineOptions {
  /**
   * Strokes belong to the line next to the mark when their vertical centre
   * is within this many mark heights of the mark's centre...
   */
  bandScale: number;
  /** ...and at least this many px, for a small mark. */
  minBandHalf: number;
  /** Minimum gap between the mark and the writing, in px. */
  minGap: number;
}

export const DEFAULT_WRITING_LINE_OPTIONS: WritingLineOptions = {
  bandScale: 0.9,
  minBandHalf: 30,
  minGap: 0,
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
  const indices: number[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (Math.abs((b.top + b.bottom) / 2 - centre) > half) {
      continue;
    }
    const onSide =
      side === 'right'
        ? b.left >= mark.right + options.minGap
        : b.right <= mark.left - options.minGap;
    if (!onSide) {
      const onOther =
        side === 'right' ? b.right <= mark.left : b.left >= mark.right;
      return {
        reason: onOther
          ? `writing on the ${other} of the mark`
          : 'mark touches the writing',
      };
    }
    indices.push(i);
  }
  return indices.length > 0
    ? {indices}
    : {reason: 'no writing next to the mark'};
}
