/** "I forgot my PIN": the coach resets it from the player's profile.
 *
 *  Peira cannot look a PIN up - only its hash was ever stored - so the answer
 *  is always a new one, shown once. Creating a first PIN needs no warning;
 *  replacing one does, because the old PIN stops working.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerProfilePage } from './PlayerProfilePage';
import * as playersApi from '../api/players';
import * as groupsApi from '../api/groups';
import type { IssuedPin } from '../api/players';
import type { Player, PlayerHistory, PinStatus } from '../api/types';

const player: Player = {
  id: 1,
  organization_id: 1,
  first_name: 'John',
  last_name: 'Smith',
  full_name: 'John Smith',
  jersey_number: '12',
  position: 'QB',
  photo_url: null,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const history = (pin_status?: PinStatus): PlayerHistory => ({
  player,
  current_groups: [],
  assigned_count: 0,
  completed_count: 0,
  completion_percent: null,
  average_score_percent: null,
  recent_results: [],
  ...(pin_status ? { pin_status } : {}),
});

const ISSUED: IssuedPin = {
  player_id: 1,
  first_name: 'John',
  last_name: 'Smith',
  full_name: 'John Smith',
  jersey_number: '12',
  position: 'QB',
  pin: '739201',
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/roster/1']}>
      <Routes>
        <Route path="/roster/:playerId" element={<PlayerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
});

describe('a player without a PIN', () => {
  it('shows No PIN and creates one without a warning', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(history('missing'));
    const reset = vi
      .spyOn(playersApi, 'resetPlayerPin')
      .mockResolvedValue({ issued: ISSUED, pin_version: 1 });
    renderPage();

    expect(await screen.findByText('No PIN')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create PIN' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('739 201')).toBeInTheDocument();
    expect(reset).toHaveBeenCalledWith(1);
  });
});

describe('a player with a PIN', () => {
  it('warns before replacing it, naming the player', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(history('set'));
    const reset = vi.spyOn(playersApi, 'resetPlayerPin');
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Reset PIN' }));

    const warning = await screen.findByRole('alertdialog');
    expect(warning).toHaveTextContent("John Smith (#12)'s current PIN will stop working");
    expect(warning).toHaveTextContent("Their quizzes and results aren't affected");
    expect(reset).not.toHaveBeenCalled();
  });

  it('cancelling changes nothing', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(history('set'));
    const reset = vi.spyOn(playersApi, 'resetPlayerPin');
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Reset PIN' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(reset).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('confirming issues a new PIN and shows it once', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(history('locked'));
    vi.spyOn(playersApi, 'resetPlayerPin').mockResolvedValue({ issued: ISSUED, pin_version: 3 });
    renderPage();

    expect(await screen.findByText('Locked')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset PIN' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reset PIN' }));

    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('739 201')).toBeInTheDocument();
  });
});

describe('an older payload', () => {
  it('shows no PIN control when the status is unknown', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(history());
    renderPage();

    await screen.findByRole('heading', { name: 'John Smith' });
    expect(screen.queryByRole('button', { name: /PIN/ })).not.toBeInTheDocument();
  });
});
