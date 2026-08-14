import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultsTab } from './ResultsTab';
import * as gradingApi from '../../api/grading';
import * as exclusionsApi from '../../api/questionExclusions';
import * as authContext from '../../auth/AuthContext';
import type {
  Coach,
  QuestionExclusion,
  Quiz,
  QuizAssignment,
  QuizDashboard,
} from '../../api/types';

/** The coach side of "don't count this question".
 *
 * Two properties matter more than the rest: the raw response counts are
 * EVIDENCE and must survive exclusion untouched, and Restore must never claim
 * a question counts again while another exclusion still covers it.
 */

function mockAuth() {
  const coach: Coach = {
    id: 1,
    username: 'coach1',
    email: 'coach1@example.com',
    organization: 'Wildcats',
    organization_id: 1,
    role: 'member',
    is_platform_owner: false,
    created_at: '2026-01-01T00:00:00Z',
  };
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    coach,
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    registerWithInvite: vi.fn(),
    logout: vi.fn(),
  });
}

const quiz: Quiz = {
  id: 1,
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Week 1 Prep',
  description: null,
  one_question_at_a_time: true,
  require_all_answers: false,
  folder_id: null,
  question_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

const ASSIGNMENTS: QuizAssignment[] = [
  {
    access_code_id: 11,
    code: 'W8XTNY',
    activated_at: '2026-08-14T15:00:00Z',
    is_active: false,
    is_valid: false,
    mode: 'GRADED',
    groups: [{ id: 1, name: 'Defense' }],
    submitted_count: 2,
  },
  {
    access_code_id: 12,
    code: 'ET4R8S',
    activated_at: '2026-08-15T15:00:00Z',
    is_active: true,
    is_valid: true,
    mode: 'GRADED',
    groups: [{ id: 2, name: 'Offense' }],
    submitted_count: 2,
  },
];

const assignmentExclusion: QuestionExclusion = {
  id: 5,
  question_id: 7,
  access_code_id: 11,
  scope: 'assignment',
  excluded_at: '2026-08-14T00:00:00Z',
  restored_at: null,
  is_active: true,
  excluded_by_username: 'coach1',
  reason: 'wrong answer key',
};

const quizWideExclusion: QuestionExclusion = {
  ...assignmentExclusion,
  id: 6,
  access_code_id: null,
  scope: 'quiz',
  reason: null,
};

function dashboardWith(exclusions: QuestionExclusion[]): QuizDashboard {
  return {
    quiz_id: 1,
    roster_size: 2,
    response_count: 5,
    response_rate: 1,
    missing_players: [],
    question_breakdown: [
      {
        question_id: 7,
        question_text: 'Which gap does the 3-tech attack?',
        question_type: 'multiple_choice',
        answered_count: 5,
        correct_count: 1,
        incorrect_count: 4,
        ungraded_count: 0,
        is_excluded: exclusions.length > 0,
        exclusions,
      },
    ],
  };
}

function renderTab() {
  render(
    <MemoryRouter>
      <ResultsTab quiz={quiz} />
    </MemoryRouter>,
  );
}

describe('ResultsTab - question exclusions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAuth();
    vi.spyOn(gradingApi, 'listResponses').mockResolvedValue([]);
    vi.spyOn(exclusionsApi, 'listQuizAssignments').mockResolvedValue(ASSIGNMENTS);
  });

  it('offers the control on a question that is still counting', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(dashboardWith([]));
    renderTab();

    expect(
      await screen.findByRole('button', { name: /Don’t count this/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Excluded')).not.toBeInTheDocument();
  });

  it('marks an excluded question and KEEPS its raw counts', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(
      dashboardWith([assignmentExclusion]),
    );
    renderTab();

    const row = (await screen.findByText(/3-tech attack/)).closest('tr')!;
    expect(within(row).getByText('Excluded')).toBeInTheDocument();
    // THE EVIDENCE SURVIVES - 1 correct, 4 incorrect is usually the very
    // reason the coach excluded the question.
    expect(within(row).getByText('1')).toBeInTheDocument();
    expect(within(row).getByText('4')).toBeInTheDocument();
    // ...and the control is replaced, not duplicated.
    expect(within(row).queryByRole('button', { name: /Don’t count this/ })).not.toBeInTheDocument();
  });

  it('shows the scope, the author and the reason', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(
      dashboardWith([assignmentExclusion]),
    );
    renderTab();

    const note = await screen.findByText(/Not counted for Defense/);
    expect(note).toHaveTextContent('W8XTNY');
    expect(note).toHaveTextContent('coach1');
    expect(note).toHaveTextContent('wrong answer key');
  });

  it('names WHICH assignment stopped counting, not just "one assignment"', async () => {
    // The walkthrough finding: on a quiz-scoped page pooling several
    // deliveries, "one assignment" left the coach unable to tell which.
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(
      dashboardWith([assignmentExclusion]),
    );
    renderTab();

    expect(await screen.findByText(/Not counted for Defense/)).toBeInTheDocument();
    expect(screen.queryByText(/Not counted for one assignment/)).not.toBeInTheDocument();
  });

  it('distinguishes two exclusions scoped to different assignments', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(
      dashboardWith([
        assignmentExclusion,
        { ...assignmentExclusion, id: 9, access_code_id: 12, reason: null },
      ]),
    );
    renderTab();

    expect(await screen.findByText(/Not counted for Defense/)).toBeInTheDocument();
    expect(screen.getByText(/Not counted for Offense/)).toBeInTheDocument();
  });

  it('falls back to the generic label when the assignment cannot be resolved', async () => {
    // Access code deleted, or the assignments request failed. Results must
    // keep working with vaguer wording rather than blanking over a label.
    vi.spyOn(exclusionsApi, 'listQuizAssignments').mockRejectedValue(new Error('boom'));
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(
      dashboardWith([assignmentExclusion]),
    );
    renderTab();

    expect(await screen.findByText(/Not counted for one assignment/)).toBeInTheDocument();
    // ...and the rest of the row is intact.
    const row = screen.getByText(/3-tech attack/).closest('tr')!;
    expect(within(row).getByText('Excluded')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('renders one Restore per active exclusion when two overlap', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(
      dashboardWith([quizWideExclusion, assignmentExclusion]),
    );
    renderTab();

    // Two separate decisions, shown as two - collapsing them into one toggle
    // is what would make Restore look broken.
    await screen.findByText(/Not counted for all assignments/);
    expect(screen.getByText(/Not counted for Defense/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Restore' })).toHaveLength(2);
  });

  it('says the question is STILL excluded when another rule remains', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(
      dashboardWith([quizWideExclusion, assignmentExclusion]),
    );
    vi.spyOn(exclusionsApi, 'restoreQuestionExclusion').mockResolvedValue({
      restored: { ...quizWideExclusion, restored_at: '2026-08-14T01:00:00Z', is_active: false },
      still_excluded_by: [assignmentExclusion],
    });
    renderTab();
    await screen.findByText(/Not counted for all assignments/);

    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Restore' })[0]);

    // The single most misleading thing this feature could do is report success
    // here while the question still does not count.
    expect(await screen.findByText(/Still excluded by another rule/)).toBeInTheDocument();
  });

  it('reports nothing further when the last exclusion is restored', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(
      dashboardWith([assignmentExclusion]),
    );
    vi.spyOn(exclusionsApi, 'restoreQuestionExclusion').mockResolvedValue({
      restored: { ...assignmentExclusion, restored_at: '2026-08-14T01:00:00Z', is_active: false },
      still_excluded_by: [],
    });
    renderTab();
    await screen.findByText(/Not counted for Defense/);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(exclusionsApi.restoreQuestionExclusion).toHaveBeenCalledWith(1, 7, 5));
    expect(screen.queryByText(/Still excluded by another rule/)).not.toBeInTheDocument();
  });

  it('opens the confirmation dialog rather than excluding on one click', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(dashboardWith([]));
    const excludeSpy = vi.spyOn(exclusionsApi, 'excludeQuestion');
    renderTab();

    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: /Don’t count this/ }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // Nothing happens until the coach confirms a scope.
    expect(excludeSpy).not.toHaveBeenCalled();
  });
});
