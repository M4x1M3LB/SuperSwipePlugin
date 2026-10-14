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
   * Polygon area divided by bounding-box area. Rejects strokes that double
   * back on themselves (zig-zags, scribbles) which close but enclose nothing.
   */
  minFillRatio: number;
}

export const DEFAULT_LOOP_OPTIONS: LoopOptions = {
  minPoints: 12,
  minSize: 40,
  closeGapPx: 60,
  closeGapRatio: 0.12,
  endSearchRatio: 0.3,
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

/** Even-odd ray casting. The polygon is implicitly closed. */
export function pointInPolygon(p: Pt, polygon: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
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
export function findClosedLoop(
  points: Pt[],
  options: LoopOptions = DEFAULT_LOOP_OPTIONS,
): Pt[] | null {
  const n = points.length;
  if (n < options.minPoints) {
    return null;
  }

  const box = boundingBox(points);
  if (
    box.right - box.left < options.minSize ||
    box.bottom - box.top < options.minSize
  ) {
    return null;
  }

  const length = pathLength(points);
  const maxGap = Math.max(options.closeGapPx, options.closeGapRatio * length);
  const window = Math.max(1, Math.floor(n * options.endSearchRatio));

  let bestI = -1;
  let bestJ = -1;
  let bestGap = Infinity;
  for (let i = 0; i < window; i++) {
    for (let j = n - window; j < n; j++) {
      if (j - i < options.minPoints - 1) {
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
    return null;
  }

  const polygon = points.slice(bestI, bestJ + 1);
  const polyBox = boundingBox(polygon);
  const boxArea =
    (polyBox.right - polyBox.left) * (polyBox.bottom - polyBox.top);
  if (boxArea <= 0 || polygonArea(polygon) / boxArea < options.minFillRatio) {
    return null;
  }
  return polygon;
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

export interface ScribbleOptions {
  /** Minimum number of sample points. */
  minPoints: number;
  /** Smallest allowed width of the scribble, in its own units. */
  minWidth: number;
  /**
   * Horizontal direction changes required (3 = four passes). A pass only
   * counts when it covers at least `minPassRatio` of the scribble's width,
   * so the small backtracks of handwriting ("e", "l", "o") do not count.
   */
  minReversals: number;
  minPassRatio: number;
}

export const DEFAULT_SCRIBBLE_OPTIONS: ScribbleOptions = {
  minPoints: 10,
  minWidth: 30,
  minReversals: 3,
  minPassRatio: 0.4,
};

/**
 * Is the stroke a scratch-out: a back-and-forth horizontal scribble?
 * Returns its bounding box if so.
 */
export function findScribble(
  points: Pt[],
  options: ScribbleOptions = DEFAULT_SCRIBBLE_OPTIONS,
): Box | null {
  if (points.length < options.minPoints) {
    return null;
  }
  const box = boundingBox(points);
  const width = box.right - box.left;
  if (width < options.minWidth) {
    return null;
  }
  const minPass = options.minPassRatio * width;
  // Follow x. `far` is the furthest x reached in the current direction; a
  // reversal counts once the pen has come back `minPass` from it.
  const start = points[0].x;
  let direction = 0;
  let far = start;
  let reversals = 0;
  for (const {x} of points) {
    if (direction === 0) {
      if (Math.abs(x - start) >= minPass) {
        direction = Math.sign(x - start);
        far = x;
      }
    } else if ((x - far) * direction > 0) {
      far = x;
    } else if ((far - x) * direction >= minPass) {
      reversals++;
      direction = -direction;
      far = x;
    }
  }
  return reversals >= options.minReversals ? box : null;
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
