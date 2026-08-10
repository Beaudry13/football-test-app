import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupDetailPage } from './GroupDetailPage';
import * as groupsApi from '../api/groups';
import * as playersApi from '../api/players';
import type { Group, Player } from '../api/types';

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 1,
    organization_id: 1,
    first_name: 'John',
    last_name: 'Smith',
    full_name: 'John Smith',
    jersey_number: '2',
    position: 'S',
    photo_url: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    organization_id: 1,
    coach_id: 1,
    name: 'Defense',
    players: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/groups/1']}>
      <Routes>
        <Route path="/groups/:groupId" element={<GroupDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GroupDetailPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([makePlayer()]);
  });

  it('offers no way to type a name-only member', async () => {
    // The Master Roster is the source of truth. A typed name would create a
    // membership with no canonical Player, and an attempt made through it
    // never reaches the player profile or the cumulative report.
    vi.spyOn(groupsApi, 'getGroup').mockResolvedValue(makeGroup({ players: [] }));
    renderPage();

    expect(await screen.findByText('Add Players from Master Roster')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Advanced / Legacy Members' })).not.toBeInTheDocument();
    expect(screen.queryByText('Edit legacy members')).not.toBeInTheDocument();
    // The legacy bulk box specifically - the page still has a rename field
    // and the picker's search box, which are not name-only membership.
    expect(screen.queryByText(/One player name per line/)).not.toBeInTheDocument();
  });

  it('still offers CSV import, which now links to the Master Roster', async () => {
    // CSV is a canonical workflow now - every row resolves to a Player - so
    // retiring the name box must not take the bulk path with it.
    vi.spyOn(groupsApi, 'getGroup').mockResolvedValue(makeGroup({ players: [] }));
    renderPage();

    expect(await screen.findByText('Import from CSV')).toBeInTheDocument();
    expect(screen.getByText(/matched to a player on your Master Roster/)).toBeInTheDocument();
  });

  it('shows existing legacy members with an explanation, and only lets them be removed', async () => {
    vi.spyOn(groupsApi, 'getGroup').mockResolvedValue(
      makeGroup({ players: [{ id: 9, player_name: 'Legacy Name', position: 0 }] }),
    );
    renderPage();

    expect(await screen.findByText('Legacy Name')).toBeInTheDocument();
    expect(
      screen.getByText(/added before Peira linked quiz rosters to the Master Roster/),
    ).toBeInTheDocument();
    // Removable...
    expect(screen.getByRole('button', { name: 'Remove Legacy Name' })).toBeInTheDocument();
    // ...but there is no way to add another.
    expect(screen.queryByText(/One player name per line/)).not.toBeInTheDocument();
  });

  it('reloads group membership after adding players from the roster picker', async () => {
    const user = userEvent.setup();
    const player = makePlayer({ id: 5, full_name: 'John Smith' });
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([player]);
    vi.spyOn(groupsApi, 'getGroup')
      .mockResolvedValueOnce(makeGroup({ players: [] }))
      // Persistent, not Once: the CSV panel mounts and fetches too, so the
      // page makes more than two calls and the last must not resolve
      // undefined.
      .mockResolvedValue(makeGroup({ players: [{ id: 1, player_name: 'John Smith', position: 0, player }] }));
    const addSpy = vi.spyOn(playersApi, 'addGroupMembers').mockResolvedValue(makeGroup());
    // NOTE: the CSV panel is now always mounted (it used to sit behind the
    // Advanced toggle), and it fetches the group once on mount. So the page
    // issues one more getGroup than it used to - counted explicitly here
    // rather than left as a surprise.
    renderPage();

    await screen.findByText('John Smith');
    await user.click(screen.getByLabelText('Select John Smith'));
    await user.click(screen.getByRole('button', { name: 'Add Selected Players' }));

    await waitFor(() => expect(addSpy).toHaveBeenCalledWith(1, [5]));
    await waitFor(() => expect(groupsApi.getGroup).toHaveBeenCalledTimes(3));
    expect(await screen.findByTestId('stat-in-group')).toHaveTextContent('In This Group: 1');
  });
});
