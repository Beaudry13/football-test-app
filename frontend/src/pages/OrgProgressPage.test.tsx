import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgProgressPage } from './OrgProgressPage';
import * as playersApi from '../api/players';
import type { OrgProgress, OrgRosterPlayerRow, Player } from '../api/types';

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

function makeRow(overrides: Partial<OrgRosterPlayerRow> = {}): OrgRosterPlayerRow {
  return {
    player: makePlayer(),
    assigned_count: 3,
    completed_count: 3,
    completion_percent: 100,
    average_score_percent: 90,
    below_threshold_count: 0,
    needs_review: false,
    last_activity_at: '2026-01-05T00:00:00Z',
    trend_direction: 'flat',
    current_groups: [],
    ...overrides,
  };
}

function makeProgress(overrides: Partial<OrgProgress> = {}): OrgProgress {
  return {
    players: [],
    summary: {
      total_active_players: 0,
      players_with_incomplete_assignments: 0,
      players_below_threshold: 0,
      average_score_percent: null,
      completion_rate: null,
      players_with_no_recent_activity: 0,
      review_threshold_percent: 80,
    },
    ...overrides,
  };
}

function renderPage() {
  render(
    <MemoryRouter>
      <OrgProgressPage />
    </MemoryRouter>,
  );
}

describe('OrgProgressPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and displays the summary stats and roster table', async () => {
    vi.spyOn(playersApi, 'getOrgProgress').mockResolvedValue(
      makeProgress({
        players: [makeRow()],
        summary: {
          total_active_players: 1,
          players_with_incomplete_assignments: 0,
          players_below_threshold: 0,
          average_score_percent: 90,
          completion_rate: 100,
          players_with_no_recent_activity: 0,
          review_threshold_percent: 80,
        },
      }),
    );
    renderPage();

    expect(await screen.findByText('Jordan Lee')).toBeInTheDocument();
    expect(screen.getAllByText('90%').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Open Profile' })).toHaveAttribute('href', '/roster/1');
  });

  it('shows the empty state when the organization has no players yet', async () => {
    vi.spyOn(playersApi, 'getOrgProgress').mockResolvedValue(makeProgress());
    renderPage();

    expect(await screen.findByText('No Players found.')).toBeInTheDocument();
  });

  it('shows a Needs Review badge for a player below the review threshold', async () => {
    vi.spyOn(playersApi, 'getOrgProgress').mockResolvedValue(
      makeProgress({ players: [makeRow({ needs_review: true, average_score_percent: 50 })] }),
    );
    renderPage();

    await screen.findByText('Jordan Lee');
    // Scope to the roster table - the summary stats also have their own
    // "Needs Review" label for a different count.
    const table = screen.getByRole('table', { name: 'Player Progress roster' });
    expect(within(table).getByText('Needs Review')).toBeInTheDocument();
  });

  it('filters the roster by search', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getOrgProgress').mockResolvedValue(
      makeProgress({
        players: [
          makeRow({ player: makePlayer({ id: 1, first_name: 'Jordan', last_name: 'Lee', full_name: 'Jordan Lee' }) }),
          makeRow({ player: makePlayer({ id: 2, first_name: 'Sam', last_name: 'Rivera', full_name: 'Sam Rivera' }) }),
        ],
      }),
    );
    renderPage();

    await screen.findByText('Jordan Lee');
    expect(screen.getByText('Sam Rivera')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Search players'), 'Sam');

    expect(screen.queryByText('Jordan Lee')).not.toBeInTheDocument();
    expect(screen.getByText('Sam Rivera')).toBeInTheDocument();
  });

  it('filters the roster to Needs Review only', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getOrgProgress').mockResolvedValue(
      makeProgress({
        players: [
          makeRow({
            player: makePlayer({ id: 1, first_name: 'Strong', last_name: 'Player', full_name: 'Strong Player' }),
            needs_review: false,
          }),
          makeRow({
            player: makePlayer({ id: 2, first_name: 'Weak', last_name: 'Player', full_name: 'Weak Player' }),
            needs_review: true,
          }),
        ],
      }),
    );
    renderPage();

    await screen.findByText('Strong Player');
    await user.selectOptions(screen.getByLabelText('Filter by review status'), 'needs_review');

    expect(screen.queryByText('Strong Player')).not.toBeInTheDocument();
    expect(screen.getByText('Weak Player')).toBeInTheDocument();
  });

  it('re-fetches with the inactive filter when the active-status select changes', async () => {
    const spy = vi.spyOn(playersApi, 'getOrgProgress').mockResolvedValue(makeProgress());
    renderPage();

    await waitFor(() => expect(spy).toHaveBeenCalledWith({ active: 'true' }));

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Filter by active status'), 'all');

    await waitFor(() => expect(spy).toHaveBeenCalledWith({ active: 'all' }));
  });

  it('shows an error banner when the request fails', async () => {
    vi.spyOn(playersApi, 'getOrgProgress').mockRejectedValue(new Error('Network error'));
    renderPage();

    expect(await screen.findByText('Network error')).toBeInTheDocument();
  });
});
