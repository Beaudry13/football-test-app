import { api } from './client';
import type { ActiveQuizStatus, Quiz } from './types';

export function listQuizzes(): Promise<Quiz[]> {
  return api.get<Quiz[]>('/quizzes');
}

export function getActiveStatus(): Promise<ActiveQuizStatus[]> {
  return api.get<ActiveQuizStatus[]>('/quizzes/active-status');
}

export function getQuiz(quizId: number): Promise<Quiz> {
  return api.get<Quiz>(`/quizzes/${quizId}`);
}

export function createQuiz(input: {
  title: string;
  description?: string | null;
  one_question_at_a_time?: boolean;
  require_all_answers?: boolean;
}): Promise<Quiz> {
  return api.post<Quiz>('/quizzes', input);
}

export function updateQuiz(
  quizId: number,
  input: Partial<{
    title: string;
    description: string | null;
    one_question_at_a_time: boolean;
    require_all_answers: boolean;
    folder_id: number | null;
  }>,
): Promise<Quiz> {
  return api.patch<Quiz>(`/quizzes/${quizId}`, input);
}

export function deleteQuiz(quizId: number): Promise<void> {
  return api.delete<void>(`/quizzes/${quizId}`);
}

export function duplicateQuiz(quizId: number): Promise<Quiz> {
  return api.post<Quiz>(`/quizzes/${quizId}/duplicate`);
}
