import { api } from './client';
import type { AttemptState, PlayerResponse, PlayerResultsResponse, ValidateCodeResponse } from './types';
import type { DrawingDocument } from '../components/drawing/types';

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
  /** Set when the player picked a canonical master-roster entry - see
   * NameStep. Never trusted blindly server-side; validated against the
   * activation's actual effective roster. */
  player_id?: number;
}): Promise<AttemptState> {
  return api.post<AttemptState>('/play/start', input, { auth: false });
}

/** Autosaves one answer against an already-started attempt. Re-derives the
 * attempt server-side from (access_code_id, player_name) - or, when set,
 * (access_code_id, player_id), which is what lets two Players who share a
 * display name never collide onto the same attempt - rather than trusting
 * a client-held attempt id. */
export function saveAnswer(input: {
  access_code_id: number;
  player_name: string;
  player_id?: number;
  question_id: number;
  selected_option_id?: number | null;
  answer_text?: string | null;
}): Promise<void> {
  return api.post<void>('/play/answers', input, { auth: false });
}

export interface SaveDrawingResult {
  revision: number;
  updated_at: string;
}

/** Autosaves a Draw Response answer.
 *
 * `base_revision` is the revision the server last returned. Sending a stale
 * one gets a 409 rather than overwriting: two devices, or one that spent a
 * while out of signal, would otherwise silently cost the player minutes of
 * work with no undo. A first save sends null.
 *
 * Deliberately a separate call from saveAnswer - a drawing payload is orders
 * of magnitude larger, debounced differently, and carries a revision the text
 * path has no concept of. */
export function saveDrawing(input: {
  access_code_id: number;
  player_name: string;
  player_id?: number;
  question_id: number;
  document: DrawingDocument;
  base_revision?: number | null;
}): Promise<SaveDrawingResult> {
  return api.put<SaveDrawingResult>('/play/drawing', input, { auth: false });
}

export interface AnswerSubmission {
  question_id: number;
  answer_text?: string | null;
  selected_option_id?: number | null;
  /** Re-sent at submit as the same safety net the text answers get, so one
   * failed autosave on a flaky connection does not cost the player their
   * answer. The server treats submit as authoritative and will not 409 it
   * against the player's own earlier autosave. */
  drawing?: DrawingDocument | null;
}

export function submitQuiz(input: {
  access_code_id: number;
  player_name: string;
  player_id?: number;
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

/** `playerId`, when known, disambiguates two same-name canonical Players -
 * a name-only lookup can't tell them apart and would return whichever
 * attempt the server happens to find first. */
export function getPlayerResults(
  code: string,
  playerName: string,
  playerId?: number,
): Promise<PlayerResultsResponse> {
  return api.post<PlayerResultsResponse>(
    '/play/results',
    { code, player_name: playerName, player_id: playerId },
    { auth: false },
  );
}
