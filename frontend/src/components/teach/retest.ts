import { createRepRetest } from '../../api/reps';
import { createRetest } from '../../api/retests';

// RETEST, ONE MEANING EVERYWHERE: build the retest for exactly the players who
// missed it and open it, ready to send. Nothing goes to players until the coach
// presses Send on the retest itself - where it says who gets it. The same words
// on Results, the Rep page, Teach, a position room, Home and an install.

/** "Ty" from "Ty Adams" - a button says a name, not a roster line. */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** "Retest the 3" / "Retest Ty" - or, where only the count is known, "Retest the 3". */
export function retestLabel(who: string[] | number): string {
  if (typeof who === 'number') return `Retest the ${who}`;
  return who.length === 1 ? `Retest ${firstName(who[0])}` : `Retest the ${who.length}`;
}

/** A quiz retest draft for exactly these players: roster ids where they have a
 *  roster record, the typed name where they joined without one - dropping
 *  those would quietly shrink the retest. Returns where it opens, to send. */
export async function buildQuizRetest(
  quizId: number,
  scope: { concept_id?: number | null; question_ids?: number[] },
  missed: { player_id: number | null; player_name: string }[],
): Promise<string> {
  const draft = await createRetest(quizId, {
    ...scope,
    player_ids: missed.map((p) => p.player_id).filter((id): id is number => id !== null),
    player_names: missed.filter((p) => p.player_id === null).map((p) => p.player_name),
  });
  return `/quizzes/${draft.id}?tab=activate`;
}

/** A Rep retest - this concept's decisions, its roster exactly who missed -
 *  built, not sent. Returns where it opens, to send. */
export async function buildRepRetest(repId: number, conceptId: number | null): Promise<string> {
  const made = await createRepRetest(repId, conceptId);
  return `/reps/${made.id}`;
}
