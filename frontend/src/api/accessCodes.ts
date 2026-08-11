import { api } from './client';
import type { AccessCode, AssessmentMode } from './types';

export function listAccessCodes(quizId: number): Promise<AccessCode[]> {
  return api.get<AccessCode[]>(`/quizzes/${quizId}/access-codes`);
}

/** `mode` is how the quiz is being used - GRADED counts, PRACTICE never does.
 * It defaults to GRADED here as well as server-side: an activation that
 * forgets to say must be the one that affects the coach's numbers, never the
 * one that silently doesn't. */
export function activateQuiz(
  quizId: number,
  groupIds: number[] = [],
  mode: AssessmentMode = 'GRADED',
  randomizeQuestions = false,
): Promise<AccessCode> {
  return api.post<AccessCode>(`/quizzes/${quizId}/access-codes`, {
    group_ids: groupIds,
    mode,
    // Practice-only, and the server ignores it for graded - but sending it
    // unconditionally keeps this call one shape rather than two.
    randomize_questions: randomizeQuestions,
  });
}

export function deactivateAccessCode(quizId: number, accessCodeId: number): Promise<AccessCode> {
  return api.post<AccessCode>(`/quizzes/${quizId}/access-codes/${accessCodeId}/deactivate`);
}
