import { api } from './client';
import type { Answer, PlayerHistoryEntry, PlayerResponse, QuizDashboard } from './types';

export function listResponses(quizId: number): Promise<PlayerResponse[]> {
  return api.get<PlayerResponse[]>(`/quizzes/${quizId}/responses`);
}

export function getResponse(quizId: number, responseId: number): Promise<PlayerResponse> {
  return api.get<PlayerResponse>(`/quizzes/${quizId}/responses/${responseId}`);
}

/** Coach-triggered manual reset: deletes the attempt outright so the
 * player can start fresh next time they enter their name. Not reversible -
 * any grading/feedback already on it is gone, not archived. */
export function resetAttempt(quizId: number, attemptId: number): Promise<void> {
  return api.delete<void>(`/quizzes/${quizId}/attempts/${attemptId}`);
}

export function gradeAnswer(
  answerId: number,
  input: { is_correct: boolean; coach_feedback?: string | null },
): Promise<Answer> {
  return api.patch<Answer>(`/answers/${answerId}/grade`, input);
}

/** One of the coach's quizzes with answers only he can decide, still waiting. */
export interface ToGrade {
  quiz_id: number;
  title: string;
  count: number;
}

/** What is waiting on the coach's eyes - the grading screen's own rules. */
export function listToGrade(): Promise<ToGrade[]> {
  return api.get<ToGrade[]>('/quizzes/to-grade');
}

export function getQuizDashboard(quizId: number): Promise<QuizDashboard> {
  return api.get<QuizDashboard>(`/quizzes/${quizId}/dashboard`);
}

export function getPlayerHistory(playerName: string): Promise<{ player_name: string; history: PlayerHistoryEntry[] }> {
  return api.get(`/players/history?name=${encodeURIComponent(playerName)}`);
}

export function exportResultsCsv(quizId: number): Promise<Blob> {
  return api.getBlob(`/quizzes/${quizId}/export.csv`);
}

export function exportResultsPdf(quizId: number): Promise<Blob> {
  return api.getBlob(`/quizzes/${quizId}/export.pdf`);
}

/** Full per-Player, per-question results PDF - the "Detailed PDF" export.
 * Distinct from exportResultsPdf above, which stays the lighter-weight
 * "Summary PDF" (one row per Player, no per-question breakdown). */
export function exportResultsDetailedPdf(quizId: number): Promise<Blob> {
  return api.getBlob(`/quizzes/${quizId}/export-detailed.pdf`);
}
