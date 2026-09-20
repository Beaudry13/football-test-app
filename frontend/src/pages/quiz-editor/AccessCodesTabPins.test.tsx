import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessCodesTab } from './AccessCodesTab';
import * as accessCodesApi from '../../api/accessCodes';
import * as groupsApi from '../../api/groups';
import * as playersApi from '../../api/players';
import { ApiError } from '../../api/client';
import type { Quiz } from '../../api/types';

/** PHASE 3C, as a coach meets it: with PINs enforced, activating a quiz for
 *  players who have no PIN is refused - and the refusal names them and fixes it
 *  in one click, without leaving the page. */

const quiz: Quiz = {
  id: 1,
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Week 1 Prep',
  description: null,
  one_question_at_a_time: true,
  require_all_answers: false,
  folder_id: null,
  question_count: 2,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const refusal = new ApiError(
  "2 players don't have a PIN yet, so they couldn't start this quiz. Give them PINs, then activate it.",
  422,
  {
    players_without_pins: [
      { player_id: 11, name: 'Ben Adams', jersey_number: null },
      { player_id: 12, name: 'Ava Zulu', jersey_number: '9' },
    ],
  } as never,
  'players_need_pins',
);

const issued = (id: number, name: string, pin: string) => ({
  player_id: id,
  first_name: name.split(' ')[0],
  last_name: name.split(' ')[1],
  full_name: name,
  jersey_number: null,
  position: null,
  pin,
});

describe('AccessCodesTab PIN gate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
  });

  it('names who needs a PIN, generates the missing ones, and shows the sheet once', async () => {
    const user = userEvent.setup();
    vi.spyOn(accessCodesApi, 'activateQuiz').mockRejectedValue(refusal);
    const generate = vi
      .spyOn(playersApi, 'generateMissingPins')
      .mockResolvedValueOnce({ issued: [issued(11, 'Ben Adams', '482915')], remaining: 1 })
      .mockResolvedValueOnce({ issued: [issued(12, 'Ava Zulu', '730146')], remaining: 0 });

    render(<AccessCodesTab quiz={quiz} />);
    await screen.findByText('This Quiz has no active access code.');
    await user.click(screen.getByRole('button', { name: 'Activate Quiz' }));

    const blocker = await screen.findByRole('alert');
    expect(blocker).toHaveTextContent("2 players don't have a PIN yet");
    expect(blocker).toHaveTextContent('Ben Adams');
    expect(blocker).toHaveTextContent('Ava Zulu · #9');
    // The refusal's data never leaks out as if it were the error message.
    expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Generate missing PINs' }));

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('482 915')).toBeInTheDocument();
    expect(screen.getByText('730 146')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('any other activation failure is shown as before, with no PIN blocker', async () => {
    const user = userEvent.setup();
    vi.spyOn(accessCodesApi, 'activateQuiz').mockRejectedValue(
      new ApiError('Cannot activate a quiz with no roster and no group selected', 422),
    );

    render(<AccessCodesTab quiz={quiz} />);
    await screen.findByText('This Quiz has no active access code.');
    await user.click(screen.getByRole('button', { name: 'Activate Quiz' }));

    expect(await screen.findByText('Cannot activate a quiz with no roster and no group selected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate missing PINs' })).not.toBeInTheDocument();
  });
});
