import { useEffect } from 'react';
import { useAuth } from '../../auth/AuthContext';

/**
 * WHERE THE COACH LEFT OFF: the quiz or Rep he last opened, on this device.
 *
 * One entry, overwritten each time - not a history. Home turns it into one
 * quiet "Pick up where you left off" line, and only while that quiz or Rep
 * still exists (the caller checks), so the cue can never be a dead link.
 * Per coach, so two coaches sharing a laptop do not pick up each other's work.
 */
export interface LastWork {
  kind: 'quiz' | 'rep';
  id: number;
  title: string;
  at: number;
}

const key = (coachId: number) => `peira.coach.lastWork.v1.${coachId}`;

export function readLastWork(coachId: number | null | undefined): LastWork | null {
  if (coachId == null) return null;
  try {
    const raw = window.localStorage.getItem(key(coachId));
    return raw ? (JSON.parse(raw) as LastWork) : null;
  } catch {
    return null;
  }
}

export function rememberWork(coachId: number | null | undefined, work: Omit<LastWork, 'at'>): void {
  if (coachId == null) return;
  try {
    window.localStorage.setItem(key(coachId), JSON.stringify({ ...work, at: Date.now() }));
  } catch {
    // A private window: Home simply offers no "pick up" line.
  }
}

/** The signed-in coach's id - null when rendered on its own (a test). */
function useCoachIdOrNull(): number | null {
  try {
    const { coach } = useAuth();
    return coach ? coach.id : null;
  } catch {
    return null;
  }
}

/** Remember `work` (once it is known) as where the signed-in coach left off. */
export function useRememberWork(work: Omit<LastWork, 'at'> | null): void {
  const coachId = useCoachIdOrNull();
  const id = work ? `${work.kind}:${work.id}:${work.title}` : '';
  useEffect(() => {
    if (work) rememberWork(coachId, work);
    // Keyed on what the work IS, not on the object's identity each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, coachId]);
}
