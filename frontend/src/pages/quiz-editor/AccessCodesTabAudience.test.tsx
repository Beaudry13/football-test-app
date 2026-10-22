import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessCodesTab } from './AccessCodesTab';
import * as accessCodesApi from '../../api/accessCodes';
import * as groupsApi from '../../api/groups';
import * as playersApi from '../../api/players';
import * as rosterApi from '../../api/roster';
import type { AccessCode, Group, Player, Quiz, Roster } from '../../api/types';

/**
 * WHO GETS IT, SAID BEFORE IT GOES. The Activate tab names the players a code
 * will reach - by the server's own rule - so a retest (whose list is exactly
 * the players who missed it) is checked at a glance and sent with one click;
 * a saved group picked on its own says that it replaces the list; a quiz that
 * would reach nobody says so instead of failing; and "Reactivate" keeps the
 * live code's audience rather than whatever happened to be ticked before.
 */

const quiz = { id: 1, title: 'Force / Contain - retest', question_count: 2 } as unknown as Quiz;
const player = (id: number, name: string): Player =>
  ({ id, first_name: name, last_name: '', full_name: name, position: null, is_active: true }) as unknown as Player;
const roster = (names: string[]): Roster => ({
  id: 5,
  quiz_id: 1,
  players: names.map((n, i) => ({ id: 100 + i, player_name: n, position: i, player: player(10 + i, n) })),
});
const defense: Group = {
  id: 7,
  organization_id: 1,
  coach_id: 1,
  name: 'Defense',
  players: [
    { id: 1, player_name: 'Jordan Smith', position: 0, player: player(31, 'Jordan Smith') },
    { id: 2, player_name: 'Mike Ross', position: 1, player: player(32, 'Mike Ross') },
  ],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};
const live = { id: 3, code: 'ABC234', mode: 'GRADED', groups: [{ id: 7, name: 'Defense' }], is_active: true, is_valid: true, expires_at: '2026-12-01T00:00:00Z' } as unknown as AccessCode;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([defense]);
  vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([]);
  vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
});

describe('Activate says who gets it', () => {
  it("names the players on the quiz's list - on a retest, exactly the ones who missed it", async () => {
    vi.spyOn(rosterApi, 'getRoster').mockResolvedValue(roster(['Ty Adams', 'Bo Brown', 'Cam Cole']));
    const activate = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(live);
    const user = userEvent.setup();
    render(<AccessCodesTab quiz={quiz} />);
    expect(await screen.findByText('Goes to these 3: Ty Adams, Bo Brown and Cam Cole.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Activate Quiz' }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith(1, [], 'GRADED', false, expect.any(Date)));
  });

  it('a long list shows a few names and how many more', async () => {
    vi.spyOn(rosterApi, 'getRoster').mockResolvedValue(roster(['A One', 'B Two', 'C Three', 'D Four', 'E Five', 'F Six', 'G Seven']));
    render(<AccessCodesTab quiz={quiz} />);
    expect(await screen.findByText('Goes to these 7: A One, B Two, C Three, D Four and 3 more.')).toBeInTheDocument();
  });

  it('a saved group picked on its own says it replaces the list', async () => {
    vi.spyOn(rosterApi, 'getRoster').mockResolvedValue(roster(['Ty Adams', 'Bo Brown']));
    const user = userEvent.setup();
    render(<AccessCodesTab quiz={quiz} />);
    await screen.findByText(/Goes to these 2/);
    await user.click(screen.getByRole('checkbox', { name: /Defense/ }));
    expect(screen.getByText("Goes to the 2 players in Defense - instead of the 2 on this quiz's list.")).toBeInTheDocument();
  });

  it('a quiz that would reach nobody says so, and does not offer to activate', async () => {
    vi.spyOn(rosterApi, 'getRoster').mockResolvedValue(roster([]));
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
    render(<AccessCodesTab quiz={quiz} />);
    expect(await screen.findByText(/Nobody yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate Quiz' })).toBeDisabled();
  });

  it('Reactivate keeps the live code’s audience, and says so', async () => {
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([live]);
    vi.spyOn(rosterApi, 'getRoster').mockResolvedValue(roster(['Ty Adams']));
    const activate = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(live);
    const user = userEvent.setup();
    render(<AccessCodesTab quiz={quiz} />);
    await user.click(await screen.findByRole('button', { name: 'Reactivate with new code' }));
    expect(screen.getByText('Goes to the same players: Defense.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create new code' }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith(1, [7], 'GRADED', false, expect.any(Date)));
  });
});
