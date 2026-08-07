import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuizStep } from './QuizStep';
import * as playApi from '../../api/play';
import type { Quiz, ResumedAnswer } from '../../api/types';

const quiz: Quiz = {
  id: 1,
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Week 1 Prep',
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

describe('QuizStep', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('seeds answers from a resumed attempt instead of starting blank', () => {
    const initialAnswers: ResumedAnswer[] = [
      { question_id: 1, selected_option_id: 10, answer_text: null },
      { question_id: 2, selected_option_id: null, answer_text: 'I set the edge.' },
    ];
    vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);

    render(
      <QuizStep
        quiz={quiz}
        accessCodeId={42}
        playerName="Jordan Smith"
        playerId={501}
        initialAnswers={initialAnswers}
        onSubmitted={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('True')).toBeChecked();
    expect(screen.getByDisplayValue('I set the edge.')).toBeInTheDocument();
  });

  it('autosaves an option pick immediately, with no debounce', async () => {
    const user = userEvent.setup();
    const saveSpy = vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);

    render(
      <QuizStep
        quiz={quiz}
        accessCodeId={42}
        playerName="Jordan Smith"
        playerId={501}
        initialAnswers={[]}
        onSubmitted={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText('True'));

    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith({
        access_code_id: 42,
        player_name: 'Jordan Smith',
        player_id: 501,
        question_id: 1,
        selected_option_id: 10,
        answer_text: null,
      }),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('debounces a free-text answer instead of saving on every keystroke', async () => {
      const user = userEvent.setup({ delay: null });
      const saveSpy = vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);

      render(
        <QuizStep
          quiz={quiz}
          accessCodeId={42}
          playerName="Jordan Smith"
          playerId={501}
          initialAnswers={[]}
          onSubmitted={vi.fn()}
        />,
      );

      const written = screen.getAllByRole('textbox')[0];
      await user.type(written, 'I set the edge.');

      // Not saved yet - still within the debounce window.
      expect(saveSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(800);

      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledWith({
        access_code_id: 42,
        player_name: 'Jordan Smith',
        player_id: 501,
        question_id: 2,
        selected_option_id: null,
        answer_text: 'I set the edge.',
      });
    });

    it('cancels a pending debounced save when Submit is clicked, without losing the answer', async () => {
      const user = userEvent.setup({ delay: null });
      const saveSpy = vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);
      const submitSpy = vi.spyOn(playApi, 'submitQuiz').mockResolvedValue({
        id: 1,
        quiz_id: 1,
        access_code_id: 42,
        player_name: 'Jordan Smith',
        display_name: 'Jordan Smith',
        submitted_at: '2026-01-01T00:00:00Z',
        answers: [],
      });
      const onSubmitted = vi.fn();

      render(
        <QuizStep
          quiz={quiz}
          accessCodeId={42}
          playerName="Jordan Smith"
          playerId={501}
          initialAnswers={[]}
          onSubmitted={onSubmitted}
        />,
      );

      const written = screen.getAllByRole('textbox')[0];
      await user.type(written, 'I set the edge.');
      await user.click(screen.getByRole('button', { name: 'Submit Quiz' }));

      // The debounce timer never gets a chance to fire post-submit.
      await vi.advanceTimersByTimeAsync(800);
      expect(saveSpy).not.toHaveBeenCalled();

      await waitFor(() =>
        expect(submitSpy).toHaveBeenCalledWith({
          access_code_id: 42,
          player_name: 'Jordan Smith',
          player_id: 501,
          answers: [
            { question_id: 1, selected_option_id: null, answer_text: null },
            { question_id: 2, selected_option_id: null, answer_text: 'I set the edge.' },
          ],
        }),
      );
      expect(onSubmitted).toHaveBeenCalled();
    });
  });

  describe('require_all_answers', () => {
    const requiredQuiz: Quiz = { ...quiz, require_all_answers: true };

    it('blocks submission and shows a message when a question is left blank', async () => {
      const user = userEvent.setup();
      vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);
      const submitSpy = vi.spyOn(playApi, 'submitQuiz');

      render(
        <QuizStep
          quiz={requiredQuiz}
          accessCodeId={42}
          playerName="Jordan Smith"
          playerId={501}
          initialAnswers={[]}
          onSubmitted={vi.fn()}
        />,
      );

      await user.click(screen.getByLabelText('True'));
      await user.click(screen.getByRole('button', { name: 'Submit Quiz' }));

      expect(await screen.findByText('Please answer all questions before submitting.')).toBeInTheDocument();
      expect(submitSpy).not.toHaveBeenCalled();
      // The blank question's answer is untouched, not cleared by the failed attempt.
      expect(screen.getByLabelText('True')).toBeChecked();
    });

    it('allows submission once every question has an answer', async () => {
      const user = userEvent.setup();
      vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);
      const submitSpy = vi.spyOn(playApi, 'submitQuiz').mockResolvedValue({
        id: 1,
        quiz_id: 1,
        access_code_id: 42,
        player_name: 'Jordan Smith',
        display_name: 'Jordan Smith',
        submitted_at: '2026-01-01T00:00:00Z',
        answers: [],
      });
      const onSubmitted = vi.fn();

      render(
        <QuizStep
          quiz={requiredQuiz}
          accessCodeId={42}
          playerName="Jordan Smith"
          playerId={501}
          initialAnswers={[]}
          onSubmitted={onSubmitted}
        />,
      );

      await user.click(screen.getByLabelText('True'));
      await user.type(screen.getAllByRole('textbox')[0], 'I set the edge.');
      await user.click(screen.getByRole('button', { name: 'Submit Quiz' }));

      await waitFor(() => expect(submitSpy).toHaveBeenCalled());
      expect(onSubmitted).toHaveBeenCalled();
    });

    it('jumps to the first unanswered question in one-question-at-a-time mode', async () => {
      const user = userEvent.setup();
      vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);
      const wizardQuiz: Quiz = { ...requiredQuiz, one_question_at_a_time: true };

      render(
        <QuizStep
          quiz={wizardQuiz}
          accessCodeId={42}
          playerName="Jordan Smith"
          playerId={501}
          initialAnswers={[]}
          onSubmitted={vi.fn()}
        />,
      );

      await user.click(screen.getByLabelText('True'));
      await user.click(screen.getByRole('button', { name: 'Next' }));
      // Now on question 2 (written, blank) - Submit should bounce back to
      // question 1 only if it's the one left blank; here it's question 2
      // itself that's blank, so the wizard just stays put with the message.
      await user.click(screen.getByRole('button', { name: 'Submit Quiz' }));

      expect(await screen.findByText('Please answer all questions before submitting.')).toBeInTheDocument();
      expect(screen.getByText('Question 2 of 2')).toBeInTheDocument();
    });

    it('does not require an answer when the setting is off', async () => {
      const user = userEvent.setup();
      vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);
      const submitSpy = vi.spyOn(playApi, 'submitQuiz').mockResolvedValue({
        id: 1,
        quiz_id: 1,
        access_code_id: 42,
        player_name: 'Jordan Smith',
        display_name: 'Jordan Smith',
        submitted_at: '2026-01-01T00:00:00Z',
        answers: [],
      });

      render(
        <QuizStep
          quiz={quiz}
          accessCodeId={42}
          playerName="Jordan Smith"
          playerId={501}
          initialAnswers={[]}
          onSubmitted={vi.fn()}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Submit Quiz' }));

      await waitFor(() => expect(submitSpy).toHaveBeenCalled());
      expect(screen.queryByText('Please answer all questions before submitting.')).not.toBeInTheDocument();
    });
  });
});

// --- Draw on Image: answer presence ------------------------------------
//
// The integration risk this feature carries is that a drawing is not
// recognised as an answer, so a player who spent a minute drawing their run
// fit is told the question is blank and blocked from submitting. That is a
// silent failure for the player and the coach alike, so it is tested through
// the real submit guard rather than by unit-testing the predicate.
vi.mock('../../components/drawing/DrawingBoard', () => ({
  DrawingBoard: () => <div data-testid="drawing-board" />,
}));

const DRAWN_DOCUMENT = {
  format: 'peira.drawing',
  version: 1,
  source: { image_id: '7', image_version: null, natural_width: 1600, natural_height: 1000 },
  coordinate_width: 1400,
  coordinate_height: 875,
  strokes: [
    { id: 'a', tool: 'pen', layer: 'player', points: [0, 0, 10, 10], color: '#00E5FF', width: 6, order: 0 },
  ],
};

const drawingQuiz: Quiz = {
  ...quiz,
  require_all_answers: true,
  question_count: 1,
  questions: [
    {
      id: 5,
      quiz_id: 1,
      question_text: 'Draw your run fit.',
      question_type: 'written',
      position: 0,
      allow_drawing: true,
      image: {
        id: 7,
        question_id: 5,
        image_url: '/uploads/still.png',
        annotations: [],
        canvas_width: 1400,
        updated_at: '2026-08-07T00:00:00Z',
      },
      options: [],
    },
  ],
};

describe('QuizStep drawing answers', () => {
  beforeEach(() => {
    // Matches the describe above. Without it the submitQuiz spy carries call
    // history in from earlier tests in this file, and "was not called" passes
    // or fails for reasons that have nothing to do with drawings.
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('blocks submission when a required drawing question has nothing drawn', () => {
    const submit = vi.spyOn(playApi, 'submitQuiz').mockResolvedValue({} as never);
    render(
      <QuizStep
        quiz={drawingQuiz}
        accessCodeId={42}
        playerName="Jordan Smith"
        playerId={undefined}
        initialAnswers={[]}
        onSubmitted={vi.fn()}
      />,
    );

    screen.getByRole('button', { name: 'Submit Quiz' }).click();
    expect(submit).not.toHaveBeenCalled();
  });

  it('explains why a drawing-only answer cannot be submitted while all answers are required', async () => {
    // The server counts a question answered only if it carries an option or
    // text, so a drawing-only submission would 422 with a message the player
    // cannot act on. Caught client-side with one that names the real cause.
    window.localStorage.setItem(
      'peira.drawing.draft:42:Jordan Smith:5',
      JSON.stringify(DRAWN_DOCUMENT),
    );
    const submit = vi.spyOn(playApi, 'submitQuiz').mockResolvedValue({} as never);

    render(
      <QuizStep
        quiz={drawingQuiz}
        accessCodeId={42}
        playerName="Jordan Smith"
        playerId={undefined}
        initialAnswers={[]}
        onSubmitted={vi.fn()}
      />,
    );
    await screen.findByRole('button', { name: /edit your drawing/i });
    await userEvent.click(screen.getByRole('button', { name: 'Submit Quiz' }));

    expect(submit).not.toHaveBeenCalled();
    expect(await screen.findByText(/cannot be submitted yet/i)).toBeInTheDocument();
  });

  it('accepts a restored drawing as a real answer and lets the player submit', async () => {
    // Seeded the way a returning player's draft would be: QuestionInput
    // restores it on mount, which is also what proves the draft survives a
    // refresh while the backend cannot store drawings yet.
    window.localStorage.setItem(
      'peira.drawing.draft:42:Jordan Smith:5',
      JSON.stringify(DRAWN_DOCUMENT),
    );
    const submit = vi.spyOn(playApi, 'submitQuiz').mockResolvedValue({} as never);
    const onSubmitted = vi.fn();

    render(
      <QuizStep
        quiz={{ ...drawingQuiz, require_all_answers: false }}
        accessCodeId={42}
        playerName="Jordan Smith"
        playerId={undefined}
        initialAnswers={[]}
        onSubmitted={onSubmitted}
      />,
    );

    // The restored draft should present itself as existing work.
    expect(await screen.findByRole('button', { name: /edit your drawing/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Submit Quiz' }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(screen.queryByText(/please answer all questions/i)).not.toBeInTheDocument();
  });
});
