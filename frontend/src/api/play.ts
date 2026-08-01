import { api } from './client';
import type { PlayerResponse, ValidateCodeResponse } from './types';

export function validateCode(code: string): Promise<ValidateCodeResponse> {
  return api.post<ValidateCodeResponse>('/play/validate-code', { code }, { auth: false });
}

export interface AnswerSubmission {
  question_id: number;
  answer_text?: string | null;
  selected_option_id?: number | null;
}

export function submitQuiz(input: {
  access_code_id: number;
  player_name: string;
  answers: AnswerSubmission[];
}): Promise<PlayerResponse> {
  return api.post<PlayerResponse>('/play/submit', input, { auth: false });
}
