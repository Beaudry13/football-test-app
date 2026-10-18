// THE FOOTBALL DECISION'S SMALL RULES - shared by the Rep runner, Review
// Missed and a normal quiz's practice review.

import type { PracticeFeedback, Question } from '../../api/types';

/** Answer types a player answers with one tap. */
export const TAPPABLE = new Set(['multiple_choice', 'true_false']);

/** "You're the..." - who the player is in this decision, when the coach said. */
export function roleOf(question: Question): string | null {
  return question.subject_role?.trim() || null;
}

/** The decisions he missed on his first answer, in order. */
export function missedOf(decisions: Question[], feedback: Record<number, PracticeFeedback>) {
  return decisions.filter((q) => feedback[q.id]?.is_correct === false);
}
