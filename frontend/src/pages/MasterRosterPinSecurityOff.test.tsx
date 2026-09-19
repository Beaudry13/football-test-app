/** PINS ARE OPTIONAL, AND AN ORGANIZATION THAT HAS NOT CHOSEN THEM IS NOT
 *  NAGGED.
 *
 *  Player PIN Security is each organization's own setting, off by default. Until
 *  it is on, Team → Players must look like it did before PINs existed: no PIN
 *  column, no "players don't have a PIN yet" count, no "Generate missing PINs",
 *  nothing that reads as unfinished setup. The ON state is covered in
 *  MasterRosterPagePins.test.tsx.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MasterRosterPage } from './MasterRosterPage';
import * as playersApi from '../api/players';
import * as orgApi from '../api/organizations';
import type { Organization, Player } from '../api/types';

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

const organization = (enabled: boolean): Organization => ({
  id: 1,
  name: 'Wildcats',
  player_pin_security_enabled: enabled,
  players_without_pins: enabled ? 2 : 2,
  members: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

// Two players who have no PIN - the exact state that used to shout at a staff
// who had never asked for PINs.
const ROSTER = [
  makePlayer({ pin_status: 'missing' }),
  makePlayer({ id: 2, first_name: 'Alex', last_name: 'Reed', full_name: 'Alex Reed', pin_status: 'missing' }),
];

function renderPage() {
  render(
    <MemoryRouter>
      <MasterRosterPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(playersApi, 'listPlayers').mockResolvedValue(ROSTER);
});

describe('Team → Players with Player PIN Security OFF', () => {
  beforeEach(() => {
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(organization(false));
  });

  it('says nothing about PINs at all', async () => {
    renderPage();

    expect(await screen.findByText('Jordan Lee')).toBeInTheDocument();
    expect(screen.queryByText(/have a PIN yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate missing PINs/ })).not.toBeInTheDocument();
    expect(screen.queryByText('No PIN')).not.toBeInTheDocument();
    expect(screen.queryByText('PIN set')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'PIN' })).not.toBeInTheDocument();
    // No wording anywhere implying setup is owed.
    expect(document.body.textContent).not.toMatch(/PIN/);
  });

  it('is still the ordinary roster: players, status and their actions', async () => {
    renderPage();

    expect(await screen.findByText('Jordan Lee')).toBeInTheDocument();
    expect(screen.getByText('Alex Reed')).toBeInTheDocument();
    expect(screen.getAllByText('Active')).toHaveLength(2);
    expect(screen.getByPlaceholderText('Search players…')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Deactivate/ })).toHaveLength(2);
  });

  it('adding a player creates no credential and shows no PIN sheet', async () => {
    const user = userEvent.setup();
    const created = makePlayer({ id: 3, first_name: 'Sam', last_name: 'Cole', full_name: 'Sam Cole' });
    vi.spyOn(playersApi, 'createPlayer').mockResolvedValue(created);
    const reset = vi.spyOn(playersApi, 'resetPlayerPin');

    renderPage();
    await screen.findByText('Jordan Lee');
    await user.type(screen.getByPlaceholderText('First name'), 'Sam');
    await user.type(screen.getByPlaceholderText('Last name'), 'Cole');
    await user.click(screen.getByRole('button', { name: 'Add Player' }));

    await waitFor(() => expect(playersApi.createPlayer).toHaveBeenCalled());
    expect(reset).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Team → Players with Player PIN Security ON', () => {
  beforeEach(() => {
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(organization(true));
  });

  it('brings the PIN column, the count and the bulk action back', async () => {
    renderPage();

    expect(await screen.findByText(/2 active players don't have a PIN yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate missing PINs' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'PIN' })).toBeInTheDocument();
    expect(screen.getAllByText('No PIN')).toHaveLength(2);
  });

  it('a new player still gets their first PIN, shown once', async () => {
    const user = userEvent.setup();
    const created = makePlayer({ id: 3, first_name: 'Sam', last_name: 'Cole', full_name: 'Sam Cole' });
    vi.spyOn(playersApi, 'createPlayer').mockResolvedValue(created);
    vi.spyOn(playersApi, 'resetPlayerPin').mockResolvedValue({
      issued: {
        player_id: created.id,
        first_name: created.first_name,
        last_name: created.last_name,
        full_name: created.full_name,
        jersey_number: created.jersey_number,
        position: created.position,
        pin: '482915',
      },
      pin_version: 1,
    });

    renderPage();
    await screen.findByText('Jordan Lee');
    await user.type(screen.getByPlaceholderText('First name'), 'Sam');
    await user.type(screen.getByPlaceholderText('Last name'), 'Cole');
    await user.click(screen.getByRole('button', { name: 'Add Player' }));

    await waitFor(() => expect(playersApi.resetPlayerPin).toHaveBeenCalledWith(3));
    expect(await screen.findByText('482 915')).toBeInTheDocument();
  });

  it('the count follows ACTIVE players only', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([
      ROSTER[0],
      makePlayer({ id: 9, first_name: 'Gone', last_name: 'Now', full_name: 'Gone Now', is_active: false, pin_status: 'missing' }),
    ]);

    renderPage();

    expect(await screen.findByText(/1 active player doesn't have a PIN yet/)).toBeInTheDocument();
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(3); // header + two players
  });
});
