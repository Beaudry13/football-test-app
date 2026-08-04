import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerPickerPanel } from './PlayerPickerPanel';
import * as playersApi from '../api/players';
import type { Player, RosterPlayer } from '../api/types';

function canonicalPlayer(overrides: Partial<Player> = {}): Player {
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

function member(player: Player, id = 1): RosterPlayer {
  return { id, player_name: player.full_name, position: 0, player };
}

describe('PlayerPickerPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and displays current canonical members', async () => {
    const jordan = canonicalPlayer();
    const load = vi.fn().mockResolvedValue({ players: [member(jordan)] });
    render(<PlayerPickerPanel load={load} onAdd={vi.fn()} onRemove={vi.fn()} />);

    expect(await screen.findByText('Jordan Lee (#12 · WR)')).toBeInTheDocument();
    expect(screen.getByText('Master Roster players (1)')).toBeInTheDocument();
  });

  it('excludes legacy (player_id-less) rows from the canonical member count', async () => {
    const legacyRow: RosterPlayer = { id: 9, player_name: 'Legacy Name', position: 0 };
    const load = vi.fn().mockResolvedValue({ players: [legacyRow] });
    render(<PlayerPickerPanel load={load} onAdd={vi.fn()} onRemove={vi.fn()} />);

    expect(await screen.findByText('Master Roster players (0)')).toBeInTheDocument();
    expect(screen.queryByText('Legacy Name')).not.toBeInTheDocument();
  });

  it('searches the master roster and adds a selected player', async () => {
    const user = userEvent.setup();
    const jordan = canonicalPlayer();
    const load = vi.fn().mockResolvedValue({ players: [] });
    const searchSpy = vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([jordan]);
    const onAdd = vi.fn().mockResolvedValue({ players: [member(jordan)] });
    render(<PlayerPickerPanel load={load} onAdd={onAdd} onRemove={vi.fn()} />);

    await screen.findByText('Master Roster players (0)');
    await user.type(screen.getByLabelText('Search master roster'), 'Jordan');

    await waitFor(() => expect(searchSpy).toHaveBeenCalledWith({ q: 'Jordan' }));
    await user.click(await screen.findByRole('button', { name: 'Add' }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(jordan.id));
    expect(await screen.findByText('Master Roster players (1)')).toBeInTheDocument();
    expect((screen.getByLabelText('Search master roster') as HTMLInputElement).value).toBe('');
  });

  it('excludes players already on the list from search results', async () => {
    const user = userEvent.setup();
    const jordan = canonicalPlayer({ id: 1, full_name: 'Jordan Lee' });
    const alex = canonicalPlayer({ id: 2, full_name: 'Alex Rivera', jersey_number: '5', position: 'RB' });
    const load = vi.fn().mockResolvedValue({ players: [member(jordan, 1)] });
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([jordan, alex]);
    render(<PlayerPickerPanel load={load} onAdd={vi.fn()} onRemove={vi.fn()} />);

    await screen.findByText('Master Roster players (1)');
    await user.type(screen.getByLabelText('Search master roster'), 'e');

    expect(await screen.findByText('Alex Rivera (#5 · RB)')).toBeInTheDocument();
    // Jordan is already a member (shown once, above) - not duplicated as a
    // second, addable search result.
    expect(screen.getAllByText('Jordan Lee (#12 · WR)')).toHaveLength(1);
  });

  it('shows a no-matches message when every search hit is already a member', async () => {
    const user = userEvent.setup();
    const jordan = canonicalPlayer();
    const load = vi.fn().mockResolvedValue({ players: [member(jordan)] });
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([jordan]);
    render(<PlayerPickerPanel load={load} onAdd={vi.fn()} onRemove={vi.fn()} />);

    await screen.findByText('Master Roster players (1)');
    await user.type(screen.getByLabelText('Search master roster'), 'Jordan');

    expect(await screen.findByText('No matching active players left to add.')).toBeInTheDocument();
  });

  it('removes a member and drops them from the list without a full reload', async () => {
    const user = userEvent.setup();
    const jordan = canonicalPlayer();
    const load = vi.fn().mockResolvedValue({ players: [member(jordan)] });
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(<PlayerPickerPanel load={load} onAdd={vi.fn()} onRemove={onRemove} />);

    await screen.findByText('Jordan Lee (#12 · WR)');
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith(jordan.id));
    await waitFor(() => expect(screen.queryByText('Jordan Lee (#12 · WR)')).not.toBeInTheDocument());
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shows an error banner when add fails, without clearing the search', async () => {
    const user = userEvent.setup();
    const jordan = canonicalPlayer();
    const load = vi.fn().mockResolvedValue({ players: [] });
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue([jordan]);
    const onAdd = vi.fn().mockRejectedValue(new Error('Player is not on this quiz'));
    render(<PlayerPickerPanel load={load} onAdd={onAdd} onRemove={vi.fn()} />);

    await screen.findByText('Master Roster players (0)');
    await user.type(screen.getByLabelText('Search master roster'), 'Jordan');
    await user.click(await screen.findByRole('button', { name: 'Add' }));

    expect(await screen.findByText('Player is not on this quiz')).toBeInTheDocument();
  });
});
