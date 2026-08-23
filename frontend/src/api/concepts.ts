import { api } from './client';

export interface Concept {
  id: number;
  name: string;
  is_archived: boolean;
}

/** Every concept this organization can currently tag with.
 *
 * Archived ones are withheld by the server - they exist so history keeps
 * resolving, not so a coach can keep choosing them. A question that already
 * references an archived concept still shows it, because that question's own
 * payload carries it; see QuestionEditor.
 */
export function listConcepts(): Promise<Concept[]> {
  return api.get<Concept[]>('/concepts');
}

/** Add a concept, or get back the one that already means this.
 *
 * A COACH TYPING AN EXISTING NAME IS NOT AN ERROR, so this is not a
 * create-or-409. The server case-folds first and returns the existing concept
 * (reviving it if archived), which is the answer the picker actually wants -
 * a conflict status would only make the caller interpret it and then do the
 * same thing.
 */
export function createConcept(name: string): Promise<Concept> {
  return api.post<Concept>('/concepts', { name });
}
