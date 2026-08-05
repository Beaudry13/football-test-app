import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerHistoryPage } from './PlayerHistoryPage';
import * as gradingApi from '../api/grading';
import type { PlayerHistoryEntry } from '../api/types';

function renderPage(name: string) {
  render(
    <MemoryRouter initialEntries={[`/players/${encodeURIComponent(name)}/history`]}>
      <Routes>
        <Route path="/players/:playerName/history" element={<PlayerHistoryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PlayerHistoryPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the decoded player name and a loading state before data arrives', () => {
    vi.spyOn(gradingApi, 'getPlayerHistory').mockReturnValue(new Promise(() => {}));
    renderPage('Mike Smith');
    expect(screen.getByRole('heading', { name: 'Mike Smith' })).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders each quiz taken with its title, date, and graded correct count', async () => {
    const history: PlayerHistoryEntry[] = [
      {
        quiz_id: 3,
        quiz_title: 'Week 1 Prep',
        response_id: 10,
        submitted_at: '2026-01-05T00:00:00Z',
        graded_answer_count: 4,
        correct_answer_count: 3,
        pending_grading_count: 0,
      },
      {
        quiz_id: 5,
        quiz_title: 'Week 2 Prep',
        response_id: 11,
        submitted_at: '2026-01-12T00:00:00Z',
        graded_answer_count: 0,
        correct_answer_count: 0,
        pending_grading_count: 0,
      },
    ];
    vi.spyOn(gradingApi, 'getPlayerHistory').mockResolvedValue({ player_name: 'Mike Smith', history });
    renderPage('Mike Smith');

    expect(await screen.findByRole('link', { name: 'Week 1 Prep' })).toHaveAttribute(
      'href',
      '/quizzes/3?tab=results',
    );
    expect(screen.getByRole('link', { name: 'Week 2 Prep' })).toHaveAttribute(
      'href',
      '/quizzes/5?tab=results',
    );
    expect(screen.getByText('3 / 4')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();

    const summary = screen.getByRole('heading', { level: 2 });
    expect(summary.textContent?.replace(/\s+/g, ' ').trim()).toBe('2 Quizzes taken · 75% correct overall');
  });

  it('shows an empty state when the player has no history', async () => {
    vi.spyOn(gradingApi, 'getPlayerHistory').mockResolvedValue({ player_name: 'Nobody', history: [] });
    renderPage('Nobody');
    expect(await screen.findByText(/No Quiz history found/)).toBeInTheDocument();
  });

  it('shows an error banner when the request fails', async () => {
    vi.spyOn(gradingApi, 'getPlayerHistory').mockRejectedValue(new Error('Request failed'));
    renderPage('Mike Smith');
    expect(await screen.findByText('Request failed')).toBeInTheDocument();
  });

  it('shows a per-row pending-grading badge and does not fold pending into the average', async () => {
    const history: PlayerHistoryEntry[] = [
      {
        quiz_id: 3,
        quiz_title: 'Week 1 Prep',
        response_id: 10,
        submitted_at: '2026-01-05T00:00:00Z',
        graded_answer_count: 2,
        correct_answer_count: 2,
        pending_grading_count: 1,
      },
    ];
    vi.spyOn(gradingApi, 'getPlayerHistory').mockResolvedValue({ player_name: 'Mike Smith', history });
    renderPage('Mike Smith');

    expect(await screen.findByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByText('1 to grade')).toBeInTheDocument();
    // 2/2 graded is 100%, unaffected by the still-ungraded answer.
    const summary = screen.getByRole('heading', { level: 2 });
    expect(summary.textContent).toContain('100% correct overall');
    expect(screen.getByText(/pending grading$/)).toBeInTheDocument();
    expect(screen.getByText(/doesn't include these yet/)).toBeInTheDocument();
  });

  it('does not show a pending badge or note when nothing is pending', async () => {
    const history: PlayerHistoryEntry[] = [
      {
        quiz_id: 3,
        quiz_title: 'Week 1 Prep',
        response_id: 10,
        submitted_at: '2026-01-05T00:00:00Z',
        graded_answer_count: 2,
        correct_answer_count: 2,
        pending_grading_count: 0,
      },
    ];
    vi.spyOn(gradingApi, 'getPlayerHistory').mockResolvedValue({ player_name: 'Mike Smith', history });
    renderPage('Mike Smith');

    await screen.findByText('2 / 2');
    expect(screen.queryByText('to grade')).not.toBeInTheDocument();
    expect(screen.queryByText(/doesn't include these yet/)).not.toBeInTheDocument();
  });
});
