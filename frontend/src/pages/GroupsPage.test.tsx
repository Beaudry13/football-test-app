import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupsPage } from './GroupsPage';
import * as groupsApi from '../api/groups';
import { acceptConfirm, cancelConfirm } from '../test/confirmDialog';
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

  it('disables New group until a name is entered, then creates and jumps straight into it', async () => {
    const user = userEvent.setup();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
    const createSpy = vi.spyOn(groupsApi, 'createGroup').mockResolvedValue(sampleGroup);
    render(
      <MemoryRouter initialEntries={['/groups']}>
        <Routes>
          <Route path="/groups" element={<GroupsPage />} />
          <Route path="/groups/:groupId" element={<div>Group detail page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('No groups yet. Create your first one above.');

    const button = screen.getByRole('button', { name: 'New group' });
    expect(button).toBeDisabled();

    await user.type(screen.getByPlaceholderText('New group name, e.g. Defense'), '  Defense  ');
    expect(button).not.toBeDisabled();

    await user.click(button);

    await waitFor(() => expect(createSpy).toHaveBeenCalledWith({ name: 'Defense' }));
    // A new group's very next step is adding players - land there directly
    // instead of leaving the coach to find and click the new card in the list.
    expect(await screen.findByText('Group detail page')).toBeInTheDocument();
  });

  it('asks for confirmation before deleting a group', async () => {
    const user = userEvent.setup();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([sampleGroup]);
    const deleteSpy = vi.spyOn(groupsApi, 'deleteGroup').mockResolvedValue(undefined);
    renderGroups();
    await screen.findByText('Defense');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Delete Group?');
    await cancelConfirm(user);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('deletes the group once confirmed', async () => {
    const user = userEvent.setup();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([sampleGroup]);
    const deleteSpy = vi.spyOn(groupsApi, 'deleteGroup').mockResolvedValue(undefined);
    renderGroups();
    await screen.findByText('Defense');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await acceptConfirm(user, 'Delete Group');

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith(7));
  });
});
