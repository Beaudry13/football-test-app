import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuizStep } from './QuizStep';
import { PracticeCompleteStep } from './PracticeCompleteStep';
import { summarisePractice } from './practiceSummary';
import * as playApi from '../../api/play';
import type { PracticeFeedback, Quiz } from '../../api/types';

const quiz: Quiz = {
  id: 1,
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Install Reps',
  description: null,
  one_question_at_a_time: false,
  require_all_answers: false,
  folder_id: null,
  question_count: 2,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  questions: [
    {
      id: 1,
      quiz_id: 1,
      question_text: 'Is this cover 2?',
      question_type: 'true_false',
      position: 0,
      image: null,
      options: [
        { id: 10, question_id: 1, option_text: 'True', position: 0 },
        { id: 11, question_id: 1, option_text: 'False', position: 1 },
      ],
    },
    {
      id: 2,
      quiz_id: 1,
      question_text: 'Describe your assignment.',
      question_type: 'written',
      position: 1,
      image: null,
      options: [],
    },
  ],
};

function renderPractice(props: Partial<Parameters<typeof QuizStep>[0]> = {}) {
  return render(
    <QuizStep
      quiz={quiz}
      accessCodeId={42}
      playerName="Jordan Smith"
      playerId={undefined}
      initialAnswers={[]}
      mode="PRACTICE"
      initialFeedback={[]}
      onSubmitted={vi.fn()}
      onPracticeComplete={vi.fn()}
      {...props}
    />,
  );
}

const CORRECT: PracticeFeedback = {
  question_id: 1,
  auto_gradable: true,
  is_correct: true,
  answer_explanation: null,
};

describe('Practice Mode player flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);
  });

  it('tells the player up front that this does not count', () => {
    renderPractice();

    expect(screen.getByText('Practice')).toBeInTheDocument();
    expect(screen.getByText(/does not count toward your grades/i)).toBeInTheDocument();
  });

  it('offers no Check Answer until the question has been answered', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'checkAnswer').mockResolvedValue(CORRECT);
    renderPractice();

    const buttons = screen.getAllByRole('button', { name: 'Check Answer' });
    expect(buttons[0]).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'True' }));

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Check Answer' })[0]).toBeEnabled(),
    );
  });

  it('shows the verdict and the coach explanation once checked', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'checkAnswer').mockResolvedValue({
      ...CORRECT,
      answer_explanation: 'Two deep safeties means Cover 2.',
    });
    renderPractice();

    await user.click(screen.getByRole('radio', { name: 'True' }));
    await user.click(screen.getAllByRole('button', { name: 'Check Answer' })[0]);

    expect(await screen.findByText('Correct')).toBeInTheDocument();
    expect(screen.getByText('Two deep safeties means Cover 2.')).toBeInTheDocument();
  });

  it('never invents a verdict for a question a coach must grade', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'checkAnswer').mockResolvedValue({
      question_id: 2,
      auto_gradable: false,
      is_correct: null,
      answer_explanation: null,
    });
    renderPractice();

    await user.type(screen.getByRole('textbox'), 'Set the edge.');
    await user.click(screen.getAllByRole('button', { name: 'Check Answer' })[1]);

    // Not "Correct", not "Not quite" - Peira cannot score a written answer
    // and says so rather than guessing.
    expect(await screen.findByText('Response recorded')).toBeInTheDocument();
    expect(screen.queryByText('Correct')).not.toBeInTheDocument();
    expect(screen.queryByText('Not quite')).not.toBeInTheDocument();
  });

  it('locks the answer once it has been checked', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'checkAnswer').mockResolvedValue(CORRECT);
    renderPractice();

    await user.click(screen.getByRole('radio', { name: 'True' }));
    await user.click(screen.getAllByRole('button', { name: 'Check Answer' })[0]);
    await screen.findByText('Correct');

    // Both options, not just the unpicked one: the player cannot change their
    // mind after reading the explanation.
    expect(screen.getByRole('radio', { name: 'True' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'False' })).toBeDisabled();
  });

  it('restores the lock and the feedback after a reload', () => {
    renderPractice({
      initialAnswers: [
        { question_id: 1, selected_option_id: 10, answer_text: null, checked: true },
      ],
      initialFeedback: [{ ...CORRECT, answer_explanation: 'Two deep safeties.' }],
    });

    // A refresh must not hand the player a second attempt at a question whose
    // explanation they have already read.
    expect(screen.getByText('Correct')).toBeInTheDocument();
    expect(screen.getByText('Two deep safeties.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'True' })).toBeDisabled();
  });

  it('ends on the practice screen, not the results page', async () => {
    const user = userEvent.setup();
    const onSubmitted = vi.fn();
    const onPracticeComplete = vi.fn();
    vi.spyOn(playApi, 'checkAnswer').mockResolvedValue(CORRECT);
    vi.spyOn(playApi, 'submitQuiz').mockResolvedValue({} as never);
    renderPractice({ onSubmitted, onPracticeComplete });

    await user.click(screen.getByRole('radio', { name: 'True' }));
    await user.click(screen.getAllByRole('button', { name: 'Check Answer' })[0]);
    await screen.findByText('Correct');
    await user.click(screen.getByRole('button', { name: 'Finish practice' }));

    await waitFor(() => expect(onPracticeComplete).toHaveBeenCalledWith([CORRECT]));
    // A practice attempt never becomes a result a coach reviews, so the
    // results screen must not be reached.
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('lets a player finish partway through even when the quiz requires every answer', async () => {
    const user = userEvent.setup();
    const submitSpy = vi.spyOn(playApi, 'submitQuiz').mockResolvedValue({} as never);
    renderPractice({ quiz: { ...quiz, require_all_answers: true } });

    await user.click(screen.getByRole('button', { name: 'Finish practice' }));

    // require_all_answers is an assessment rule. Reps are not an assessment.
    await waitFor(() => expect(submitSpy).toHaveBeenCalled());
    expect(screen.queryByText(/answer all questions/i)).not.toBeInTheDocument();
  });
});

describe('graded mode is untouched', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);
  });

  it('offers no Check Answer and no practice banner', () => {
    render(
      <QuizStep
        quiz={quiz}
        accessCodeId={42}
        playerName="Jordan Smith"
        playerId={undefined}
        initialAnswers={[]}
        onSubmitted={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Check Answer' })).not.toBeInTheDocument();
    expect(screen.queryByText('Practice')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit Quiz' })).toBeInTheDocument();
  });

  it('never calls the check endpoint', async () => {
    const user = userEvent.setup();
    const checkSpy = vi.spyOn(playApi, 'checkAnswer');
    render(
      <QuizStep
        quiz={quiz}
        accessCodeId={42}
        playerName="Jordan Smith"
        playerId={undefined}
        initialAnswers={[]}
        onSubmitted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('radio', { name: 'True' }));

    expect(checkSpy).not.toHaveBeenCalled();
  });
});

describe('summarisePractice', () => {
  it('scores only what Peira could actually check', () => {
    const summary = summarisePractice([
      { question_id: 1, auto_gradable: true, is_correct: true, answer_explanation: null },
      { question_id: 2, auto_gradable: true, is_correct: false, answer_explanation: null },
      { question_id: 3, auto_gradable: false, is_correct: null, answer_explanation: null },
    ]);

    expect(summary).toEqual({ scored: 2, correct: 1, awaitingCoach: 1, percent: 50 });
  });

  it('returns no percentage when nothing was auto-gradable', () => {
    const summary = summarisePractice([
      { question_id: 1, auto_gradable: false, is_correct: null, answer_explanation: null },
      { question_id: 2, auto_gradable: false, is_correct: null, answer_explanation: null },
    ]);

    // NOT 0%. Nothing was marked, so claiming a score would be inventing one -
    // the same rule the coach-facing analytics follow.
    expect(summary.percent).toBeNull();
    expect(summary.awaitingCoach).toBe(2);
  });

  it('is empty-safe', () => {
    expect(summarisePractice([])).toEqual({
      scored: 0,
      correct: 0,
      awaitingCoach: 0,
      percent: null,
    });
  });
});

describe('PracticeCompleteStep', () => {
  it('shows a score when there was something to score', () => {
    render(
      <PracticeCompleteStep
        feedback={[
          { question_id: 1, auto_gradable: true, is_correct: true, answer_explanation: null },
          { question_id: 2, auto_gradable: true, is_correct: false, answer_explanation: null },
        ]}
        onTryAgain={vi.fn()}
      />,
    );

    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(screen.getByText(/none of it counts toward your grades/i)).toBeInTheDocument();
  });

  it('shows no percentage when nothing was auto-gradable', () => {
    render(
      <PracticeCompleteStep
        feedback={[
          { question_id: 1, auto_gradable: false, is_correct: null, answer_explanation: null },
        ]}
        onTryAgain={vi.fn()}
      />,
    );

    expect(screen.getByText('Your answers were recorded.')).toBeInTheDocument();
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 question needs your coach/i)).toBeInTheDocument();
  });

  it('offers another go', async () => {
    const user = userEvent.setup();
    const onTryAgain = vi.fn();
    render(<PracticeCompleteStep feedback={[CORRECT]} onTryAgain={onTryAgain} />);

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onTryAgain).toHaveBeenCalled();
  });
});
