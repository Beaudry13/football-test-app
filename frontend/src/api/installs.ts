import { api } from './client';

/** What an install item refers to. A Rep is a quiz with kind REP. */
export type InstallItemKind = 'play' | 'quiz' | 'concept';

/** What PEIRA already knows about a play in the install. */
export interface PlayStatus {
  made: { quizzes: number; reps: number };
}
/** ...about a quiz: out, turned in, waiting to be graded, its weakest concept. */
export interface QuizStatus {
  live: boolean;
  submitted: number;
  to_grade: number;
  weakest: { concept_id: number; name: string; missed: number; responded: number } | null;
}
/** ...about a Rep: who ran it, its open football problem (first-try rules). */
export interface RepStatus {
  live: boolean;
  ran: number;
  invited: number;
  open_problem: { name: string; concept_id: number | null; missed: number; responded: number; taught: boolean } | null;
}
/** ...about a concept: how much of his football is about it. */
export interface ConceptStatus {
  in: { quizzes: number; reps: number };
}

export type InstallItem =
  | { id: number; kind: 'play'; section_id: number | null; position: number; ref_id: number; ref: { id: number; name: string; updated_at: string }; status: PlayStatus }
  | {
      id: number;
      kind: 'quiz';
      section_id: number | null;
      position: number;
      ref_id: number;
      ref: { id: number; title: string; kind: 'QUIZ' | 'REP'; question_count: number };
      status: QuizStatus | RepStatus;
    }
  | { id: number; kind: 'concept'; section_id: number | null; position: number; ref_id: number; ref: { id: number; name: string; is_archived: boolean }; status: ConceptStatus };

export interface InstallSummary {
  id: number;
  title: string;
  /** The room it is for ("family:Safeties"), or null for the whole team. */
  position_group: string | null;
  archived: boolean;
  /** The install he is working on this week - his choice, one at a time. */
  current: boolean;
  item_count: number;
  counts: { plays: number; quizzes: number; reps: number; concepts: number };
  created_at: string;
  updated_at: string;
}

export interface Install extends InstallSummary {
  sections: { id: number; title: string; position: number }[];
  items: InstallItem[];
}

/** The whole order: items before any section, then each section with its items. */
export interface InstallLayout {
  loose: number[];
  sections: { id: number | null; title: string; item_ids: number[] }[];
}

export function listInstalls(archived = false): Promise<InstallSummary[]> {
  return api.get<InstallSummary[]>(`/installs${archived ? '?archived=1' : ''}`);
}

export function createInstall(input: { title: string; position_group?: string | null }): Promise<Install> {
  return api.post<Install>('/installs', input);
}

export function getInstall(id: number): Promise<Install> {
  return api.get<Install>(`/installs/${id}`);
}

export function updateInstall(
  id: number,
  input: { title?: string; position_group?: string | null; archived?: boolean; current?: boolean },
): Promise<Install> {
  return api.patch<Install>(`/installs/${id}`, input);
}

export function deleteInstall(id: number): Promise<void> {
  return api.delete<void>(`/installs/${id}`);
}

export function addToInstall(id: number, kind: InstallItemKind, refId: number, sectionId: number | null = null): Promise<Install> {
  return api.post<Install>(`/installs/${id}/items`, { kind, ref_id: refId, section_id: sectionId });
}

export function removeFromInstall(id: number, itemId: number): Promise<Install> {
  return api.delete<Install>(`/installs/${id}/items/${itemId}`);
}

export function setInstallLayout(id: number, layout: InstallLayout): Promise<Install> {
  return api.put<Install>(`/installs/${id}/layout`, layout);
}

export function duplicateInstall(id: number, title: string, makeCurrent = false): Promise<Install> {
  return api.post<Install>(`/installs/${id}/duplicate`, { title, make_current: makeCurrent });
}

/** His active installs, and which already hold this piece of football. */
export function installsFor(kind: InstallItemKind, refId: number): Promise<{ id: number; title: string; has: boolean }[]> {
  return api.get(`/installs/for?kind=${kind}&ref_id=${refId}`);
}

/** The install's order, as a layout - the shape the server takes back. */
export function layoutOf(install: Install): InstallLayout {
  const inOrder = (sectionId: number | null) =>
    install.items.filter((i) => i.section_id === sectionId).sort((a, b) => a.position - b.position).map((i) => i.id);
  return {
    loose: inOrder(null),
    sections: [...install.sections].sort((a, b) => a.position - b.position).map((s) => ({ id: s.id, title: s.title, item_ids: inOrder(s.id) })),
  };
}

/** Every item, in the order the install runs: loose first, then each section. */
export function itemsInOrder(install: Install): InstallItem[] {
  const layout = layoutOf(install);
  const byId = new Map(install.items.map((i) => [i.id, i]));
  return [...layout.loose, ...layout.sections.flatMap((s) => s.item_ids)].map((id) => byId.get(id)!).filter(Boolean);
}
