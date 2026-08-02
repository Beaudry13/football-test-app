import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupsPage } from './GroupsPage';
import * as groupsApi from '../api/groups';
import type { Group } from '../api/types';

const sampleGroup: Group = {
  id: 7,
  organization_id: 1,
  coach_id: 1,
  name: 'Defense',
  players: [
    { id: 1, player_name: 'Jordan Smith', position: 0 },
    { id: 2, player_name: 'Alex Lee', position: 1 },
  ],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function renderGroups() {
  render(
    <MemoryRouter>
      <GroupsPage />
    </MemoryRouter>,
  );
}

describe('GroupsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the empty state when there are no groups', async () => {
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
    renderGroups();

    expect(await screen.findByText('No groups yet. Create your first one above.')).toBeInTheDocument();
  });

  it('lists groups with their player count', async () => {
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([sampleGroup]);
    renderGroups();

    expect(await screen.findByText('Defense')).toBeInTheDocument();
    expect(screen.getByText('2 players')).toBeInTheDocument();
  });

  it('shows the server error when the list fails to load', async () => {
    vi.spyOn(groupsApi, 'listGroups').mockRejectedValue(new Error('Could not reach the server.'));
    renderGroups();

    expect(await screen.findByText('Could not reach the server.')).toBeInTheDocument();
  });

  it('disables New group until a name is entered, then creates and refreshes', async () => {
    const user = userEvent.setup();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
    const createSpy = vi.spyOn(groupsApi, 'createGroup').mockResolvedValue(sampleGroup);
    renderGroups();
    await screen.findByText('No groups yet. Create your first one above.');

    const button = screen.getByRole('button', { name: 'New group' });
    expect(button).toBeDisabled();

    await user.type(screen.getByPlaceholderText('New group name, e.g. Defense'), '  Defense  ');
    expect(button).not.toBeDisabled();

    vi.mocked(groupsApi.listGroups).mockResolvedValue([sampleGroup]);
    await user.click(button);

    await waitFor(() => expect(createSpy).toHaveBeenCalledWith({ name: 'Defense' }));
  });

  it('asks for confirmation before deleting a group', async () => {
    const user = userEvent.setup();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([sampleGroup]);
    const deleteSpy = vi.spyOn(groupsApi, 'deleteGroup').mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderGroups();
    await screen.findByText('Defense');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('deletes the group once confirmed', async () => {
    const user = userEvent.setup();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([sampleGroup]);
    const deleteSpy = vi.spyOn(groupsApi, 'deleteGroup').mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderGroups();
    await screen.findByText('Defense');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith(7));
  });
});
