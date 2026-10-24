import type { Question, Quiz } from '../../api/types';

/**
 * THE SAME FOOTBALL, TAUGHT ONCE. A retest (or a Rep made from a quiz) re-asks
 * a question as a copy: a new id, a copied picture, the same football. When
 * Teach gathers questions from several quizzes, each piece of football should
 * appear once - and two different pieces of football must never be merged
 * just because they share words ("Your check?").
 *
 * Identity first:
 *   1. the copied-from chain (`copied_from_question_id`, coach-side
 *      provenance): a copy, a copy of a copy, and the original are one;
 *   2. only where provenance is missing (copies made before it was recorded):
 *      the same words in a retest and the quiz it retests - a source
 *      relationship, not a coincidence of wording.
 * Anything else is distinct, however it is worded.
 *
 * Order is kept: the first of each (the caller puts the newest first) stays.
 */
export function distinctFootball(entries: { quiz: Pick<Quiz, 'id' | 'retest_of'>; question: Question }[]): Question[] {
  const byId = new Map(entries.map((e) => [e.question.id, e.question]));
  const root = (q: Question): number => {
    let at = q;
    for (let hops = 0; hops < 20; hops += 1) {
      const from = at.copied_from_question_id;
      if (from == null) return at.id;
      const parent = byId.get(from);
      if (!parent) return from;
      at = parent;
    }
    return at.id;
  };
  const words = (q: Question) => q.question_text.trim().replace(/\s+/g, ' ').toLowerCase();
  const kept: { key: number; quizId: number; retestOf: number | null; words: string; provenance: boolean }[] = [];
  const out: Question[] = [];
  for (const { quiz, question } of entries) {
    const key = root(question);
    if (kept.some((k) => k.key === key)) continue;
    const retestOf = quiz.retest_of?.id ?? null;
    const provenance = question.copied_from_question_id != null;
    const legacyCopy = kept.some(
      (k) =>
        k.words === words(question) &&
        (!provenance || !k.provenance) &&
        (retestOf === k.quizId || k.retestOf === quiz.id),
    );
    if (legacyCopy) continue;
    kept.push({ key, quizId: quiz.id, retestOf, words: words(question), provenance });
    out.push(question);
  }
  return out;
}
