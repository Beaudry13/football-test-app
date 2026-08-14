import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResponseRow } from './ResponseRow';
import * as authContext from '../../auth/AuthContext';
import type {
  Coach,
  PlayerResponse,
  QuestionExclusion,
  Quiz,
  QuizAssignment,
} from '../../api/types';

/** The coach's EXPANDED per-player view.
 *
 * Before this, an excluded question here looked like any other - a bare
 * Correct/Incorrect - while the per-question breakdown, the player's own
 * results page, the PDF and the CSV all said it had been excluded. This was
 * the one surface that stayed silent.
 *
 * The rule it now follows: SAY IT NO LONGER COUNTS, KEEP EVERYTHING ELSE.
 * The stored grade and the player's answer are evidence and stay visible.
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

const quiz = {
  id: 1,
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Week 1 Prep',
  description: null,
  one_question_at_a_time: true,
  require_all_answers: false,
  folder_id: null,
  question_count: 2,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  questions: [
    {
      id: 7,
      quiz_id: 1,
      question_text: 'Which gap does the 3-tech attack?',
      question_type: 'multiple_choice',
      position: 11,
      options: [
        { id: 70, question_id: 7, option_text: 'B gap', position: 0 },
        { id: 71, question_id: 7, option_text: 'A gap', position: 1 },
      ],
      image: null,
    },
    {
      id: 8,
      quiz_id: 1,
      question_text: 'After the broken one',
      question_type: 'multiple_choice',
      position: 12,
      options: [{ id: 80, question_id: 8, option_text: 'Yes', position: 0 }],
      image: null,
    },
  ],
} as unknown as Quiz;

const response = {
  id: 1,
  quiz_id: 1,
  access_code_id: 11,
  player_name: 'Jordan Smith',
  display_name: 'Jordan Smith',
  player_id: 1,
  status: 'submitted',
  started_at: '2026-01-01T00:00:00Z',
  submitted_at: '2026-01-01T00:05:00Z',
  answers: [
    {
      id: 1,
      question_id: 7,
      answer_text: null,
      selected_option_id: 70,
      is_correct: true,
      coach_feedback: null,
      graded_at: null,
      graded_by_username: null,
      drawing: null,
    },
    {
      id: 2,
      question_id: 8,
      answer_text: null,
      selected_option_id: 80,
      is_correct: false,
      coach_feedback: null,
      graded_at: null,
      graded_by_username: null,
      drawing: null,
    },
  ],
} as unknown as PlayerResponse;

const ASSIGNMENTS = new Map<number, QuizAssignment>([
  [
    11,
    {
      access_code_id: 11,
      code: '8A9FXP',
      activated_at: '2026-08-12T15:00:00Z',
      is_active: false,
      is_valid: false,
      mode: 'GRADED',
      groups: [{ id: 1, name: 'SECONDARY' }],
      submitted_count: 16,
    },
  ],
]);

const assignmentExclusion: QuestionExclusion = {
  id: 5,
  question_id: 7,
  access_code_id: 11,
  scope: 'assignment',
  excluded_at: '2026-08-14T00:00:00Z',
  restored_at: null,
  is_active: true,
  excluded_by_username: 'coach1',
  reason: 'PICTURE ERROR',
};

const quizWideExclusion: QuestionExclusion = {
  ...assignmentExclusion,
  id: 6,
  access_code_id: null,
  scope: 'quiz',
  reason: null,
};

async function renderExpanded(exclusions?: Map<number, QuestionExclusion[]>) {
  render(
    <MemoryRouter>
      <ResponseRow
        quiz={quiz}
        response={response}
        questionNumbers={new Map([[7, 12], [8, 13]])}
        exclusionsByQuestion={exclusions}
        assignments={ASSIGNMENTS}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByLabelText(/Expand answers/));
}

describe('ResponseRow - excluded questions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAuth();
  });

  it('says the question is excluded, naming the assignment', async () => {
    await renderExpanded(new Map([[7, [assignmentExclusion]]]));

    expect(screen.getByText('Excluded from scoring')).toBeInTheDocument();
    expect(screen.getByText(/Not counted for SECONDARY/)).toBeInTheDocument();
    expect(screen.getByText(/8A9FXP/)).toBeInTheDocument();
  });

  it('keeps the stored verdict visible alongside it', async () => {
    // The grade is EVIDENCE. Exclusion says it no longer counts, not that it
    // never happened - and restoring must not leave the answer unmarked.
    await renderExpanded(new Map([[7, [assignmentExclusion]]]));

    expect(screen.getByText('Correct')).toBeInTheDocument();
  });

  it("keeps the player's original answer visible", async () => {
    await renderExpanded(new Map([[7, [assignmentExclusion]]]));

    expect(screen.getByText('B gap')).toBeInTheDocument();
  });

  it('leaves questions that still count completely untouched', async () => {
    await renderExpanded(new Map([[7, [assignmentExclusion]]]));

    expect(screen.getByText('After the broken one')).toBeInTheDocument();
    expect(screen.getByText('Incorrect')).toBeInTheDocument();
    // Exactly one excluded marker, on the one excluded question.
    expect(screen.getAllByText('Excluded from scoring')).toHaveLength(1);
  });

  it('describes a quiz-wide exclusion as all assignments', async () => {
    await renderExpanded(new Map([[7, [quizWideExclusion]]]));

    expect(screen.getByText(/Not counted for all assignments/)).toBeInTheDocument();
  });

  it('shows both when an assignment and a quiz-wide exclusion overlap', async () => {
    await renderExpanded(new Map([[7, [quizWideExclusion, assignmentExclusion]]]));

    expect(screen.getByText(/Not counted for all assignments/)).toBeInTheDocument();
    expect(screen.getByText(/Not counted for SECONDARY/)).toBeInTheDocument();
  });

  it('shows nothing unusual when no exclusion applies - the restored state', async () => {
    await renderExpanded(new Map());

    expect(screen.queryByText('Excluded from scoring')).not.toBeInTheDocument();
    expect(screen.queryByText(/Not counted for/)).not.toBeInTheDocument();
    expect(screen.getByText('Correct')).toBeInTheDocument();
  });

  it('never shows the coach-only reason here', async () => {
    // The reason belongs on the exclusion chip in the breakdown, where the
    // coach manages it - repeating it against every player's answer would
    // spread a private note across the whole results view.
    await renderExpanded(new Map([[7, [assignmentExclusion]]]));

    expect(screen.queryByText(/PICTURE ERROR/)).not.toBeInTheDocument();
  });

  it('numbers each answer with the quiz question number', async () => {
    await renderExpanded(new Map());

    expect(screen.getByText('Q12')).toBeInTheDocument();
    expect(screen.getByText('Q13')).toBeInTheDocument();
  });

  it('renders unnumbered when no numbering is supplied', async () => {
    // Optional on purpose, so existing callers and tests keep working.
    render(
      <MemoryRouter>
        <ResponseRow quiz={quiz} response={response} onChanged={vi.fn()} />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByLabelText(/Expand answers/));

    expect(screen.queryByText(/^Q\d+$/)).not.toBeInTheDocument();
    expect(screen.getByText('Which gap does the 3-tech attack?')).toBeInTheDocument();
  });
});


describe('ResponseRow - the summary "N correct" badge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAuth();
  });

  function renderCollapsed(exclusions?: Map<number, QuestionExclusion[]>) {
    render(
      <MemoryRouter>
        <ResponseRow
          quiz={quiz}
          response={response}
          questionNumbers={new Map([[7, 12], [8, 13]])}
          exclusionsByQuestion={exclusions}
          assignments={ASSIGNMENTS}
          onChanged={vi.fn()}
        />
      </MemoryRouter>,
    );
  }

  it('counts every correct answer when nothing is excluded', () => {
    renderCollapsed(new Map());

    // Q7 correct, Q8 incorrect.
    expect(screen.getByText('1 correct')).toBeInTheDocument();
  });

  it('DROPS a correct answer whose question is excluded', () => {
    // The badge is a score: it must mean "correct answers that currently
    // count", not a tally of stored verdicts. Q7 was correct and is now
    // excluded, so the summary falls to zero.
    renderCollapsed(new Map([[7, [assignmentExclusion]]]));

    expect(screen.getByText('0 correct')).toBeInTheDocument();
    expect(screen.queryByText('1 correct')).not.toBeInTheDocument();
  });

  it('does not move when the excluded answer was INCORRECT', () => {
    // Q8 was already wrong, so it contributed nothing to begin with.
    renderCollapsed(new Map([[8, [assignmentExclusion]]]));

    expect(screen.getByText('1 correct')).toBeInTheDocument();
  });

  it('agrees with the expanded rows about the same player', async () => {
    // THE CONTRADICTION THIS FIXES: badge 1, expanded rows showing one
    // Correct-but-excluded, PDF 0. They must tell one story.
    renderCollapsed(new Map([[7, [assignmentExclusion]]]));

    expect(screen.getByText('0 correct')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/Expand answers/));
    // The stored verdict is still there as evidence, next to the marker.
    expect(screen.getByText('Correct')).toBeInTheDocument();
    expect(screen.getByText('Excluded from scoring')).toBeInTheDocument();
  });

  it('stays a raw count when no exclusion data is supplied', () => {
    // Existing callers that pass no lookup keep the old behaviour rather than
    // silently under-reporting.
    render(
      <MemoryRouter>
        <ResponseRow quiz={quiz} response={response} onChanged={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByText('1 correct')).toBeInTheDocument();
  });
});
