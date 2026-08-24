import { api } from './client';
import type { Quiz } from './types';

export interface RetestDraft extends Quiz {
  /** Questions the group missed but that the coach has since STOPPED sending.
   *  Left out of the copy - they would be undeliverable - and named here so
   *  the coach is told rather than left to notice a short question count. */
  skipped_retired_questions: { id: number; question_text: string }[];
}

/** Assemble a targeted draft from the players who missed a concept.
 *
 * The server recomputes who is eligible and what they missed; everything sent
 * here can only NARROW that. It returns an ordinary draft - nothing is
 * activated, no code is generated, nobody is notified.
 */
export function createRetest(
  quizId: number,
  input: {
    concept_id: number;
    player_ids?: number[];
    player_names?: string[];
    question_ids?: number[] | null;
  },
): Promise<RetestDraft> {
  return api.post<RetestDraft>(`/quizzes/${quizId}/retests`, input);
}
