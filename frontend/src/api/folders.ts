import { api } from './client';
import type { Folder } from './types';

export function listFolders(): Promise<Folder[]> {
  return api.get<Folder[]>('/folders');
}

export function createFolder(input: { name: string }): Promise<Folder> {
  return api.post<Folder>('/folders', input);
}

export function renameFolder(folderId: number, input: { name: string }): Promise<Folder> {
  return api.patch<Folder>(`/folders/${folderId}`, input);
}

export function deleteFolder(folderId: number): Promise<void> {
  return api.delete<void>(`/folders/${folderId}`);
}
