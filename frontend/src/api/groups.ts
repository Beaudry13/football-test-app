import { api } from './client';
import type { Group } from './types';

export function listGroups(): Promise<Group[]> {
  return api.get<Group[]>('/groups');
}

export function createGroup(input: { name: string }): Promise<Group> {
  return api.post<Group>('/groups', input);
}

export function getGroup(groupId: number): Promise<Group> {
  return api.get<Group>(`/groups/${groupId}`);
}

export function renameGroup(groupId: number, input: { name: string }): Promise<Group> {
  return api.patch<Group>(`/groups/${groupId}`, input);
}

export function setGroupPlayers(groupId: number, players: string[]): Promise<Group> {
  return api.put<Group>(`/groups/${groupId}/players`, { players });
}

export function uploadGroupPlayersCsv(groupId: number, file: File): Promise<Group> {
  const formData = new FormData();
  formData.append('file', file);
  return api.postForm<Group>(`/groups/${groupId}/players/csv`, formData);
}

export function deleteGroup(groupId: number): Promise<void> {
  return api.delete<void>(`/groups/${groupId}`);
}
