import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerListEditor } from './PlayerListEditor';
import type { RosterPlayer } from '../api/types';

function players(names: string[]): RosterPlayer[] {
  return names.map((player_name, i) => ({ id: i + 1, player_name, position: i }));
}

/** The textarea holds the same names as the list, so a bare text query can
 * match twice - scope list assertions to the rendered <li>s. */
async function findInList(name: string) {
  return (await screen.findAllByRole('listitem')).find((li) => li.textContent === name);
}

describe('PlayerListEditor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and displays the current list', async () => {
    const load = vi.fn().mockResolvedValue({ players: players(['Jordan Smith', 'Alex Lee']) });
    render(
      <PlayerListEditor load={load} onSave={vi.fn()} onUploadCsv={vi.fn()} currentListTitle="Current members" />,
    );

    expect(await screen.findByText('Jordan Smith')).toBeInTheDocument();
    expect(screen.getByText('Alex Lee')).toBeInTheDocument();
    expect(screen.getByText('Current members (2)')).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    const load = vi.fn().mockRejectedValue(new Error('Could not reach the server.'));
    render(<PlayerListEditor load={load} onSave={vi.fn()} onUploadCsv={vi.fn()} />);

    expect(await screen.findByText('Could not reach the server.')).toBeInTheDocument();
  });

  it('saves the edited textarea contents, one name per line', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockResolvedValue({ players: players(['Jordan Smith']) });
    const onSave = vi.fn().mockResolvedValue({ players: players(['Jordan Smith', 'Sam Rivera']) });
    render(<PlayerListEditor load={load} onSave={onSave} onUploadCsv={vi.fn()} saveButtonLabel="Save members" />);

    await findInList('Jordan Smith');
    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Jordan Smith\nSam Rivera');
    await user.click(screen.getByRole('button', { name: 'Save members' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['Jordan Smith', 'Sam Rivera']));
    expect(await findInList('Sam Rivera')).toBeDefined();
  });

  it('shows an error and does not save when the textarea is emptied', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockResolvedValue({ players: players(['Jordan Smith']) });
    const onSave = vi.fn();
    render(<PlayerListEditor load={load} onSave={onSave} onUploadCsv={vi.fn()} />);

    await findInList('Jordan Smith');
    await user.clear(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Save roster' }));

    expect(await screen.findByText('Add at least one player name.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('confirms before a save that would remove players, and skips the save if cancelled', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockResolvedValue({ players: players(['Jordan Smith', 'Alex Lee']) });
    const onSave = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<PlayerListEditor load={load} onSave={onSave} onUploadCsv={vi.fn()} />);

    await findInList('Jordan Smith');
    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Jordan Smith');
    await user.click(screen.getByRole('button', { name: 'Save roster' }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Alex Lee'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves a removal once the confirmation is accepted', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockResolvedValue({ players: players(['Jordan Smith', 'Alex Lee']) });
    const onSave = vi.fn().mockResolvedValue({ players: players(['Jordan Smith']) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PlayerListEditor load={load} onSave={onSave} onUploadCsv={vi.fn()} />);

    await findInList('Jordan Smith');
    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Jordan Smith');
    await user.click(screen.getByRole('button', { name: 'Save roster' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['Jordan Smith']));
  });

  it('does not prompt for confirmation when the save only adds players', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockResolvedValue({ players: players(['Jordan Smith']) });
    const onSave = vi.fn().mockResolvedValue({ players: players(['Jordan Smith', 'Sam Rivera']) });
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<PlayerListEditor load={load} onSave={onSave} onUploadCsv={vi.fn()} />);

    await findInList('Jordan Smith');
    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Jordan Smith\nSam Rivera');
    await user.click(screen.getByRole('button', { name: 'Save roster' }));

    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['Jordan Smith', 'Sam Rivera']));
  });

  it('shows a search box only once the roster is big enough to need one', async () => {
    const load = vi.fn().mockResolvedValue({ players: players(['Jordan Smith', 'Alex Lee']) });
    render(<PlayerListEditor load={load} onSave={vi.fn()} onUploadCsv={vi.fn()} />);

    await findInList('Jordan Smith');
    expect(screen.queryByLabelText('Search players')).not.toBeInTheDocument();
  });

  it('filters the current-members list by search text on a large roster', async () => {
    const user = userEvent.setup();
    const bigRoster = players([
      'Jordan Smith', 'Alex Lee', 'Sam Rivera', 'Casey Jones', 'Chris Park',
      'Drew Kim', 'Micah Torres', 'Noah Scott', 'Bryce Adams',
    ]);
    const load = vi.fn().mockResolvedValue({ players: bigRoster });
    render(<PlayerListEditor load={load} onSave={vi.fn()} onUploadCsv={vi.fn()} />);

    await findInList('Jordan Smith');
    await user.type(screen.getByLabelText('Search players'), 'ri');

    expect(await findInList('Sam Rivera')).toBeDefined();
    expect(await findInList('Chris Park')).toBeDefined();
    expect(await findInList('Jordan Smith')).toBeUndefined();
    expect(screen.getByText('Current roster (9)')).toBeInTheDocument();
  });

  it('shows a no-matches message rather than an empty-roster message when a search has no hits', async () => {
    const user = userEvent.setup();
    const bigRoster = players([
      'Jordan Smith', 'Alex Lee', 'Sam Rivera', 'Casey Jones', 'Chris Park',
      'Drew Kim', 'Micah Torres', 'Noah Scott', 'Bryce Adams',
    ]);
    const load = vi.fn().mockResolvedValue({ players: bigRoster });
    render(<PlayerListEditor load={load} onSave={vi.fn()} onUploadCsv={vi.fn()} />);

    await findInList('Jordan Smith');
    await user.type(screen.getByLabelText('Search players'), 'zzz');

    expect(await screen.findByText('No players match "zzz".')).toBeInTheDocument();
  });

  it('uploads a CSV and refreshes both the list and the textarea', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockResolvedValue({ players: [] });
    const onUploadCsv = vi.fn().mockResolvedValue({ players: players(['Casey Jones']) });
    render(<PlayerListEditor load={load} onSave={vi.fn()} onUploadCsv={onUploadCsv} />);

    await screen.findByText(/No players yet/);
    const file = new File(['Casey Jones'], 'roster.csv', { type: 'text/csv' });
    const input = screen.getByLabelText('Upload CSV', { exact: false }) as HTMLInputElement;
    await user.upload(input, file);

    await waitFor(() => expect(onUploadCsv).toHaveBeenCalledWith(file));
    expect(await findInList('Casey Jones')).toBeDefined();
  });
});
