import { useEffect, useState } from 'react';
import { getRepsSummary, type RepSummary } from '../../api/reps';

/** This coach's Reps summary: undefined while loading, null if it failed. */
export function useRepsSummary(enabled = true): RepSummary[] | null | undefined {
  const [reps, setReps] = useState<RepSummary[] | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getRepsSummary()
      .then((list) => !cancelled && setReps(list))
      // Home does not fail over Reps: no summary, no card.
      .catch(() => !cancelled && setReps(null));
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return reps;
}
