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

  it('shows a photo thumbnail for a player with one, and initials for a player without', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([
      makePlayer({ id: 1, photo_url: '/uploads/jordan.jpg' }),
      makePlayer({ id: 2, first_name: 'Alex', last_name: 'Rivera', full_name: 'Alex Rivera', photo_url: null }),
    ]);
    const { container } = render(
      <MemoryRouter>
        <MasterRosterPage />
      </MemoryRouter>,
    );

    await screen.findByText('Jordan Lee');
    const rows = container.querySelectorAll('tbody tr');
    expect(rows[0].querySelector('img')).not.toBeNull();
    expect(rows[1].querySelector('img')).toBeNull();
    expect(rows[1]).toHaveTextContent('AR');
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
    await user.click(screen.getByRole('button', { name: 'Deactivate Jordan Lee' }));
    await acceptConfirm(user, 'Deactivate');

    await waitFor(() => expect(deactivateSpy).toHaveBeenCalledWith(1));
  });

  it('reactivates an inactive player without a confirmation prompt', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([makePlayer({ is_active: false })]);
    const reactivateSpy = vi.spyOn(playersApi, 'reactivatePlayer').mockResolvedValue(makePlayer());
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Jordan Lee');
    await user.click(screen.getByRole('button', { name: 'Reactivate Jordan Lee' }));

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

describe('MasterRosterPage performance report', () => {
  const jordan = makePlayer({ id: 1, first_name: 'Jordan', last_name: 'Lee', full_name: 'Jordan Lee' });
  const marcus = makePlayer({ id: 2, first_name: 'Marcus', last_name: 'Hill', full_name: 'Marcus Hill', jersey_number: '5' });

  beforeEach(() => {
    vi.restoreAllMocks();
    // downloadBlob reaches for URL.createObjectURL, which jsdom does not have.
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true });
  });

  async function renderWithPlayers() {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([jordan, marcus]);
    renderPage();
    await screen.findByText('Jordan Lee');
    return userEvent.setup();
  }

  it('disables the report button until a player is selected', async () => {
    await renderWithPlayers();

    expect(screen.getByRole('button', { name: 'Generate Performance Report' })).toBeDisabled();
    expect(screen.getByText('No players selected')).toBeInTheDocument();
  });

  it('counts the selection as it changes', async () => {
    const user = await renderWithPlayers();

    await user.click(screen.getByRole('checkbox', { name: 'Select Jordan Lee' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select Marcus Hill' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate Performance Report' })).toBeEnabled();
  });

  it('generates a report for one selected player', async () => {
    const download = vi
      .spyOn(playersApi, 'downloadPerformanceReport')
      .mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }));
    const user = await renderWithPlayers();

    await user.click(screen.getByRole('checkbox', { name: 'Select Jordan Lee' }));
    await user.click(screen.getByRole('button', { name: 'Generate Performance Report' }));

    await waitFor(() => expect(download).toHaveBeenCalledWith([1]));
  });

  it('generates one report for several selected players', async () => {
    // One request, one PDF - not one download per player.
    const download = vi
      .spyOn(playersApi, 'downloadPerformanceReport')
      .mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }));
    const user = await renderWithPlayers();

    await user.click(screen.getByRole('checkbox', { name: 'Select Jordan Lee' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Marcus Hill' }));
    await user.click(screen.getByRole('button', { name: 'Generate Performance Report' }));

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(download).toHaveBeenCalledWith([1, 2]);
  });

  it('selects and clears every visible player', async () => {
    const user = await renderWithPlayers();

    await user.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByText('No players selected')).toBeInTheDocument();
  });

  it('select all covers only what the search has left on screen', async () => {
    // Selecting rows hidden behind a filter would put players in the report
    // that the coach never saw.
    const user = await renderWithPlayers();
    await user.type(screen.getByPlaceholderText(/search/i), 'Marcus');
    await waitFor(() => expect(screen.queryByText('Jordan Lee')).not.toBeInTheDocument());

    await user.click(screen.getByRole('checkbox', { name: 'Select all shown' }));

    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('surfaces a failure instead of silently doing nothing', async () => {
    vi.spyOn(playersApi, 'downloadPerformanceReport').mockRejectedValue(new Error('nope'));
    const user = await renderWithPlayers();

    await user.click(screen.getByRole('checkbox', { name: 'Select Jordan Lee' }));
    await user.click(screen.getByRole('button', { name: 'Generate Performance Report' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('offers no selection bar when the roster is empty', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([]);
    renderPage();
    await screen.findByText(/No players yet/);

    expect(
      screen.queryByRole('button', { name: 'Generate Performance Report' }),
    ).not.toBeInTheDocument();
  });
});

describe('MasterRosterPage selection scope', () => {
  const jordan = makePlayer({ id: 1, full_name: 'Jordan Lee' });
  const marcus = makePlayer({ id: 2, first_name: 'Marcus', last_name: 'Hill', full_name: 'Marcus Hill' });

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true });
  });

  it('drops a player from the selection once they leave the list', async () => {
    // Deactivating a selected player used to leave them selected but
    // invisible: the count reported somebody the coach could not see, and
    // the report quietly included them.
    const list = vi
      .spyOn(playersApi, 'listPlayers')
      .mockResolvedValueOnce([jordan, marcus])
      .mockResolvedValue([jordan]);
    vi.spyOn(playersApi, 'deactivatePlayer').mockResolvedValue({ ...marcus, is_active: false });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Marcus Hill');

    await user.click(screen.getByRole('checkbox', { name: 'Select Marcus Hill' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Deactivate Marcus Hill' }));
    await acceptConfirm(user, 'Deactivate');

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('No players selected')).toBeInTheDocument());
  });

  it('keeps a selection that is still on screen', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([jordan, marcus]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Jordan Lee');

    await user.click(screen.getByRole('checkbox', { name: 'Select Jordan Lee' }));

    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
})
