import {
  DEFAULT_LOOP_OPTIONS,
  DEFAULT_SCRIBBLE_OPTIONS,
  type LoopOptions,
  type ScribbleOptions,
} from './geometry';

export interface SelectorConfig {
  loop: LoopOptions;
  scribble: ScribbleOptions;
  /**
   * Also erase strokes that cross or touch a scribbled-over stroke (the rest
   * of the word: a "t" bar, connected letters).
   */
  eraseTouching: boolean;
  /** Strokes closer than this, in px, count as touching. */
  eraseTouchTolerance: number;
  /**
   * Pen types whose strokes may trigger a gesture. The SDK documents
   * 10 (fineliner/technical), 16 (pressure), 15 (calligraphy); 1 is an older
   * ink pen id seen on devices. Marker (11) is left out on purpose: circling
   * or scribbling with the highlighter is almost always emphasis or shading.
   * Lasso-tool paths also arrive on pen-up with penType 4 and must never
   * match.
   */
  triggerPenTypes: number[];
  /** Fraction of an element's outline that must be inside the loop. */
  minInsideFraction: number;
  /**
   * Margin around the gesture, in px, within which nearby elements are
   * gathered (a word only partly covered by the gesture is still found).
   */
  gatherMargin: number;
  /** Padding added around the elements' box for the lasso, in px. */
  lassoPadding: number;
  /** Give up on a stroke that takes longer than this to process, in ms. */
  timeoutMs: number;
  /** Max time to wait for the pen to lift before editing the page, in ms. */
  penUpWaitMs: number;
}

export const DEFAULT_CONFIG: SelectorConfig = {
  loop: DEFAULT_LOOP_OPTIONS,
  scribble: DEFAULT_SCRIBBLE_OPTIONS,
  eraseTouching: true,
  eraseTouchTolerance: 4,
  triggerPenTypes: [1, 10, 15, 16],
  minInsideFraction: 0.85,
  gatherMargin: 150,
  lassoPadding: 4,
  timeoutMs: 8000,
  penUpWaitMs: 5000,
};
