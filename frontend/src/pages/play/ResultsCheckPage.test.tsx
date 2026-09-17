import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultsCheckPage } from './ResultsCheckPage';
import * as playApi from '../../api/play';
import type { PlayerResultsResponse } from '../../api/types';
import { ApiError } from '../../api/client';
import { readAttemptToken, saveAttemptToken } from './attemptToken';
import { rememberPlayer, rememberedPlayer } from './playerSession';

const playerResults: PlayerResultsResponse = {
  quiz_title: 'Week 1 Prep',
  player_name: 'Jordan Smith',
  submitted_at: '2026-01-01T00:05:00Z',
  answers: [
    {
      question_id: 10,
      question_number: 1,
      question_text: 'Is this cover 2?',
      question_type: 'true_false',
      your_answer: 'False',
      correct_answer: 'True',
      is_correct: false,
      is_excluded: false,
      coach_feedback: null,
      graded_at: null,
    },
  ],
};

const identities = {
  identities: [
    { player_id: 501, name: 'Jordan Smith', jersey_number: '7', position: 'QB' },
    { player_id: 502, name: 'Jordan Smith', jersey_number: '22', position: 'LB' },
    { player_id: null, name: 'Alex Lee' },
  ],
};

function renderAt(initialPath: string) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/results" element={<ResultsCheckPage />} />
        <Route path="/results/:code/:playerName" element={<ResultsCheckPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const JORDAN = { playerId: 501, name: 'Jordan Smith', jerseyNumber: '7', position: 'QB' };

describe('ResultsCheckPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('auto-fetches and renders results when code and name are in the URL', async () => {
    vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue(playerResults);

    renderAt('/results/ABC123/Jordan%20Smith');

    await waitFor(() =>
      expect(playApi.getPlayerResults).toHaveBeenCalledWith('ABC123', 'Jordan Smith', undefined),
    );
    expect(await screen.findByText('Results for Jordan Smith')).toBeInTheDocument();
    expect(screen.getByText('Incorrect')).toBeInTheDocument();
    expect(screen.getByText('Correct answer: True', { exact: false })).toBeInTheDocument();
  });

  it('asks for the code, then "Choose your name" from the roster, then opens results', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'getResultsIdentities').mockResolvedValue(identities);
    const resultsSpy = vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue(playerResults);

    renderAt('/results');

    await user.type(screen.getByPlaceholderText('CODE'), 'abc123');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Choose your name.')).toBeInTheDocument();
    // Two players who share a name stay two choices, told apart by jersey.
    await user.click(screen.getByRole('button', { name: 'Jordan Smith (#22 · LB)' }));

    // Chosen from the list: no stored token is ever sent.
    await waitFor(() => expect(resultsSpy).toHaveBeenCalledWith('ABC123', 'Jordan Smith', 502));
    expect(await screen.findByText('Results for Jordan Smith')).toBeInTheDocument();
  });

  it('asks for the PIN when the server does, and keeps the token it issues for next time', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'getResultsIdentities').mockResolvedValue(identities);
    const resultsSpy = vi
      .spyOn(playApi, 'getPlayerResults')
      .mockRejectedValueOnce(new ApiError('Enter your PIN to continue.', 401, undefined, 'pin_required'))
      .mockRejectedValueOnce(new ApiError("That PIN didn't match.", 401, undefined, 'pin_incorrect'))
      .mockResolvedValueOnce({
        ...playerResults,
        player_auth: { attempt_token: 'new-token', token_header: 'X-Attempt-Token' },
      });

    renderAt('/results');
    await user.type(screen.getByPlaceholderText('CODE'), 'abc123');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Jordan Smith (#7 · QB)' }));

    await user.type(await screen.findByLabelText('Enter your PIN'), '111111');
    expect(await screen.findByText('Incorrect PIN. Try again.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Enter your PIN'), '482915');

    expect(await screen.findByText('Results for Jordan Smith')).toBeInTheDocument();
    expect(resultsSpy).toHaveBeenLastCalledWith('ABC123', 'Jordan Smith', 501, { pin: '482915' });
    expect(readAttemptToken('ABC123', 501)).toBe('new-token');
    expect(rememberedPlayer('ABC123')?.playerId).toBe(501);
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toContain('482915');
    expect(stored).not.toContain('111111');
  });

  it('offers "Continue as" for the player this device remembers, sending their token', async () => {
    const user = userEvent.setup();
    rememberPlayer('ABC123', JORDAN);
    saveAttemptToken('ABC123', 501, 'device-token');
    vi.spyOn(playApi, 'getResultsIdentities').mockResolvedValue(identities);
    const resultsSpy = vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue(playerResults);

    renderAt('/results');
    await user.type(screen.getByPlaceholderText('CODE'), 'abc123');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Continue as Jordan Smith · #7 · QB' }));

    await waitFor(() =>
      expect(resultsSpy).toHaveBeenCalledWith('ABC123', 'Jordan Smith', 501, { token: 'device-token' }),
    );
  });

  it('"Not you?" forgets the remembered player and their token on a shared device', async () => {
    const user = userEvent.setup();
    rememberPlayer('ABC123', JORDAN);
    saveAttemptToken('ABC123', 501, 'device-token');
    vi.spyOn(playApi, 'getResultsIdentities').mockResolvedValue(identities);

    renderAt('/results');
    await user.type(screen.getByPlaceholderText('CODE'), 'abc123');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Not you? Choose your name' }));

    expect(await screen.findByText('Choose your name.')).toBeInTheDocument();
    expect(readAttemptToken('ABC123', 501)).toBeNull();
    expect(rememberedPlayer('ABC123')).toBeNull();
  });

  it('a name that is not listed can still be typed, for free-text results', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'getResultsIdentities').mockResolvedValue(identities);
    const resultsSpy = vi
      .spyOn(playApi, 'getPlayerResults')
      .mockRejectedValue(new ApiError('No results found for that code and name', 404));

    renderAt('/results');
    await user.type(screen.getByPlaceholderText('CODE'), 'abc123');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: "My name isn't listed" }));
    await user.type(screen.getByPlaceholderText('Your name'), 'Nobody');
    await user.click(screen.getByRole('button', { name: 'View results' }));

    await waitFor(() => expect(resultsSpy).toHaveBeenCalledWith('ABC123', 'Nobody', undefined));
    expect(await screen.findByText('No results found for that code and name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Your name')).toBeInTheDocument();
  });

  it('shows the error and keeps the code box when the code is unknown', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'getResultsIdentities').mockRejectedValue(
      new ApiError('No results found for that code and name', 404),
    );

    renderAt('/results');
    await user.type(screen.getByPlaceholderText('CODE'), 'ZZZZZZ');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('No results found for that code and name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('CODE')).toBeInTheDocument();
  });

  it('a bookmark for the remembered player uses their token; a PIN is asked when it is refused', async () => {
    const user = userEvent.setup();
    rememberPlayer('ABC123', JORDAN);
    saveAttemptToken('ABC123', 501, 'old-token');
    const resultsSpy = vi
      .spyOn(playApi, 'getPlayerResults')
      .mockRejectedValueOnce(new ApiError('Your PIN was changed.', 401, undefined, 'token_revoked'))
      .mockResolvedValueOnce(playerResults);

    renderAt('/results/ABC123/Jordan%20Smith?player_id=501');

    await waitFor(() =>
      expect(resultsSpy).toHaveBeenCalledWith('ABC123', 'Jordan Smith', 501, { token: 'old-token' }),
    );
    expect(
      await screen.findByText('Your PIN was changed. Enter your new PIN to keep going.'),
    ).toBeInTheDocument();
    expect(readAttemptToken('ABC123', 501)).toBeNull();
    await user.type(screen.getByLabelText('Enter your PIN'), '482915');
    expect(await screen.findByText('Results for Jordan Smith')).toBeInTheDocument();
  });

  it('a bookmark for somebody else on this device never uses the stored token', async () => {
    rememberPlayer('ABC123', JORDAN);
    saveAttemptToken('ABC123', 501, 'jordans-token');
    const resultsSpy = vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue(playerResults);

    renderAt('/results/ABC123/Chris%20Smith?player_id=502');

    await waitFor(() => expect(resultsSpy).toHaveBeenCalledWith('ABC123', 'Chris Smith', 502));
  });
});
