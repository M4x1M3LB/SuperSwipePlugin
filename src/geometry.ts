/**
 * Pure geometry for the gestures: loop, straight line and margin wave
 * detection, containment, touching strokes and the line of writing next to
 * a wave. No SDK imports so everything here is unit-testable in plain Jest.
 *
 * Page copies of strokes are in Android page pixels (sn-plugin-lib >
 * 0.1.65). The pen-up copy may use another system (scale, axes), so checks
 * run on it use ratios and angles only.
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
 * The smallest count k (0..n+1) with `k / n >= fraction`, so `count >= k`
 * holds exactly when `count / n >= fraction` does (the division is
 * monotonic in k): no float compared against fraction × n.
 */
export function minCountFor(fraction: number, n: number): number {
  let k = Math.ceil(fraction * n);
  if (!(k >= 0)) {
    k = 0;
  } else if (k > n + 1) {
    k = n + 1;
  }
  while (k > 0 && (k - 1) / n >= fraction) {
    k--;
  }
  while (k <= n && !(k / n >= fraction)) {
    k++;
  }
  return k;
}

/**
 * `fractionInside(points, polygon) >= fraction`, stopping as soon as the
 * answer is known. `polygonBox` must be the polygon's bounding box.
 */
export function insideAtLeast(
  points: Pt[],
  polygon: Pt[],
  fraction: number,
  polygonBox: Box = boundingBox(polygon),
): boolean {
  const n = points.length;
  if (n === 0) {
    return fraction <= 0;
  }
  const needed = minCountFor(fraction, n);
  if (needed === 0) {
    return true;
  }
  const box = polygonBox;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (count + (n - i) < needed) {
      return false;
    }
    const p = points[i];
    if (
      p.x >= box.left &&
      p.x <= box.right &&
      p.y >= box.top &&
      p.y <= box.bottom &&
      pointInPolygon(p, polygon)
    ) {
      count++;
      if (count >= needed) {
        return true;
      }
    }
  }
  return false;
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
  const {i: bestI, j: bestJ, gap: bestGap} = closingPair(points, options);
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

/**
 * Squared distances this close (relatively) may order differently from
 * `Math.hypot`; such near-ties are settled with `Math.hypot`, as before.
 */
const NEAR_TIE = 1e-9;

/**
 * Where a loop closes: the closest pair of points, i in the head and j in
 * the tail (the first such pair in i, then j order on a tie), at least the
 * loop's minimum span apart. i is -1 when no pair qualifies. `gap` is
 * exactly `distance(points[i], points[j])`.
 */
export function closingPair(
  points: Pt[],
  options: LoopOptions = DEFAULT_LOOP_OPTIONS,
): {i: number; j: number; gap: number} {
  const n = points.length;
  const window = Math.max(1, Math.floor(n * options.endSearchRatio));
  // j - i must be at least this (both bounds are whole numbers of points).
  const minSpan = Math.max(
    Math.ceil(options.minPoints - 1),
    Math.ceil(options.minSpanRatio * (n - 1)),
  );
  let bestI = -1;
  let bestJ = -1;
  let bestSq = Infinity;
  let bestGap = Infinity;
  for (let i = 0; i < window; i++) {
    const pi = points[i];
    for (let j = Math.max(n - window, i + minSpan); j < n; j++) {
      const pj = points[j];
      const dx = pi.x - pj.x;
      const dy = pi.y - pj.y;
      const sq = dx * dx + dy * dy;
      if (sq < bestSq * (1 - NEAR_TIE)) {
        bestSq = sq;
        bestGap = Math.hypot(dx, dy);
        bestI = i;
        bestJ = j;
      } else if (sq <= bestSq * (1 + NEAR_TIE)) {
        const gap = Math.hypot(dx, dy);
        if (gap < bestGap) {
          bestSq = sq;
          bestGap = gap;
          bestI = i;
          bestJ = j;
        }
      }
    }
  }
  return {i: bestI, j: bestJ, gap: bestGap};
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

/** Do the boxes overlap, or come within `margin` of each other? */
export function overlapsWithin(a: Box, b: Box, margin: number): boolean {
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
 * exactly). `aBox` and `bBox`, when given, must be the bounding boxes of
 * exactly `a` and `b` (saves computing them again).
 */
export function strokesTouch(
  a: Pt[],
  b: Pt[],
  tolerance: number,
  aBox?: Box,
  bBox?: Box,
): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  if (
    !overlapsWithin(aBox ?? boundingBox(a), bBox ?? boundingBox(b), tolerance)
  ) {
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
   * tilde "~" has 2, an "m" or "w" 3 or 4, so it needs 5 or more ("∿∿∿").
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
  minBounces: 5,
  bounceRatio: 0.25,
  minAspect: 1,
  minFlatness: 0.12,
  maxBacktrack: 0.15,
  minSize: 20,
  maxSize: 400,
};

/**
 * Is the stroke a sideways wave with 5 bounces or more (like "∿∿∿"), drawn left to right or right to left? Returns its
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

export interface BarOptions {
  /** Fraction of the path trimmed off each end (landing hooks, "[" arms). */
  trimRatio: number;
  /** Shape of what is left: within this of vertical, bow and wobble. */
  core: StraightLineOptions;
  /** The whole stroke's width over its height, at most ("[" arms included). */
  maxWidthRatio: number;
}

export const DEFAULT_BAR_OPTIONS: BarOptions = {
  trimRatio: 0.12,
  core: {
    minPoints: 5,
    maxDeviation: 0.15,
    maxPathRatio: 1.45,
    maxTiltDegrees: 20,
  },
  maxWidthRatio: 0.45,
};

/** The stroke without `ratio` of its path length at each end. */
export function trimEnds(points: Pt[], ratio: number): Pt[] {
  const cut = pathLength(points) * ratio;
  let from = 0;
  for (let run = 0; from + 1 < points.length; from++) {
    run += distance(points[from], points[from + 1]);
    if (run > cut) {
      break;
    }
  }
  let to = points.length - 1;
  for (let run = 0; to - 1 > from; to--) {
    run += distance(points[to], points[to - 1]);
    if (run > cut) {
      break;
    }
  }
  return points.slice(from, to + 1);
}

/**
 * Is the stroke a vertical bar: "|", "[", "]" or a gentle "(", drawn up or
 * down, leaning, bowing or wobbling a little? Returns its bounding box, or
 * why not. Only ratios and angles, so it also works on the pen-up copy
 * (callers try both axes there).
 */
export function checkVerticalBar(
  points: Pt[],
  options: BarOptions = DEFAULT_BAR_OPTIONS,
): {box: Box} | {reason: string} {
  const core = trimEnds(points, options.trimRatio);
  // A vertical bar is a horizontal line with the axes swapped.
  const swapped = core.map(p => ({x: p.y, y: p.x}));
  const straight = checkStraightLine(swapped, options.core);
  if ('reason' in straight) {
    return {
      reason: straight.reason.replace('not horizontal', 'not vertical'),
    };
  }
  const box = boundingBox(points);
  if (box.right - box.left > options.maxWidthRatio * (box.bottom - box.top)) {
    return {reason: 'too wide for a bar'};
  }
  return {box};
}

export interface BlockOptions {
  /** Nearest writing at least this far from the bar, in px... */
  minGap: number;
  /** ...and at most this fraction of the page width. */
  maxFirstGapRatio: number;
  /** A wider empty gutter, × page width, ends the block (a second column). */
  maxChainGapRatio: number;
  /** The selection must cover at least this much of the bar's height. */
  minCoverage: number;
}

export const DEFAULT_BLOCK_OPTIONS: BlockOptions = {
  minGap: 8,
  maxFirstGapRatio: 0.15,
  maxChainGapRatio: 0.1,
  minCoverage: 0.5,
};

/**
 * The block of writing beside a margin bar: indices of the boxes level with
 * it, on its one side, from the nearest out to the first empty gutter.
 * Refused (with a reason) when the bar runs through the writing, has
 * writing on both sides, or does not look like it marks a block.
 */
export function findBlockBesideBar(
  bar: Box,
  boxes: Box[],
  pageWidth: number,
  options: BlockOptions = DEFAULT_BLOCK_OPTIONS,
): {indices: number[]; side: 'left' | 'right'} | {reason: string} {
  const height = bar.bottom - bar.top;
  const centre = (b: Box) => (b.top + b.bottom) / 2;
  // Level: centre within the bar, give or take half a letter, so a bar
  // stopping a little short still takes the first and last line.
  const inside = boxes.filter(
    b => centre(b) >= bar.top && centre(b) <= bar.bottom,
  );
  const heights = inside.map(b => b.bottom - b.top).sort((a, b) => a - b);
  const median = heights.length ? heights[Math.floor(heights.length / 2)] : 30;
  const pad = Math.min(50, Math.max(15, median)) / 2;
  const level = boxes
    .map((b, i) => ({b, i}))
    .filter(
      ({b}) => centre(b) >= bar.top - pad && centre(b) <= bar.bottom + pad,
    );

  const right = level.filter(({b}) => b.left >= bar.right);
  const left = level.filter(({b}) => b.right <= bar.left);
  if (right.length + left.length < level.length) {
    return {reason: 'bar runs through the writing'};
  }
  if (right.length > 0 && left.length > 0) {
    return {reason: 'writing on both sides of the bar'};
  }
  if (right.length === 0 && left.length === 0) {
    return {reason: 'no writing beside the bar'};
  }
  const side = right.length > 0 ? 'right' : 'left';
  // Distance from the bar, along the side: near edge and far edge.
  const near = (b: Box) =>
    side === 'right' ? b.left - bar.right : bar.left - b.right;
  const far = (b: Box) =>
    side === 'right' ? b.right - bar.right : bar.left - b.left;
  const group = (side === 'right' ? right : left).sort(
    (a, b) => near(a.b) - near(b.b),
  );

  const first = near(group[0].b);
  if (first < options.minGap) {
    return {reason: `bar too close to the writing (${Math.round(first)} px)`};
  }
  if (first > options.maxFirstGapRatio * pageWidth) {
    return {reason: `writing too far from the bar (${Math.round(first)} px)`};
  }
  const taken: {b: Box; i: number}[] = [];
  let reach = 0;
  for (const g of group) {
    if (
      taken.length > 0 &&
      near(g.b) - reach > options.maxChainGapRatio * pageWidth
    ) {
      break;
    }
    taken.push(g);
    reach = Math.max(reach, far(g.b));
  }

  const union = unionBoxes(taken.map(t => t.b))!;
  if (union.bottom - union.top < options.minCoverage * height) {
    return {reason: 'too little writing beside the bar (an axis?)'};
  }
  // A bracket or border facing the bar: a closing matrix bracket, a table.
  const facing = taken.some(({b}) => {
    const h = b.bottom - b.top;
    const overlap = Math.min(b.bottom, bar.bottom) - Math.max(b.top, bar.top);
    return (
      h >= 0.6 * height &&
      b.right - b.left <= 0.35 * h &&
      overlap >= 0.6 * height
    );
  });
  if (facing) {
    return {reason: 'a bracket or border faces the bar'};
  }
  return {indices: taken.map(t => t.i).sort((a, b) => a - b), side};
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
        return {reason: `writing on the ${other} of the wave`};
      }
      return {
        reason:
          distanceOut < 0
            ? 'wave touches the writing'
            : `wave too close to the writing (${Math.round(
                distanceOut,
              )} px, needs ${Math.round(gap)})`,
      };
    }
    indices.push(i);
  }
  return indices.length > 0
    ? {indices}
    : {reason: 'no writing next to the wave'};
}
