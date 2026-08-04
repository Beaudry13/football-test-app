import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RosterImportPanel } from './RosterImportPanel';
import * as playersApi from '../api/players';
import type { ImportPreviewResponse, ImportConfirmResponse } from '../api/types';

function makePreview(overrides: Partial<ImportPreviewResponse> = {}): ImportPreviewResponse {
  return {
    detected_mapping: { first_name: 'First Name', last_name: 'Last Name' },
    available_columns: ['First Name', 'Last Name', 'Jersey Number', 'Position'],
    total_rows: 1,
    valid_count: 1,
    invalid_count: 0,
    rows: [
      {
        row_number: 1,
        first_name: 'Chris',
        last_name: 'Smith',
        jersey_number: '2',
        position: 'WR',
        full_name_parsed: false,
        is_valid: true,
        errors: [],
        possible_duplicates: [],
        default_action: 'create',
      },
    ],
    ...overrides,
  };
}

describe('RosterImportPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('previews pasted text and shows the parsed row', async () => {
    const user = userEvent.setup();
    const previewSpy = vi.spyOn(playersApi, 'previewImport').mockResolvedValue(makePreview());
    render(<RosterImportPanel onImported={vi.fn()} />);

    await user.type(screen.getByLabelText('Paste roster data'), 'Chris,Smith,2,WR');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));

    await waitFor(() => expect(previewSpy).toHaveBeenCalledWith('Chris,Smith,2,WR'));
    expect(await screen.findByDisplayValue('Chris')).toBeInTheDocument();
    expect(screen.getByText('1 row parsed')).toBeInTheDocument();
    expect(screen.getByText('1 valid')).toBeInTheDocument();
    expect(screen.getByText('1 to create')).toBeInTheDocument();
    expect(screen.getByText('0 to update')).toBeInTheDocument();
    expect(screen.getByText('0 to skip')).toBeInTheDocument();
  });

  it('shows an error instead of previewing when nothing was pasted or uploaded', async () => {
    const user = userEvent.setup();
    const previewSpy = vi.spyOn(playersApi, 'previewImport');
    render(<RosterImportPanel onImported={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Preview import' }));

    expect(await screen.findByText('Paste some rows or choose a CSV file first.')).toBeInTheDocument();
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('flags invalid rows and defaults their action to skip', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'previewImport').mockResolvedValue(
      makePreview({
        invalid_count: 1,
        rows: [
          {
            row_number: 1,
            first_name: '',
            last_name: '',
            jersey_number: null,
            position: null,
            full_name_parsed: false,
            is_valid: false,
            errors: ['Name is required'],
            possible_duplicates: [],
            default_action: 'skip',
          },
        ],
      }),
    );
    render(<RosterImportPanel onImported={vi.fn()} />);

    await user.type(screen.getByLabelText('Paste roster data'), ',,2,WR');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));

    expect(await screen.findByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText('1 invalid')).toBeInTheDocument();
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(select.value).toBe('skip');
  });

  it('surfaces an exact match, defaults it away from Create, and offers an Update action', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'previewImport').mockResolvedValue(
      makePreview({
        rows: [
          {
            row_number: 1,
            first_name: 'Chris',
            last_name: 'Smith',
            jersey_number: '2',
            position: 'WR',
            full_name_parsed: false,
            is_valid: true,
            errors: [],
            possible_duplicates: [
              {
                player_id: 42,
                first_name: 'Chris',
                last_name: 'Smith',
                jersey_number: '2',
                position: 'WR',
                strong_match: true,
              },
            ],
            default_action: 'skip',
          },
        ],
      }),
    );
    render(<RosterImportPanel onImported={vi.fn()} />);

    await user.type(screen.getByLabelText('Paste roster data'), 'Chris,Smith,2,WR');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));

    expect(await screen.findByText(/Exact match:/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Update match' })).toBeInTheDocument();
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(select.value).toBe('skip');
  });

  it('defaults an ambiguous same-name match to "review required" and blocks import until resolved', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'previewImport').mockResolvedValue(
      makePreview({
        rows: [
          {
            row_number: 1,
            first_name: 'Chris',
            last_name: 'Smith',
            jersey_number: '99',
            position: 'TE',
            full_name_parsed: false,
            is_valid: true,
            errors: [],
            possible_duplicates: [
              {
                player_id: 42,
                first_name: 'Chris',
                last_name: 'Smith',
                jersey_number: '2',
                position: 'WR',
                strong_match: false,
              },
            ],
            default_action: 'review',
          },
        ],
      }),
    );
    const confirmSpy = vi.spyOn(playersApi, 'confirmImport');
    render(<RosterImportPanel onImported={vi.fn()} />);

    await user.type(screen.getByLabelText('Paste roster data'), 'Chris,Smith,99,TE');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));

    expect(await screen.findByText(/Same name:/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Review required' })).toBeInTheDocument();
    expect(screen.getByText('1 need review')).toBeInTheDocument();

    // The Import button itself is disabled while any row is unresolved -
    // a coach cannot accidentally import (or silently skip) a row that
    // still needs a decision.
    expect(screen.getByRole('button', { name: 'Import 0 Players' })).toBeDisabled();
    expect(confirmSpy).not.toHaveBeenCalled();

    // Explicitly resolving it to Create clears the block and lets import proceed.
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'create');
    expect(screen.queryByRole('option', { name: 'Review required' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 1 Player' })).not.toBeDisabled();
  });

  it('confirms the import and reports the created/updated summary', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'previewImport').mockResolvedValue(makePreview());
    const confirmSpy = vi.spyOn(playersApi, 'confirmImport').mockResolvedValue({
      success: true,
      created: 1,
      updated: 0,
      players: [],
    } satisfies ImportConfirmResponse);
    const onImported = vi.fn();
    render(<RosterImportPanel onImported={onImported} />);

    await user.type(screen.getByLabelText('Paste roster data'), 'Chris,Smith,2,WR');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByDisplayValue('Chris');
    await user.click(screen.getByRole('button', { name: 'Import 1 Player' }));

    await waitFor(() =>
      expect(confirmSpy).toHaveBeenCalledWith([
        { first_name: 'Chris', last_name: 'Smith', jersey_number: '2', position: 'WR', action: 'create', existing_player_id: null },
      ]),
    );
    expect(await screen.findByText('Imported 1 new player.')).toBeInTheDocument();
    expect(onImported).toHaveBeenCalled();
  });

  it('refuses to import when every row has been set to skip', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'previewImport').mockResolvedValue(makePreview());
    const confirmSpy = vi.spyOn(playersApi, 'confirmImport');
    render(<RosterImportPanel onImported={vi.fn()} />);

    await user.type(screen.getByLabelText('Paste roster data'), 'Chris,Smith,2,WR');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByDisplayValue('Chris');

    // "0 will be imported" disables the Import button entirely once every
    // row is skipped - confirm the button reflects that live.
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'skip');
    expect(screen.getByRole('button', { name: 'Import 0 Players' })).toBeDisabled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('returns to the paste view from Back without importing', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'previewImport').mockResolvedValue(makePreview());
    render(<RosterImportPanel onImported={vi.fn()} />);

    await user.type(screen.getByLabelText('Paste roster data'), 'Chris,Smith,2,WR');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByDisplayValue('Chris');

    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByLabelText('Paste roster data')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Chris')).not.toBeInTheDocument();
  });

  it('downloads the CSV template', async () => {
    const user = userEvent.setup();
    const blob = new Blob(['First Name,Last Name,Jersey Number,Position'], { type: 'text/csv' });
    vi.spyOn(playersApi, 'downloadImportTemplate').mockResolvedValue(blob);
    const createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    render(<RosterImportPanel onImported={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Download template' }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(blob));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});
