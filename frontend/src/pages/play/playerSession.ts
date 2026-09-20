/** WHO IS PLAYING ON THIS DEVICE, per access code - for "Continue as".
 *
 * A player who refreshes, closes the tab or comes back tomorrow should not have
 * to find their name and type their PIN again on the device they already
 * proved it on. This remembers the one player a device last played a code as,
 * and nothing else: never a PIN, never a token (attemptToken.ts keeps that).
 *
 * THE SHARED-PHONE RULE. A stored token is only ever used for the player
 * remembered here, reached by tapping "Continue as <name>". Tapping a name in
 * the roster never uses a stored token - so a teammate handed the same phone
 * cannot become the last player by picking their name. Remembering a player
 * forgets every other player's token for that code, and "Not you?" forgets
 * both the player and their token.
 *
 * localStorage, like the token: "I closed Safari and reopened it" is exactly
 * the case this exists for.
 */

import { clearAttemptToken, clearOtherAttemptTokens } from './attemptToken';

export interface RememberedPlayer {
  /** Null for a free-text (legacy) roster name, which has no PIN or token. */
  playerId: number | null;
  name: string;
  jerseyNumber: string | null;
  position: string | null;
}

const SESSION_PREFIX = 'peira.play.session.v1';
/** Marks that THIS TAB has the player's quiz open, so a refresh resumes
 *  without a tap. sessionStorage, so it dies with the tab: a new tab or a
 *  reopened browser asks "Continue as" first. */
const ACTIVE_PREFIX = 'peira.play.active.v1';

function key(prefix: string, code: string): string {
  return `${prefix}:${code.trim().toUpperCase()}`;
}

export function rememberPlayer(code: string, player: RememberedPlayer): void {
  if (!code.trim()) return;
  clearOtherAttemptTokens(code, player.playerId);
  try {
    window.localStorage.setItem(key(SESSION_PREFIX, code), JSON.stringify(player));
    window.sessionStorage.setItem(key(ACTIVE_PREFIX, code), '1');
  } catch {
    // Private browsing or a full quota: the player just picks their name next time.
  }
}

export function rememberedPlayer(code: string): RememberedPlayer | null {
  if (!code.trim()) return null;
  try {
    const raw = window.localStorage.getItem(key(SESSION_PREFIX, code));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RememberedPlayer>;
    if (typeof value.name !== 'string' || !value.name.trim()) return null;
    const playerId = typeof value.playerId === 'number' && value.playerId > 0 ? value.playerId : null;
    return {
      playerId,
      name: value.name,
      jerseyNumber: typeof value.jerseyNumber === 'string' ? value.jerseyNumber : null,
      position: typeof value.position === 'string' ? value.position : null,
    };
  } catch {
    return null;
  }
}

/** Was the quiz open in THIS tab a moment ago? True after a refresh only. */
export function wasActiveInThisTab(code: string): boolean {
  try {
    return window.sessionStorage.getItem(key(ACTIVE_PREFIX, code)) === '1';
  } catch {
    return false;
  }
}

/** "Not you?" - forget the player, their token and the open-quiz marker. */
export function forgetPlayer(code: string): void {
  const player = rememberedPlayer(code);
  if (player?.playerId) clearAttemptToken(code, player.playerId);
  clearOtherAttemptTokens(code, null);
  try {
    window.localStorage.removeItem(key(SESSION_PREFIX, code));
    window.sessionStorage.removeItem(key(ACTIVE_PREFIX, code));
  } catch {
    /* already unreachable */
  }
}

/** The jersey and position shown beside a name, or '' when neither is known. */
export function playerTag(player: { jerseyNumber?: string | null; position?: string | null }): string {
  return [player.jerseyNumber ? `#${player.jerseyNumber}` : null, player.position].filter(Boolean).join(' · ');
}
