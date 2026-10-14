import type {Gestures, Outcome} from './selector';

/**
 * In-memory plugin state shared between the background listener and the
 * plugin view. Lives as long as PluginHost keeps the plugin loaded.
 */
type Listener = () => void;

let gestures: Gestures = {loopSelect: true, lineErase: true};
let lastOutcome: Outcome | null = null;
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
  lastOutcome: () => lastOutcome,
  setLastOutcome(outcome: Outcome) {
    lastOutcome = outcome;
    notify();
  },
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
