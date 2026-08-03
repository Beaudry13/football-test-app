import { api } from './client';
import type { AttemptState, PlayerResponse, PlayerResultsResponse, ValidateCodeResponse } from './types';

export function validateCode(code: string): Promise<ValidateCodeResponse> {
  return api.post<ValidateCodeResponse>('/play/validate-code', { code }, { auth: false });
}

/** Creates the attempt the moment a player picks their name, or resumes an
 * existing in-progress one with its saved answers if they've already
 * started. Throws an ApiError with status 409 if this name has already
 * submitted this quiz under this access code. */
export function startAttempt(input: {
  access_code_id: number;
  player_name: string;
}): Promise<AttemptState> {
  return api.post<AttemptState>('/play/start', input, { auth: false });
}

/** Autosaves one answer against an already-started attempt. Re-derives the
 * attempt server-side from (access_code_id, player_name) rather than
 * trusting a client-held attempt id. */
export function saveAnswer(input: {
  access_code_id: number;
  player_name: string;
  question_id: number;
  selected_option_id?: number | null;
  answer_text?: string | null;
}): Promise<void> {
  return api.post<void>('/play/answers', input, { auth: false });
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

/** Title-only lookup for the browser tab title, fired before a player has
 * done anything (just landed on /play/CODE). Never errors on an invalid/
 * expired/deactivated code - resolves to `{ quiz_title: null }` instead, so
 * callers fall back to generic branding. */
export function getQuizTitleByCode(code: string): Promise<{ quiz_title: string | null }> {
  return api.get<{ quiz_title: string | null }>(`/play/quiz-by-code/${encodeURIComponent(code)}`, {
    auth: false,
  });
}

export function getPlayerResults(code: string, playerName: string): Promise<PlayerResultsResponse> {
  return api.post<PlayerResultsResponse>(
    '/play/results',
    { code, player_name: playerName },
    { auth: false },
  );
}
