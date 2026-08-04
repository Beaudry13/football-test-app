import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerProfilePage } from './PlayerProfilePage';
import * as playersApi from '../api/players';
import { acceptConfirm } from '../test/confirmDialog';
import type { Player, PlayerHistory } from '../api/types';

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

function makeHistory(overrides: Partial<PlayerHistory> = {}): PlayerHistory {
  return {
    player: makePlayer(),
    current_groups: [],
    assigned_count: 3,
    completed_count: 2,
    completion_percent: 67,
    average_score_percent: 85,
    recent_results: [],
    ...overrides,
  };
}

function renderPage(initialPath = '/roster/1') {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/roster/:playerId" element={<PlayerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PlayerProfilePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and displays the player header, stats, and groups', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({ current_groups: [{ id: 1, name: 'Defense' }] }),
    );
    renderPage();

    expect(await screen.findByText('Jordan Lee')).toBeInTheDocument();
    expect(screen.getByText('#12 · WR')).toBeInTheDocument();
    expect(screen.getByText('Groups: Defense')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('85%')).toBeInTheDocument();
  });

  it('shows the inactive badge and a Reactivate action for an inactive player', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({ player: makePlayer({ is_active: false }) }),
    );
    renderPage();

    expect(await screen.findByText('Inactive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('shows an empty-results message when nothing has been completed yet', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(makeHistory());
    renderPage();

    expect(await screen.findByText('No completed Quizzes yet.')).toBeInTheDocument();
  });

  it('lists recent results with score and a pending-grading badge', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({
        recent_results: [
          {
            quiz_id: 5,
            quiz_title: 'Week 1 Prep',
            attempt_id: 900,
            submitted_at: '2026-01-05T00:00:00Z',
            score_percent: 80,
            graded_answer_count: 4,
            correct_answer_count: 3,
            pending_grading_count: 1,
          },
        ],
      }),
    );
    renderPage();

    expect(await screen.findByRole('link', { name: 'Week 1 Prep' })).toHaveAttribute(
      'href',
      '/quizzes/5?tab=results',
    );
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('1 to grade')).toBeInTheDocument();
  });

  it('edits and saves the player, pre-filled from the loaded profile', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(makeHistory());
    const updateSpy = vi.spyOn(playersApi, 'updatePlayer').mockResolvedValue(makePlayer({ position: 'QB' }));
    renderPage();

    await screen.findByText('Jordan Lee');
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByDisplayValue('Jordan')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Lee')).toBeInTheDocument();
    const positionInput = screen.getByPlaceholderText('Position');
    await user.clear(positionInput);
    await user.type(positionInput, 'QB');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(1, {
        first_name: 'Jordan',
        last_name: 'Lee',
        jersey_number: '12',
        position: 'QB',
      }),
    );
  });

  it('deactivates the player once the confirmation is accepted', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(makeHistory());
    const deactivateSpy = vi.spyOn(playersApi, 'deactivatePlayer').mockResolvedValue(
      makePlayer({ is_active: false }),
    );
    renderPage();

    await screen.findByText('Jordan Lee');
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await acceptConfirm(user, 'Deactivate');

    await waitFor(() => expect(deactivateSpy).toHaveBeenCalledWith(1));
  });
});
