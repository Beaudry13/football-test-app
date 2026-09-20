/** Where a player's device keeps its attempt token.
 *
 * A correct PIN earns a token for ONE attempt, so the same device can carry on
 * without being asked again - through a refresh, a closed tab, a phone that
 * locked mid-quiz. It is sent as the `X-Attempt-Token` header, and read back
 * ONLY for the player this device remembers for the code (playerSession.ts) -
 * never because somebody tapped a name in a list.
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

/** Every token this device holds for a code, except one player's. A shared
 *  phone must never keep a teammate's token around to be picked up later. */
export function clearOtherAttemptTokens(code: string, keepPlayerId: number | null): void {
  if (!code.trim()) return;
  const prefix = `${TOKEN_PREFIX}:${code.trim().toUpperCase()}:`;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(prefix) && key !== `${prefix}${keepPlayerId}`) doomed.push(key);
    }
    doomed.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    /* storage unavailable: nothing was kept either */
  }
}

/** The header a player request carries. Empty when there is no token, so a
 *  caller can spread it unconditionally. */
export function attemptTokenHeaders(token: string | null): Record<string, string> {
  return token ? { [ATTEMPT_TOKEN_HEADER]: token } : {};
}
