/** Question-first grading, tested as the coach experiences it.
 *
 * The queue's rules are proven in gradingQueue.test.ts against the pure
 * functions. This file covers what the screen does with them: what a coach
 * sees, what a click writes, and what happens to a decision afterwards.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GradeResponsesPage } from './GradeResponsesPage';
import * as authModule from '../../auth/AuthContext';
import type { PlayerResponse, Quiz, QuizDashboard } from '../../api/types';

vi.mock('../../api/quizzes', () => ({ getQuiz: vi.fn() }));
vi.mock('../../api/grading', () => ({
  listResponses: vi.fn(),
  getQuizDashboard: vi.fn(),
  gradeAnswer: vi.fn().mockResolvedValue({}),
  listToGrade: vi.fn().mockResolvedValue([]),
}));
// The drawing engine renders to canvas, which jsdom cannot. Stubbed to
// something identifiable so the tests can assert the drawing IS presented and
// which image it was drawn over, without asserting pixels.
vi.mock('../../components/drawing/DrawingViewer', () => ({
  DrawingViewer: ({ imageUrl, alt, overlay }: { imageUrl: string; alt: string; overlay?: unknown }) => (
    <div data-testid="drawing" data-image={imageUrl} data-overlay={overlay ? 'on' : 'off'}>
      {alt}
    </div>
  ),
}));

import { getQuiz } from '../../api/quizzes';
import { getQuizDashboard, gradeAnswer, listResponses, listToGrade } from '../../api/grading';

const WRITTEN_Q = 11;
const DRAW_Q = 12;
const AUTO_Q = 13;
const EXCLUDED_Q = 14;

const quiz = (): Quiz =>
  ({
    id: 1,
    title: 'Install Week 2',
    questions: [
      {
        id: AUTO_Q,
        question_text: 'Cover 3 or Cover 4?',
        question_type: 'multiple_choice',
        options: [],
      },
      {
        id: WRITTEN_Q,
        question_text: 'What is your responsibility in Cover 3?',
        question_type: 'written',
        expected_answers: ['Hook/curl', '#3 vertical'],
        options: [],
      },
      {
        id: DRAW_Q,
        question_text: 'Draw your drop.',
        question_type: 'draw_response',
        options: [],
      },
      {
        id: EXCLUDED_Q,
        question_text: 'Explain the check.',
        question_type: 'written',
        options: [],
      },
    ],
  }) as unknown as Quiz;

let answerId = 100;
const answer = (question_id: number, is_correct: boolean | null, text: string, drawing = false) => ({
  id: answerId++,
  question_id,
  answer_text: text,
  selected_option_id: null,
  is_correct,
  coach_feedback: null,
  graded_at: null,
  graded_by_username: null,
  ...(drawing ? { drawing: { id: 1, answer_id: 1, document: { strokes: [] }, revision: 1 } } : {}),
});

const responses = (): PlayerResponse[] =>
  [
    {
      id: 1,
      display_name: 'Mike Beaudry',
      player_name: 'Mike Beaudry',
      answers: [
        answer(WRITTEN_Q, null, 'Hook to curl, eyes on #3'),
        answer(DRAW_Q, null, '', true),
        answer(AUTO_Q, true, ''),
        answer(EXCLUDED_Q, null, 'Something'),
      ],
      delivered_questions: [
        { question_id: DRAW_Q, image: { image_url: '/uploads/drop.jpg' } },
      ],
    },
    {
      id: 2,
      display_name: 'John Smith',
      player_name: 'John Smith',
      answers: [answer(WRITTEN_Q, null, 'Flat')],
      delivered_questions: [],
    },
  ] as unknown as PlayerResponse[];

const dashboard = (excluded: number[] = [EXCLUDED_Q]): QuizDashboard =>
  ({
    quiz_id: 1,
    question_breakdown: [
      { question_id: AUTO_Q, is_excluded: false, ungraded_count: 0, question_type: 'multiple_choice' },
      { question_id: WRITTEN_Q, is_excluded: false, ungraded_count: 2, question_type: 'written' },
      { question_id: DRAW_Q, is_excluded: false, ungraded_count: 1, question_type: 'draw_response' },
      {
        question_id: EXCLUDED_Q,
        is_excluded: excluded.includes(EXCLUDED_Q),
        ungraded_count: 1,
        question_type: 'written',
      },
    ],
    concept_breakdown: [],
    verification: null,
  }) as unknown as QuizDashboard;

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/quizzes/1/grade']}>
      <Routes>
        <Route path="/quizzes/:quizId/grade" element={<GradeResponsesPage />} />
        <Route path="/quizzes/:quizId" element={<div>RESULTS</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  answerId = 100;
  vi.mocked(getQuiz).mockResolvedValue(quiz());
  vi.mocked(listResponses).mockResolvedValue(responses());
  vi.mocked(getQuizDashboard).mockResolvedValue(dashboard());
  vi.mocked(gradeAnswer).mockResolvedValue({} as never);
  vi.mocked(listToGrade).mockResolvedValue([]);
});

describe('the question anchors the screen', () => {
  it('states the question once, however many answers there are', async () => {
    renderPage();

    // Two players answered it; the question is written on screen ONCE.
    // Repeating it per player would rebuild the context-switching cost this
    // screen exists to remove.
    const heading = await screen.findByRole('heading', {
      name: 'What is your responsibility in Cover 3?',
    });
    expect(heading).toBeInTheDocument();
    expect(screen.getAllByText('What is your responsibility in Cover 3?')).toHaveLength(1);
  });

  it('shows the accepted answers as the standard being applied', async () => {
    renderPage();

    expect(await screen.findByText('Hook/curl · #3 vertical')).toBeInTheDocument();
  });

  it('says which question this is and how much is left', async () => {
    renderPage();

    // Question 2 of the QUIZ - the auto-graded one is first - not "1 of 2".
    expect(await screen.findByText(/Question 2/)).toBeInTheDocument();
    expect(screen.getByText(/0 of 2 graded/)).toBeInTheDocument();
    expect(screen.getByText(/3 left on this quiz/)).toBeInTheDocument();
  });

  it('lists every player who answered, with their answer', async () => {
    renderPage();

    expect(await screen.findByText('Mike Beaudry')).toBeInTheDocument();
    expect(screen.getByText('Hook to curl, eyes on #3')).toBeInTheDocument();
    expect(screen.getByText('John Smith')).toBeInTheDocument();
    expect(screen.getByText('Flat')).toBeInTheDocument();
  });
});

describe('making the call', () => {
  it('writes Correct through the existing grade endpoint', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');

    const row = screen.getByText('Hook to curl, eyes on #3').closest('li')!;
    await user.click(within(row).getByRole('button', { name: /Correct/ }));

    await waitFor(() =>
      expect(gradeAnswer).toHaveBeenCalledWith(100, { is_correct: true, coach_feedback: null }),
    );
  });

  it('writes Incorrect through the same endpoint', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('John Smith');

    const row = screen.getByText('Flat').closest('li')!;
    await user.click(within(row).getByRole('button', { name: /Incorrect/ }));

    await waitFor(() =>
      expect(gradeAnswer).toHaveBeenCalledWith(104, { is_correct: false, coach_feedback: null }),
    );
  });

  it('keeps a graded response on screen, marked', async () => {
    // A row that vanishes the instant it is decided makes a misclick
    // invisible at exactly the moment it is most likely.
    const graded = responses();
    graded[0].answers![0].is_correct = true;
    vi.mocked(listResponses).mockResolvedValue(graded);
    renderPage();

    await screen.findByText('Mike Beaudry');
    expect(screen.getByText('Hook to curl, eyes on #3')).toBeInTheDocument();
    const row = screen.getByText('Hook to curl, eyes on #3').closest('li')!;
    expect(within(row).getByRole('button', { name: /Correct/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('lets a coach change a decision they already made', async () => {
    const user = userEvent.setup();
    const graded = responses();
    graded[0].answers![0].is_correct = true;
    const alreadyGradedId = graded[0].answers![0].id;
    vi.mocked(listResponses).mockResolvedValue(graded);
    renderPage();
    await screen.findByText('Mike Beaudry');

    const row = screen.getByText('Hook to curl, eyes on #3').closest('li')!;
    await user.click(within(row).getByRole('button', { name: /Incorrect/ }));

    await waitFor(() =>
      expect(gradeAnswer).toHaveBeenCalledWith(alreadyGradedId, {
        is_correct: false,
        coach_feedback: null,
      }),
    );
  });

  it('never asks for confirmation', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');

    const row = screen.getByText('Flat').closest('li')!;
    await user.click(within(row).getByRole('button', { name: /Correct/ }));

    await waitFor(() => expect(gradeAnswer).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('drawings', () => {
  it('renders the drawing over the image that player was delivered', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');

    await user.click(screen.getByRole('button', { name: /Next question/ }));

    expect(await screen.findByRole('heading', { name: 'Draw your drop.' })).toBeInTheDocument();
    const drawing = screen.getByTestId('drawing');
    expect(drawing.getAttribute('data-image')).toContain('/uploads/drop.jpg');
  });

  it('grades a drawing with the same two buttons', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');
    await user.click(screen.getByRole('button', { name: /Next question/ }));
    await screen.findByRole('heading', { name: 'Draw your drop.' });

    const row = screen.getByTestId('drawing').closest('li')!;
    await user.click(within(row).getByRole('button', { name: /Correct/ }));

    await waitFor(() =>
      expect(gradeAnswer).toHaveBeenCalledWith(101, { is_correct: true, coach_feedback: null }),
    );
  });
});

describe('a drawing question is graded against the drawn answer', () => {
  const ANSWER = { format: 'peira.drawing', version: 1, coordinate_width: 1200, coordinate_height: 800, strokes: [{ points: [1, 1, 2, 2] }] };
  const withAnswer = () => {
    const q = quiz();
    const draw = q.questions!.find((x) => x.id === DRAW_Q)!;
    Object.assign(draw, { answer_drawing: ANSWER, image: { image_url: '/uploads/live-drop.jpg' } });
    return q;
  };

  it('shows the answer once, beside the question, and lays it over every drawing - one switch for all', async () => {
    vi.mocked(getQuiz).mockResolvedValue(withAnswer());
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');
    await user.click(screen.getByRole('button', { name: /Next question/ }));
    await screen.findByRole('heading', { name: 'Draw your drop.' });

    expect(screen.getByText('The answer')).toBeInTheDocument();
    const key = screen.getByText('The answer, drawn, for: Draw your drop.');
    expect(key.getAttribute('data-image')).toContain('/uploads/live-drop.jpg');
    const tile = () => screen.getByText(/Drawing by .* for: Draw your drop\./);
    expect(tile().getAttribute('data-overlay')).toBe('on');
    // No per-drawing toggle: the question's switch governs them all.
    expect(screen.queryByRole('button', { name: /Your answer/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Answer over each drawing/ }));
    expect(tile().getAttribute('data-overlay')).toBe('off');
    // The key itself always shows the answer.
    expect(key.getAttribute('data-overlay')).toBe('on');
  });

  it('without a drawn answer, says how to add one', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');
    await user.click(screen.getByRole('button', { name: /Next question/ }));
    await screen.findByRole('heading', { name: 'Draw your drop.' });
    expect(screen.getByText(/No answer drawn for this question yet/)).toBeInTheDocument();
  });
});

describe('what is in the queue', () => {
  it('never shows an auto-graded question', async () => {
    renderPage();
    await screen.findByText('Mike Beaudry');

    expect(screen.queryByText('Cover 3 or Cover 4?')).not.toBeInTheDocument();
  });

  it("never shows a question marked don't count", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');

    // Written, ungraded, answered - and still absent, because the coach
    // already said it does not count.
    expect(screen.queryByText('Explain the check.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Next question/ }));
    await screen.findByRole('heading', { name: 'Draw your drop.' });
    expect(screen.queryByText('Explain the check.')).not.toBeInTheDocument();
  });

  it('includes it once the coach restores the question', async () => {
    // The mirror of the rule: exclusion is what removes it, nothing else.
    vi.mocked(getQuizDashboard).mockResolvedValue(dashboard([]));
    renderPage();

    expect(await screen.findByText(/4 left on this quiz/)).toBeInTheDocument();
  });
});

describe('finishing', () => {
  it('shows a plain completion state when nothing is left', async () => {
    const allGraded = responses();
    allGraded[0].answers!.forEach((a) => (a.is_correct = true));
    allGraded[1].answers!.forEach((a) => (a.is_correct = true));
    vi.mocked(listResponses).mockResolvedValue(allGraded);
    renderPage();

    expect(await screen.findByRole('heading', { name: 'All caught up' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to results' })).toHaveAttribute(
      'href',
      '/quizzes/1',
    );
    // No statistics, no celebration.
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('says so plainly when a quiz has no hand-graded questions at all', async () => {
    vi.mocked(getQuiz).mockResolvedValue({
      id: 1,
      title: 'Auto only',
      questions: [{ id: AUTO_Q, question_text: 'A', question_type: 'multiple_choice', options: [] }],
    } as unknown as Quiz);
    renderPage();

    expect(await screen.findByText(/Nothing on this quiz needs grading by hand/)).toBeInTheDocument();
  });
});

/** GRADE FAST: the keys, the cursor, a decision shown at once, and only what
 *  is still waiting - with no way to decide answers nobody looked at. */
describe('grading fast', () => {
  const rowOf = (text: string) => screen.getByText(text).closest('li')!;
  const pressed = (row: HTMLElement, name: RegExp) => within(row).getByRole('button', { name }).getAttribute('aria-pressed');

  it('C marks the current answer correct and moves on to the next one waiting; X marks it incorrect', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');
    // The first answer waiting is current.
    expect(rowOf('Hook to curl, eyes on #3')).toHaveAttribute('aria-current', 'true');

    await user.keyboard('c');
    expect(gradeAnswer).toHaveBeenCalledWith(100, { is_correct: true, coach_feedback: null });
    // Shown at once - and the cursor is on the next answer waiting.
    expect(pressed(rowOf('Hook to curl, eyes on #3'), /Correct/)).toBe('true');
    expect(rowOf('Flat')).toHaveAttribute('aria-current', 'true');
    expect(await screen.findByText(/1 of 2 graded/)).toBeInTheDocument();

    await user.keyboard('x');
    expect(gradeAnswer).toHaveBeenLastCalledWith(104, { is_correct: false, coach_feedback: null });
    expect(pressed(rowOf('Flat'), /Incorrect/)).toBe('true');
    // Nothing left here: the next step is the next question.
    await waitFor(() => expect(screen.getByRole('button', { name: /Next question/ })).toHaveFocus());
    // Each decision is one write; nothing is reloaded after it.
    expect(listResponses).toHaveBeenCalledTimes(1);
  });

  it('the arrows move the cursor, and a click picks an answer', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');
    await user.keyboard('{ArrowRight}');
    expect(rowOf('Flat')).toHaveAttribute('aria-current', 'true');
    await user.keyboard('{ArrowLeft}');
    expect(rowOf('Hook to curl, eyes on #3')).toHaveAttribute('aria-current', 'true');
    await user.click(screen.getByText('Flat'));
    expect(rowOf('Flat')).toHaveAttribute('aria-current', 'true');
  });

  it('a decision the server refuses is undone, and said', async () => {
    vi.mocked(gradeAnswer).mockRejectedValue(new Error('Could not save that grade.'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');
    await user.keyboard('c');
    expect(await screen.findByText('Could not save that grade.')).toBeInTheDocument();
    expect(pressed(rowOf('Hook to curl, eyes on #3'), /Correct/)).toBe('false');
    expect(screen.getByText(/0 of 2 graded/)).toBeInTheDocument();
  });

  it('"Ungraded only" shows what is still waiting - one decided now stays, marked, until he moves on', async () => {
    const graded = responses();
    graded[0].answers![0].is_correct = true;
    vi.mocked(listResponses).mockResolvedValue(graded);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');
    expect(screen.getByText(/1 of 2 graded/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Ungraded only/ }));
    expect(screen.queryByText('Hook to curl, eyes on #3')).toBeNull();
    expect(rowOf('Flat')).toHaveAttribute('aria-current', 'true');
    await user.click(within(rowOf('Flat')).getByRole('button', { name: /Correct/ }));
    // Still there, marked: a misclick stays visible.
    expect(pressed(rowOf('Flat'), /Correct/)).toBe('true');

    await user.keyboard('u');
    expect(screen.getByText('Hook to curl, eyes on #3')).toBeInTheDocument();
  });

  it('"Ungraded only" is not offered before anything is decided', async () => {
    renderPage();
    await screen.findByText('Mike Beaudry');
    expect(screen.queryByRole('button', { name: /Ungraded only/ })).toBeNull();
  });

  it('N goes to the next question, and A lays the answer over the drawings or takes it off', async () => {
    const q = quiz();
    Object.assign(q.questions!.find((x) => x.id === DRAW_Q)!, {
      answer_drawing: { format: 'peira.drawing', version: 1, coordinate_width: 1200, coordinate_height: 800, strokes: [] },
      image: { image_url: '/uploads/live-drop.jpg' },
    });
    vi.mocked(getQuiz).mockResolvedValue(q);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');
    await user.keyboard('n');
    await screen.findByRole('heading', { name: 'Draw your drop.' });
    const tile = () => screen.getByText(/Drawing by .* for: Draw your drop\./);
    expect(tile().getAttribute('data-overlay')).toBe('on');
    await user.keyboard('a');
    expect(tile().getAttribute('data-overlay')).toBe('off');
    await user.keyboard('c');
    expect(gradeAnswer).toHaveBeenCalledWith(101, { is_correct: true, coach_feedback: null });
  });

  it('there is no way to mark everything at once', async () => {
    renderPage();
    await screen.findByText('Mike Beaudry');
    expect(screen.queryByRole('button', { name: /all correct|mark all|grade all/i })).toBeNull();
  });

  it('beside the question: the concept, who he is, and - for a Motion Lab coach - the play it came from', async () => {
    const q = quiz();
    Object.assign(q.questions!.find((x) => x.id === WRITTEN_Q)!, {
      concept: { id: 3, name: 'Cover 3 rules', is_archived: false },
      subject_role: 'Boundary safety',
      motion_play_id: 14,
    });
    vi.mocked(getQuiz).mockResolvedValue(q);
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: true } } as never);
    renderPage();
    await screen.findByText('Mike Beaudry');
    expect(screen.getByText('Cover 3 rules')).toBeInTheDocument();
    expect(screen.getByText('Boundary safety')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the play' })).toHaveAttribute('href', '/motion-lab/plays/14');
    vi.restoreAllMocks();
  });

  it('a coach without Motion Lab is not offered the play', async () => {
    const q = quiz();
    Object.assign(q.questions!.find((x) => x.id === WRITTEN_Q)!, { motion_play_id: 14 });
    vi.mocked(getQuiz).mockResolvedValue(q);
    renderPage();
    await screen.findByText('Mike Beaudry');
    expect(screen.queryByRole('link', { name: 'Open the play' })).toBeNull();
  });
});

describe('all caught up, then the next one', () => {
  const allGraded = () => {
    const r = responses();
    r.forEach((resp) => resp.answers!.forEach((a) => (a.is_correct = a.is_correct ?? true)));
    return r;
  };

  it('offers the next quiz still waiting, one tap from its grading', async () => {
    vi.mocked(listResponses).mockResolvedValue(allGraded());
    vi.mocked(listToGrade).mockResolvedValue([
      { quiz_id: 1, title: 'Install Week 2', count: 0 },
      { quiz_id: 5, title: 'Red zone', count: 2 },
    ]);
    renderPage();
    expect(await screen.findByText('All caught up')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Next: Red zone · 2 to grade/ })).toHaveAttribute('href', '/quizzes/5/grade');
  });

  it('nothing waiting anywhere: back to results is the one step', async () => {
    vi.mocked(listResponses).mockResolvedValue(allGraded());
    renderPage();
    expect(await screen.findByText('All caught up')).toBeInTheDocument();
    await waitFor(() => expect(listToGrade).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /Next:/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to results' })).toBeInTheDocument();
  });
});
