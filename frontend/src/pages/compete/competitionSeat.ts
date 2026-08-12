/**
 * Where a player's seat credential lives on their phone.
 *
 * sessionStorage, not localStorage: a competition is one sitting in one room.
 * A token that outlives the browser tab is a credential left behind on a
 * shared or borrowed phone, and it would still be there weeks later when it
 * can only cause confusion.
 *
 * ONE SEAT PER TAB. The key is not namespaced by join code - a player is in
 * one competition at a time, and keeping a drawer of old tokens around would
 * mean deciding which stale one to replay.
 *
 * WHAT IS STORED, AND WHAT IS NOT
 * -------------------------------
 * Stored: join code, token, display name. The name is stored so a reconnect
 * can render "YOU'RE IN, Ada Lovelace" before the server answers, which makes
 * a refresh feel instant rather than blank.
 *
 * NOT stored: the roster. It is other people's names, it is public only to
 * someone holding the code, and it changes constantly - persisting it would
 * mean carrying a stale copy of the room around for no benefit.
 *
 * NOT a credential, and deliberately absent from the type: player_id and
 * participant_id. Storing them would invite a future reconnect that uses them.
 */

const SEAT_KEY = 'peira_competition_seat';

export interface CompetitionSeat {
  joinCode: string;
  /** The opaque per-seat secret. Sent as X-Competition-Token, never shown. */
  token: string;
  displayName: string;
}

function storage(): Storage | null {
  // Private-mode Safari and some embedded webviews throw on access rather
  // than returning null. A player whose browser refuses storage should still
  // be able to play - they just lose reconnect - so this never throws.
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readSeat(): CompetitionSeat | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(SEAT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CompetitionSeat>;
    // Every field must be present and a string. A half-written seat is worse
    // than none: it produces a reconnect attempt that can never succeed.
    if (
      typeof parsed.joinCode !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.displayName !== 'string' ||
      !parsed.joinCode ||
      !parsed.token
    ) {
      return null;
    }
    return { joinCode: parsed.joinCode, token: parsed.token, displayName: parsed.displayName };
  } catch {
    return null;
  }
}

export function writeSeat(seat: CompetitionSeat): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SEAT_KEY, JSON.stringify(seat));
  } catch {
    // Quota or a refusing browser. Reconnect is a convenience, not a
    // requirement - failing to store it must not break joining.
  }
}

/**
 * Forget the seat.
 *
 * Called whenever the server says this token is no longer usable: removed by
 * the coach, session ended, session expired, token rejected. Leaving a dead
 * token in place is what turns "you were removed" into an infinite retry loop.
 */
export function clearSeat(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(SEAT_KEY);
  } catch {
    /* nothing useful to do */
  }
}

/** The seat for THIS competition, if the stored one belongs to it. */
export function seatFor(joinCode: string): CompetitionSeat | null {
  const seat = readSeat();
  if (!seat) return null;
  return seat.joinCode.toUpperCase() === joinCode.toUpperCase() ? seat : null;
}
