import type { InstallItem, InstallSummary, QuizStatus, RepStatus } from '../../api/installs';
import type { GroupNeed } from '../../api/players';

/** "2 plays · 1 Rep · 1 concept" - what is in it, in coach words. */
export function contents(i: Pick<InstallSummary, 'counts' | 'item_count'>): string {
  const c = i.counts;
  const parts = [
    c.plays ? `${c.plays} ${c.plays === 1 ? 'play' : 'plays'}` : null,
    c.reps ? `${c.reps} ${c.reps === 1 ? 'Rep' : 'Reps'}` : null,
    c.quizzes ? `${c.quizzes} ${c.quizzes === 1 ? 'quiz' : 'quizzes'}` : null,
    c.concepts ? `${c.concepts} ${c.concepts === 1 ? 'concept' : 'concepts'}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Nothing in it yet';
}

/** The item's kind, as a coach says it. */
export function kindLabel(item: InstallItem): string {
  if (item.kind === 'play') return 'Play';
  if (item.kind === 'concept') return 'Concept';
  return item.ref.kind === 'REP' ? 'Rep' : 'Quiz';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * WHAT PEIRA ALREADY KNOWS ABOUT AN ITEM, in one line - and whether it needs
 * the coach (something to grade, players still missing it, an open problem).
 * Only what the server or the room's needs say; nothing scored or guessed.
 */
export function itemDetail(
  item: InstallItem,
  room: { need: GroupNeed | null; players: number; plural: string } | null = null,
): { parts: string[]; attention: string | null } {
  if (item.kind === 'play') {
    const { quizzes, reps } = item.status.made;
    const made = [reps ? plural(reps, 'Rep') : null, quizzes ? plural(quizzes, 'quiz', 'quizzes') : null].filter(Boolean) as string[];
    return { parts: [made.length ? `${made.join(' · ')} made from it` : 'Nothing made from it yet'], attention: null };
  }
  if (item.kind === 'concept') {
    const { quizzes, reps } = item.status.in;
    const inn = [reps ? plural(reps, 'Rep') : null, quizzes ? plural(quizzes, 'quiz', 'quizzes') : null].filter(Boolean) as string[];
    const parts = [inn.length ? `In ${inn.join(' · ')}` : 'Not in any quiz or Rep yet'];
    const attention =
      room && room.need && room.need.missing.length > 0
        ? `${room.need.missing.length} of ${room.players} ${room.plural} still missing it`
        : null;
    return { parts, attention };
  }
  if (item.ref.kind === 'REP') {
    const s = item.status as RepStatus;
    const parts = [s.live ? 'Out now' : null, s.invited ? `${s.ran} of ${s.invited} ran it` : s.ran ? `${s.ran} ran it` : null].filter(Boolean) as string[];
    if (parts.length === 0) parts.push(plural(item.ref.question_count, 'decision'));
    const p = s.open_problem;
    return { parts, attention: p ? `${p.name}: ${p.missed} of ${p.responded} missed${p.taught ? ' · taught' : ''}` : null };
  }
  const s = item.status as QuizStatus;
  const parts = [s.live ? 'Out now' : null, s.submitted ? `${s.submitted} turned in` : null].filter(Boolean) as string[];
  if (parts.length === 0) parts.push(plural(item.ref.question_count, 'question'));
  const attention = [
    s.to_grade ? `${s.to_grade} to grade` : null,
    s.weakest ? `Weakest: ${s.weakest.name} (${s.weakest.missed} of ${s.weakest.responded})` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return { parts, attention: attention || null };
}

/** Where the item lives, to open it. */
export function itemHref(item: InstallItem): string {
  if (item.kind === 'play') return `/motion-lab/plays/${item.ref_id}`;
  if (item.kind === 'concept') return `/reps/concepts/${item.ref_id}`;
  return item.ref.kind === 'REP' ? `/reps/${item.ref_id}` : `/quizzes/${item.ref_id}`;
}
