import { api } from './client';
import type { Roster } from './types';

export function getRoster(quizId: number): Promise<Roster> {
  return api.get<Roster>(`/quizzes/${quizId}/roster`);
}

export function setRoster(quizId: number, players: string[]): Promise<Roster> {
  return api.put<Roster>(`/quizzes/${quizId}/roster`, { players });
}

export function uploadRosterCsv(quizId: number, file: File): Promise<Roster> {
  const formData = new FormData();
  formData.append('file', file);
  return api.postForm<Roster>(`/quizzes/${quizId}/roster/csv`, formData);
}
