import { api } from './client';
import type { Answer, PlayerHistoryEntry, PlayerResponse, QuizDashboard } from './types';

export function listResponses(quizId: number): Promise<PlayerResponse[]> {
  return api.get<PlayerResponse[]>(`/quizzes/${quizId}/responses`);
}

export function getResponse(quizId: number, responseId: number): Promise<PlayerResponse> {
  return api.get<PlayerResponse>(`/quizzes/${quizId}/responses/${responseId}`);
}

export function gradeAnswer(
  answerId: number,
  input: { is_correct: boolean; coach_feedback?: string | null },
): Promise<Answer> {
  return api.patch<Answer>(`/answers/${answerId}/grade`, input);
}

export function getQuizDashboard(quizId: number): Promise<QuizDashboard> {
  return api.get<QuizDashboard>(`/quizzes/${quizId}/dashboard`);
}

export function getPlayerHistory(playerName: string): Promise<{ player_name: string; history: PlayerHistoryEntry[] }> {
  return api.get(`/players/history?name=${encodeURIComponent(playerName)}`);
}
