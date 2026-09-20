import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as playApi from '../../api/play';
import { ApiError } from '../../api/client';
import type { AttemptState } from '../../api/types';
import { readAttemptToken, saveAttemptToken } from './attemptToken';
import { enterAsPlayer, enterWithPin, isAuthRefusal, pinErrorMessage, pinNoticeFor } from './playerEntry';
import { rememberedPlayer } from './playerSession';

/** THE ENTRY DECISION. The server says whether a PIN is needed; this module
 *  follows - so with enforcement off (no pin_required ever arrives) nobody
 *  sees a PIN screen. */

const attempt: AttemptState = {
  attempt_id: 900,
  status: 'in_progress',
  mode: 'GRADED',
  question_order: [],
  feedback: [],
  answers: [],
};
const JORDAN = { playerId: 501, name: 'Jordan Smith', jerseyNumber: '7', position: 'QB' };
const claimed = (token: string | null, state: unknown = attempt) => ({
  attempt_token: token,
  token_header: 'X-Attempt-Token',
  player: { player_id: 501, name: 'Jordan Smith' },
  reclaimed: token === null,
  attempt: state as AttemptState,
});
const refusal = (status: number, reason: string, extra?: { details?: unknown; retry?: number }) =>
  new ApiError('refused', status, extra?.details as never, reason, extra?.retry);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('enterAsPlayer', () => {
  it('with enforcement off, a roster name simply starts - no PIN, nothing claimed', async () => {
    const start = vi.spyOn(playApi, 'startAttempt').mockResolvedValue(attempt);
    const claim = vi.spyOn(playApi, 'claimAttempt');

    const outcome = await enterAsPlayer({ code: 'ABC123', accessCodeId: 42, player: JORDAN, continuing: false });

    expect(outcome).toEqual({ kind: 'quiz', attempt });
    expect(start).toHaveBeenCalledWith({ access_code_id: 42, player_name: 'Jordan Smith', player_id: 501 });
    expect(claim).not.toHaveBeenCalled();
    expect(rememberedPlayer('ABC123')).toEqual(JORDAN);
  });

  it('pin_required sends the player to the PIN screen for the player the server named', async () => {
    vi.spyOn(playApi, 'startAttempt').mockRejectedValue(
      refusal(401, 'pin_required', { details: { player_id: 777 } }),
    );

    const outcome = await enterAsPlayer({
      code: 'ABC123',
      accessCodeId: 42,
      player: { playerId: null, name: 'Jordan Smith', jerseyNumber: null, position: null },
      continuing: false,
    });

    expect(outcome).toEqual({ kind: 'pin', playerId: 777, notice: null });
  });

  it('already_submitted goes to results', async () => {
    vi.spyOn(playApi, 'startAttempt').mockRejectedValue(refusal(409, 'already_submitted'));
    expect(await enterAsPlayer({ code: 'ABC123', accessCodeId: 42, player: JORDAN, continuing: false })).toEqual({
      kind: 'submitted',
    });
  });

  it('pick_player and every other refusal are thrown for the screen to show', async () => {
    vi.spyOn(playApi, 'startAttempt').mockRejectedValue(refusal(409, 'pick_player'));
    await expect(
      enterAsPlayer({ code: 'ABC123', accessCodeId: 42, player: JORDAN, continuing: false }),
    ).rejects.toMatchObject({ reason: 'pick_player' });
  });

  it('a roster tap NEVER uses a stored token, even the same player’s', async () => {
    saveAttemptToken('ABC123', 501, 'device-token');
    const claim = vi.spyOn(playApi, 'claimAttempt');
    vi.spyOn(playApi, 'startAttempt').mockResolvedValue(attempt);

    await enterAsPlayer({ code: 'ABC123', accessCodeId: 42, player: JORDAN, continuing: false });

    expect(claim).not.toHaveBeenCalled();
  });

  it('continuing with a stored token claims with it and types no PIN', async () => {
    saveAttemptToken('ABC123', 501, 'device-token');
    const claim = vi.spyOn(playApi, 'claimAttempt').mockResolvedValue(claimed(null));
    const start = vi.spyOn(playApi, 'startAttempt');

    const outcome = await enterAsPlayer({ code: 'ABC123', accessCodeId: 42, player: JORDAN, continuing: true });

    expect(outcome).toEqual({ kind: 'quiz', attempt });
    expect(claim).toHaveBeenCalledWith({ access_code_id: 42, player_id: 501 }, 'device-token');
    expect(start).not.toHaveBeenCalled();
    expect(readAttemptToken('ABC123', 501)).toBe('device-token');
  });

  it('a refused token is forgotten and the PIN is asked for, saying why', async () => {
    saveAttemptToken('ABC123', 501, 'old-token');
    vi.spyOn(playApi, 'claimAttempt').mockRejectedValue(refusal(401, 'token_revoked'));

    const outcome = await enterAsPlayer({ code: 'ABC123', accessCodeId: 42, player: JORDAN, continuing: true });

    expect(outcome).toEqual({
      kind: 'pin',
      playerId: 501,
      notice: 'Your PIN was changed. Enter your new PIN to keep going.',
    });
    expect(readAttemptToken('ABC123', 501)).toBeNull();
  });

  it('a legacy attempt the token cannot reach continues through /start', async () => {
    saveAttemptToken('ABC123', 501, 'device-token');
    vi.spyOn(playApi, 'claimAttempt').mockRejectedValue(refusal(409, 'legacy_attempt'));
    const start = vi.spyOn(playApi, 'startAttempt').mockResolvedValue(attempt);

    expect(await enterAsPlayer({ code: 'ABC123', accessCodeId: 42, player: JORDAN, continuing: true })).toEqual({
      kind: 'quiz',
      attempt,
    });
    expect(start).toHaveBeenCalled();
  });

  it('a submitted graded attempt continued by token goes to results', async () => {
    saveAttemptToken('ABC123', 501, 'device-token');
    vi.spyOn(playApi, 'claimAttempt').mockResolvedValue(claimed(null, { attempt_id: 900, status: 'submitted' }));

    expect(await enterAsPlayer({ code: 'ABC123', accessCodeId: 42, player: JORDAN, continuing: true })).toEqual({
      kind: 'submitted',
    });
  });
});

describe('enterWithPin', () => {
  it('saves the issued token, remembers the player, and never stores the PIN', async () => {
    const claim = vi.spyOn(playApi, 'claimAttempt').mockResolvedValue(claimed('issued-token'));

    const outcome = await enterWithPin({ code: 'ABC123', accessCodeId: 42, player: JORDAN, pin: '482915' });

    expect(outcome).toEqual({ kind: 'quiz', attempt });
    expect(claim).toHaveBeenCalledWith({ access_code_id: 42, player_id: 501, pin: '482915' });
    expect(readAttemptToken('ABC123', 501)).toBe('issued-token');
    expect(rememberedPlayer('ABC123')?.playerId).toBe(501);
    expect(JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })).not.toContain('482915');
  });

  it('throws a wrong PIN for the PIN screen to word', async () => {
    vi.spyOn(playApi, 'claimAttempt').mockRejectedValue(refusal(401, 'pin_incorrect'));
    await expect(
      enterWithPin({ code: 'ABC123', accessCodeId: 42, player: JORDAN, pin: '111111' }),
    ).rejects.toMatchObject({ reason: 'pin_incorrect' });
    expect(readAttemptToken('ABC123', 501)).toBeNull();
  });
});

describe('player words', () => {
  it.each([
    [refusal(401, 'pin_incorrect'), 'Incorrect PIN. Try again.'],
    [refusal(401, 'pin_incorrect', { retry: 60 }), 'Incorrect PIN. Too many attempts. Try again in 1 minute.'],
    [refusal(429, 'pin_cooldown'), 'Too many attempts. Try again shortly.'],
    [refusal(429, 'pin_cooldown', { retry: 45 }), 'Too many attempts. Try again in 1 minute.'],
    [refusal(429, 'pin_cooldown', { retry: 240 }), 'Too many attempts. Try again in 4 minutes.'],
    [refusal(423, 'pin_locked'), 'Too many attempts. Ask your coach to reset your PIN.'],
    [refusal(403, 'pin_not_set'), "You don't have a PIN yet. Ask your coach."],
    [refusal(422, 'not_eligible'), "You're not on the list for this quiz. Ask your coach."],
    [new ApiError('No results found for that code and name', 404), "You don't have results for this quiz yet."],
    [new ApiError('Validation failed', 422, { pin: ['String does not match expected pattern.'] }), 'Enter the 6 digits of your PIN.'],
  ])('%s -> %s', (error, words) => {
    expect(pinErrorMessage(error)).toBe(words);
  });

  it('never shows a reason code or the word token', () => {
    for (const reason of ['token_invalid', 'token_missing', 'pin_required']) {
      expect(pinErrorMessage(new ApiError('Enter your PIN to continue.', 401, undefined, reason))).not.toMatch(
        /token|reason|_/i,
      );
    }
  });

  it('auth refusals are recognised by reason, not by status alone', () => {
    expect(isAuthRefusal(refusal(401, 'token_missing'))).toBe(true);
    expect(isAuthRefusal(refusal(401, 'pin_incorrect'))).toBe(false);
    expect(isAuthRefusal(new ApiError('Unauthorized', 401))).toBe(false);
  });

  it('explains a move to another device only to a device that held a token', () => {
    expect(pinNoticeFor('token_invalid', true)).toMatch(/another device/);
    expect(pinNoticeFor('token_invalid', false)).toBeNull();
    expect(pinNoticeFor('token_missing', false)).toBeNull();
  });
});
