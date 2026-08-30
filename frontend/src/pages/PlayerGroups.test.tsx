/** Group membership, edited from the player.
 *
 * The rule these all protect: membership is a SET a player belongs to, not a
 * place they live. Adding one group never removes another, removing one never
 * disturbs the rest, and neither touches the player's identity or history.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerGroups } from './PlayerGroups';
import type { Group } from '../api/types';

vi.mock('../api/players', () => ({
  addGroupMembers: vi.fn().mockResolvedValue({}),
  removeGroupMember: vi.fn().mockResolvedValue(undefined),
}));

import { addGroupMembers, removeGroupMember } from '../api/players';

const group = (id: number, name: string): Group => ({ id, name }) as unknown as Group;

const ALL = [
  group(1, 'Defense'),
  group(2, 'Safeties'),
  group(3, 'Special Teams'),
  group(4, 'Scout Team'),
  group(5, 'Travel'),
];

function renderGroups(memberOf: { id: number; name: string }[], onChanged = vi.fn()) {
  render(
    <PlayerGroups playerId={77} allGroups={ALL} memberOf={memberOf} onChanged={onChanged} />,
  );
  return onChanged;
}

beforeEach(() => vi.clearAllMocks());

describe('what the coach can see', () => {
  it('shows every group, marking the ones this player is in', () => {
    renderGroups([
      { id: 1, name: 'Defense' },
      { id: 2, name: 'Safeties' },
    ]);

    expect(screen.getByRole('button', { name: /Defense/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /Safeties/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Offered, not hidden - a coach cannot add someone to a group they
    // cannot see.
    expect(screen.getByRole('button', { name: /Scout Team/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getAllByRole('button')).toHaveLength(5);
  });

  it('says so plainly when the organization has no groups yet', () => {
    render(<PlayerGroups playerId={77} allGroups={[]} memberOf={[]} onChanged={vi.fn()} />);

    expect(screen.getByText(/No groups yet/)).toBeInTheDocument();
  });
});

describe('changing membership', () => {
  it('adds this one player to a group they were not in', async () => {
    const user = userEvent.setup();
    renderGroups([{ id: 1, name: 'Defense' }]);

    await user.click(screen.getByRole('button', { name: /Travel/ }));

    await waitFor(() => expect(addGroupMembers).toHaveBeenCalledWith(5, [77]));
    expect(removeGroupMember).not.toHaveBeenCalled();
  });

  it('removes only the group that was clicked', async () => {
    const user = userEvent.setup();
    renderGroups([
      { id: 1, name: 'Defense' },
      { id: 2, name: 'Safeties' },
      { id: 3, name: 'Special Teams' },
    ]);

    await user.click(screen.getByRole('button', { name: /Safeties/ }));

    await waitFor(() => expect(removeGroupMember).toHaveBeenCalledWith(2, 77));
    // THE MULTI-GROUP RULE. One call, for one group. Nothing rebuilds the
    // player's whole membership set, so Defense and Special Teams cannot be
    // collateral damage.
    expect(removeGroupMember).toHaveBeenCalledTimes(1);
    expect(addGroupMembers).not.toHaveBeenCalled();
  });

  it('adding a group never removes the ones already held', async () => {
    const user = userEvent.setup();
    renderGroups([
      { id: 1, name: 'Defense' },
      { id: 3, name: 'Special Teams' },
    ]);

    await user.click(screen.getByRole('button', { name: /Scout Team/ }));

    await waitFor(() => expect(addGroupMembers).toHaveBeenCalledTimes(1));
    expect(addGroupMembers).toHaveBeenCalledWith(4, [77]);
    expect(removeGroupMember).not.toHaveBeenCalled();
  });

  it('refetches from the server rather than trusting its own copy', async () => {
    // Membership lives in group_players. If this kept local state, the
    // player page and the group page could disagree about the same rows.
    const user = userEvent.setup();
    const onChanged = renderGroups([]);

    await user.click(screen.getByRole('button', { name: /Defense/ }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('never sends a player id other than this player', async () => {
    const user = userEvent.setup();
    renderGroups([{ id: 2, name: 'Safeties' }]);

    await user.click(screen.getByRole('button', { name: /Defense/ }));
    await waitFor(() => expect(addGroupMembers).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /Safeties/ }));
    await waitFor(() => expect(removeGroupMember).toHaveBeenCalled());

    expect(vi.mocked(addGroupMembers).mock.calls[0][1]).toEqual([77]);
    expect(vi.mocked(removeGroupMember).mock.calls[0][1]).toBe(77);
  });

  it('surfaces a failure instead of showing a change that did not happen', async () => {
    const user = userEvent.setup();
    vi.mocked(addGroupMembers).mockRejectedValueOnce(new Error('Request failed'));
    const onChanged = renderGroups([]);

    await user.click(screen.getByRole('button', { name: /Travel/ }));

    expect(await screen.findByText(/Request failed/)).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Travel/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
