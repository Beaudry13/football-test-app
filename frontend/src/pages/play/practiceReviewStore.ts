// A FINISHED PRACTICE, KEPT FOR THIS TAB - so a refresh comes back to
// "Practice complete" and Review missed instead of a fresh run.
//
// Only the player's OWN picks and verdicts, in sessionStorage: it dies with the
// tab, never leaves the device, and needs no new API or proof. (Restoring it
// on another device would mean reading a submitted attempt back from the
// server - a new player-facing endpoint, deliberately not built here.)

import type { PracticeFeedback } from '../../api/types';
import type { RememberedPlayer } from './playerSession';

const PREFIX = 'peira.play.practiceReview.v1';

interface Stored {
  /** Whose run it was: player id, or the free-text name. */
  who: string;
  feedback: PracticeFeedback[];
  /** The question ids in the order he met them. */
  order: number[];
  chosen: Record<number, number[]>;
  /** The finished run - what "Try the misses again" retries. */
  attemptId?: number;
}

const keyFor = (code: string) => `${PREFIX}:${code.trim().toUpperCase()}`;
const whoOf = (player: RememberedPlayer) => (player.playerId !== null ? `p${player.playerId}` : `n:${player.name}`);

export function savePracticeReview(
  code: string,
  player: RememberedPlayer,
  feedback: PracticeFeedback[],
  order: number[],
  chosen: Record<number, number[]>,
  attemptId?: number,
): void {
  try {
    const value: Stored = { who: whoOf(player), feedback, order, chosen, ...(attemptId !== undefined ? { attemptId } : {}) };
    window.sessionStorage.setItem(keyFor(code), JSON.stringify(value));
  } catch {
    // A private window or a full store: the review simply does not survive a refresh.
  }
}

/** This tab's finished practice for this code, if it was this player's. */
export function readPracticeReview(code: string, player: RememberedPlayer): Omit<Stored, 'who'> | null {
  try {
    const raw = window.sessionStorage.getItem(keyFor(code));
    if (!raw) return null;
    const value = JSON.parse(raw) as Stored;
    if (value.who !== whoOf(player) || !Array.isArray(value.feedback) || !Array.isArray(value.order)) return null;
    return {
      feedback: value.feedback,
      order: value.order,
      chosen: value.chosen ?? {},
      attemptId: typeof value.attemptId === 'number' ? value.attemptId : undefined,
    };
  } catch {
    return null;
  }
}

export function clearPracticeReview(code: string): void {
  try {
    window.sessionStorage.removeItem(keyFor(code));
  } catch {
    // Nothing to clear.
  }
}
