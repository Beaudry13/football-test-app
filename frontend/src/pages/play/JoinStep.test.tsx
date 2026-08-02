import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { JoinStep } from './JoinStep';
import * as playApi from '../../api/play';
import { ApiError } from '../../api/client';

function renderJoinStep(onJoined = vi.fn()) {
  render(<JoinStep initialCode="" onJoined={onJoined} />);
  return { onJoined };
}

describe('JoinStep', () => {
  it('shows a calm, specific message when the code has expired', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'validateCode').mockRejectedValue(
      new ApiError('This access code has expired', 404, undefined, 'expired'),
    );
    renderJoinStep();

    await user.type(screen.getByPlaceholderText('CODE'), 'OLDCOD');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByText('This code has expired — ask your coach for a new one.'),
    ).toBeInTheDocument();
  });

  it('shows the generic server message for a not-found or deactivated code', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'validateCode').mockRejectedValue(
      new ApiError('Invalid access code', 404, undefined, 'not_found'),
    );
    renderJoinStep();

    await user.type(screen.getByPlaceholderText('CODE'), 'BADCOD');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Invalid access code')).toBeInTheDocument();
    // Not the expired-specific copy.
    expect(screen.queryByText(/ask your coach/)).not.toBeInTheDocument();
  });

  it('calls onJoined with the code and result on success', async () => {
    const user = userEvent.setup();
    const result = {
      access_code_id: 1,
      expires_at: '2026-08-02T00:00:00Z',
      roster_players: [],
      quiz: {
        id: 1,
        organization_id: 1,
        coach_id: 1,
        created_by_username: 'coach1',
        title: 'Week 1',
        description: null,
        one_question_at_a_time: false,
        folder_id: null,
        question_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        questions: [],
      },
    };
    vi.spyOn(playApi, 'validateCode').mockResolvedValue(result);
    const { onJoined } = renderJoinStep();

    await user.type(screen.getByPlaceholderText('CODE'), 'goodcode');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(onJoined).toHaveBeenCalledWith('GOODCODE', result);
  });
});
