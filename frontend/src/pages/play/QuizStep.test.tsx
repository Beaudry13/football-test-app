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
      { question_id: 1, selected_option_id: 10, answer_text: null, checked: false },
      { question_id: 2, selected_option_id: null, answer_text: 'I set the edge.', checked: false },
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
            { question_id: 1, selected_option_id: null, answer_text: null, drawing: null },
            { question_id: 2, selected_option_id: null, answer_text: 'I set the edge.', drawing: null },
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
  // The real board builds a Fabric canvas jsdom cannot back. This stands in
  // for the one interaction these tests need: the player drawing another
  // stroke, which is what drives autosave.
  DrawingBoard: (props: { document: unknown; onChange: (d: unknown) => void }) => (
    <div data-testid="drawing-board">
      <button
        type="button"
        onClick={() => {
          const doc = props.document as { strokes: unknown[] };
          props.onChange({ ...doc, strokes: [...doc.strokes, { ...(doc.strokes[0] as object) }] });
        }}
      >
        add stroke
      </button>
    </div>
  ),
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
      question_type: 'draw_response',
      position: 0,
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

  it('accepts a restored drawing as a real answer and lets the player submit', async () => {
    // Seeded the way a returning player's draft would be. localStorage stays
    // the resilience layer even though the server is now authoritative: it is
    // what survives a dead network, and it is what QuestionInput restores.
    window.localStorage.setItem(
      'peira.drawing.draft:42:Jordan Smith:5',
      JSON.stringify(DRAWN_DOCUMENT),
    );
    const submit = vi.spyOn(playApi, 'submitQuiz').mockResolvedValue({} as never);
    const onSubmitted = vi.fn();

    render(
      <QuizStep
        quiz={drawingQuiz}
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

describe('QuizStep drawing autosave', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  function renderWithDraft() {
    window.localStorage.setItem(
      'peira.drawing.draft:42:Jordan Smith:5',
      JSON.stringify(DRAWN_DOCUMENT),
    );
    return render(
      <QuizStep
        quiz={drawingQuiz}
        accessCodeId={42}
        playerName="Jordan Smith"
        playerId={undefined}
        initialAnswers={[]}
        onSubmitted={vi.fn()}
      />,
    );
  }

  it('autosaves a restored drawing to the server, debounced', async () => {
    const save = vi.spyOn(playApi, 'saveDrawing').mockResolvedValue({
      revision: 1,
      updated_at: '2026-08-07T00:00:00Z',
    });
    renderWithDraft();
    await screen.findByRole('button', { name: /edit your drawing/i });

    // Nothing yet - the drawing debounce is deliberately long, since a player
    // mid-stroke changes the document continuously.
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        access_code_id: 42,
        player_name: 'Jordan Smith',
        question_id: 5,
        // First save has no revision to check against.
        base_revision: null,
      }),
    );
  });

  it('sends the revision the server last confirmed on the next save', async () => {
    const save = vi
      .spyOn(playApi, 'saveDrawing')
      .mockResolvedValue({ revision: 4, updated_at: '2026-08-07T00:00:00Z' });
    renderWithDraft();
    await screen.findByRole('button', { name: /edit your drawing/i });
    await vi.advanceTimersByTimeAsync(1500);

    // A second change, now that the server has answered with revision 4.
    await userEvent.click(screen.getByRole('button', { name: /edit your drawing/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'add stroke' }));
    await vi.advanceTimersByTimeAsync(1500);

    const lastCall = save.mock.calls.at(-1)?.[0];
    expect(lastCall?.base_revision).toBe(4);
  });

  it('does not save an empty document, so opening the board writes nothing', async () => {
    // Opening the board creates a 0-stroke document. Persisting it wrote a
    // row purely so the player's first real stroke could conflict with it -
    // found in end-to-end testing, where every drawing showed "Couldn't save".
    const save = vi.spyOn(playApi, 'saveDrawing').mockResolvedValue({
      revision: 1,
      updated_at: '2026-08-07T00:00:00Z',
    });
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
    await userEvent.click(screen.getByRole('button', { name: /draw your answer/i }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(save).not.toHaveBeenCalled();
  });

  it('keeps the drawing and warns the player when another device won the race', async () => {
    // A 409 must never discard the player's work: submit is authoritative and
    // will still carry it. They are told, not silently overwritten.
    vi.spyOn(playApi, 'saveDrawing').mockRejectedValue(
      new Error('This drawing was updated on another device'),
    );
    renderWithDraft();
    await screen.findByRole('button', { name: /edit your drawing/i });
    await vi.advanceTimersByTimeAsync(1500);

    expect(await screen.findByText(/changed on another device/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit your drawing/i })).toBeInTheDocument();
  });

  it('carries the drawing document in the submit payload', async () => {
    // The safety net: one failed autosave must not cost the player the answer.
    vi.spyOn(playApi, 'saveDrawing').mockRejectedValue(new Error('network down'));
    const submit = vi.spyOn(playApi, 'submitQuiz').mockResolvedValue({} as never);
    renderWithDraft();
    await screen.findByRole('button', { name: /edit your drawing/i });
    await vi.advanceTimersByTimeAsync(1500);

    await userEvent.click(screen.getByRole('button', { name: 'Submit Quiz' }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    const payload = submit.mock.calls[0][0];
    expect(payload.answers[0].drawing).toMatchObject({ format: 'peira.drawing' });
  });
});

// ---------------------------------------------------------------------------
// require_all_answers under a RANDOMIZED presented order.
//
// This is the one place presentation and identity meet. The "jump to the first
// missing question" logic finds a question by id, then converts it to an index
// - and that index must be into the PRESENTED array, not the authored one. If
// it ever indexed the authored order, a randomized attempt would send the
// player to a question they had already answered while the blank one stayed
// hidden.
// ---------------------------------------------------------------------------

describe('require_all_answers with a randomized question order', () => {
  /** Four questions, authored 1..4, each identifiable on screen. */
  const fourQuestions: Quiz = {
    ...quiz,
    require_all_answers: true,
    one_question_at_a_time: true,
    question_count: 4,
    questions: [1, 2, 3, 4].map((id) => ({
      id,
      quiz_id: 1,
      question_text: `Authored ${id}`,
      question_type: 'written' as const,
      position: id - 1,
      image: null,
      options: [],
    })),
  };

  function renderReordered(order: number[], initialAnswers: ResumedAnswer[] = []) {
    return render(
      <QuizStep
        quiz={fourQuestions}
        questionOrder={order}
        accessCodeId={42}
        playerName="Jordan Smith"
        playerId={501}
        initialAnswers={initialAnswers}
        onSubmitted={vi.fn()}
      />,
    );
  }

  beforeEach(() => {
    vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);
  });

  it('presents the questions in the frozen order, not the authored one', () => {
    renderReordered([4, 3, 2, 1]);

    // First screen is authored #4 because the attempt was given that order.
    expect(screen.getByText('Authored 4')).toBeInTheDocument();
    expect(screen.queryByText('Authored 1')).not.toBeInTheDocument();
  });

  it('jumps to the first missing question in PRESENTED order, not authored order', async () => {
    const user = userEvent.setup();
    // Presented 4, 3, 2, 1. Everything answered except authored #3, which is
    // SECOND in the presented order but THIRD by authored position - so an
    // authored-order jump would land somewhere else entirely.
    renderReordered(
      [4, 3, 2, 1],
      [
        { question_id: 4, selected_option_id: null, answer_text: 'a', checked: false },
        { question_id: 2, selected_option_id: null, answer_text: 'b', checked: false },
        { question_id: 1, selected_option_id: null, answer_text: 'c', checked: false },
      ],
    );

    // Walk to the end so Submit is reachable.
    for (let i = 0; i < 3; i += 1) {
      await user.click(screen.getByRole('button', { name: 'Next' }));
    }
    await user.click(screen.getByRole('button', { name: 'Submit Quiz' }));

    expect(
      await screen.findByText('Please answer all questions before submitting.'),
    ).toBeInTheDocument();
    // Landed on the blank question itself - identified by id, shown at its
    // PRESENTED index.
    expect(screen.getByText('Authored 3')).toBeInTheDocument();
    expect(screen.queryByText('Authored 4')).not.toBeInTheDocument();
  });

  it('uses question ids, so answers map to the right questions after reordering', async () => {
    const user = userEvent.setup();
    const saveSpy = vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);
    renderReordered([4, 3, 2, 1]);

    await user.type(screen.getByRole('textbox'), 'answer for four');
    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ question_id: 4 }),
      ),
    );
  });

  it('keeps the same order and the same missing question after a resume', async () => {
    const user = userEvent.setup();
    // A resume re-renders from the server's frozen order and the saved
    // answers - the identical inputs a refresh produces.
    const answers: ResumedAnswer[] = [
      { question_id: 4, selected_option_id: null, answer_text: 'a', checked: false },
      { question_id: 2, selected_option_id: null, answer_text: 'b', checked: false },
      { question_id: 1, selected_option_id: null, answer_text: 'c', checked: false },
    ];
    const { unmount } = renderReordered([4, 3, 2, 1], answers);
    expect(screen.getByText('Authored 4')).toBeInTheDocument();
    unmount();

    renderReordered([4, 3, 2, 1], answers);

    expect(screen.getByText('Authored 4')).toBeInTheDocument();
    for (let i = 0; i < 3; i += 1) {
      await user.click(screen.getByRole('button', { name: 'Next' }));
    }
    await user.click(screen.getByRole('button', { name: 'Submit Quiz' }));

    expect(
      await screen.findByText('Please answer all questions before submitting.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Authored 3')).toBeInTheDocument();
  });

  it('ignores a stored id whose question was deleted, and appends a new one', async () => {
    const user = userEvent.setup();
    // The attempt froze [4, 3, 2, 1]. Since then #3 was deleted and #9 added.
    // Reconciliation should present 4, 2, 1 then 9 - and the missing-question
    // check must never look for the deleted one.
    const changedQuiz: Quiz = {
      ...fourQuestions,
      questions: [
        ...fourQuestions.questions!.filter((q) => q.id !== 3),
        {
          id: 9,
          quiz_id: 1,
          question_text: 'Authored 9',
          question_type: 'written' as const,
          position: 9,
          image: null,
          options: [],
        },
      ],
    };

    render(
      <QuizStep
        quiz={changedQuiz}
        questionOrder={[4, 3, 2, 1]}
        accessCodeId={42}
        playerName="Jordan Smith"
        playerId={501}
        initialAnswers={[
          { question_id: 4, selected_option_id: null, answer_text: 'a', checked: false },
          { question_id: 2, selected_option_id: null, answer_text: 'b', checked: false },
          { question_id: 1, selected_option_id: null, answer_text: 'c', checked: false },
        ]}
        onSubmitted={vi.fn()}
      />,
    );

    // Deleted question is simply gone from the sequence.
    expect(screen.getByText('Authored 4')).toBeInTheDocument();
    for (let i = 0; i < 3; i += 1) {
      await user.click(screen.getByRole('button', { name: 'Next' }));
    }
    // The appended question is last, and it is the one still unanswered.
    expect(screen.getByText('Authored 9')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Submit Quiz' }));
    expect(
      await screen.findByText('Please answer all questions before submitting.'),
    ).toBeInTheDocument();
    // Landed on the appended question, never on the deleted one.
    expect(screen.getByText('Authored 9')).toBeInTheDocument();
  });
});
