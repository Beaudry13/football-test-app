import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayPage } from './PlayPage';
import * as playApi from '../../api/play';
import { ApiError } from '../../api/client';
import type { AttemptState, PlayerResultsResponse, ValidateCodeResponse } from '../../api/types';
import { readAttemptToken, saveAttemptToken } from './attemptToken';
import { rememberPlayer, rememberedPlayer } from './playerSession';

/** THE PLAYER PIN FLOW, through the real page: choosing a name, the PIN, the
 *  quiz, a refresh, a new tab, a PIN reset mid-quiz, and results. The API is
 *  mocked; everything between the screen and it is real. */

const joined: ValidateCodeResponse = {
  mode: 'GRADED',
  access_code_id: 42,
  expires_at: '2026-08-02T00:00:00Z',
  roster_players: ['Jordan Smith', 'Jordan Smith'],
  roster_players_v2: [
    { player_id: 501, name: 'Jordan Smith', jersey_number: '7', position: 'QB', photo_url: null },
    { player_id: 502, name: 'Jordan Smith', jersey_number: '22', position: 'LB', photo_url: null },
  ],
  quiz: {
    id: 5,
    organization_id: 1,
    coach_id: 1,
    created_by_username: 'coach1',
    title: 'Week 1 Prep',
    description: null,
    one_question_at_a_time: false,
    require_all_answers: false,
    folder_id: null,
    question_count: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    questions: [
      {
        id: 10,
        quiz_id: 5,
        question_text: 'Is this cover 2?',
        question_type: 'true_false',
        position: 0,
        image: null,
        options: [
          { id: 100, question_id: 10, option_text: 'True', position: 0 },
          { id: 101, question_id: 10, option_text: 'False', position: 1 },
        ],
      },
    ],
  },
};

const attempt: AttemptState = {
  attempt_id: 900,
  status: 'in_progress',
  mode: 'GRADED',
  question_order: [],
  feedback: [],
  answers: [],
};

const results: PlayerResultsResponse = {
  quiz_title: 'Week 1 Prep',
  player_name: 'Jordan Smith',
  submitted_at: '2026-01-01T00:05:00Z',
  answers: [],
};

const JORDAN = { playerId: 501, name: 'Jordan Smith', jerseyNumber: '7', position: 'QB' };
const pinRequired = () => new ApiError('Enter your PIN to continue.', 401, { player_id: 501 } as never, 'pin_required');
const claimed = (token: string | null, state: unknown = attempt) => ({
  attempt_token: token,
  token_header: 'X-Attempt-Token',
  player: { player_id: 501, name: 'Jordan Smith' },
  reclaimed: token === null,
  attempt: state as AttemptState,
});

/** Under StrictMode, like the real app (main.tsx): it mounts effects twice,
 *  which is exactly what once left a refreshed player stuck on "Loading…". */
function renderAt(path: string) {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/play" element={<PlayPage />} />
          <Route path="/play/:code" element={<PlayPage />} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(playApi, 'getQuizTitleByCode').mockResolvedValue({ quiz_title: 'Week 1 Prep' });
});
afterEach(() => vi.restoreAllMocks());

describe('PlayPage with player PINs', () => {
  it('choose your name, enter your PIN, play with the private token, see results', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'validateCode').mockResolvedValue(joined);
    vi.spyOn(playApi, 'startAttempt').mockRejectedValue(pinRequired());
    const claim = vi
      .spyOn(playApi, 'claimAttempt')
      .mockRejectedValueOnce(new ApiError("That PIN didn't match.", 401, undefined, 'pin_incorrect'))
      .mockResolvedValueOnce(claimed('issued-token'));
    const save = vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);
    const submit = vi
      .spyOn(playApi, 'submitQuiz')
      .mockResolvedValue({ attempt_id: 900, status: 'submitted', submitted_at: '2026-01-01T00:05:00Z', mode: 'GRADED' });
    const getResults = vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue(results);

    renderAt('/play');
    await user.type(screen.getByPlaceholderText('CODE'), 'abc123');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    // Two players share the name; the jersey tells them apart.
    await user.click(await screen.findByRole('button', { name: 'Jordan Smith (#7 · QB)' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // The PIN screen says who it is for.
    const pin = await screen.findByLabelText('Enter your PIN');
    expect(screen.getByText('#7 · QB')).toBeInTheDocument();
    await user.type(pin, '111111');
    expect(await screen.findByText('Incorrect PIN. Try again.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Enter your PIN'), '482915');

    expect(await screen.findByText('Is this cover 2?')).toBeInTheDocument();
    expect(claim).toHaveBeenLastCalledWith({ access_code_id: 42, player_id: 501, pin: '482915' });
    expect(readAttemptToken('ABC123', 501)).toBe('issued-token');

    await user.click(screen.getByLabelText('True'));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ player_id: 501 }), 'issued-token'));
    await user.click(screen.getByRole('button', { name: 'Submit Quiz' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ player_id: 501 }), 'issued-token'));

    await waitFor(() =>
      expect(getResults).toHaveBeenCalledWith('ABC123', 'Jordan Smith', 501, { token: 'issued-token' }),
    );
    expect(await screen.findByText('Results for Jordan Smith')).toBeInTheDocument();
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toContain('482915');
  });

  it('a new tab offers "Continue as", and continuing uses the device token - no PIN', async () => {
    const user = userEvent.setup();
    rememberPlayer('ABC123', JORDAN);
    saveAttemptToken('ABC123', 501, 'device-token');
    sessionStorage.clear(); // a new tab
    vi.spyOn(playApi, 'validateCode').mockResolvedValue(joined);
    const claim = vi.spyOn(playApi, 'claimAttempt').mockResolvedValue(claimed(null));
    const start = vi.spyOn(playApi, 'startAttempt');

    renderAt('/play/ABC123');

    await user.click(await screen.findByRole('button', { name: 'Continue as Jordan Smith · #7 · QB' }));

    expect(await screen.findByText('Is this cover 2?')).toBeInTheDocument();
    expect(claim).toHaveBeenCalledWith({ access_code_id: 42, player_id: 501 }, 'device-token');
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Enter your PIN')).not.toBeInTheDocument();
  });

  it('a refresh in the same tab comes straight back to the quiz', async () => {
    rememberPlayer('ABC123', JORDAN); // also marks this tab active
    saveAttemptToken('ABC123', 501, 'device-token');
    vi.spyOn(playApi, 'validateCode').mockResolvedValue(joined);
    vi.spyOn(playApi, 'claimAttempt').mockResolvedValue(
      claimed(null, { ...attempt, answers: [{ question_id: 10, selected_option_id: 101, answer_text: null, checked: false }] }),
    );

    renderAt('/play/ABC123');

    expect(await screen.findByText('Is this cover 2?')).toBeInTheDocument();
    expect(screen.getByLabelText('False')).toBeChecked();
  });

  it('"Not you?" on a shared phone forgets the last player and their token', async () => {
    const user = userEvent.setup();
    rememberPlayer('ABC123', JORDAN);
    saveAttemptToken('ABC123', 501, 'device-token');
    sessionStorage.clear();
    vi.spyOn(playApi, 'validateCode').mockResolvedValue(joined);
    const claim = vi.spyOn(playApi, 'claimAttempt');
    const start = vi.spyOn(playApi, 'startAttempt').mockRejectedValue(pinRequired());

    renderAt('/play/ABC123');
    await user.click(await screen.findByRole('button', { name: 'Not you? Choose your name' }));

    expect(readAttemptToken('ABC123', 501)).toBeNull();
    expect(rememberedPlayer('ABC123')).toBeNull();
    // A teammate picking Jordan's name gets the PIN screen, never Jordan's quiz.
    await user.click(await screen.findByRole('button', { name: 'Jordan Smith (#7 · QB)' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText('Enter your PIN')).toBeInTheDocument();
    expect(start).toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('a PIN reset mid-quiz asks for the new PIN and keeps the answer that had not saved', async () => {
    const user = userEvent.setup();
    rememberPlayer('ABC123', JORDAN);
    saveAttemptToken('ABC123', 501, 'old-token');
    vi.spyOn(playApi, 'validateCode').mockResolvedValue(joined);
    vi.spyOn(playApi, 'claimAttempt')
      .mockResolvedValueOnce(claimed(null)) // the refresh resumes with the old token
      .mockResolvedValueOnce(claimed('new-token')); // the new PIN, same attempt, nothing saved yet
    const save = vi
      .spyOn(playApi, 'saveAnswer')
      .mockRejectedValueOnce(new ApiError('Your PIN was changed.', 401, undefined, 'token_revoked'))
      .mockResolvedValue(undefined);

    renderAt('/play/ABC123');
    await user.click(await screen.findByLabelText('True'));

    expect(
      await screen.findByText('Your PIN was changed. Enter your new PIN to keep going.'),
    ).toBeInTheDocument();
    expect(screen.queryByText("Couldn't save - will retry")).not.toBeInTheDocument();
    expect(readAttemptToken('ABC123', 501)).toBeNull();

    await user.type(screen.getByLabelText('Enter your PIN'), '482915');

    expect(await screen.findByText('Is this cover 2?')).toBeInTheDocument();
    expect(screen.getByLabelText('True')).toBeChecked();
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ selected_option_id: 100 }), 'new-token'),
    );
  });

  it('a graded quiz already submitted goes to results after the PIN', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'validateCode').mockResolvedValue(joined);
    vi.spyOn(playApi, 'startAttempt').mockRejectedValue(pinRequired());
    vi.spyOn(playApi, 'claimAttempt').mockResolvedValue(claimed('results-token', { attempt_id: 900, status: 'submitted' }));
    const getResults = vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue(results);

    renderAt('/play');
    await user.type(screen.getByPlaceholderText('CODE'), 'ABC123');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Jordan Smith (#7 · QB)' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('Enter your PIN'), '482915');

    expect(await screen.findByText('Results for Jordan Smith')).toBeInTheDocument();
    expect(getResults).toHaveBeenCalledWith('ABC123', 'Jordan Smith', 501, { token: 'results-token' });
  });
});
