import {
  DEFAULT_CORNER_OPTIONS,
  DEFAULT_LOOP_OPTIONS,
  DEFAULT_STRAIGHT_LINE_OPTIONS,
  DEFAULT_WAVE_OPTIONS,
  DEFAULT_WRITING_LINE_OPTIONS,
  type CornerOptions,
  type LoopOptions,
  type StraightLineOptions,
  type WaveOptions,
  type WritingLineOptions,
} from './geometry';

export interface SelectorConfig {
  loop: LoopOptions;
  /** The margin mark: a sideways wave with 3 bounces or more ("∿∿"). */
  wave: WaveOptions;
  /** The separator line: straight, horizontal. */
  straightLine: StraightLineOptions;
  /** A separator line spans at least this fraction of the page width... */
  lineMinWidthRatio: number;
  /** ...and no writing comes closer than this, in px (an underline). */
  lineClearance: number;
  /**
   * Shortest line, in the pen-up copy's own units, worth reading the page
   * for. The device's other unit (EMR) is larger than page px, so this is
   * never stricter than it reads.
   */
  lineMinPenUpLength: number;
  /** The ┌ and ┘ corners of a selection rectangle. */
  corner: CornerOptions;
  /** How many of the newest strokes to search for a corner's partner. */
  cornerPartnerSearch: number;
  /** Which strokes form the line of writing next to the mark. */
  writingLine: WritingLineOptions;
  /** Strokes closer than this, in px, count as touching. */
  eraseTouchTolerance: number;
  /**
   * Pen types whose strokes may trigger a selection. The SDK documents
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
  lineMinWidthRatio: 0.3,
  lineClearance: 20,
  lineMinPenUpLength: 300,
  corner: DEFAULT_CORNER_OPTIONS,
  cornerPartnerSearch: 20,
  writingLine: DEFAULT_WRITING_LINE_OPTIONS,
  eraseTouchTolerance: 4,
  triggerPenTypes: [1, 10, 15, 16],
  minInsideFraction: 0.5,
  loopMargin: 20,
  lassoPadding: 4,
  timeoutMs: 8000,
  penUpWaitMs: 5000,
};
