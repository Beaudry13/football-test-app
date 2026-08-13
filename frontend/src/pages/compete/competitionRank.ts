/**
 * Formatting for ranks and movement.
 *
 * Pure and separate from any component, because "what does 21st look like"
 * and "is this a tie" are rules worth testing directly rather than inferring
 * from a rendered row. Suffix logic inlined in JSX is exactly where an 11TH
 * quietly becomes an 11ST.
 */

/**
 * 1ST, 2ND, 3RD, 4TH… and the teens, which are the whole reason this exists.
 *
 * 11, 12 and 13 take TH despite ending in 1, 2 and 3 - so the tens digit has
 * to be consulted before the units digit, and a naive `n % 10` lookup gets
 * all three wrong.
 */
export function ordinal(rank: number): string {
  if (!Number.isFinite(rank) || rank < 1) return '—';
  const value = Math.floor(rank);
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}TH`;
  switch (value % 10) {
    case 1:
      return `${value}ST`;
    case 2:
      return `${value}ND`;
    case 3:
      return `${value}RD`;
    default:
      return `${value}TH`;
  }
}

/**
 * A player's own rank, honest about ties.
 *
 * `T-2ND` when the place is shared. Rendering a plain "2ND" to two people who
 * are level tells both of them they hold the position alone, which is a small
 * lie the scoreboard does not need to tell.
 */
export function rankLabel(rank: number, tiedCount: number): string {
  const base = ordinal(rank);
  return tiedCount > 1 ? `T-${base}` : base;
}

export interface MovementLabel {
  /** ▲ / ▼ / — / NEW. Paired with text, never carrying meaning alone. */
  symbol: string;
  /** Screen-reader and fallback wording. */
  text: string;
  direction: 'up' | 'down' | 'same' | 'new';
}

/**
 * Movement, straight from the server's arithmetic.
 *
 * `movement` is `previous - current`, so positive means climbed. `null` means
 * there is no baseline yet - the room has never been shown standings - and
 * that is reported as NEW rather than as "unchanged", because claiming
 * somebody held station at a rank nobody ever saw would be invented.
 *
 * Nothing is recomputed here. The client formats; the server decides.
 */
export function movementLabel(movement: number | null | undefined): MovementLabel {
  if (movement === null || movement === undefined) {
    return { symbol: 'NEW', text: 'New to the board', direction: 'new' };
  }
  if (movement > 0) {
    return { symbol: `▲${movement}`, text: `Up ${movement}`, direction: 'up' };
  }
  if (movement < 0) {
    return { symbol: `▼${Math.abs(movement)}`, text: `Down ${Math.abs(movement)}`, direction: 'down' };
  }
  return { symbol: '—', text: 'Unchanged', direction: 'same' };
}
