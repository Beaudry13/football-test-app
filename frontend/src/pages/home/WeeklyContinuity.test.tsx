import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TourProvider } from '../../help/tour/TourProvider';
import { DashboardPage } from '../DashboardPage';
import { DashboardRail } from '../DashboardRail';
import { QuizEditorPage } from '../quiz-editor/QuizEditorPage';
import * as quizzesApi from '../../api/quizzes';
import * as foldersApi from '../../api/folders';
import * as gradingApi from '../../api/grading';
import * as repsApi from '../../api/reps';
import * as authContext from '../../auth/AuthContext';
import { readLastWork, rememberWork } from './lastWork';
import type { Coach, Quiz } from '../../api/types';

/**
 * HOME, FOR THE WEEK: what is waiting on the coach's eyes ("7 to grade",
 * one tap from the grading screen) and one quiet line to pick up the quiz or
 * Rep he last opened - only while it still exists, under its current name.
 */

const coach = { id: 1, username: 'coach1', organization_id: 1, is_platform_owner: false } as Coach;
const quiz = (id: number, title: string, kind: 'QUIZ' | 'REP' = 'QUIZ'): Quiz =>
  ({ id, title, kind, organization_id: 1, coach_id: 1, question_count: 3, folder_id: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' }) as unknown as Quiz;

function renderHome() {
  render(
    <MemoryRouter>
      <TourProvider>
        <DashboardPage />
      </TourProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.spyOn(authContext, 'useAuth').mockReturnValue({ coach } as never);
  vi.spyOn(foldersApi, 'listFolders').mockResolvedValue([]);
  vi.spyOn(repsApi, 'getRepsSummary').mockResolvedValue([]);
  vi.spyOn(gradingApi, 'listToGrade').mockResolvedValue([]);
});

describe('Needs attention: what is waiting to be graded', () => {
  it('names each quiz with answers to grade, one tap from its grading screen', () => {
    render(
      <MemoryRouter>
        <DashboardRail
          entries={[]}
          quizzes={[]}
          toGrade={[
            { quiz_id: 4, title: 'Week 6 install', count: 7 },
            { quiz_id: 5, title: 'Red zone', count: 2 },
            { quiz_id: 6, title: 'Two minute', count: 1 },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '7 to grade' })).toHaveAttribute('href', '/quizzes/4/grade');
    expect(screen.getByText('Week 6 install')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2 to grade' })).toHaveAttribute('href', '/quizzes/5/grade');
    expect(screen.getByText('and 1 more quiz')).toBeInTheDocument();
  });

  it('nothing waiting, nothing said', () => {
    render(
      <MemoryRouter>
        <DashboardRail entries={[]} quizzes={[]} toGrade={[]} />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/to grade/)).toBeNull();
  });

  it('Home asks for it and hands it to the rail', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([quiz(4, 'Week 6 install')]);
    vi.mocked(gradingApi.listToGrade).mockResolvedValue([{ quiz_id: 4, title: 'Week 6 install', count: 7 }]);
    renderHome();
    expect(await screen.findByRole('link', { name: '7 to grade' })).toHaveAttribute('href', '/quizzes/4/grade');
  });
});

describe('Pick up where you left off', () => {
  it('one line to the quiz he last opened, under its current name', async () => {
    rememberWork(1, { kind: 'quiz', id: 4, title: 'Old name' });
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([quiz(4, 'Week 6 install')]);
    renderHome();
    const link = await screen.findByRole('link', { name: 'Week 6 install' });
    expect(link.closest('p')).toHaveTextContent('Pick up where you left off: Week 6 install · Quiz');
    expect(link).toHaveAttribute('href', '/quizzes/4');
  });

  it('a Rep opens on its Rep page', async () => {
    rememberWork(1, { kind: 'rep', id: 8, title: 'Boundary safety' });
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([quiz(4, 'Week 6 install'), quiz(8, 'Boundary safety', 'REP')]);
    renderHome();
    expect(await screen.findByRole('link', { name: 'Boundary safety' })).toHaveAttribute('href', '/reps/8');
  });

  it('never a dead link: work that is gone is not offered', async () => {
    rememberWork(1, { kind: 'quiz', id: 99, title: 'Deleted quiz' });
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([quiz(4, 'Week 6 install')]);
    renderHome();
    await screen.findAllByText('Week 6 install');
    expect(screen.queryByText(/Pick up where you left off/)).toBeNull();
  });

  it("another coach's last work on this device is not offered", async () => {
    rememberWork(2, { kind: 'quiz', id: 4, title: 'Week 6 install' });
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([quiz(4, 'Week 6 install')]);
    renderHome();
    await screen.findAllByText('Week 6 install');
    expect(screen.queryByText(/Pick up where you left off/)).toBeNull();
    await waitFor(() => expect(readLastWork(1)).toBeNull());
  });
});

describe('where he left off is remembered as he works', () => {
  it('opening a quiz makes it the one Home offers to pick up', async () => {
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue({ ...quiz(4, 'Week 6 install'), questions: [] } as never);
    render(
      <MemoryRouter initialEntries={['/quizzes/4?tab=results']}>
        <Routes>
          <Route path="/quizzes/:quizId" element={<QuizEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(readLastWork(1)).toMatchObject({ kind: 'quiz', id: 4, title: 'Week 6 install' }));
  });
});
