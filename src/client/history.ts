/**
 * Undo stack for editor state. Snapshots are plain values, so undoing a split
 * restores the exact pre-split cues — text and annotations identical, no
 * re-derivation from the split result.
 */
export type History<T> = {past: T[]; present: T};

export function historyOf<T>(present: T): History<T> {
  return {past: [], present};
}

export function pushHistory<T>(history: History<T>, next: T): History<T> {
  return {past: [...history.past, history.present], present: next};
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function undoHistory<T>(history: History<T>): History<T> {
  if (!canUndo(history)) return history;
  const past = history.past.slice(0, -1);
  return {past, present: history.past[history.past.length - 1]};
}
