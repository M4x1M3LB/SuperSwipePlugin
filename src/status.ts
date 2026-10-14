import type {Gestures, Outcome} from './selector';

/**
 * In-memory plugin state shared between the background listener and the
 * plugin view. Lives as long as PluginHost keeps the plugin loaded.
 */
type Listener = () => void;

let gestures: Gestures = {
  loopSelect: true,
  marginErase: true,
  lineSelect: true,
  barSelect: true,
  screenRefresh: true,
};
let lastOutcome: Outcome | null = null;
let lastTrace: string[] = [];
let penUpCount = 0;
/** One line per recent stroke, newest first. */
let history: string[] = [];
const HISTORY_LENGTH = 8;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach(l => l());
}

export const status = {
  gestures: (): Gestures => gestures,
  setGesture(name: keyof Gestures, on: boolean) {
    gestures = {...gestures, [name]: on};
    notify();
  },
  /** Pen-up events received from the host since the plugin started. */
  penUpCount: () => penUpCount,
  countPenUp() {
    penUpCount++;
  },
  lastOutcome: () => lastOutcome,
  /** Step-by-step log of the last stroke, for diagnosing on the device. */
  lastTrace: () => lastTrace,
  setLast(outcome: Outcome, trace: string[]) {
    lastOutcome = outcome;
    lastTrace = trace;
    history = [summarise(outcome, trace), ...history].slice(0, HISTORY_LENGTH);
    notify();
  },
  /** The last few strokes, newest first, one line each. */
  history: () => history,
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function describeOutcome(outcome: Outcome | null): string {
  if (!outcome) {
    return 'No gesture drawn yet.';
  }
  switch (outcome.kind) {
    case 'selected':
      return `Selected ${plural(outcome.count, 'element')}.`;
    case 'erased':
      return `Erased ${plural(outcome.count, 'stroke')}.`;
    case 'ignored':
      return `Last stroke left as ink: ${outcome.reason}.`;
    case 'failed':
      return `Last gesture failed: ${outcome.reason}.`;
  }
}

/**
 * One line for the stroke history: what happened, and for a stroke that was
 * not taken as a gesture, why each check refused it.
 */
export function summarise(outcome: Outcome, trace: string[]): string {
  const time = new Date().toTimeString().slice(0, 8);
  const reasons = trace
    .filter(l => l.includes('check:'))
    .map(l => l.trim())
    .join('; ');
  const what = describeOutcome(outcome);
  return reasons && outcome.kind === 'ignored'
    ? `${time} ${what} (${reasons})`
    : `${time} ${what}`;
}
