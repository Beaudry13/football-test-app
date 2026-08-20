/** Multi-Select M4 - the coach's expanded response, which shows the whole set.
 *
 * THE BUG THIS FIXES. `answers.selected_option_id` is NULL on every
 * "Select all that apply" answer by construction, so the row resolved it,
 * found nothing, and printed "No answer" over three ticked boxes.
 *
 * ORDER IS THE QUESTION'S, NOT THE PLAYER'S. `selected_option_ids` arrives
 * sorted by id, which means nothing to a reader; the delivered option list
 * decides. That is the same rule the backend applies to the player's results
 * page, the CSV and the PDF, which is why all four agree.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ResponseRow } from './ResponseRow';
import * as authContext from '../../auth/AuthContext';
import type { Answer, Coach, DeliveredQuestion, PlayerResponse, Quiz } from '../../api/types';

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
  updated_at: '2026-01-01T00:00:00Z',
};

/** IN DELIVERED ORDER, and deliberately not in id order - Nickel (id 30)
 *  precedes Boundary Safety (id 40) here only because the question put it
 *  there. */
const DELIVERED_OPTIONS = [
  { id: 10, option_text: 'Mike', is_correct_answer: true },
  { id: 20, option_text: 'Will', is_correct_answer: false },
  { id: 30, option_text: 'Nickel', is_correct_answer: true },
  { id: 40, option_text: 'Boundary Safety', is_correct_answer: true },
];

function delivered(overrides: Partial<DeliveredQuestion> = {}): DeliveredQuestion {
  return {
    question_id: 5,
    question_number: 1,
    question_text: 'Who is in the pressure?',
    question_type: 'multiple_choice',
    allows_multiple_answers: true,
    options: DELIVERED_OPTIONS,
    image: null,
    from_snapshot: true,
    ...overrides,
  };
}

function answer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: 100,
    question_id: 5,
    answer_text: null,
    selected_option_id: null,
    selected_option_ids: [10, 30, 40],
    is_correct: true,
    coach_feedback: null,
    graded_at: null,
    graded_by_username: null,
    ...overrides,
  };
}

/** THE LIVE QUESTION AS IT STANDS TODAY - every option renamed, so any
 *  surface that read it instead of the delivered record announces itself. */
const liveQuestion = {
  id: 5,
  quiz_id: 1,
  question_text: 'Who is in the pressure? (rewritten)',
  question_type: 'multiple_choice' as const,
  position: 0,
  allows_multiple_answers: true,
  image: null,
  options: [
    { id: 10, question_id: 5, option_text: 'MIKE (edited)', is_correct_answer: true, position: 0 },
    { id: 20, question_id: 5, option_text: 'WILL (edited)', is_correct_answer: false, position: 1 },
    { id: 30, question_id: 5, option_text: 'NICKEL (edited)', is_correct_answer: true, position: 2 },
    {
      id: 40,
      question_id: 5,
      option_text: 'BOUNDARY SAFETY (edited)',
      is_correct_answer: true,
      position: 3,
    },
  ],
};

async function expand(response: Partial<PlayerResponse>, quizOverrides: Partial<Quiz> = {}) {
  render(
    <MemoryRouter>
      <ResponseRow
        quiz={{ ...quiz, ...quizOverrides }}
        response={{
          id: 7,
          quiz_id: 1,
          access_code_id: 9,
          player_name: 'Jordan Smith',
          display_name: 'Jordan Smith',
          submitted_at: '2026-01-01T00:05:00Z',
          answers: [answer()],
          delivered_questions: [delivered()],
          ...response,
        }}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: /expand answers/i }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    coach,
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    registerWithInvite: vi.fn(),
    registerWithBetaInvite: vi.fn(),
    logout: vi.fn(),
  });
});

describe('a set answer', () => {
  it('shows every selection instead of "No answer"', async () => {
    await expand({});

    expect(screen.getByText('Mike; Nickel; Boundary Safety')).toBeInTheDocument();
    expect(screen.queryByText('No answer')).not.toBeInTheDocument();
  });

  it('lists them in DELIVERED order, whatever order the ids arrive in', async () => {
    await expand({ answers: [answer({ selected_option_ids: [40, 10, 30] })] });

    expect(screen.getByText('Mike; Nickel; Boundary Safety')).toBeInTheDocument();
  });

  it('uses the DELIVERED wording even when the live question was rewritten', async () => {
    // The live quiz carries a correction made after this player answered. It
    // must not reach a record they already have.
    await expand({}, { questions: [liveQuestion] });

    expect(screen.getByText('Mike; Nickel; Boundary Safety')).toBeInTheDocument();
    expect(screen.queryByText(/edited/)).not.toBeInTheDocument();
  });

  it('shows a partial selection exactly as it was made', async () => {
    await expand({
      answers: [answer({ selected_option_ids: [20], is_correct: false })],
    });

    expect(screen.getByText('Will')).toBeInTheDocument();
  });

  it('still says "No answer" when nothing was selected', async () => {
    await expand({
      answers: [answer({ selected_option_ids: [], is_correct: null })],
    });

    expect(screen.getByText('No answer')).toBeInTheDocument();
  });
});

describe('single choice is untouched', () => {
  it('still resolves the one selected option', async () => {
    await expand({
      answers: [
        answer({ selected_option_id: 20, selected_option_ids: [20], is_correct: false }),
      ],
      delivered_questions: [delivered({ allows_multiple_answers: false })],
    });

    expect(screen.getByText('Will')).toBeInTheDocument();
  });

  it('ignores a stray selection set on a single-choice answer', async () => {
    // The join table holds a row for single-choice answers too. The column is
    // what this format has always been read from, and M4 does not change that.
    await expand({
      answers: [
        answer({ selected_option_id: 10, selected_option_ids: [10, 30], is_correct: true }),
      ],
      delivered_questions: [delivered({ allows_multiple_answers: false })],
    });

    expect(screen.getByText('Mike')).toBeInTheDocument();
    expect(screen.queryByText('Mike; Nickel')).not.toBeInTheDocument();
  });
});

describe('a payload with no delivered record', () => {
  it('falls back to the live question rather than showing nothing', async () => {
    // Pre-Phase-4a responses carry no delivered_questions. The live quiz is a
    // COMPATIBILITY FALLBACK - it is what this view has always shown for such
    // a response, and showing "No answer" instead would be a regression for
    // exactly the attempts that have no record to defend them.
    await expand(
      { answers: [answer({ selected_option_ids: [10, 30] })], delivered_questions: [] },
      { questions: [liveQuestion] },
    );

    expect(screen.getByText('MIKE (edited); NICKEL (edited)')).toBeInTheDocument();
  });
});
