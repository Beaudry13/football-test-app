import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/quizzes', () => ({ listQuizzes: vi.fn() }));
vi.mock('../../api/reps', () => ({ makeRepFromQuiz: vi.fn(), getConceptTrends: vi.fn().mockResolvedValue([]) }));
import * as quizzesApi from '../../api/quizzes';
import * as repsApi from '../../api/reps';
import * as authModule from '../../auth/AuthContext';
import { RepsPage } from './RepsPage';

/** EVERY REP, and the fastest way to make one: from a quiz in one tap, for every coach. */

const quiz = (id: number, title: string, kind: 'QUIZ' | 'REP', question_count = 3) =>
  ({ id, title, kind, question_count, updated_at: `2026-10-0${id}`, is_active: false }) as never;

function open(owner: boolean) {
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: owner } } as never);
  render(
    <MemoryRouter initialEntries={['/reps']}>
      <Routes>
        <Route path="/reps" element={<RepsPage />} />
        <Route path="/reps/:id" element={<p>the new rep</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(quizzesApi.listQuizzes).mockReset().mockResolvedValue([
    quiz(1, 'Week 3 install', 'QUIZ'),
    quiz(2, 'Empty draft', 'QUIZ', 0),
    quiz(3, 'Trips Jet - Boundary safety', 'REP'),
  ]);
  vi.mocked(repsApi.makeRepFromQuiz).mockReset().mockResolvedValue({ id: 9 } as never);
});

describe('Reps, for every coach', () => {
  it('lists the reps and makes a new one from a quiz in one tap', async () => {
    open(false);
    expect(await screen.findByRole('link', { name: /Trips Jet/ })).toHaveAttribute('href', '/reps/3');
    expect(screen.queryByRole('link', { name: 'From a Motion Lab play' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Make a rep from a quiz' }));
    const picker = within(screen.getByRole('region', { name: 'Make a rep from a quiz' }));
    // Quizzes with questions only - never a rep, never an empty draft.
    expect(picker.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Make a rep from Week 3 install']);
    fireEvent.click(picker.getByRole('button', { name: 'Make a rep from Week 3 install' }));
    expect(await screen.findByText('the new rep')).toBeInTheDocument();
    expect(repsApi.makeRepFromQuiz).toHaveBeenCalledWith(1);
  });

  it('says why a quiz cannot become a rep, on its row', async () => {
    vi.mocked(repsApi.makeRepFromQuiz).mockRejectedValue(new Error('This quiz has no tap-an-answer questions'));
    open(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Make a rep from a quiz' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make a rep from Week 3 install' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This quiz has no tap-an-answer questions');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Make a rep from Week 3 install' })).toBeEnabled());
  });

  it('a coach with Motion Lab can also start from a play', async () => {
    open(true);
    expect(await screen.findByRole('link', { name: 'From a Motion Lab play' })).toHaveAttribute('href', '/motion-lab');
  });
});
