import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RosterSelectPanel } from './RosterSelectPanel';
import * as playersApi from '../api/players';
import type { Player, RosterPlayer } from '../api/types';

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

function member(player: Player, id = player.id): RosterPlayer {
  return { id, player_name: player.full_name, position: 0, player };
}

const rosterFixture: Player[] = [
  makePlayer({ id: 1, first_name: 'John', last_name: 'Smith', full_name: 'John Smith', jersey_number: '2', position: 'S' }),
  makePlayer({ id: 2, first_name: 'Marcus', last_name: 'Brown', full_name: 'Marcus Brown', jersey_number: '7', position: 'CB' }),
  makePlayer({ id: 3, first_name: 'Chris', last_name: 'Jones', full_name: 'Chris Jones', jersey_number: '14', position: 'LB' }),
];

function renderPanel(members: RosterPlayer[] = []) {
  const onAddMany = vi.fn<(playerIds: number[]) => Promise<void>>().mockResolvedValue(undefined);
  const onRemove = vi.fn<(playerId: number) => Promise<void>>().mockResolvedValue(undefined);
  render(<RosterSelectPanel members={members} onAddMany={onAddMany} onRemove={onRemove} />);
  return { onAddMany, onRemove };
}

describe('RosterSelectPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue(rosterFixture);
  });

  it('loads and displays the full active roster by default', async () => {
    renderPanel();

    expect(await screen.findByText('Marcus Brown')).toBeInTheDocument();
    expect(screen.getByText('John Smith')).toBeInTheDocument();
    expect(screen.getByText('Chris Jones')).toBeInTheDocument();
    expect(playersApi.listPlayers).toHaveBeenCalledWith({ active: 'true' });
  });

  it('sorts by jersey number, then last name, then first name', async () => {
    renderPanel();
    await screen.findByText('John Smith');

    const rows = screen.getAllByRole('row').slice(1); // drop header row
    const names = rows.map((r) => within(r).getByText(/Smith|Brown|Jones/).textContent);
    expect(names).toEqual(['John Smith', 'Marcus Brown', 'Chris Jones']); // jersey 2, 7, 14
  });

  it('searches by name', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('John Smith');

    await user.type(screen.getByLabelText('Search Players'), 'marcus');

    expect(screen.getByText('Marcus Brown')).toBeInTheDocument();
    expect(screen.queryByText('John Smith')).not.toBeInTheDocument();
    expect(screen.queryByText('Chris Jones')).not.toBeInTheDocument();
  });

  it('filters by position', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('John Smith');

    await user.selectOptions(screen.getByLabelText('Position filter'), 'LB');

    expect(screen.getByText('Chris Jones')).toBeInTheDocument();
    expect(screen.queryByText('John Smith')).not.toBeInTheDocument();
  });

  it('the "Already In Group" view filter shows only members', async () => {
    const user = userEvent.setup();
    renderPanel([member(rosterFixture[1])]);
    await screen.findByText('John Smith');

    await user.click(screen.getByRole('button', { name: 'Already In Group' }));

    expect(screen.getByText('Marcus Brown')).toBeInTheDocument();
    expect(screen.queryByText('John Smith')).not.toBeInTheDocument();
    expect(screen.queryByText('Chris Jones')).not.toBeInTheDocument();
  });

  it('the "Not In Group" view filter excludes members', async () => {
    const user = userEvent.setup();
    renderPanel([member(rosterFixture[1])]);
    await screen.findByText('John Smith');

    await user.click(screen.getByRole('button', { name: 'Not In Group' }));

    expect(screen.queryByText('Marcus Brown')).not.toBeInTheDocument();
    expect(screen.getByText('John Smith')).toBeInTheDocument();
    expect(screen.getByText('Chris Jones')).toBeInTheDocument();
  });

  it('supports multi-select and tracks the selected count', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('John Smith');

    await user.click(screen.getByLabelText('Select John Smith'));
    await user.click(screen.getByLabelText('Select Chris Jones'));

    expect(screen.getByTestId('stat-selected')).toHaveTextContent('Selected: 2 Players');
  });

  it('Add Selected Players calls onAddMany with every selected id', async () => {
    const user = userEvent.setup();
    const { onAddMany } = renderPanel();
    await screen.findByText('John Smith');

    await user.click(screen.getByLabelText('Select John Smith'));
    await user.click(screen.getByLabelText('Select Chris Jones'));
    await user.click(screen.getByRole('button', { name: 'Add Selected Players' }));

    await waitFor(() => expect(onAddMany).toHaveBeenCalledWith([1, 3]));
  });

  it('clears the selection after a successful add', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('John Smith');

    await user.click(screen.getByLabelText('Select John Smith'));
    await user.click(screen.getByRole('button', { name: 'Add Selected Players' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Selected Players' })).toBeDisabled());
  });

  it('disables the checkbox for a player already in the Group, preventing duplicate selection', async () => {
    renderPanel([member(rosterFixture[1])]);
    await screen.findByText('John Smith');

    const marcusCheckbox = screen.getByLabelText('Select Marcus Brown') as HTMLInputElement;
    expect(marcusCheckbox.checked).toBe(true);
    expect(marcusCheckbox).toBeDisabled();
    expect(screen.getByText('Already in Group')).toBeInTheDocument();
  });

  it('Select All Visible only selects addable players matching the current filters', async () => {
    const user = userEvent.setup();
    renderPanel([member(rosterFixture[1])]); // Marcus already in group
    await screen.findByText('John Smith');

    await user.click(screen.getByRole('button', { name: 'Select All Visible' }));

    // 3 players visible, 1 already a member (not addable) -> 2 selected
    expect(screen.getByTestId('stat-selected')).toHaveTextContent('Selected: 2 Players');
  });

  it('Select All Visible respects an active search/filter', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('John Smith');

    await user.selectOptions(screen.getByLabelText('Position filter'), 'CB');
    await user.click(screen.getByRole('button', { name: 'Select All Visible' }));

    expect(screen.getByTestId('stat-selected')).toHaveTextContent('Selected: 1 Player');
  });

  it('Clear Selection empties the current selection', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('John Smith');

    await user.click(screen.getByRole('button', { name: 'Select All Visible' }));
    await user.click(screen.getByRole('button', { name: 'Clear Selection' }));

    expect(screen.getByRole('button', { name: 'Add Selected Players' })).toBeDisabled();
  });

  it('removing a player calls onRemove without touching Master Roster data', async () => {
    const user = userEvent.setup();
    const { onRemove } = renderPanel([member(rosterFixture[1])]);
    await screen.findByText('Marcus Brown');

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith(2));
  });

  it('shows accurate roster summary counts', async () => {
    renderPanel([member(rosterFixture[0]), member(rosterFixture[1])]);
    await screen.findByText('John Smith');

    expect(screen.getByTestId('stat-master-roster')).toHaveTextContent('Master Roster: 3 Players');
    expect(screen.getByTestId('stat-in-group')).toHaveTextContent('In This Group: 2');
    expect(screen.getByTestId('stat-available')).toHaveTextContent('Available: 1');
  });

  it('handles a large roster (75+ players) without error', async () => {
    const largeRoster = Array.from({ length: 80 }, (_, i) =>
      makePlayer({
        id: i + 1,
        first_name: `Player${i}`,
        last_name: `Lastname${i}`,
        full_name: `Player${i} Lastname${i}`,
        jersey_number: String(i),
        position: 'WR',
      }),
    );
    vi.spyOn(playersApi, 'listPlayers').mockResolvedValue(largeRoster);
    renderPanel();

    expect(await screen.findByText('Player0 Lastname0')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(81); // 80 players + header row
  });

  it('shows an empty state when nothing matches the current search and filters', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('John Smith');

    await user.type(screen.getByLabelText('Search Players'), 'nobody-matches-this');

    expect(await screen.findByText('No players match your search and filters.')).toBeInTheDocument();
  });
});
