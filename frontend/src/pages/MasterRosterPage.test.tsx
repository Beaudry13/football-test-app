import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MasterRosterPage } from './MasterRosterPage';
import * as playersApi from '../api/players';
import { acceptConfirm } from '../test/confirmDialog';
import type { Player } from '../api/types';

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 1,
    organization_id: 1,
    first_name: 'Jordan',
    last_name: 'Lee',
    full_name: 'Jordan Lee',
    jersey_number: '12',
    position: 'WR',
    photo_url: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderPage() {
  render(
    <MemoryRouter>
      <MasterRosterPage />
    </MemoryRouter>,
  );
}

describe('MasterRosterPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and lists active players by default', async () => {
    const listSpy = vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([makePlayer()]);
    renderPage();

    expect(await screen.findByText('Jordan Lee')).toBeInTheDocument();
    expect(screen.getByText('1 Player')).toBeInTheDocument();
    expect(listSpy).toHaveBeenCalledWith({ active: 'true' });
  });

  it('shows an empty state when there are no players yet', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText('No players yet. Add one above, or import a roster.')).toBeInTheDocument();
  });

  it('re-fetches with active=all when "Show inactive" is checked', async () => {
    const listSpy = vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([makePlayer()]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Jordan Lee');
    await user.click(screen.getByLabelText('Show inactive'));

    await waitFor(() => expect(listSpy).toHaveBeenLastCalledWith({ active: 'all' }));
  });

  it('filters the visible list by search text client-side', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([
      makePlayer({ id: 1, full_name: 'Jordan Lee' }),
      makePlayer({ id: 2, full_name: 'Alex Rivera', jersey_number: '5', position: 'RB' }),
    ]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Jordan Lee');
    await user.type(screen.getByLabelText('Search players'), 'Alex');

    expect(screen.getByText('Alex Rivera')).toBeInTheDocument();
    expect(screen.queryByText('Jordan Lee')).not.toBeInTheDocument();
  });

  it('creates a player from the add-player form', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([]);
    const createSpy = vi.spyOn(playersApi, 'createPlayer').mockResolvedValue(makePlayer());
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(/No players yet/);
    await user.type(screen.getByLabelText('New player first name'), 'Jordan');
    await user.type(screen.getByLabelText('New player last name'), 'Lee');
    await user.type(screen.getByLabelText('New player jersey number'), '12');
    await user.type(screen.getByLabelText('New player position'), 'WR');
    await user.click(screen.getByRole('button', { name: 'Add Player' }));

    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith({
        first_name: 'Jordan',
        last_name: 'Lee',
        jersey_number: '12',
        position: 'WR',
      }),
    );
  });

  it('deactivates a player once the confirmation is accepted', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([makePlayer()]);
    const deactivateSpy = vi.spyOn(playersApi, 'deactivatePlayer').mockResolvedValue(
      makePlayer({ is_active: false }),
    );
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Jordan Lee');
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await acceptConfirm(user, 'Deactivate');

    await waitFor(() => expect(deactivateSpy).toHaveBeenCalledWith(1));
  });

  it('reactivates an inactive player without a confirmation prompt', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([makePlayer({ is_active: false })]);
    const reactivateSpy = vi.spyOn(playersApi, 'reactivatePlayer').mockResolvedValue(makePlayer());
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Jordan Lee');
    await user.click(screen.getByRole('button', { name: 'Reactivate' }));

    await waitFor(() => expect(reactivateSpy).toHaveBeenCalledWith(1));
  });

  it('toggles the import panel open and closed', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(/No players yet/);
    expect(screen.queryByText('Import Roster')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Import roster' }));
    expect(screen.getByText('Import Roster')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close import' }));
    expect(screen.queryByText('Import Roster')).not.toBeInTheDocument();
  });
});
