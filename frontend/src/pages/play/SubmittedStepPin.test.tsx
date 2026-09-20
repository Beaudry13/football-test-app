import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubmittedStep } from './SubmittedStep';
import * as playApi from '../../api/play';
import { ApiError } from '../../api/client';
import type { PlayerResultsResponse } from '../../api/types';
import { readAttemptToken, saveAttemptToken } from './attemptToken';

const results: PlayerResultsResponse = {
  quiz_title: 'Week 1 Prep',
  player_name: 'Jordan Smith',
  submitted_at: '2026-01-01T00:05:00Z',
  answers: [],
};
const JORDAN = { playerId: 501, name: 'Jordan Smith', jerseyNumber: '7', position: 'QB' };

describe('SubmittedStep with player PINs', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('opens the results with the token the device played with - no second PIN', async () => {
    saveAttemptToken('ABC123', 501, 'play-token');
    const spy = vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue(results);

    render(<SubmittedStep code="ABC123" playerName="Jordan Smith" playerId={501} player={JORDAN} />);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('ABC123', 'Jordan Smith', 501, { token: 'play-token' }));
    expect(await screen.findByText('Results for Jordan Smith')).toBeInTheDocument();
  });

  it('asks for the PIN when the results require it, then keeps the new token', async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(playApi, 'getPlayerResults')
      .mockRejectedValueOnce(new ApiError('Enter your PIN to continue.', 401, undefined, 'pin_required'))
      .mockResolvedValueOnce({ ...results, player_auth: { attempt_token: 'results-token', token_header: 'X-Attempt-Token' } });

    render(<SubmittedStep code="ABC123" playerName="Jordan Smith" playerId={501} player={JORDAN} />);

    await user.type(await screen.findByLabelText('Enter your PIN'), '482915');

    expect(await screen.findByText('Results for Jordan Smith')).toBeInTheDocument();
    expect(spy).toHaveBeenLastCalledWith('ABC123', 'Jordan Smith', 501, { pin: '482915' });
    expect(readAttemptToken('ABC123', 501)).toBe('results-token');
  });
});
