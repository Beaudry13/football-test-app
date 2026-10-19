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

/** Concepts that look like one idea, each with how many questions use it. */
export interface ConceptDuplicateGroup {
  concepts: { id: number; name: string; question_count: number }[];
  suggested_keep: number;
}

export function getConceptDuplicates(): Promise<ConceptDuplicateGroup[]> {
  return api.get<ConceptDuplicateGroup[]>('/concepts/duplicates');
}

/** Merge spellings into the kept concept: questions retagged, the rest archived. Admins only. */
export function mergeConcepts(keepId: number, mergeIds: number[]): Promise<{ kept: Concept; retagged: number }> {
  return api.post('/concepts/merge', { keep_id: keepId, merge_ids: mergeIds });
}
