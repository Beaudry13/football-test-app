import { api } from './client';
import type { AnnotationLayer, Question, QuestionImage, QuestionType } from './types';

export interface QuestionOptionInput {
  option_text: string;
  is_correct_answer: boolean;
}

export interface QuestionInput {
  question_text: string;
  question_type: QuestionType;
  options: QuestionOptionInput[];
  position?: number | null;
}

export function createQuestion(quizId: number, input: QuestionInput): Promise<Question> {
  return api.post<Question>(`/quizzes/${quizId}/questions`, input);
}

export function updateQuestion(
  quizId: number,
  questionId: number,
  input: Partial<QuestionInput>,
): Promise<Question> {
  return api.patch<Question>(`/quizzes/${quizId}/questions/${questionId}`, input);
}

export function deleteQuestion(quizId: number, questionId: number): Promise<void> {
  return api.delete<void>(`/quizzes/${quizId}/questions/${questionId}`);
}

export function reorderQuestions(quizId: number, questionIds: number[]): Promise<Question[]> {
  return api.post<Question[]>(`/quizzes/${quizId}/questions/reorder`, { question_ids: questionIds });
}

export function uploadQuestionImage(
  quizId: number,
  questionId: number,
  file: File,
): Promise<QuestionImage> {
  const formData = new FormData();
  formData.append('image', file);
  return api.postForm<QuestionImage>(`/quizzes/${quizId}/questions/${questionId}/image`, formData);
}

export function saveAnnotations(
  quizId: number,
  questionId: number,
  annotations: AnnotationLayer[],
): Promise<QuestionImage> {
  return api.put<QuestionImage>(`/quizzes/${quizId}/questions/${questionId}/image/annotations`, {
    annotations,
  });
}

export function deleteQuestionImage(quizId: number, questionId: number): Promise<void> {
  return api.delete<void>(`/quizzes/${quizId}/questions/${questionId}/image`);
}
