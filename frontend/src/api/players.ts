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

/** A PIN exactly as issued - the ONLY payload that ever carries one. It exists
 *  in memory for as long as the PIN sheet is open and nowhere else. */
export interface IssuedPin {
  player_id: number;
  first_name: string;
  last_name: string;
  full_name: string;
  jersey_number: string | null;
  position: string | null;
  pin: string;
}

/** One batch of PINs for active players who have none. Never replaces a PIN.
 *  Call again until `remaining` is 0 - see MasterRosterPage. */
export function generateMissingPins(): Promise<{ issued: IssuedPin[]; remaining: number }> {
  return api.post<{ issued: IssuedPin[]; remaining: number }>('/players/pins/generate-missing');
}

/** A new PIN for one player (or their first). The old one stops working;
 *  nothing about their quizzes or results changes. */
export function resetPlayerPin(playerId: number): Promise<{ issued: IssuedPin; pin_version: number }> {
  return api.post<{ issued: IssuedPin; pin_version: number }>(`/players/${playerId}/pin/reset`);
}

/** Set one player's PIN to digits the coach chose.
 *
 *  The PIN travels in this one request and comes back once so it can be handed
 *  over. Peira stores only a hash: nothing can read it back afterwards, and a
 *  player who already had a PIN is reset (their old PIN and any signed-in
 *  device stop working; their attempts and results do not change). */
export function setPlayerPin(
  playerId: number,
  pin: string,
): Promise<{ issued: IssuedPin; pin_version: number }> {
  return api.post<{ issued: IssuedPin; pin_version: number }>(`/players/${playerId}/pin`, { pin });
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
