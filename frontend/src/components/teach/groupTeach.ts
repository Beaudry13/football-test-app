import { getConceptFootball } from '../../api/concepts';
import type { GroupNeed } from '../../api/players';
import { getQuiz } from '../../api/quizzes';
import { addDecisions, makeRepFromQuiz } from '../../api/reps';
import { addRosterMembers } from '../../api/roster';
import type { Question, Quiz } from '../../api/types';
import { quizTeachSlides, teachable } from '../../pages/quiz-editor/quizTeach';
import { distinctFootball } from './sameFootball';
import type { TeachSlide } from './TeachView';

// TEACH A GROUP'S PROBLEM - "my safeties are missing motion adjustment" - the
// football they missed and the Rep that retests exactly them. Shared by the
// roster's "What your safeties need" and an install's meeting.

/** Each quiz fetched once per screen. */
export function quizCache(): (id: number) => Promise<Quiz> {
  const seen = new Map<number, Promise<Quiz>>();
  return (id) => {
    if (!seen.has(id)) seen.set(id, getQuiz(id));
    return seen.get(id)!;
  };
}

/** THE FOOTBALL THEY MISSED: the concept's questions where each last missed
 *  it - newest first, the ones they missed (else the concept's) - from the
 *  quizzes and Reps themselves, so Teach shows exactly what they saw. A
 *  retest's copy is the same football: taught once, by its source identity. */
export async function groupNeedSlides(need: GroupNeed): Promise<TeachSlide[]> {
  const byQuiz = new Map<number, { ids: Set<number>; at: string }>();
  for (const m of need.missing) {
    const entry = byQuiz.get(m.last.quiz_id) ?? { ids: new Set<number>(), at: '' };
    m.last.question_ids.forEach((id) => entry.ids.add(id));
    if ((m.last.at ?? '') > entry.at) entry.at = m.last.at ?? '';
    byQuiz.set(m.last.quiz_id, entry);
  }
  const ordered = [...byQuiz.entries()].sort((a, b) => b[1].at.localeCompare(a[1].at));
  if (ordered.length === 0) return [];
  // ONE READ for every quiz they missed it in - not each quiz whole, in turn.
  const football = await getConceptFootball(need.concept_id, ordered.map(([id]) => id));
  const quizzes = new Map(football.quizzes.map((q) => [q.id, q]));
  const gathered: { quiz: Pick<Quiz, 'id' | 'retest_of'>; question: Question }[] = [];
  for (const [quizId, { ids }] of ordered) {
    const quiz = quizzes.get(quizId);
    if (!quiz) continue;
    // The read holds only the concept's live questions; Teach needs football to show.
    const inConcept = football.questions.filter((q) => q.quiz_id === quizId && teachable(q));
    const missedHere = inConcept.filter((q) => ids.has(q.id));
    for (const question of missedHere.length > 0 ? missedHere : inConcept) gathered.push({ quiz, question });
  }
  return quizTeachSlides(distinctFootball(gathered));
}

/** Whether any of them missed something a Rep can re-ask. */
export const groupRetestable = (need: GroupNeed) => need.missing.some((m) => m.last.question_ids.length > 0);

/** RETEST THEM: each one's missed decisions, one Rep, for exactly them - built,
 *  not sent. Resolves with the Rep's id (open it to send). */
export async function retestGroup(need: GroupNeed, label: string): Promise<number> {
  const byQuiz = new Map<number, Set<number>>();
  for (const m of need.missing) {
    const set = byQuiz.get(m.last.quiz_id) ?? new Set<number>();
    m.last.question_ids.forEach((id) => set.add(id));
    byQuiz.set(m.last.quiz_id, set);
  }
  const [[firstQuiz, firstIds], ...rest] = [...byQuiz.entries()].filter(([, set]) => set.size > 0);
  const rep = await makeRepFromQuiz(firstQuiz, [...firstIds], `${need.name} - ${label}`);
  for (const [quizId, set] of rest) await addDecisions(rep.id, quizId, [...set]);
  await addRosterMembers(rep.id, need.missing.map((m) => m.player_id));
  return rep.id;
}
