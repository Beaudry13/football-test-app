import { api } from './client';
import type { Roster } from './types';

export function getRoster(quizId: number): Promise<Roster> {
  return api.get<Roster>(`/quizzes/${quizId}/roster`);
}

/** Put roster Players straight onto a quiz's own roster (idempotent). */
export function addRosterMembers(quizId: number, playerIds: number[]): Promise<Roster> {
  return api.post<Roster>(`/quizzes/${quizId}/roster/members`, { player_ids: playerIds });
}

export function setRoster(quizId: number, players: string[]): Promise<Roster> {
  return api.put<Roster>(`/quizzes/${quizId}/roster`, { players });
}

export function uploadRosterCsv(quizId: number, file: File): Promise<Roster> {
  const formData = new FormData();
  formData.append('file', file);
  return api.postForm<Roster>(`/quizzes/${quizId}/roster/csv`, formData);
}
