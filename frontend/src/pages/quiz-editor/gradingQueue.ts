/** WHAT IS STILL WAITING ON A COACH, and in what order.
 *
 * One module so the three surfaces that ask "how much grading is left" cannot
 * answer differently: the Results banner, a player row's "N to grade" badge,
 * and the question-first grading screen itself. Before this, the badge asked
 * `type === 'written'` inline and silently ignored every ungraded drawing, so
 * a quiz with nothing but drawings outstanding reported "0 to grade".
 *
 * Mirrors backend `MANUALLY_GRADED_TYPES` (app/models/question.py). That set is
 * derived there - AUTO_GRADABLE_TYPES is everything else - for exactly the
 * reason this file exists: two hand-maintained lists eventually disagree.
 */
import type {
  AnswerDrawing,
  DeliveredQuestion,
  PlayerResponse,
  Question,
  QuestionType,
  Quiz,
} from '../../api/types';

/** The types a person decides. Everything else the server scored the moment
 *  the player answered, and offering a coach a verdict on one would invite
 *  them to overrule a decision already recorded. */
export const MANUALLY_GRADED_TYPES: readonly QuestionType[] = ['written', 'draw_response'];

export function needsManualGrading(type: QuestionType | undefined): boolean {
  return type !== undefined && MANUALLY_GRADED_TYPES.includes(type);
}

/** One player's answer to the question being graded, with everything the
 *  screen needs to show it. */
export interface GradeTarget {
  answerId: number;
  attemptId: number;
  playerName: string;
  answerText: string | null;
  /** Present only for a draw_response the player actually drew on. */
  drawing: AnswerDrawing | null | undefined;
  /** null = ungraded. Mirrors answers.is_correct exactly; there is no third
   *  state, and "skipped" is just a decision not made. */
  isCorrect: boolean | null;
  /** What THIS player was delivered, so a drawing is rendered over the image
   *  it was drawn on rather than today's copy of the question. */
  delivered: DeliveredQuestion | undefined;
}

/** One question, and every response to it that a coach may act on. */
export interface GradeQuestion {
  questionId: number;
  /** The quiz's own numbering, so "Question 7" here means question 7 there. */
  questionNumber: number;
  questionText: string;
  questionType: QuestionType;
  /** Accepted answers, shown muted under the question as the standard a coach
   *  is judging against. Empty for a type that has none. */
  expectedAnswers: string[];
  targets: GradeTarget[];
  ungradedCount: number;
}

function isGraded(target: GradeTarget): boolean {
  return target.isCorrect !== null;
}

/** Build the grading queue for a quiz.
 *
 * THE FOUR RULES, all of them decided elsewhere and merely applied here:
 *
 *   1. Manual types only. An auto-graded question is already decided.
 *   2. Excluded questions are OUT. A coach who marked a question "don't count"
 *      has said it no longer affects anybody's score; making them grade it
 *      anyway spends their time on a decision they already made. Nothing is
 *      deleted, no grade is cleared, and the question stays fully visible in
 *      player-first review - it just leaves the queue.
 *   3. The quiz's own question order, so the queue matches the quiz a coach
 *      knows rather than an order invented from response times.
 *   4. A question with no outstanding responses is not active work. It stays
 *      reachable so a coach can revisit what they just did; it simply does not
 *      count towards "left to grade".
 */
export function buildGradingQueue(
  quiz: Pick<Quiz, 'questions'>,
  responses: PlayerResponse[],
  excludedQuestionIds: ReadonlySet<number>,
): GradeQuestion[] {
  const questions = (quiz.questions ?? []) as Question[];

  return questions
    .filter((q) => needsManualGrading(q.question_type) && !excludedQuestionIds.has(q.id))
    .map((question) => {
      const targets: GradeTarget[] = [];

      for (const response of responses) {
        const answer = (response.answers ?? []).find((a) => a.question_id === question.id);
        // No row at all means the player never answered it. That is
        // UNANSWERED, not ungraded - there is nothing for a coach to judge,
        // and scoring already keeps the two apart.
        if (!answer) continue;

        targets.push({
          answerId: answer.id,
          attemptId: response.id,
          playerName: response.display_name || response.player_name,
          answerText: answer.answer_text,
          drawing: answer.drawing,
          isCorrect: answer.is_correct,
          delivered: (response.delivered_questions ?? []).find(
            (d) => d.question_id === question.id,
          ),
        });
      }

      return {
        questionId: question.id,
        // The quiz's numbering, not the queue's: a manual question that is
        // seventh in the quiz is "Question 7" here too, however few manual
        // questions come before it.
        questionNumber: questions.findIndex((q) => q.id === question.id) + 1,
        questionText: question.question_text,
        questionType: question.question_type,
        expectedAnswers: question.expected_answers ?? [],
        targets,
        ungradedCount: targets.filter((t) => !isGraded(t)).length,
      };
    })
    .filter((q) => q.targets.length > 0);
}

/** How many responses are still waiting on a decision, across the whole quiz.
 *
 * THE ONE NUMBER. The Results banner and the grading screen's progress both
 * read this, so the count a coach is offered and the work they are given
 * cannot differ. Auto-graded and excluded questions are already out by
 * construction - `buildGradingQueue` removed them.
 */
export function countAwaitingGrades(queue: GradeQuestion[]): number {
  return queue.reduce((total, question) => total + question.ungradedCount, 0);
}

/** The questions that still have outstanding work, in quiz order. */
export function questionsAwaitingGrades(queue: GradeQuestion[]): GradeQuestion[] {
  return queue.filter((q) => q.ungradedCount > 0);
}

/** How many of ONE player's answers are waiting on a decision.
 *
 * The player-row badge. Takes the same delivered-question lookup the row
 * already builds, so a question whose type was edited after delivery is read
 * the way it was delivered - one source, consistently.
 */
export function countPlayerAwaitingGrades(
  answers: { question_id: number; is_correct: boolean | null }[],
  typeOf: (questionId: number) => QuestionType | undefined,
  excludedQuestionIds: ReadonlySet<number> = new Set(),
): number {
  return answers.filter(
    (a) =>
      a.is_correct === null &&
      needsManualGrading(typeOf(a.question_id)) &&
      !excludedQuestionIds.has(a.question_id),
  ).length;
}
