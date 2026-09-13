/** Two players called John Smith, in one group.
 *
 * THIS SURFACE WAS ALREADY DISAMBIGUATED, and these tests exist to keep it
 * that way rather than to add anything. The member table has its own Jersey
 * and Position columns, so a duplicate-name suffix in the Player column would
 * only repeat what sits beside it. No suffix is expected here, on purpose.
 *
 * THE TRAP THEY GUARD: a group-member row carries TWO things called
 * "position". `GroupPlayer.position` (RosterPlayer.position in the frontend
 * types) is an INTEGER SORT ORDER. The football position is the linked
 * Player's `position`. Both type-check as something printable, so reaching
 * for the wrong one would render "3" where "LB" belongs and nothing would
 * complain - except the sort-index test below.
 *
 * Rendered through GroupDetailPage rather than the table component alone, so
 * the whole path is covered: the group payload that carries the sort index,
 * the roster that carries the Player, and the table that shows the row.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupDetailPage } from './GroupDetailPage';
import * as groupsApi from '../api/groups';
import * as playersApi from '../api/players';
import type { Group, Player, RosterPlayer } from '../api/types';

const GROUP_ID = 1;

function makePlayer(overrides: Partial<Player>): Player {
  return {
    id: 1,
    organization_id: 1,
    first_name: 'John',
    last_name: 'Smith',
    full_name: 'John Smith',
    jersey_number: null,
    position: null,
    photo_url: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const QB = makePlayer({ id: 21, jersey_number: '12', position: 'QB' });
const LB = makePlayer({ id: 22, jersey_number: '37', position: 'LB' });
const BARE = makePlayer({ id: 40, first_name: 'Sam', last_name: 'Rivera', full_name: 'Sam Rivera' });

/** A canonical member row. `sortIndex` is GroupPlayer.position - the integer
 *  that must never be shown as a football position. */
const member = (id: number, player: Player, sortIndex: number): RosterPlayer => ({
  id,
  player_name: player.full_name,
  position: sortIndex,
  player,
});

function makeGroup(players: RosterPlayer[]): Group {
  return {
    id: GROUP_ID,
    organization_id: 1,
    coach_id: 1,
    name: 'Defense',
    players,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={[`/groups/${GROUP_ID}`]}>
      <Routes>
        <Route path="/groups/:groupId" element={<GroupDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The member table's row for a player, found by a cell that is unique to it -
 *  never by the name, which is the whole point. */
async function rowWithCell(text: string): Promise<HTMLElement> {
  const cell = await screen.findByRole('cell', { name: text });
  return cell.closest('tr') as HTMLElement;
}

const cellsOf = (row: HTMLElement) =>
  within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent);

// Column order in the member table: select, avatar, Player, #, Position, actions.
const NAME = 2;
const JERSEY = 3;
const POSITION = 4;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([QB, LB, BARE]);
});

describe('same-named canonical members', () => {
  it('are told apart by the existing Jersey and Position cells', async () => {
    // Persistent, not Once: the legacy CSV panel fetches the group too.
    vi.spyOn(groupsApi, 'getGroup').mockResolvedValue(
      makeGroup([member(1, QB, 0), member(2, LB, 1)]),
    );
    renderPage();

    const qbRow = await rowWithCell('#12');
    const lbRow = await rowWithCell('#37');
    expect(qbRow).not.toBe(lbRow);

    expect(cellsOf(qbRow)[JERSEY]).toBe('#12');
    expect(cellsOf(qbRow)[POSITION]).toBe('QB');
    expect(cellsOf(lbRow)[JERSEY]).toBe('#37');
    expect(cellsOf(lbRow)[POSITION]).toBe('LB');
  });

  it('carry no suffix in the Player column - the columns beside it already say it', async () => {
    vi.spyOn(groupsApi, 'getGroup').mockResolvedValue(
      makeGroup([member(1, QB, 0), member(2, LB, 1)]),
    );
    renderPage();

    expect(cellsOf(await rowWithCell('#12'))[NAME]).toBe('John Smith');
    expect(cellsOf(await rowWithCell('#37'))[NAME]).toBe('John Smith');
  });
});

describe('THE SORT-INDEX TRAP', () => {
  it('shows the linked Player’s football position, never GroupPlayer.position', async () => {
    // GroupPlayer.position = 3 (sort order). Player.position = "LB".
    const trap = member(7, LB, 3);
    expect(trap.position).toBe(3);
    expect(trap.player?.position).toBe('LB');

    vi.spyOn(groupsApi, 'getGroup').mockResolvedValue(makeGroup([trap]));
    renderPage();

    const row = await rowWithCell('#37');
    expect(cellsOf(row)[POSITION]).toBe('LB');
    expect(cellsOf(row)[POSITION]).not.toBe('3');
    // Not in ANY cell of that row - not as a position, not appended to the name.
    expect(cellsOf(row)).not.toContain('3');
    expect(row.textContent).not.toMatch(/\b3\b/);
  });
});

describe('Remove', () => {
  it('sends the intended row’s canonical player.id, not a name and not the other Smith', async () => {
    const user = userEvent.setup();
    vi.spyOn(groupsApi, 'getGroup').mockResolvedValue(
      makeGroup([member(1, QB, 0), member(2, LB, 1)]),
    );
    const removeSpy = vi
      .spyOn(playersApi, 'removeGroupMember')
      .mockResolvedValue(undefined as never);
    renderPage();

    const lbRow = await rowWithCell('#37');
    await user.click(within(lbRow).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(1));
    expect(removeSpy).toHaveBeenCalledWith(GROUP_ID, LB.id);
    expect(removeSpy).not.toHaveBeenCalledWith(GROUP_ID, QB.id);
  });
});

describe('a canonical member with no jersey or position', () => {
  it('renders — in both cells and invents nothing', async () => {
    vi.spyOn(groupsApi, 'getGroup').mockResolvedValue(makeGroup([member(3, BARE, 2)]));
    renderPage();

    const nameCell = await screen.findByRole('cell', { name: 'Sam Rivera' });
    const row = nameCell.closest('tr') as HTMLElement;
    expect(cellsOf(row)[JERSEY]).toBe('—');
    expect(cellsOf(row)[POSITION]).toBe('—');
    // And the sort index (2) did not step in to fill the gap.
    expect(cellsOf(row)).not.toContain('2');
  });
});

describe('legacy rows keep their existing name-only behaviour', () => {
  it('show the name and a Remove, with no jersey or position', async () => {
    vi.spyOn(groupsApi, 'getGroup').mockResolvedValue(
      makeGroup([member(1, QB, 0), { id: 9, player_name: 'John Smith', position: 5 }]),
    );
    renderPage();

    const legacyRemove = await screen.findByRole('button', { name: 'Remove John Smith' });
    const legacyItem = legacyRemove.closest('li') as HTMLElement;
    expect(legacyItem.textContent).toBe('John SmithRemove');
    // A legacy row is never a table row with jersey/position cells.
    expect(legacyItem.closest('tr')).toBeNull();
  });
});
