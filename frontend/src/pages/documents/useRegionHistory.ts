import { useCallback, useRef, useState } from 'react';

/** One reversible authoring action.
 *
 * Stored as a pair of thunks rather than as a diff of state: creating a
 * question is a server round-trip, and "undo" means deleting the row that came
 * back, not restoring a previous array. A snapshot-based stack would happily
 * restore a question the server still has.
 */
export interface HistoryEntry {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

const MAX_DEPTH = 50;

/** Undo/redo for the authoring loop.
 *
 * A coach building thirty questions will mis-tap. Without undo they slow down
 * and become careful, which costs far more than the mistake did - so this is a
 * speed feature, not a safety one.
 *
 * Actions are serialised through a busy flag: each undo/redo is a network
 * call, and letting a second start before the first resolves would apply them
 * out of order against the server.
 */
export function useRegionHistory() {
  const [past, setPast] = useState<HistoryEntry[]>([]);
  const [future, setFuture] = useState<HistoryEntry[]>([]);
  const busy = useRef(false);

  const push = useCallback((entry: HistoryEntry) => {
    setPast((current) => [...current, entry].slice(-MAX_DEPTH));
    // A new action makes the redo branch unreachable - keeping it would let a
    // coach "redo" onto a timeline that no longer exists.
    setFuture([]);
  }, []);

  const undo = useCallback(async () => {
    if (busy.current) return;
    const entry = past[past.length - 1];
    if (!entry) return;

    busy.current = true;
    try {
      await entry.undo();
      setPast((current) => current.slice(0, -1));
      setFuture((current) => [...current, entry]);
    } finally {
      busy.current = false;
    }
  }, [past]);

  const redo = useCallback(async () => {
    if (busy.current) return;
    const entry = future[future.length - 1];
    if (!entry) return;

    busy.current = true;
    try {
      await entry.redo();
      setFuture((current) => current.slice(0, -1));
      setPast((current) => [...current, entry]);
    } finally {
      busy.current = false;
    }
  }, [future]);

  const clear = useCallback(() => {
    // Called when the coach changes page or target quiz: an entry that undoes
    // something on a page they are no longer looking at would appear to do
    // nothing, which is worse than not offering it at all.
    setPast([]);
    setFuture([]);
  }, []);

  return {
    push,
    undo,
    redo,
    clear,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    nextUndoLabel: past[past.length - 1]?.label ?? null,
  };
}
