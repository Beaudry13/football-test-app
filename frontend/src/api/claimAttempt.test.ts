import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import { claimAttempt } from './play';

/** The one client call that sends a PIN. It must send it to the claim
 *  endpoint, without a coach login, and keep no copy of it anywhere. */

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

describe('claimAttempt', () => {
  it('posts the PIN to /play/claim without coach auth', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      attempt_token: 'tok',
      token_header: 'X-Attempt-Token',
      player: { player_id: 21, name: 'John Smith' },
      reclaimed: false,
      attempt: { attempt_id: 5, status: 'in_progress' },
    });

    await claimAttempt({ access_code_id: 9, player_id: 21, pin: '482915' });

    expect(post).toHaveBeenCalledWith(
      '/play/claim',
      { access_code_id: 9, player_id: 21, pin: '482915' },
      { auth: false },
    );
  });

  it('stores neither the PIN nor the token by itself', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({
      attempt_token: 'secret-token',
      token_header: 'X-Attempt-Token',
      player: { player_id: 21, name: 'John Smith' },
      reclaimed: false,
      attempt: { attempt_id: 5, status: 'in_progress' },
    });

    await claimAttempt({ access_code_id: 9, player_id: 21, pin: '482915' });

    const everything = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(everything).not.toContain('482915');
    expect(everything).not.toContain('secret-token');
  });
});
