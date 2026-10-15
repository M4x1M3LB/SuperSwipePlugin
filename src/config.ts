import {
  DEFAULT_BAR_OPTIONS,
  DEFAULT_BLOCK_OPTIONS,
  DEFAULT_LOOP_OPTIONS,
  DEFAULT_STRAIGHT_LINE_OPTIONS,
  DEFAULT_WAVE_OPTIONS,
  DEFAULT_WRITING_LINE_OPTIONS,
  type BarOptions,
  type BlockOptions,
  type LoopOptions,
  type StraightLineOptions,
  type WaveOptions,
  type WritingLineOptions,
} from './geometry';

export interface SelectorConfig {
  loop: LoopOptions;
  /** The margin wave: a sideways wave with 5 bounces or more ("∿∿∿"). */
  wave: WaveOptions;
  /** The separator line: straight, horizontal. */
  straightLine: StraightLineOptions;
  /** A separator line spans at least this fraction of the page width... */
  lineMinWidthRatio: number;
  /** ...no writing comes closer than this, in px, below or beside it... */
  lineClearance: number;
  /** ...nor this, in px, above it over its span (an underline). */
  lineUnderlineClearance: number;
  /**
   * Shortest line, in page px, worth reading the page for: 12 % of 1404 px,
   * the narrowest page, so a shorter one would be refused there anyway.
   */
  lineMinPenUpLength: number;
  /**
   * A pen-up copy with a coordinate above this is in the digitiser's units
   * (EMR): pages are at most 3414 px...
   */
  maxPagePx: number;
  /** ...and EMR units per page px, to measure it (from the SDK's PointUtils). */
  emrPerPx: number;
  /** The margin bar: a roughly vertical stroke ("|", "[", gentle "("). */
  bar: BarOptions;
  /** Which writing beside a bar is its block. */
  block: BlockOptions;
  /** Shortest bar worth reading the page for, in page px. */
  barMinPenUpLength: number;
  /** A bar is at least this tall, in px, and this × the page height... */
  barMinPx: number;
  barMinHeightRatio: number;
  /** ...and at most this × the page height (longer: a page rule). */
  barMaxHeightRatio: number;
  /** Which strokes form the line of writing next to the wave. */
  writingLine: WritingLineOptions;
  /** Strokes closer than this, in px, count as touching. */
  eraseTouchTolerance: number;
  /**
   * Pen types whose strokes may trigger a gesture. The SDK documents
   * 10 (fineliner/technical), 16 (pressure), 15 (calligraphy); 1 is an older
   * ink pen id seen on devices. Marker (11) is left out on purpose: circling
   * or marking with the highlighter is almost always emphasis.
   * Lasso-tool paths also arrive on pen-up with penType 4 and must never
   * match.
   */
  triggerPenTypes: number[];
  /** Fraction of an element's outline that must be inside the loop. */
  minInsideFraction: number;
  /** How far outside the drawn loop, in px, still counts as inside. */
  loopMargin: number;
  /** Padding added around the enclosed elements' box for the lasso, in px. */
  lassoPadding: number;
  /** Give up on a stroke that takes longer than this to process, in ms. */
  timeoutMs: number;
  /** Max time to wait for the pen to lift before editing the page, in ms. */
  penUpWaitMs: number;
}

export const DEFAULT_CONFIG: SelectorConfig = {
  loop: DEFAULT_LOOP_OPTIONS,
  wave: DEFAULT_WAVE_OPTIONS,
  straightLine: DEFAULT_STRAIGHT_LINE_OPTIONS,
  lineMinWidthRatio: 0.12,
  lineClearance: 20,
  lineUnderlineClearance: 40,
  lineMinPenUpLength: 168,
  maxPagePx: 3500,
  emrPerPx: 8.45,
  bar: DEFAULT_BAR_OPTIONS,
  block: DEFAULT_BLOCK_OPTIONS,
  barMinPenUpLength: 100,
  barMinPx: 100,
  barMinHeightRatio: 0.06,
  barMaxHeightRatio: 0.75,
  writingLine: DEFAULT_WRITING_LINE_OPTIONS,
  eraseTouchTolerance: 4,
  triggerPenTypes: [1, 10, 15, 16],
  minInsideFraction: 0.5,
  loopMargin: 20,
  lassoPadding: 4,
  timeoutMs: 8000,
  penUpWaitMs: 5000,
};
