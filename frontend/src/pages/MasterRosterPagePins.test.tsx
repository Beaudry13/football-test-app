/** Team → Players: PIN status, "Generate missing PINs", and a new player's
 *  first PIN.
 *
 *  The rule these hold the page to: a coach sees WHETHER a player has a PIN,
 *  never the PIN, except on the one-time sheet right after issuing it - and
 *  every PIN that was issued is shown, even if a later batch failed.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MasterRosterPage } from './MasterRosterPage';
import * as playersApi from '../api/players';
import type { IssuedPin } from '../api/players';
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

const issued = (player: Player, pin: string): IssuedPin => ({
  player_id: player.id,
  first_name: player.first_name,
  last_name: player.last_name,
  full_name: player.full_name,
  jersey_number: player.jersey_number,
  position: player.position,
  pin,
});

function renderPage() {
  render(
    <MemoryRouter>
      <MasterRosterPage />
    </MemoryRouter>,
  );
}

const ALEX = makePlayer({ id: 2, first_name: 'Alex', last_name: 'Reed', full_name: 'Alex Reed', pin_status: 'missing' });
const SAM = makePlayer({ id: 3, first_name: 'Sam', last_name: 'Cole', full_name: 'Sam Cole', pin_status: 'missing' });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('PIN status on the roster', () => {
  it('shows status, never a PIN', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([
      makePlayer({ id: 1, pin_status: 'set' }),
      ALEX,
      makePlayer({ id: 4, first_name: 'Kim', last_name: 'Park', full_name: 'Kim Park', pin_status: 'locked' }),
    ]);
    renderPage();

    const row = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;
    expect(within(await row('Jordan Lee')).getByText('PIN set')).toBeInTheDocument();
    expect(within(await row('Alex Reed')).getByText('No PIN')).toBeInTheDocument();
    expect(within(await row('Kim Park')).getByText('Locked')).toBeInTheDocument();
  });

  it('counts only ACTIVE players without a PIN', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([
      ALEX,
      SAM,
      makePlayer({ id: 9, full_name: 'Gone Player', is_active: false, pin_status: 'missing' }),
      makePlayer({ id: 1, pin_status: 'set' }),
    ]);
    renderPage();

    // By its text, not role="status": the page's loading spinner carries that
    // role too, and would be found first.
    expect(await screen.findByText("2 active players don't have a PIN yet.")).toBeInTheDocument();
  });

  it('shows no banner once everyone has a PIN', async () => {
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([makePlayer({ pin_status: 'set' })]);
    renderPage();

    await screen.findByText('Jordan Lee');
    expect(screen.queryByRole('button', { name: 'Generate missing PINs' })).not.toBeInTheDocument();
  });
});

describe('Generate missing PINs', () => {
  it('keeps asking until none remain, then shows every PIN once', async () => {
    const user = userEvent.setup();
    const list = vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([ALEX, SAM]);
    const generate = vi
      .spyOn(playersApi, 'generateMissingPins')
      .mockResolvedValueOnce({ issued: [issued(ALEX, '103948')], remaining: 1 })
      .mockResolvedValueOnce({ issued: [issued(SAM, '572031')], remaining: 0 });
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Generate missing PINs' }));

    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('103 948')).toBeInTheDocument();
    expect(within(sheet).getByText('572 031')).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(2);
    // The roster is re-read so the badges change from "No PIN".
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('still shows the PINs that WERE issued when a later batch fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([ALEX, SAM]);
    vi.spyOn(playersApi, 'generateMissingPins')
      .mockResolvedValueOnce({ issued: [issued(ALEX, '103948')], remaining: 1 })
      .mockRejectedValueOnce(new Error('Network down.'));
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Generate missing PINs' }));

    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('103 948')).toBeInTheDocument();
    expect(screen.getByText(/try again for the rest/i)).toBeInTheDocument();
  });
});

describe('adding a player', () => {
  it('gives the new player a PIN and shows it once', async () => {
    const user = userEvent.setup();
    const created = makePlayer({ id: 7, first_name: 'Nia', last_name: 'Ford', full_name: 'Nia Ford', jersey_number: '8', position: 'S' });
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([]);
    vi.spyOn(playersApi, 'createPlayer').mockResolvedValue(created);
    const reset = vi
      .spyOn(playersApi, 'resetPlayerPin')
      .mockResolvedValue({ issued: issued(created, '630284'), pin_version: 1 });
    renderPage();

    await user.type(await screen.findByLabelText('New player first name'), 'Nia');
    await user.type(screen.getByLabelText('New player last name'), 'Ford');
    await user.click(screen.getByRole('button', { name: 'Add Player' }));

    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'PIN for Nia Ford' })).toBeInTheDocument();
    expect(within(sheet).getByText('630 284')).toBeInTheDocument();
    expect(reset).toHaveBeenCalledWith(7);
  });

  it('keeps the player and says what to do if their PIN could not be made', async () => {
    const user = userEvent.setup();
    const created = makePlayer({ id: 7, full_name: 'Nia Ford' });
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([]);
    vi.spyOn(playersApi, 'createPlayer').mockResolvedValue(created);
    vi.spyOn(playersApi, 'resetPlayerPin').mockRejectedValue(new Error('Server busy.'));
    renderPage();

    await user.type(await screen.findByLabelText('New player first name'), 'Nia');
    await user.click(screen.getByRole('button', { name: 'Add Player' }));

    expect(await screen.findByText(/Player added, but their PIN couldn't be created/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
