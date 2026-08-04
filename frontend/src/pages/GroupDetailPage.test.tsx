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

  it('collapses the Legacy Members section behind Advanced when there are none', async () => {
    vi.spyOn(groupsApi, 'getGroup').mockResolvedValue(makeGroup({ players: [] }));
    renderPage();

    expect(await screen.findByText('Add Players from Master Roster')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Advanced / Legacy Members' })).toBeInTheDocument();
    expect(screen.queryByText('Edit legacy members')).not.toBeInTheDocument();
  });

  it('expands the Legacy Members editor when Advanced is clicked', async () => {
    const user = userEvent.setup();
    vi.spyOn(groupsApi, 'getGroup').mockResolvedValue(makeGroup({ players: [] }));
    renderPage();

    await screen.findByText('Add Players from Master Roster');
    await user.click(screen.getByRole('button', { name: 'Advanced / Legacy Members' }));

    expect(await screen.findByText('Edit legacy members')).toBeInTheDocument();
  });

  it('shows Legacy Members directly with an explanatory note when they exist', async () => {
    vi.spyOn(groupsApi, 'getGroup').mockResolvedValue(
      makeGroup({ players: [{ id: 9, player_name: 'Legacy Name', position: 0 }] }),
    );
    renderPage();

    expect(await screen.findByText('Edit legacy members')).toBeInTheDocument();
    expect(screen.getByText(/aren't connected to a canonical Player/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Advanced / Legacy Members' })).not.toBeInTheDocument();
  });

  it('reloads group membership after adding players from the roster picker', async () => {
    const user = userEvent.setup();
    const player = makePlayer({ id: 5, full_name: 'John Smith' });
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([player]);
    vi.spyOn(groupsApi, 'getGroup')
      .mockResolvedValueOnce(makeGroup({ players: [] }))
      .mockResolvedValueOnce(makeGroup({ players: [{ id: 1, player_name: 'John Smith', position: 0, player }] }));
    const addSpy = vi.spyOn(playersApi, 'addGroupMembers').mockResolvedValue(makeGroup());
    renderPage();

    await screen.findByText('John Smith');
    await user.click(screen.getByLabelText('Select John Smith'));
    await user.click(screen.getByRole('button', { name: 'Add Selected Players' }));

    await waitFor(() => expect(addSpy).toHaveBeenCalledWith(1, [5]));
    await waitFor(() => expect(groupsApi.getGroup).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('stat-in-group')).toHaveTextContent('In This Group: 1');
  });
});
