/** Arrange questions by the attempt's frozen order.
 *
 * The server already reconciles its stored order against the live quiz, so
 * this is normally a straight lookup. It is defensive anyway because the two
 * payloads arrive from DIFFERENT requests - questions from /play/validate-code,
 * the order from /play/start - and a quiz edited in between would otherwise
 * silently drop a question the player can still answer.
 *
 * Ids in the order that no longer exist are skipped; questions missing from
 * the order are appended in authored order. A question is never lost and
 * never duplicated.
 */
export function orderQuestions<T extends { id: number }>(
  questions: T[],
  order: number[] | undefined,
): T[] {
  if (!order || order.length === 0) return questions;
  const byId = new Map(questions.map((question) => [question.id, question]));
  const arranged: T[] = [];
  const placed = new Set<number>();
  for (const id of order) {
    const question = byId.get(id);
    if (question && !placed.has(id)) {
      arranged.push(question);
      placed.add(id);
    }
  }
  for (const question of questions) {
    if (!placed.has(question.id)) arranged.push(question);
  }
  return arranged;
}

