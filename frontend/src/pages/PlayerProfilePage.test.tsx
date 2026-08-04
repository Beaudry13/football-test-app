import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerProfilePage } from './PlayerProfilePage';
import * as playersApi from '../api/players';
import { acceptConfirm } from '../test/confirmDialog';
import type { ComparisonStats, Player, PlayerHistory, PlayerHistoryRow } from '../api/types';

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

function makeComparisonStats(overrides: Partial<ComparisonStats> = {}): ComparisonStats {
  return {
    average_score_percent: null,
    graded_answer_count: 0,
    player_count: 0,
    sufficient_data: false,
    ...overrides,
  };
}

function makeHistoryRow(overrides: Partial<PlayerHistoryRow> = {}): PlayerHistoryRow {
  return {
    attempt_id: 900,
    quiz_id: 5,
    quiz_title: 'Week 1 Prep',
    started_at: '2026-01-05T00:00:00Z',
    submitted_at: '2026-01-05T00:00:00Z',
    completion_status: 'completed',
    score_percent: 80,
    review_status: 'strong',
    correct_count: 4,
    graded_count: 5,
    group_source: [],
    ...overrides,
  };
}

function makeHistory(overrides: Partial<PlayerHistory> = {}): PlayerHistory {
  return {
    player: makePlayer(),
    summary: {
      assigned_count: 3,
      completed_count: 2,
      completion_percent: 67,
      average_score_percent: 85,
      below_threshold_count: 0,
      pending_grading_count: 0,
      last_completed_at: null,
      current_groups: [],
      review_threshold_percent: 80,
    },
    history: [],
    trend: { available: false, direction: null, points: [] },
    missed_questions: [],
    comparisons: {
      player: makeComparisonStats(),
      groups: [],
      position: null,
      organization: makeComparisonStats(),
    },
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

  it('loads and displays the player header, summary stats, and groups', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({
        summary: {
          assigned_count: 3,
          completed_count: 2,
          completion_percent: 67,
          average_score_percent: 85,
          below_threshold_count: 1,
          pending_grading_count: 0,
          last_completed_at: null,
          current_groups: [{ id: 1, name: 'Defense' }],
          review_threshold_percent: 80,
        },
      }),
    );
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Jordan Lee' })).toBeInTheDocument();
    expect(screen.getByText('#12 · WR')).toBeInTheDocument();
    expect(screen.getByText('Groups: Defense')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument(); // Needs Review count
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
    expect(screen.getByText('No Quiz history yet.')).toBeInTheDocument();
  });

  it('shows the insufficient-data empty state when the trend is not yet available', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(makeHistory());
    renderPage();

    expect(
      await screen.findByText('Not enough completed, graded quizzes yet to show a trend - at least 2 are needed.'),
    ).toBeInTheDocument();
  });

  it('renders a trend sparkline with a directional label once available', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({
        trend: {
          available: true,
          direction: 'improving',
          points: [
            { date: '2026-01-01T00:00:00Z', score_percent: 60 },
            { date: '2026-01-08T00:00:00Z', score_percent: 90 },
          ],
        },
      }),
    );
    renderPage();

    expect(await screen.findByText(/Improving/)).toBeInTheDocument();
  });

  it('lists recent results with a score and completion status', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({ history: [makeHistoryRow({ score_percent: 80, review_status: 'strong' })] }),
    );
    renderPage();

    expect(await screen.findByRole('link', { name: 'Week 1 Prep' })).toHaveAttribute(
      'href',
      '/quizzes/5?tab=results',
    );
    expect(screen.getAllByText('80%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Strong').length).toBeGreaterThan(0);
  });

  it('shows a Pending Grading status for an ungraded written attempt, never as incorrect', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({
        history: [
          makeHistoryRow({
            score_percent: null,
            review_status: 'pending_grading',
            correct_count: 0,
            graded_count: 0,
          }),
        ],
      }),
    );
    renderPage();

    await screen.findByRole('link', { name: 'Week 1 Prep' });
    expect(screen.getAllByText('Pending Grading').length).toBeGreaterThan(0);
  });

  it('filters the full history table by Needs Review', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({
        history: [
          makeHistoryRow({ attempt_id: 1, quiz_title: 'Strong Quiz', review_status: 'strong', score_percent: 95 }),
          makeHistoryRow({
            attempt_id: 2,
            quiz_title: 'Weak Quiz',
            review_status: 'needs_review',
            score_percent: 50,
          }),
        ],
      }),
    );
    renderPage();

    await screen.findByRole('heading', { name: 'Jordan Lee' });
    // Scope to the full "Quiz History" table specifically - the same quiz
    // titles also legitimately appear in the separate "Recent Performance"
    // list above it.
    const historyTable = () => screen.getByRole('table', { name: 'Quiz History' });
    expect(within(historyTable()).getByText('Strong Quiz')).toBeInTheDocument();
    expect(within(historyTable()).getByText('Weak Quiz')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'needs_review');

    expect(within(historyTable()).queryByText('Strong Quiz')).not.toBeInTheDocument();
    expect(within(historyTable()).getByText('Weak Quiz')).toBeInTheDocument();
  });

  it('shows Areas to Review with a missed-question preview and repeat-miss count', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({
        missed_questions: [
          {
            question_id: 42,
            quiz_id: 5,
            quiz_title: 'Week 1 Prep',
            question_number: 3,
            question_preview: 'Is this a blitz?',
            miss_count: 2,
            most_recent_missed_at: '2026-01-05T00:00:00Z',
          },
        ],
      }),
    );
    renderPage();

    expect(await screen.findByText(/Is this a blitz\?/)).toBeInTheDocument();
    const areasTable = screen.getByRole('table', { name: 'Areas to Review' });
    expect(within(areasTable).getByText('2')).toBeInTheDocument();
  });

  it('shows the empty state when no missed questions are on record', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(makeHistory());
    renderPage();

    expect(
      await screen.findByText(
        'No missed questions on record - either no Quizzes are complete yet, or every graded answer so far has been correct.',
      ),
    ).toBeInTheDocument();
  });

  it('flags an insufficient sample size instead of showing a misleading comparison', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({
        comparisons: {
          player: makeComparisonStats({ average_score_percent: 100, player_count: 1, sufficient_data: true }),
          groups: [],
          position: null,
          organization: makeComparisonStats({ average_score_percent: 100, player_count: 1, sufficient_data: false }),
        },
      }),
    );
    renderPage();

    expect(await screen.findByText(/Not enough data yet/)).toBeInTheDocument();
  });

  it('shows each Group comparison separately for a multi-Group player', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({
        comparisons: {
          player: makeComparisonStats(),
          groups: [
            { group_id: 1, group_name: 'Offense', ...makeComparisonStats({ average_score_percent: 70, player_count: 5, sufficient_data: true }) },
            { group_id: 2, group_name: 'Special Teams', ...makeComparisonStats({ average_score_percent: 90, player_count: 4, sufficient_data: true }) },
          ],
          position: null,
          organization: makeComparisonStats(),
        },
      }),
    );
    renderPage();

    expect(await screen.findByText('Offense')).toBeInTheDocument();
    expect(screen.getByText('Special Teams')).toBeInTheDocument();
  });

  it('edits and saves the player, pre-filled from the loaded profile', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(makeHistory());
    const updateSpy = vi.spyOn(playersApi, 'updatePlayer').mockResolvedValue(makePlayer({ position: 'QB' }));
    renderPage();

    await screen.findByRole('heading', { name: 'Jordan Lee' });
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

    await screen.findByRole('heading', { name: 'Jordan Lee' });
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await acceptConfirm(user, 'Deactivate');

    await waitFor(() => expect(deactivateSpy).toHaveBeenCalledWith(1));
  });

  describe('player photo', () => {
    it('uploads a photo and refreshes the profile with the new photo_url', async () => {
      const user = userEvent.setup();
      const getHistorySpy = vi
        .spyOn(playersApi, 'getPlayerHistory')
        .mockResolvedValueOnce(makeHistory())
        .mockResolvedValueOnce(makeHistory({ player: makePlayer({ photo_url: '/uploads/new.jpg' }) }));
      const uploadSpy = vi
        .spyOn(playersApi, 'uploadPlayerPhoto')
        .mockResolvedValue(makePlayer({ photo_url: '/uploads/new.jpg' }));
      renderPage();

      await screen.findByRole('heading', { name: 'Jordan Lee' });
      expect(screen.getByRole('button', { name: 'Add photo' })).toBeInTheDocument();
      const file = new File(['fake-image-bytes'], 'photo.jpg', { type: 'image/jpeg' });
      const input = screen.getByLabelText('Upload player photo', { selector: 'input' });
      await user.upload(input, file);

      await waitFor(() => expect(uploadSpy).toHaveBeenCalledWith(1, file));
      await waitFor(() => expect(getHistorySpy).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole('button', { name: 'Replace photo' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add photo' })).not.toBeInTheDocument();
    });

    it('shows "Replace photo" once the player already has one, and re-uploads through the same control', async () => {
      const user = userEvent.setup();
      vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
        makeHistory({ player: makePlayer({ photo_url: '/uploads/existing.jpg' }) }),
      );
      const uploadSpy = vi
        .spyOn(playersApi, 'uploadPlayerPhoto')
        .mockResolvedValue(makePlayer({ photo_url: '/uploads/replaced.jpg' }));
      renderPage();

      await screen.findByRole('heading', { name: 'Jordan Lee' });
      expect(screen.getByRole('button', { name: 'Replace photo' })).toBeInTheDocument();

      const file = new File(['fake-image-bytes'], 'new-photo.jpg', { type: 'image/jpeg' });
      const input = screen.getByLabelText('Upload player photo', { selector: 'input' });
      await user.upload(input, file);

      await waitFor(() => expect(uploadSpy).toHaveBeenCalledWith(1, file));
    });

    it('shows an error if the photo upload fails, without disrupting the rest of the page', async () => {
      // The rejection here stands in for whatever the server refused it for
      // (bad content, oversized, etc.) - this test is only exercising the
      // error-handling path, not accept-attribute filtering (the browser's
      // own file picker already restricts extensions before a file ever
      // reaches this handler).
      const user = userEvent.setup();
      vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(makeHistory());
      vi.spyOn(playersApi, 'uploadPlayerPhoto').mockRejectedValue(new Error("The uploaded file isn't a valid image"));
      renderPage();

      await screen.findByRole('heading', { name: 'Jordan Lee' });
      const file = new File(['not-really-an-image'], 'payload.jpg', { type: 'image/jpeg' });
      const input = screen.getByLabelText('Upload player photo', { selector: 'input' });
      await user.upload(input, file);

      expect(await screen.findByText("The uploaded file isn't a valid image")).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Jordan Lee' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add photo' })).toBeInTheDocument();
    });
  });
});
