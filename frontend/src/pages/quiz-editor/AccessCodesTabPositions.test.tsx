import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessCodesTab } from './AccessCodesTab';
import * as accessCodesApi from '../../api/accessCodes';
import * as groupsApi from '../../api/groups';
import * as playersApi from '../../api/players';
import * as rosterApi from '../../api/roster';
import type { AccessCode, Group, Player, Quiz, Roster } from '../../api/types';

/**
 * WHO A QUIZ GOES TO, BY POSITION - the same chips a Rep is sent with. Picked
 * positions join the quiz's own roster (no throwaway group) and the code goes
 * to that roster; the line under the chips says exactly who that is. A coach
 * who picks no position activates exactly as before.
 */

const quiz = { id: 1, title: 'Week 1 Prep', question_count: 2 } as unknown as Quiz;

const player = (id: number, position: string): Player =>
  ({ id, first_name: `P${id}`, last_name: 'X', position, is_active: true }) as unknown as Player;
const PLAYERS = [player(11, 'FS'), player(12, 'SS'), player(13, 'S'), player(21, 'CB'), player(22, 'CB')];

const linebackers: Group = {
  id: 7,
  organization_id: 1,
  coach_id: 1,
  name: 'Linebackers',
  players: [{ id: 1, player_name: 'Mike', position: 0, player: player(31, 'LB') }],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const roster = (ids: number[]): Roster => ({
  id: 5,
  quiz_id: 1,
  players: ids.map((id, i) => ({ id: 100 + i, player_name: `P${id}`, position: i, player: player(id, 'S') })),
});

const code = { id: 3, code: 'ABC234', mode: 'GRADED', groups: [], is_active: true, is_valid: true } as unknown as AccessCode;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([linebackers]);
  vi.spyOn(playersApi, 'listPlayers').mockResolvedValue(PLAYERS);
  vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
});

describe('Activate - send to positions', () => {
  it('puts the safeties on the quiz roster and activates for that roster', async () => {
    const user = userEvent.setup();
    vi.spyOn(rosterApi, 'getRoster').mockResolvedValue(roster([]));
    const add = vi.spyOn(rosterApi, 'addRosterMembers').mockResolvedValue(roster([11, 12, 13]));
    const activate = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(code);
    render(<AccessCodesTab quiz={quiz} />);

    const chips = within(await screen.findByRole('group', { name: 'Positions' }));
    await user.click(chips.getByRole('button', { name: /Safeties/ }));
    expect(screen.getByRole('status')).toHaveTextContent('Goes to 3 players.');
    await user.click(screen.getByRole('button', { name: 'Activate Quiz' }));

    await waitFor(() => expect(activate).toHaveBeenCalledWith(1, [], 'GRADED', false, expect.any(Date)));
    expect(add).toHaveBeenCalledWith(1, [11, 12, 13]);
  });

  it('says plainly when the quiz roster already has players - the code reaches them too', async () => {
    const user = userEvent.setup();
    vi.spyOn(rosterApi, 'getRoster').mockResolvedValue(roster([11, 40, 41]));
    render(<AccessCodesTab quiz={quiz} />);

    const chips = within(await screen.findByRole('group', { name: 'Positions' }));
    await user.click(chips.getByRole('button', { name: /Safeties/ }));
    expect(screen.getByRole('status')).toHaveTextContent(
      "Goes to this quiz's roster: 5 players - the 3 already on it and 2 more.",
    );
  });

  it('picked groups join the positions on the roster', async () => {
    const user = userEvent.setup();
    vi.spyOn(rosterApi, 'getRoster').mockResolvedValue(roster([]));
    const add = vi.spyOn(rosterApi, 'addRosterMembers').mockResolvedValue(roster([21, 22, 31]));
    const activate = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(code);
    render(<AccessCodesTab quiz={quiz} />);

    const chips = within(await screen.findByRole('group', { name: 'Positions' }));
    await user.click(chips.getByRole('button', { name: /Corners/ }));
    await user.click(screen.getByRole('checkbox', { name: /Linebackers/ }));
    expect(screen.getByText('Add saved group(s) too (optional)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Activate Quiz' }));

    await waitFor(() => expect(activate).toHaveBeenCalledWith(1, [], 'GRADED', false, expect.any(Date)));
    expect(add).toHaveBeenCalledWith(1, [21, 22, 31]);
  });

  it('with no position picked, groups restrict the code exactly as before - the roster untouched', async () => {
    const user = userEvent.setup();
    vi.spyOn(rosterApi, 'getRoster').mockResolvedValue(roster([]));
    const add = vi.spyOn(rosterApi, 'addRosterMembers');
    const activate = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(code);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByRole('group', { name: 'Positions' });
    await user.click(screen.getByRole('checkbox', { name: /Linebackers/ }));
    await user.click(screen.getByRole('button', { name: 'Activate Quiz' }));

    await waitFor(() => expect(activate).toHaveBeenCalledWith(1, [7], 'GRADED', false, expect.any(Date)));
    expect(add).not.toHaveBeenCalled();
  });
});
