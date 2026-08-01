import { api } from './client';
import type { AccessCode } from './types';

export function listAccessCodes(quizId: number): Promise<AccessCode[]> {
  return api.get<AccessCode[]>(`/quizzes/${quizId}/access-codes`);
}

export function activateQuiz(quizId: number, groupIds: number[] = []): Promise<AccessCode> {
  return api.post<AccessCode>(`/quizzes/${quizId}/access-codes`, { group_ids: groupIds });
}

export function deactivateAccessCode(quizId: number, accessCodeId: number): Promise<AccessCode> {
  return api.post<AccessCode>(`/quizzes/${quizId}/access-codes/${accessCodeId}/deactivate`);
}
