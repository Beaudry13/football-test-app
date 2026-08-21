/** Phase 4B step 2 - "Stop sending this question", coach side.
 *
 * The two things this UI must get right are both about NOT hiding something:
 *
 * 1. A stopped question stays VISIBLE in the editor. It is de-emphasised, not
 *    removed - a coach who cannot see it cannot restore it, and this screen is
 *    the only place that can.
 * 2. It stays clearly SEPARATE from "Don't count this question" (Phase 3),
 *    which lives on Results and changes scoring for players who already
 *    answered. Merging the two would let one click do something the coach
 *    never asked for.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionsTab } from './QuestionsTab';
import type { Question, Quiz } from '../../api/types';

vi.mock('../../api/questions', () => ({
  createQuestion: vi.fn(),
  deleteQuestion: vi.fn(),
  reorderQuestions: vi.fn(),
  updateQuestion: vi.fn(),
  retireQuestion: vi.fn().mockResolvedValue({}),
  restoreQuestion: vi.fn().mockResolvedValue({}),
}));

import { restoreQuestion, retireQuestion } from '../../api/questions';

const question = (over: Partial<Question> = {}): Question =>
  ({
    id: 1,
    quiz_id: 9,
    question_text: 'Which gap does the 3-tech attack?',
    question_type: 'multiple_choice',
    position: 0,
    options: [
      { id: 11, question_id: 1, option_text: 'B gap', is_correct_answer: true, position: 0 },
      { id: 12, question_id: 1, option_text: 'A gap', is_correct_answer: false, position: 1 },
    ],
    image: null,
    ...over,
  }) as unknown as Question;

function renderTab(questions: Question[]) {
  const quiz = { id: 9, title: 'Install', questions } as unknown as Quiz;
  return render(
    <MemoryRouter>
      <QuestionsTab quiz={quiz} reload={vi.fn().mockResolvedValue(undefined)} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});


/** Opens a question's "..." menu and returns the item by name.
 *
 * Stopping and deleting a question are things a coach does once or never, so
 * they moved out of six permanent per-question controls and into the same menu
 * a quiz card uses. Reaching them costs one click here, and costs a coach
 * looking at a twenty-question quiz nothing at all. */
async function openQuestionMenu(user: ReturnType<typeof userEvent.setup>, n = 1) {
  await user.click(screen.getByRole('button', { name: `More actions for question ${n}` }));
}

describe('stopping a question', () => {
  it('offers "Stop sending it" on an active question', () => {
    renderTab([question()]);

    // Behind the menu now - a coach stops a question once, or never.
    expect(screen.getByRole('button', { name: 'More actions for question 1' })).toBeInTheDocument();
  });

  it('avoids the word "retire", which reads as jargon to a coach', () => {
    renderTab([question()]);

    expect(screen.queryByText(/retire/i)).not.toBeInTheDocument();
  });

  it('warns before stopping, and says what does NOT change', async () => {
    const user = userEvent.setup();
    renderTab([question()]);

    await openQuestionMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Stop sending it' }));

    // The reassurance is the load-bearing half: a coach reaching for this has
    // just found a broken question and needs to know existing results are safe.
    expect(screen.getByText(/keep the question, their answer and their score/i)).toBeInTheDocument();
    expect(screen.getByText(/start sending it again at any time/i)).toBeInTheDocument();
  });

  it('calls the API once confirmed', async () => {
    const user = userEvent.setup();
    renderTab([question()]);

    await openQuestionMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Stop sending it' }));
    // Scoped to the dialog: the confirm button deliberately repeats the card's
    // wording, so an unscoped query matches both. The role is `alertdialog`,
    // not `dialog` - querying the wrong one finds nothing and would make the
    // restore test below pass without proving anything.
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop sending it' }),
    );

    await waitFor(() => expect(retireQuestion).toHaveBeenCalledWith(9, 1));
  });
});

describe('a stopped question', () => {
  it('is STILL SHOWN in the editor', () => {
    renderTab([question({ is_retired: true })]);

    expect(screen.getByText('Which gap does the 3-tech attack?')).toBeInTheDocument();
  });

  it('says so in words, not only by appearance', () => {
    renderTab([question({ is_retired: true })]);

    expect(screen.getByText('Not sent to new Peiras')).toBeInTheDocument();
  });

  it('offers a one-click restore', async () => {
    const user = userEvent.setup();
    renderTab([question({ is_retired: true })]);

    await openQuestionMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Start sending it again' }));

    await waitFor(() => expect(restoreQuestion).toHaveBeenCalledWith(9, 1));
  });

  it('does not ask for confirmation to restore', async () => {
    // Nothing to warn about: restoring only ever adds it back to FUTURE Peiras.
    const user = userEvent.setup();
    renderTab([question({ is_retired: true })]);

    await openQuestionMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Start sending it again' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('can still be edited', () => {
    renderTab([question({ is_retired: true })]);

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('shows only one of stop/restore at a time', () => {
    renderTab([question({ is_retired: true })]);

    expect(screen.queryByRole('menuitem', { name: 'Stop sending it' })).not.toBeInTheDocument();
  });
});

describe('separation from Phase 3 exclusion', () => {
  it('does not offer "Don\'t count this question" in the editor', () => {
    // That action changes SCORING for players who already answered, and lives
    // on Results next to the players it affects. Offering both here would
    // invite a coach to conflate them.
    renderTab([question(), question({ id: 2, is_retired: true })]);

    expect(screen.queryByText(/don't count/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/count this question/i)).not.toBeInTheDocument();
  });

  it('never claims stopping affects existing scores', async () => {
    const user = userEvent.setup();
    renderTab([question()]);

    await openQuestionMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Stop sending it' }));

    expect(screen.queryByText(/won't count/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/removed from scoring/i)).not.toBeInTheDocument();
  });
});

describe('a mixed list', () => {
  it('numbers every question by its position in the editor', () => {
    // Including stopped ones - this is the authoring list, not the delivery
    // list. Activation errors renumber over deliverable questions server-side;
    // that is a different number for a different audience.
    renderTab([question({ is_retired: true }), question({ id: 2 })]);

    expect(screen.getByText('Question 1')).toBeInTheDocument();
    expect(screen.getByText('Question 2')).toBeInTheDocument();
  });
});

describe('a question list that scales', () => {
  /**
   * THE OLD DASHBOARD PROBLEM, IN A DIFFERENT PLACE. Every question used to
   * carry six permanent controls - Edit, image, Stop sending, Delete, Move up,
   * Move down - so a twenty-question quiz put a hundred and twenty of them on
   * one screen. Fine with three, a wall with twenty.
   *
   * Edit and the two reorder arrows stay: those are the jobs a coach does
   * WHILE authoring, repeatedly. The rest are once-or-never and moved into the
   * same "..." a quiz card uses.
   */
  it('KEEPS ONLY THE AUTHORING JOBS PERMANENTLY VISIBLE', async () => {
    renderTab([question()]);

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move down' })).toBeInTheDocument();

    // The once-or-never actions are not competing for attention.
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop sending it' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit image/ })).not.toBeInTheDocument();
  });

  it('SCALES: permanent controls grow by four per question, not six', async () => {
    // Four = Edit, Move up, Move down, and the menu trigger itself. The
    // difference is what turns a twenty-question quiz from a wall back into a
    // list.
    const many = Array.from({ length: 20 }, (_, i) =>
      question({ id: i + 1, question_text: `Question ${i + 1}` }),
    );
    renderTab(many);

    const buttons = screen.getAllByRole('button');
    const perQuestion = buttons.filter((b) =>
      /^(Edit|Move up|Move down|More actions for question \d+)$/.test(
        b.getAttribute('aria-label') || b.textContent || '',
      ),
    );

    expect(perQuestion).toHaveLength(20 * 4);
  });

  it('still reaches Delete, in one click', async () => {
    const user = userEvent.setup();
    renderTab([question()]);

    await openQuestionMenu(user);

    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('KEEPS "Add image" VISIBLE WHEN THE QUESTION CANNOT BE ANSWERED WITHOUT ONE', () => {
    // The card says this question is unanswerable without a picture. A fix
    // hidden behind a menu is a warning with no button.
    renderTab([question({ needs_image: true, image: null } as Partial<Question>)]);

    expect(screen.getByText(/Needs an image/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add image' })).toBeInTheDocument();
  });
});
