import {
  DEFAULT_LOOP_OPTIONS,
  DEFAULT_MARK_OPTIONS,
  DEFAULT_WRITING_LINE_OPTIONS,
  type LoopOptions,
  type MarkOptions,
  type WritingLineOptions,
} from './geometry';

export interface SelectorConfig {
  loop: LoopOptions;
  /** The margin ✕: two short straight strokes crossing near their middles. */
  mark: MarkOptions;
  /** Max time between the two strokes of the ✕, in ms. */
  markMaxDelayMs: number;
  /** Which strokes form the line of writing next to the ✕. */
  writingLine: WritingLineOptions;
  /** Strokes closer than this, in px, count as touching. */
  eraseTouchTolerance: number;
  /**
   * Pen types whose strokes may trigger a selection. The SDK documents
   * 10 (fineliner/technical), 16 (pressure), 15 (calligraphy); 1 is an older
   * ink pen id seen on devices. Marker (11) is left out on purpose: circling
   * or crossing with the highlighter is almost always emphasis.
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
  mark: DEFAULT_MARK_OPTIONS,
  markMaxDelayMs: 2000,
  writingLine: DEFAULT_WRITING_LINE_OPTIONS,
  eraseTouchTolerance: 4,
  triggerPenTypes: [1, 10, 15, 16],
  minInsideFraction: 0.5,
  loopMargin: 20,
  lassoPadding: 4,
  timeoutMs: 8000,
  penUpWaitMs: 5000,
};
