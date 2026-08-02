import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NameStep } from './NameStep';
import * as playApi from '../../api/play';
import { ApiError } from '../../api/client';
import type { AttemptState } from '../../api/types';

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
        rosterPlayers={['Jordan Smith', 'Alex Lee']}
        accessCodeId={42}
        onStarted={onStarted}
        onAlreadySubmitted={onAlreadySubmitted}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Jordan Smith' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(startSpy).toHaveBeenCalledWith({ access_code_id: 42, player_name: 'Jordan Smith' }),
    );
    expect(onStarted).toHaveBeenCalledWith('Jordan Smith', attempt);
    expect(onAlreadySubmitted).not.toHaveBeenCalled();
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
        rosterPlayers={['Jordan Smith']}
        accessCodeId={42}
        onStarted={onStarted}
        onAlreadySubmitted={onAlreadySubmitted}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Jordan Smith' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(onAlreadySubmitted).toHaveBeenCalledWith('Jordan Smith'));
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
        rosterPlayers={['Jordan Smith']}
        accessCodeId={42}
        onStarted={onStarted}
        onAlreadySubmitted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Jordan Smith' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Invalid or expired access code')).toBeInTheDocument();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('disables the Continue button until a name is selected', () => {
    render(
      <NameStep
        quizTitle="Week 1 Prep"
        rosterPlayers={['Jordan Smith']}
        accessCodeId={42}
        onStarted={vi.fn()}
        onAlreadySubmitted={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });
});
