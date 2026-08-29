/** The rules that decide what a coach is asked to grade.
 *
 * Every one of these is a product decision made before the screen existed, so
 * they are tested here against the queue rather than through a rendered page:
 * a rule that survives only because a component happens to render it a certain
 * way is a rule that moves the next time the component does.
 */
import { describe, expect, it } from 'vitest';
import {
  buildGradingQueue,
  countAwaitingGrades,
  countPlayerAwaitingGrades,
  needsManualGrading,
  questionsAwaitingGrades,
} from './gradingQueue';
import type { PlayerResponse, Question, QuestionType, Quiz } from '../../api/types';

let nextId = 1;

const question = (type: QuestionType, over: Partial<Question> = {}): Question =>
  ({
    id: nextId++,
    quiz_id: 1,
    question_text: `A ${type} question`,
    question_type: type,
    position: 0,
    options: [],
    expected_answers: type === 'written' ? ['Hook/curl'] : [],
    ...over,
  }) as unknown as Question;

/** One submitted attempt. `answers` is [questionId, is_correct] pairs so the
 *  fixtures read as the state they are describing. */
const player = (
  name: string,
  answers: [number, boolean | null][],
  over: Partial<PlayerResponse> = {},
): PlayerResponse =>
  ({
    id: nextId++,
    quiz_id: 1,
    display_name: name,
    player_name: name,
    submitted_at: '2026-08-21T18:00:00Z',
    answers: answers.map(([question_id, is_correct]) => ({
      id: nextId++,
      question_id,
      answer_text: `${name}'s answer`,
      selected_option_id: null,
      is_correct,
      coach_feedback: null,
      graded_at: null,
      graded_by_username: null,
    })),
    ...over,
  }) as unknown as PlayerResponse;

const NONE: ReadonlySet<number> = new Set();

describe('which types a coach decides', () => {
  it('claims written and draw_response, and nothing else', () => {
    expect(needsManualGrading('written')).toBe(true);
    expect(needsManualGrading('draw_response')).toBe(true);
    expect(needsManualGrading('true_false')).toBe(false);
    expect(needsManualGrading('multiple_choice')).toBe(false);
    // Every Playbook question is fill_blank. They are scored the moment the
    // player types, and must never reach a coach as grading work.
    expect(needsManualGrading('fill_blank')).toBe(false);
    expect(needsManualGrading(undefined)).toBe(false);
  });
});

describe('the grading queue', () => {
  it('includes written and draw_response, and excludes every auto-graded type', () => {
    const written = question('written');
    const drawing = question('draw_response');
    const tf = question('true_false');
    const mc = question('multiple_choice');
    const fill = question('fill_blank');
    const quiz = { questions: [written, drawing, tf, mc, fill] } as unknown as Quiz;
    const responses = [
      player('Mike', [
        [written.id, null],
        [drawing.id, null],
        [tf.id, true],
        [mc.id, false],
        [fill.id, true],
      ]),
    ];

    const queue = buildGradingQueue(quiz, responses, NONE);

    expect(queue.map((q) => q.questionId)).toEqual([written.id, drawing.id]);
  });

  it('leaves out a question the coach marked "don\'t count"', () => {
    // The locked decision: they already said it does not affect a score, so
    // spending their time on it is the thing to avoid. Nothing is deleted.
    const kept = question('written');
    const excluded = question('written');
    const quiz = { questions: [kept, excluded] } as unknown as Quiz;
    const responses = [
      player('Mike', [
        [kept.id, null],
        [excluded.id, null],
      ]),
    ];

    const queue = buildGradingQueue(quiz, responses, new Set([excluded.id]));

    expect(queue.map((q) => q.questionId)).toEqual([kept.id]);
    expect(countAwaitingGrades(queue)).toBe(1);
  });

  it('keeps the quiz\'s own question order and numbering', () => {
    // Question 4 of the quiz is "Question 4" here even though three
    // auto-graded questions come before it and it is first in the queue.
    const tf = question('true_false');
    const mc = question('multiple_choice');
    const fill = question('fill_blank');
    const written = question('written');
    const drawing = question('draw_response');
    const quiz = { questions: [tf, mc, fill, written, drawing] } as unknown as Quiz;
    const responses = [
      player('Mike', [
        [written.id, null],
        [drawing.id, null],
      ]),
    ];

    const queue = buildGradingQueue(quiz, responses, NONE);

    expect(queue.map((q) => q.questionNumber)).toEqual([4, 5]);
  });

  it('gathers every player who answered, in response order', () => {
    const written = question('written');
    const quiz = { questions: [written] } as unknown as Quiz;
    const responses = [
      player('Mike', [[written.id, null]]),
      player('John', [[written.id, null]]),
      player('Chris', [[written.id, true]]),
    ];

    const queue = buildGradingQueue(quiz, responses, NONE);

    expect(queue[0].targets.map((t) => t.playerName)).toEqual(['Mike', 'John', 'Chris']);
    expect(queue[0].ungradedCount).toBe(2);
  });

  it('skips a player who never answered rather than counting them ungraded', () => {
    // No answer row is UNANSWERED, which is not a decision a coach can make.
    // Scoring already keeps the two apart; the queue must not merge them.
    const written = question('written');
    const other = question('written');
    const quiz = { questions: [written, other] } as unknown as Quiz;
    const responses = [
      player('Mike', [[written.id, null]]),
      player('Absent', [[other.id, null]]),
    ];

    const queue = buildGradingQueue(quiz, responses, NONE);
    const first = queue.find((q) => q.questionId === written.id)!;

    expect(first.targets.map((t) => t.playerName)).toEqual(['Mike']);
    expect(first.ungradedCount).toBe(1);
  });

  it('drops a question nobody answered at all', () => {
    const answered = question('written');
    const untouched = question('written');
    const quiz = { questions: [answered, untouched] } as unknown as Quiz;

    const queue = buildGradingQueue(quiz, [player('Mike', [[answered.id, null]])], NONE);

    expect(queue.map((q) => q.questionId)).toEqual([answered.id]);
  });

  it('keeps an already-graded question reachable but out of outstanding work', () => {
    // Rule 4: a finished question is not active work, but a coach must still
    // be able to reach what they just decided.
    const done = question('written');
    const todo = question('written');
    const quiz = { questions: [done, todo] } as unknown as Quiz;
    const responses = [
      player('Mike', [
        [done.id, true],
        [todo.id, null],
      ]),
    ];

    const queue = buildGradingQueue(quiz, responses, NONE);

    expect(queue).toHaveLength(2);
    expect(questionsAwaitingGrades(queue).map((q) => q.questionId)).toEqual([todo.id]);
    expect(countAwaitingGrades(queue)).toBe(1);
  });

  it('carries the accepted answers through as the standard to judge against', () => {
    const written = question('written', { expected_answers: ['Hook/curl', '#3 vertical'] });
    const quiz = { questions: [written] } as unknown as Quiz;

    const queue = buildGradingQueue(quiz, [player('Mike', [[written.id, null]])], NONE);

    expect(queue[0].expectedAnswers).toEqual(['Hook/curl', '#3 vertical']);
  });
});

describe('the count a coach is shown', () => {
  it('counts an ungraded drawing - THE BUG', () => {
    // The reported defect, stated as a test: with nothing but a drawing
    // outstanding, the old inline `type === 'written'` check reported zero and
    // the work was invisible.
    const written = question('written');
    const drawing = question('draw_response');
    const quiz = { questions: [written, drawing] } as unknown as Quiz;
    const responses = [
      player('Mike', [
        [written.id, true],
        [drawing.id, null],
      ]),
    ];

    expect(countAwaitingGrades(buildGradingQueue(quiz, responses, NONE))).toBe(1);
  });

  it('counts written and drawings together', () => {
    const written = question('written');
    const drawing = question('draw_response');
    const quiz = { questions: [written, drawing] } as unknown as Quiz;
    const responses = [
      player('Mike', [
        [written.id, null],
        [drawing.id, null],
      ]),
      player('John', [
        [written.id, null],
        [drawing.id, true],
      ]),
    ];

    expect(countAwaitingGrades(buildGradingQueue(quiz, responses, NONE))).toBe(3);
  });

  it('counts nothing for a quiz that is entirely auto-graded', () => {
    const quiz = {
      questions: [question('true_false'), question('multiple_choice'), question('fill_blank')],
    } as unknown as Quiz;
    const ids = (quiz.questions as Question[]).map((q) => q.id);
    const responses = [player('Mike', ids.map((id) => [id, null] as [number, null]))];

    expect(countAwaitingGrades(buildGradingQueue(quiz, responses, NONE))).toBe(0);
  });

  it('does not count an excluded question', () => {
    const excluded = question('written');
    const quiz = { questions: [excluded] } as unknown as Quiz;
    const responses = [player('Mike', [[excluded.id, null]])];

    expect(countAwaitingGrades(buildGradingQueue(quiz, responses, new Set([excluded.id])))).toBe(0);
  });
});

describe("one player's outstanding count", () => {
  const typeOf = (map: Record<number, QuestionType>) => (id: number) => map[id];

  it('counts a drawing as well as a short answer - THE BUG, per player', () => {
    const answers = [
      { question_id: 1, is_correct: null },
      { question_id: 2, is_correct: null },
    ];

    expect(
      countPlayerAwaitingGrades(answers, typeOf({ 1: 'written', 2: 'draw_response' })),
    ).toBe(2);
  });

  it('reports 1, not 0, when only a drawing is outstanding', () => {
    const answers = [
      { question_id: 1, is_correct: true },
      { question_id: 2, is_correct: null },
    ];

    expect(
      countPlayerAwaitingGrades(answers, typeOf({ 1: 'written', 2: 'draw_response' })),
    ).toBe(1);
  });

  it('ignores auto-graded answers that carry no grade', () => {
    const answers = [
      { question_id: 1, is_correct: null },
      { question_id: 2, is_correct: null },
    ];

    expect(
      countPlayerAwaitingGrades(answers, typeOf({ 1: 'true_false', 2: 'fill_blank' })),
    ).toBe(0);
  });

  it('ignores an excluded question', () => {
    const answers = [
      { question_id: 1, is_correct: null },
      { question_id: 2, is_correct: null },
    ];

    expect(
      countPlayerAwaitingGrades(
        answers,
        typeOf({ 1: 'written', 2: 'written' }),
        new Set([2]),
      ),
    ).toBe(1);
  });
});
