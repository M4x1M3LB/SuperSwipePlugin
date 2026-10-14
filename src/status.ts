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
/** Strokes that made us save and read the page, and how each ended. */
let pageReads = 0;
const pageReadEnds = new Map<string, number>();
/** Motion events received, by action (-1: none given). */
const motion: Record<number, number> = {};

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
  /** Screens currently subscribed (is one kept while the view is closed?). */
  listenerCount: () => listeners.size,
  /** A stroke that read the page ended with this outcome. */
  countPageRead(outcome: Outcome) {
    pageReads++;
    const key = endKey(outcome);
    pageReadEnds.set(key, (pageReadEnds.get(key) ?? 0) + 1);
  },
  /** e.g. "Page reads: 37; 31 left as ink: loop encloses nothing 20, …" */
  pageReadSummary: () => summarisePageReads(pageReads, pageReadEnds),
  /** Called for every motion event, before any filtering: no allocation. */
  countMotion(action: number) {
    motion[action] = (motion[action] ?? 0) + 1;
  },
  /** e.g. "0: 12, 1: 12, 2: 340, 7: 51" (action: events). */
  motionSummary(): string {
    const parts = Object.keys(motion)
      .map(Number)
      .sort((a, b) => a - b)
      .map(action => `${action}: ${motion[action]}`);
    return parts.length > 0 ? parts.join(', ') : 'none yet';
  },
};

const KINDS: Outcome['kind'][] = ['ignored', 'selected', 'erased', 'failed'];

/** What a stroke ended with, numbers left out so alike reasons add up. */
function endKey(outcome: Outcome): string {
  const reason =
    'reason' in outcome ? outcome.reason.replace(/\d+(\.\d+)?/g, '#') : '';
  return `${outcome.kind}|${reason}`;
}

export function summarisePageReads(
  total: number,
  ends: Map<string, number>,
): string {
  if (total === 0) {
    return 'Page reads: none yet.';
  }
  const groups = KINDS.map(kind => {
    const reasons = [...ends]
      .filter(([key]) => key.startsWith(`${kind}|`))
      .map(([key, count]) => ({reason: key.slice(kind.length + 1), count}))
      .sort((a, b) => b.count - a.count);
    const count = reasons.reduce((sum, r) => sum + r.count, 0);
    if (count === 0) {
      return null;
    }
    const label = kind === 'ignored' ? 'left as ink' : kind;
    const detail = reasons
      .filter(r => r.reason)
      .map(r => `${r.reason} ${r.count}`)
      .join(', ');
    return detail ? `${count} ${label}: ${detail}` : `${count} ${label}`;
  }).filter((g): g is string => g !== null);
  return `Page reads: ${total}; ${groups.join('; ')}.`;
}

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
