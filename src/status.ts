import type {Outcome} from './selector';

/**
 * In-memory plugin state shared between the background listener and the
 * plugin view. Lives as long as PluginHost keeps the plugin loaded.
 */
type Listener = () => void;

let enabled = true;
let lastOutcome: Outcome | null = null;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach(l => l());
}

export const status = {
  isEnabled: () => enabled,
  setEnabled(value: boolean) {
    enabled = value;
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

export function describeOutcome(outcome: Outcome | null): string {
  if (!outcome) {
    return 'No loop drawn yet.';
  }
  switch (outcome.kind) {
    case 'selected':
      return `Selected ${outcome.count} element${
        outcome.count === 1 ? '' : 's'
      }.`;
    case 'ignored':
      return `Last stroke ignored: ${outcome.reason}.`;
    case 'failed':
      return `Last loop failed: ${outcome.reason}.`;
  }
}
