import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NameStep } from './NameStep';
import * as playApi from '../../api/play';
import { ApiError } from '../../api/client';
import type { AttemptState, RosterPlayerOption } from '../../api/types';

const rosterPlayers: RosterPlayerOption[] = [
  { player_id: 501, name: 'Jordan Smith', jersey_number: '7', position: 'QB', photo_url: null },
  { player_id: null, name: 'Alex Lee', jersey_number: null, position: null, photo_url: null },
];

const rosterPlayersWithPhotos: RosterPlayerOption[] = [
  { player_id: 501, name: 'Jordan Smith', jersey_number: '7', position: 'QB', photo_url: '/uploads/jordan.jpg' },
  { player_id: 502, name: 'Chris Smith', jersey_number: '9', position: 'WR', photo_url: null },
];

describe('NameStep', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('starts an attempt for the selected name and calls onStarted with the resumed state', async () => {
    const user = userEvent.setup();
    const attempt: AttemptState = {
      attempt_id: 5,
      status: 'in_progress',
      answers: [{ question_id: 1, selected_option_id: 10, answer_text: null }],
    };
    const startSpy = vi.spyOn(playApi, 'startAttempt').mockResolvedValue(attempt);
    const onStarted = vi.fn();
    const onAlreadySubmitted = vi.fn();

    render(
      <NameStep
        quizTitle="Week 1 Prep"
        rosterPlayers={rosterPlayers}
        accessCodeId={42}
        onStarted={onStarted}
        onAlreadySubmitted={onAlreadySubmitted}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Jordan Smith (#7 · QB)' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(startSpy).toHaveBeenCalledWith({ access_code_id: 42, player_name: 'Jordan Smith', player_id: 501 }),
    );
    expect(onStarted).toHaveBeenCalledWith('Jordan Smith', 501, attempt);
    expect(onAlreadySubmitted).not.toHaveBeenCalled();
  });

  it('starts an attempt for a legacy (non-canonical) roster entry without a player_id', async () => {
    const user = userEvent.setup();
    const attempt: AttemptState = { attempt_id: 6, status: 'in_progress', answers: [] };
    const startSpy = vi.spyOn(playApi, 'startAttempt').mockResolvedValue(attempt);
    const onStarted = vi.fn();

    render(
      <NameStep
        quizTitle="Week 1 Prep"
        rosterPlayers={rosterPlayers}
        accessCodeId={42}
        onStarted={onStarted}
        onAlreadySubmitted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Alex Lee' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(startSpy).toHaveBeenCalledWith({ access_code_id: 42, player_name: 'Alex Lee', player_id: undefined }),
    );
    expect(onStarted).toHaveBeenCalledWith('Alex Lee', undefined, attempt);
  });

  it('routes to onAlreadySubmitted on a 409 instead of showing an error', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'startAttempt').mockRejectedValue(
      new ApiError('This player has already submitted this quiz', 409),
    );
    const onStarted = vi.fn();
    const onAlreadySubmitted = vi.fn();

    render(
      <NameStep
        quizTitle="Week 1 Prep"
        rosterPlayers={rosterPlayers}
        accessCodeId={42}
        onStarted={onStarted}
        onAlreadySubmitted={onAlreadySubmitted}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Jordan Smith (#7 · QB)' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(onAlreadySubmitted).toHaveBeenCalledWith('Jordan Smith', 501));
    expect(onStarted).not.toHaveBeenCalled();
    expect(screen.queryByText(/already submitted/)).not.toBeInTheDocument();
  });

  it('shows an inline error and stays on this step for any other failure', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'startAttempt').mockRejectedValue(new ApiError('Invalid or expired access code', 404));
    const onStarted = vi.fn();

    render(
      <NameStep
        quizTitle="Week 1 Prep"
        rosterPlayers={rosterPlayers}
        accessCodeId={42}
        onStarted={onStarted}
        onAlreadySubmitted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Jordan Smith (#7 · QB)' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Invalid or expired access code')).toBeInTheDocument();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("shows a roster player's photo when set, and initials otherwise - helps tell same-name Players apart", () => {
    const { container } = render(
      <NameStep
        quizTitle="Week 1 Prep"
        rosterPlayers={rosterPlayersWithPhotos}
        accessCodeId={42}
        onStarted={vi.fn()}
        onAlreadySubmitted={vi.fn()}
      />,
    );

    const jordanButton = screen.getByRole('button', { name: 'Jordan Smith (#7 · QB)' });
    const chrisButton = screen.getByRole('button', { name: 'Chris Smith (#9 · WR)' });
    expect(jordanButton.querySelector('img')).not.toBeNull();
    expect(chrisButton.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('disables the Continue button until a name is selected', () => {
    render(
      <NameStep
        quizTitle="Week 1 Prep"
        rosterPlayers={rosterPlayers}
        accessCodeId={42}
        onStarted={vi.fn()}
        onAlreadySubmitted={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });
});
