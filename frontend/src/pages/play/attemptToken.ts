/** Where a player's device keeps its attempt token. PHASE 2: STORED, NOT SENT.
 *
 * A correct PIN earns a token for ONE attempt, so the same device can carry on
 * without being asked again - through a refresh, a closed tab, a phone that
 * locked mid-quiz. Nothing reads it back for authorization yet; Phase 3 sends
 * it as the `X-Attempt-Token` header.
 *
 * localStorage, matching the drawing drafts next to this file: sessionStorage
 * dies with the tab, and "I closed Safari and reopened it" is exactly the case
 * this has to survive.
 *
 * STORED: the token and nothing else. Never the PIN - there is no function
 * here that could store one. Never in a URL. Keyed by access code AND
 * canonical player, so two players sharing a phone, or one player on two
 * codes, can never pick up each other's token.
 */

export const ATTEMPT_TOKEN_HEADER = 'X-Attempt-Token';

const TOKEN_PREFIX = 'peira.attempt.token';

export function attemptTokenKey(code: string, playerId: number): string {
  return `${TOKEN_PREFIX}:${code.trim().toUpperCase()}:${playerId}`;
}

function usable(code: string, playerId: number): boolean {
  return code.trim().length > 0 && Number.isInteger(playerId) && playerId > 0;
}

export function saveAttemptToken(code: string, playerId: number, token: string): boolean {
  if (!usable(code, playerId) || !token.trim()) return false;
  try {
    window.localStorage.setItem(attemptTokenKey(code, playerId), token);
    return true;
  } catch {
    // Private browsing or a full quota. The player can still prove who they
    // are with their PIN; they just will not skip it next time.
    return false;
  }
}

export function readAttemptToken(code: string, playerId: number): string | null {
  if (!usable(code, playerId)) return null;
  try {
    const value = window.localStorage.getItem(attemptTokenKey(code, playerId));
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function clearAttemptToken(code: string, playerId: number): void {
  if (!usable(code, playerId)) return;
  try {
    window.localStorage.removeItem(attemptTokenKey(code, playerId));
  } catch {
    /* already unreachable */
  }
}

/** The header a player request will carry in Phase 3. Empty when there is no
 *  token, so a caller can spread it unconditionally. */
export function attemptTokenHeaders(token: string | null): Record<string, string> {
  return token ? { [ATTEMPT_TOKEN_HEADER]: token } : {};
}
