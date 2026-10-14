import {DEFAULT_LOOP_OPTIONS, type LoopOptions} from './geometry';

export interface SelectorConfig {
  loop: LoopOptions;
  /**
   * Pen types whose strokes may trigger a selection. The SDK documents
   * 10 (fineliner/technical), 16 (pressure), 15 (calligraphy); 1 is an older
   * ink pen id seen on devices. Marker (11) is left out on purpose: circling
   * with the highlighter is almost always emphasis, not a selection.
   * Lasso-tool paths also arrive on pen-up with penType 4 and must never
   * match.
   */
  triggerPenTypes: number[];
  /** Fraction of an element's outline that must be inside the loop. */
  minInsideFraction: number;
  /** Padding added around the enclosed elements' box for the lasso, in px. */
  lassoPadding: number;
  /** Give up on a stroke that takes longer than this to process, in ms. */
  timeoutMs: number;
  /** Max time to wait for the pen to lift before editing the page, in ms. */
  penUpWaitMs: number;
}

export const DEFAULT_CONFIG: SelectorConfig = {
  loop: DEFAULT_LOOP_OPTIONS,
  triggerPenTypes: [1, 10, 15, 16],
  minInsideFraction: 0.85,
  lassoPadding: 4,
  timeoutMs: 8000,
  penUpWaitMs: 5000,
};
