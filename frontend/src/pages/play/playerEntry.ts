/** HOW A PLAYER GETS INTO THEIR QUIZ - the one place that decides it.
 *
 * THE SERVER DECIDES WHETHER A PIN IS NEEDED; this file only follows. With
 * player PIN enforcement off (production today) /start never asks for one, so
 * nobody ever sees a PIN screen and the flow is exactly what it always was.
 * With it on, /start answers `pin_required` for a protected player and the PIN
 * screen appears. Nothing here reads a flag, so switching enforcement on or off
 * needs no frontend change.
 *
 *   remembered player + stored token  -> /claim with the token (no PIN typed)
 *   otherwise                         -> /start
 *     401 pin_required                -> the PIN screen
 *     409 already_submitted           -> results
 *   PIN typed                         -> /claim with the PIN, token saved
 */

import { ApiError, getErrorMessage } from '../../api/client';
import { claimAttempt, startAttempt, type ClaimAttemptResponse } from '../../api/play';
import type { AttemptState } from '../../api/types';
import { clearAttemptToken, readAttemptToken, saveAttemptToken } from './attemptToken';
import { rememberPlayer, type RememberedPlayer } from './playerSession';

export type EntryOutcome =
  | { kind: 'quiz'; attempt: AttemptState }
  | { kind: 'submitted' }
  | { kind: 'pin'; playerId: number; notice: string | null };

/** Refusals that mean "prove who you are", from any player route. */
const AUTH_REASONS = new Set(['pin_required', 'token_missing', 'token_invalid', 'token_revoked']);

export function isAuthRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401 && AUTH_REASONS.has(error.reason ?? '');
}

/** What the PIN screen says above the box when the player was sent there by
 *  something that happened rather than by choosing a name. */
export function pinNoticeFor(reason: string | undefined, deviceHadToken: boolean): string | null {
  if (reason === 'token_revoked') return 'Your PIN was changed. Enter your new PIN to keep going.';
  if (reason === 'token_invalid' && deviceHadToken) {
    return 'You continued on another device. Enter your PIN to keep going here.';
  }
  return null;
}

/** TRY THE MISSES AGAIN refused for a reason that is an answer, not a failure:
 *  nothing left to retry (`fixed`), or the run can no longer be retried. The
 *  caller says so - it never quietly starts a different task instead. */
export function retryEndReason(error: unknown): 'fixed' | 'unavailable' | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  if (error.reason === 'nothing_to_retry') return 'fixed';
  if (error.reason === 'retry_not_available') return 'unavailable';
  return null;
}

/** Plain words for a PIN that was not accepted. No reason codes, no jargon. */
export function pinErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return getErrorMessage(error);
  const wait = (seconds: number | undefined) => {
    if (!seconds) return 'Try again shortly.';
    const minutes = Math.ceil(seconds / 60);
    return `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  };
  switch (error.reason) {
    case 'pin_incorrect':
      // The wrong PIN that STARTS a wait says so - otherwise the player types
      // straight into a refusal they were never warned about.
      return error.retryAfterSeconds
        ? `Incorrect PIN. Too many attempts. ${wait(error.retryAfterSeconds)}`
        : 'Incorrect PIN. Try again.';
    case 'pin_cooldown':
      return `Too many attempts. ${wait(error.retryAfterSeconds)}`;
    case 'pin_locked':
      return 'Too many attempts. Ask your coach to reset your PIN.';
    case 'pin_not_set':
      return "You don't have a PIN yet. Ask your coach.";
    case 'not_eligible':
      return "You're not on the list for this quiz. Ask your coach.";
    default:
      if (error.status === 422) return 'Enter the 6 digits of your PIN.';
      // Only ever reached AFTER a correct PIN: nothing is submitted yet.
      if (error.status === 404) return "You don't have results for this quiz yet.";
      return getErrorMessage(error);
  }
}

function pinRequiredPlayerId(error: ApiError, fallback: number | null): number | null {
  const fromServer = (error.details as unknown as { player_id?: unknown } | undefined)?.player_id;
  return typeof fromServer === 'number' ? fromServer : fallback;
}

function fromClaim(code: string, player: RememberedPlayer, response: ClaimAttemptResponse): EntryOutcome {
  if (response.attempt_token) saveAttemptToken(code, response.player.player_id, response.attempt_token);
  rememberPlayer(code, { ...player, playerId: response.player.player_id });
  const attempt = response.attempt;
  if ('answers' in attempt) return { kind: 'quiz', attempt };
  return { kind: 'submitted' };
}

async function startByRoster(
  code: string,
  accessCodeId: number,
  player: RememberedPlayer,
  retryOf?: number,
): Promise<EntryOutcome> {
  try {
    const attempt = await startAttempt({
      access_code_id: accessCodeId,
      player_name: player.name,
      player_id: player.playerId ?? undefined,
      ...(retryOf !== undefined ? { retry_of_attempt_id: retryOf } : {}),
    });
    rememberPlayer(code, player);
    return { kind: 'quiz', attempt };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && error.reason === 'pin_required') {
      const playerId = pinRequiredPlayerId(error, player.playerId);
      if (playerId !== null) return { kind: 'pin', playerId, notice: null };
    }
    if (error instanceof ApiError && error.status === 409 && error.reason === 'already_submitted') {
      rememberPlayer(code, player);
      return { kind: 'submitted' };
    }
    throw error;
  }
}

/** Enter the quiz as `player`.
 *
 *  `continuing` is true ONLY when the player tapped "Continue as" (or the tab
 *  refreshed mid-quiz): that is the one case a stored token may be used. A name
 *  tapped in the roster never uses one - see playerSession.ts. */
export async function enterAsPlayer(input: {
  code: string;
  accessCodeId: number;
  player: RememberedPlayer;
  continuing: boolean;
  /** TRY THE MISSES AGAIN: the finished practice run whose misses the new run holds. */
  retryOf?: number;
}): Promise<EntryOutcome> {
  const { code, accessCodeId, player, continuing, retryOf } = input;
  const retry = retryOf !== undefined ? { retry_of_attempt_id: retryOf } : {};
  if (continuing && player.playerId !== null) {
    const token = readAttemptToken(code, player.playerId);
    if (token) {
      try {
        const response = await claimAttempt({ access_code_id: accessCodeId, player_id: player.playerId, ...retry }, token);
        return fromClaim(code, player, response);
      } catch (error) {
        if (isAuthRefusal(error)) {
          clearAttemptToken(code, player.playerId);
          return { kind: 'pin', playerId: player.playerId, notice: pinNoticeFor(error.reason, true) };
        }
        // An attempt from before this player was linked to the roster: it has
        // no token to use, so it continues the way it always has.
        if (!(error instanceof ApiError && error.reason === 'legacy_attempt')) throw error;
      }
    }
  }
  return startByRoster(code, accessCodeId, player, retryOf);
}

/** The player typed their PIN. Errors are thrown for the PIN screen to word
 *  with pinErrorMessage. */
export async function enterWithPin(input: {
  code: string;
  accessCodeId: number;
  player: RememberedPlayer & { playerId: number };
  pin: string;
  /** TRY THE MISSES AGAIN, carried through a PIN the server asked for. */
  retryOf?: number;
}): Promise<EntryOutcome> {
  const { code, accessCodeId, player, pin, retryOf } = input;
  try {
    const response = await claimAttempt({
      access_code_id: accessCodeId,
      player_id: player.playerId,
      pin,
      ...(retryOf !== undefined ? { retry_of_attempt_id: retryOf } : {}),
    });
    return fromClaim(code, player, response);
  } catch (error) {
    if (error instanceof ApiError && error.reason === 'legacy_attempt') {
      return startByRoster(code, accessCodeId, player);
    }
    throw error;
  }
}
