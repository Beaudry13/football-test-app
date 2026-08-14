import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExcludeQuestionDialog } from './ExcludeQuestionDialog';
import * as exclusionsApi from '../../api/questionExclusions';
import type { QuestionBreakdown, QuizAssignment } from '../../api/types';

/** THE SCOPE MUST NEVER BE GUESSED.
 *
 * The Results tab pools every assignment of a quiz, so "this assignment" is
 * ambiguous there. These tests pin the rule: with more than one assignment
 * the coach must choose, and quiz-wide is never reached by accident.
 */

const question: QuestionBreakdown = {
  question_id: 7,
  question_number: 7,
  question_text: 'Which gap does the 3-tech attack?',
  question_type: 'multiple_choice',
  answered_count: 5,
  correct_count: 1,
  incorrect_count: 4,
  ungraded_count: 0,
  is_excluded: false,
  exclusions: [],
};

const monday: QuizAssignment = {
  access_code_id: 11,
  code: 'MON111',
  activated_at: '2026-08-10T15:00:00Z',
  is_active: false,
  is_valid: false,
  mode: 'GRADED',
  groups: [{ id: 1, name: 'Defense' }],
  submitted_count: 12,
};

const tuesday: QuizAssignment = {
  access_code_id: 12,
  code: 'TUE222',
  activated_at: '2026-08-11T15:00:00Z',
  is_active: true,
  is_valid: true,
  mode: 'GRADED',
  groups: [{ id: 2, name: 'Offense' }],
  submitted_count: 9,
};

function renderDialog(onExcluded = vi.fn(), onCancel = vi.fn()) {
  render(
    <ExcludeQuestionDialog
      quizId={1}
      question={question}
      onCancel={onCancel}
      onExcluded={onExcluded}
    />,
  );
  return { onExcluded, onCancel };
}

describe('ExcludeQuestionDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(exclusionsApi, 'excludeQuestion').mockResolvedValue({
      id: 1,
      question_id: 7,
      access_code_id: 11,
      scope: 'assignment',
      excluded_at: '2026-08-14T00:00:00Z',
      restored_at: null,
      is_active: true,
      excluded_by_username: 'coach1',
    });
  });

  it('labels assignments from existing metadata, not database ids', async () => {
    vi.spyOn(exclusionsApi, 'listQuizAssignments').mockResolvedValue([monday, tuesday]);
    renderDialog();

    // Group name, submitted count and code - enough to tell Monday's Defense
    // session from Tuesday's Offense one.
    const option = await screen.findByRole('option', { name: /Defense/ });
    expect(option).toHaveTextContent('12 submitted');
    expect(option).toHaveTextContent('MON111');
    expect(screen.getByRole('option', { name: /Offense/ })).toBeInTheDocument();
  });

  it('does not preselect a scope when the quiz has several assignments', async () => {
    vi.spyOn(exclusionsApi, 'listQuizAssignments').mockResolvedValue([monday, tuesday]);
    renderDialog();
    await screen.findByRole('option', { name: /Defense/ });

    expect(screen.getByLabelText(/Remove it from scoring for/)).toHaveValue('');
    // ...and the coach cannot confirm until they pick one. Guessing which
    // delivery they meant is how Monday's fix rewrites Tuesday.
    expect(screen.getByRole('button', { name: /Exclude from scoring/ })).toBeDisabled();
  });

  it('preselects the only assignment when there is exactly one', async () => {
    vi.spyOn(exclusionsApi, 'listQuizAssignments').mockResolvedValue([monday]);
    renderDialog();
    await screen.findByRole('option', { name: /Defense/ });

    expect(screen.getByLabelText(/Remove it from scoring for/)).toHaveValue('11');
    expect(screen.getByRole('button', { name: /Exclude from scoring/ })).toBeEnabled();
  });

  it('sends the chosen assignment and the optional reason', async () => {
    vi.spyOn(exclusionsApi, 'listQuizAssignments').mockResolvedValue([monday, tuesday]);
    const { onExcluded } = renderDialog();
    await screen.findByRole('option', { name: /Defense/ });
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText(/Remove it from scoring for/), '12');
    await user.type(screen.getByLabelText(/Reason/), 'wrong answer key');
    await user.click(screen.getByRole('button', { name: /Exclude from scoring/ }));

    await waitFor(() =>
      expect(exclusionsApi.excludeQuestion).toHaveBeenCalledWith(1, 7, {
        access_code_id: 12,
        reason: 'wrong answer key',
      }),
    );
    expect(onExcluded).toHaveBeenCalled();
  });

  it('sends a null reason when the coach leaves it blank', async () => {
    vi.spyOn(exclusionsApi, 'listQuizAssignments').mockResolvedValue([monday]);
    renderDialog();
    await screen.findByRole('option', { name: /Defense/ });

    await userEvent.setup().click(screen.getByRole('button', { name: /Exclude from scoring/ }));

    await waitFor(() =>
      expect(exclusionsApi.excludeQuestion).toHaveBeenCalledWith(1, 7, {
        access_code_id: 11,
        reason: null,
      }),
    );
  });

  it('warns before a quiz-wide exclusion and sends a null access code', async () => {
    vi.spyOn(exclusionsApi, 'listQuizAssignments').mockResolvedValue([monday, tuesday]);
    renderDialog();
    await screen.findByRole('option', { name: /Defense/ });
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText(/Remove it from scoring for/), 'quiz-wide');

    // The broader choice earns a stronger warning - it rewrites history for
    // every past use of the quiz.
    expect(screen.getByText(/every past and future use of this quiz/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Exclude from scoring/ }));
    await waitFor(() =>
      expect(exclusionsApi.excludeQuestion).toHaveBeenCalledWith(1, 7, {
        access_code_id: null,
        reason: null,
      }),
    );
  });

  it('promises that answers are kept, because that is what a coach fears', async () => {
    vi.spyOn(exclusionsApi, 'listQuizAssignments').mockResolvedValue([monday]);
    renderDialog();
    await screen.findByRole('option', { name: /Defense/ });

    expect(screen.getByText(/Player answers are kept/i)).toBeInTheDocument();
    expect(screen.getByText(/undo this at any time/i)).toBeInTheDocument();
  });

  it('says so when the quiz has never been sent out', async () => {
    vi.spyOn(exclusionsApi, 'listQuizAssignments').mockResolvedValue([]);
    renderDialog();

    expect(await screen.findByText(/never been sent out/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Exclude from scoring/ })).toBeDisabled();
  });
});
