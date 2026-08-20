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
  expiresAt?: Date,
): Promise<AccessCode> {
  return api.post<AccessCode>(`/quizzes/${quizId}/access-codes`, {
    group_ids: groupIds,
    mode,
    // Practice-only, and the server ignores it for graded - but sending it
    // unconditionally keeps this call one shape rather than two.
    randomize_questions: randomizeQuestions,
    // AN ABSOLUTE INSTANT, never a wall-clock string. `toISOString` resolves
    // what the coach picked through the browser's own timezone database, so
    // DST and travel are handled where the data lives. Omitted entirely when
    // unset, which is what keeps the historical 24-hour default.
    ...(expiresAt ? { expires_at: expiresAt.toISOString() } : {}),
  });
}

/** Changes when an activation stops - SAME CODE, SAME LINK.
 *
 * Deliberately not "reactivate": that mints a new code and silently kills the
 * URL already sitting in twenty players' group text. A coach whose session
 * runs late needs the opposite. */
export function setAccessCodeExpiry(
  quizId: number,
  accessCodeId: number,
  expiresAt: Date,
): Promise<AccessCode> {
  return api.patch<AccessCode>(`/quizzes/${quizId}/access-codes/${accessCodeId}`, {
    expires_at: expiresAt.toISOString(),
  });
}

export function deactivateAccessCode(quizId: number, accessCodeId: number): Promise<AccessCode> {
  return api.post<AccessCode>(`/quizzes/${quizId}/access-codes/${accessCodeId}/deactivate`);
}
