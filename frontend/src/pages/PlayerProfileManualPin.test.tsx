/** A COACH CHOOSES THE DIGITS. "Set PIN manually" beside "Generate PIN", with
 *  the same warning a reset gives when it replaces one that already works. */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerProfilePage } from './PlayerProfilePage';
import * as playersApi from '../api/players';
import * as groupsApi from '../api/groups';
import { ApiError } from '../api/client';
import { acceptConfirm, cancelConfirm, findConfirmDialog } from '../test/confirmDialog';
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

const history = (pin_status: PinStatus): PlayerHistory => ({
  player,
  current_groups: [],
  assigned_count: 0,
  completed_count: 0,
  completion_percent: null,
  average_score_percent: null,
  recent_results: [],
  pin_status,
});

const ISSUED: IssuedPin = {
  player_id: 1,
  first_name: 'John',
  last_name: 'Smith',
  full_name: 'John Smith',
  jersey_number: '12',
  position: 'QB',
  pin: '482915',
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

async function openManualBox(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Set PIN manually' }));
  return screen.getByLabelText('New 6-digit PIN');
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
});

describe('setting a PIN by hand', () => {
  it('sets a first PIN with no warning, and shows it once', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(history('missing'));
    const set = vi.spyOn(playersApi, 'setPlayerPin').mockResolvedValue({ issued: ISSUED, pin_version: 1 });
    renderPage();

    await user.type(await openManualBox(user), '482915');
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));

    await waitFor(() => expect(set).toHaveBeenCalledWith(1, '482915'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    // The one-time sheet, and nothing kept on this device.
    expect(await screen.findByText('482 915')).toBeInTheDocument();
    expect(JSON.stringify({ ...localStorage })).not.toContain('482915');
  });

  it('takes digits only, and will not send fewer than six', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(history('missing'));
    renderPage();
    const box = await openManualBox(user);

    await user.type(box, '4a8-2 9');

    expect(box).toHaveValue('4829');
    expect(screen.getByRole('button', { name: 'Save PIN' })).toBeDisabled();

    await user.type(box, '15999');
    expect(box).toHaveValue('482915'); // six, and no more
    expect(screen.getByRole('button', { name: 'Save PIN' })).toBeEnabled();
  });

  it('warns before replacing a PIN that already works, and says what survives', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(history('set'));
    const set = vi.spyOn(playersApi, 'setPlayerPin').mockResolvedValue({ issued: ISSUED, pin_version: 2 });
    renderPage();

    await user.type(await openManualBox(user), '482915');
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));

    const dialog = await findConfirmDialog();
    expect(dialog).toHaveTextContent(
      "Changing this PIN will sign John Smith (#12) out on any device they're using.",
    );
    expect(dialog).toHaveTextContent('Their quiz attempts and results will not be deleted.');
    await acceptConfirm(user, 'Change PIN');

    await waitFor(() => expect(set).toHaveBeenCalledWith(1, '482915'));
  });

  it('cancelling the warning changes nothing', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(history('set'));
    const set = vi.spyOn(playersApi, 'setPlayerPin');
    renderPage();

    await user.type(await openManualBox(user), '482915');
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));
    await cancelConfirm(user);

    expect(set).not.toHaveBeenCalled();
  });

  it("shows the server's refusal when the PIN is too guessable", async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(history('missing'));
    vi.spyOn(playersApi, 'setPlayerPin').mockRejectedValue(
      new ApiError(
        'Pick a different 6-digit PIN - not all one digit, a run like 123456, or a repeated pair.',
        422,
        undefined,
        'weak_pin',
      ),
    );
    renderPage();

    await user.type(await openManualBox(user), '123456');
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));

    expect(await screen.findByText(/Pick a different 6-digit PIN/)).toBeInTheDocument();
  });

  it('keeps the generated option alongside it', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(history('missing'));
    renderPage();

    expect(await screen.findByRole('button', { name: 'Generate PIN' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set PIN manually' })).toBeInTheDocument();
  });
});
