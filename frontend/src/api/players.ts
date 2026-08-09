import { api } from './client';
import type {
  Group,
  ImportConfirmResponse,
  ImportPreviewResponse,
  Player,
  PlayerHistory,
  Roster,
} from './types';

export interface PlayerInput {
  first_name: string;
  last_name: string;
  jersey_number?: string | null;
  position?: string | null;
}

export function listPlayers(params: { q?: string; position?: string; active?: 'true' | 'false' | 'all' } = {}): Promise<Player[]> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.position) search.set('position', params.position);
  if (params.active) search.set('active', params.active);
  const query = search.toString();
  return api.get<Player[]>(`/players${query ? `?${query}` : ''}`);
}

export function createPlayer(input: PlayerInput): Promise<Player> {
  return api.post<Player>('/players', input);
}

export function bulkCreatePlayers(players: PlayerInput[]): Promise<Player[]> {
  return api.post<Player[]>('/players/bulk', { players });
}

export function getPlayer(playerId: number): Promise<Player> {
  return api.get<Player>(`/players/${playerId}`);
}

export function getPlayerHistory(playerId: number): Promise<PlayerHistory> {
  return api.get<PlayerHistory>(`/players/${playerId}/history`);
}

export function updatePlayer(playerId: number, input: PlayerInput): Promise<Player> {
  return api.patch<Player>(`/players/${playerId}`, input);
}

export function uploadPlayerPhoto(playerId: number, file: File): Promise<Player> {
  const formData = new FormData();
  formData.append('photo', file);
  return api.postForm<Player>(`/players/${playerId}/photo`, formData);
}

export function deactivatePlayer(playerId: number): Promise<Player> {
  return api.post<Player>(`/players/${playerId}/deactivate`);
}

export function reactivatePlayer(playerId: number): Promise<Player> {
  return api.post<Player>(`/players/${playerId}/reactivate`);
}

export function deletePlayer(playerId: number): Promise<void> {
  return api.delete<void>(`/players/${playerId}`);
}

export function previewImport(
  rawText: string,
  columnMapping?: Record<string, string | null>,
): Promise<ImportPreviewResponse> {
  return api.post<ImportPreviewResponse>('/players/import/preview', {
    raw_text: rawText,
    column_mapping: columnMapping ?? null,
  });
}

export interface ImportRowInput {
  first_name: string;
  last_name: string;
  jersey_number?: string | null;
  position?: string | null;
  action: 'create' | 'update' | 'skip';
  existing_player_id?: number | null;
}

export function confirmImport(rows: ImportRowInput[]): Promise<ImportConfirmResponse> {
  return api.post<ImportConfirmResponse>('/players/import/confirm', { rows });
}

export function downloadImportTemplate(): Promise<Blob> {
  return api.getBlob('/players/import/template.csv');
}

/** One cumulative performance PDF covering every selected player.
 *
 *  Scoped server-side to the signed-in coach's own quizzes - see the Coach
 *  View rule in backend routes/players.cumulative_performance_report. */
export function downloadPerformanceReport(playerIds: number[]): Promise<Blob> {
  return api.getBlob(`/players/report.pdf?ids=${playerIds.join(',')}`);
}

export function addGroupMembers(groupId: number, playerIds: number[]): Promise<Group> {
  return api.post<Group>(`/groups/${groupId}/members`, { player_ids: playerIds });
}

export function removeGroupMember(groupId: number, playerId: number): Promise<void> {
  return api.delete<void>(`/groups/${groupId}/members/${playerId}`);
}

export function addRosterMembers(quizId: number, playerIds: number[]): Promise<Roster> {
  return api.post<Roster>(`/quizzes/${quizId}/roster/members`, { player_ids: playerIds });
}

export function removeRosterMember(quizId: number, playerId: number): Promise<void> {
  return api.delete<void>(`/quizzes/${quizId}/roster/members/${playerId}`);
}
