import { api } from './client';
import type { Folder } from './types';

/**
 * Motion Lab plays, looks and Motion Lab folders - organization-owned content.
 *
 * `document` is the coach's authored intent exactly as the Motion Lab model
 * defines it (engine/play.ts) minus the fields that are columns here. The
 * server checks its structure and never interprets the football.
 */

export interface MotionPlayDocument {
  players: unknown[];
  ball: unknown;
  ballThen: unknown;
  engagements: unknown[];
  situation: unknown;
  filter: string;
}

export interface MotionPlayRow {
  id: number;
  name: string;
  document: MotionPlayDocument;
  schema_version: number;
  /** Bumped on every content write; a save naming an older one is refused (409). */
  revision: number;
  folder_id: number | null;
  /** Provenance only - never a live link. */
  copied_from_play_id: number | null;
  created_by_coach_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface MotionLookRow {
  id: number;
  name: string;
  document: { players: unknown[] };
  schema_version: number;
  revision: number;
  created_by_coach_id: number | null;
  created_at: string;
  updated_at: string;
}

/** A 409 carrying this reason means "changed somewhere else since you loaded it". */
export const REVISION_CONFLICT = 'revision_conflict';

/** Browsers refuse keepalive bodies over ~64KB; stay under it. */
const KEEPALIVE_LIMIT = 60 * 1024;
const keepaliveFor = (body: unknown) => JSON.stringify(body).length < KEEPALIVE_LIMIT;

// ---- plays -----------------------------------------------------------------

export function listMotionPlays(): Promise<MotionPlayRow[]> {
  return api.get<MotionPlayRow[]>('/motion-lab/plays');
}

export function getMotionPlay(id: number): Promise<MotionPlayRow> {
  return api.get<MotionPlayRow>(`/motion-lab/plays/${id}`);
}

export function createMotionPlay(input: {
  name: string;
  document: MotionPlayDocument;
  schema_version: number;
  folder_id?: number | null;
}): Promise<MotionPlayRow> {
  return api.post<MotionPlayRow>('/motion-lab/plays', input, { keepalive: keepaliveFor(input) });
}

export function saveMotionPlay(
  id: number,
  input: { name: string; document: MotionPlayDocument; schema_version: number; base_revision: number },
): Promise<MotionPlayRow> {
  return api.put<MotionPlayRow>(`/motion-lab/plays/${id}`, input, { keepalive: keepaliveFor(input) });
}

/** Library housekeeping: rename (bumps the revision) or file (does not). */
export function updateMotionPlay(id: number, input: { name?: string; folder_id?: number | null }): Promise<MotionPlayRow> {
  return api.patch<MotionPlayRow>(`/motion-lab/plays/${id}`, input);
}

export function copyMotionPlay(id: number, input: { name?: string; folder_id?: number | null } = {}): Promise<MotionPlayRow> {
  return api.post<MotionPlayRow>(`/motion-lab/plays/${id}/copy`, input);
}

export function deleteMotionPlay(id: number): Promise<void> {
  return api.delete<void>(`/motion-lab/plays/${id}`);
}

// ---- looks -----------------------------------------------------------------

export function listMotionLooks(): Promise<MotionLookRow[]> {
  return api.get<MotionLookRow[]>('/motion-lab/looks');
}

export function createMotionLook(input: { name: string; document: { players: unknown[] }; schema_version: number }): Promise<MotionLookRow> {
  return api.post<MotionLookRow>('/motion-lab/looks', input);
}

export function deleteMotionLook(id: number): Promise<void> {
  return api.delete<void>(`/motion-lab/looks/${id}`);
}

// ---- Motion Lab folders ------------------------------------------------------
// The same folder system Quizzes uses, in its own tree. Rename and delete are
// the ordinary folder routes (api/folders.ts); only listing and creating need
// to name the area.

export function listMotionFolders(): Promise<Folder[]> {
  return api.get<Folder[]>('/folders?area=motion');
}

export function createMotionFolder(input: { name: string; parent_folder_id?: number | null }): Promise<Folder> {
  return api.post<Folder>('/folders', { ...input, area: 'motion' });
}
