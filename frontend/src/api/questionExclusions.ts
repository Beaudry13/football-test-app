import { api } from './client';
import type { QuestionExclusion, QuizAssignment } from './types';

/** "Don't count this question."
 *
 * Every call is nested under the quiz AND the question so the server can
 * re-verify both - the ids here are never trusted on their own. The scope
 * (`access_code_id`) is validated server-side too: an assignment belonging to
 * another quiz is rejected, so a tampered selector cannot reach one.
 */

export function listQuizAssignments(quizId: number): Promise<QuizAssignment[]> {
  return api.get<QuizAssignment[]>(`/quizzes/${quizId}/assignments`);
}

export function listQuestionExclusions(
  quizId: number,
  questionId: number,
): Promise<QuestionExclusion[]> {
  return api.get<QuestionExclusion[]>(`/quizzes/${quizId}/questions/${questionId}/exclusions`);
}

/** `accessCodeId: null` means QUIZ-WIDE - every past and future use of this
 *  quiz. It is passed explicitly rather than omitted so the broader choice can
 *  never be made by forgetting a field. */
export function excludeQuestion(
  quizId: number,
  questionId: number,
  input: { access_code_id: number | null; reason?: string | null },
): Promise<QuestionExclusion> {
  return api.post<QuestionExclusion>(
    `/quizzes/${quizId}/questions/${questionId}/exclusions`,
    input,
  );
}

/** Restoring returns what is STILL excluding the question, which is empty only
 *  when it genuinely counts again. A quiz-wide and an assignment exclusion can
 *  overlap, and telling a coach "restored" while the other still applies is the
 *  single most misleading thing this feature could do. */
export function restoreQuestionExclusion(
  quizId: number,
  questionId: number,
  exclusionId: number,
): Promise<{ restored: QuestionExclusion; still_excluded_by: QuestionExclusion[] }> {
  return api.post(
    `/quizzes/${quizId}/questions/${questionId}/exclusions/${exclusionId}/restore`,
    {},
  );
}
