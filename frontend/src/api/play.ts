import { api } from './client';
import type {
  AssessmentMode,
  AttemptState,
  PlayerResultsResponse,
  PracticeFeedback,
  ValidateCodeResponse,
} from './types';
import type { DrawingDocument } from '../components/drawing/types';
import { attemptTokenHeaders } from '../pages/play/attemptToken';

/** What proving who you are returns - with a PIN or with the token this device
 *  already holds. */
export interface ClaimAttemptResponse {
  /** A NEW token, or null when the device's existing token was accepted and
   *  kept. The ONLY place a raw attempt token ever appears: keep it with
   *  saveAttemptToken, never in a URL. */
  attempt_token: string | null;
  token_header: string;
  player: { player_id: number; name: string };
  /** True when an attempt already existed. A PIN claim then rotates the token,
   *  which signs any other device out of this attempt. */
  reclaimed: boolean;
  /** The full attempt state for a quiz to play; just its id and status for a
   *  graded attempt that is already submitted. */
  attempt: AttemptState | { attempt_id: number; status: 'submitted' | 'in_progress' };
}

/** A canonical player proves who they are - with their PIN, or (no PIN) with
 *  the token this device holds for this code. The PIN travels in the body of
 *  this one request and is stored nowhere. */
export function claimAttempt(
  input: { access_code_id: number; player_id: number; pin?: string },
  token?: string | null,
): Promise<ClaimAttemptResponse> {
  return api.post<ClaimAttemptResponse>('/play/claim', input, {
    auth: false,
    headers: attemptTokenHeaders(input.pin ? null : token ?? null),
  });
}

/** The roster a player picks their name from to open results. Identifiers
 *  only - the same list whoever has or hasn't finished. */
export interface ResultsIdentity {
  player_id: number | null;
  name: string;
  jersey_number?: string | null;
  position?: string | null;
}

export function getResultsIdentities(code: string): Promise<{ identities: ResultsIdentity[] }> {
  return api.post<{ identities: ResultsIdentity[] }>('/play/results/identities', { code }, { auth: false });
}

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
  /** "Select all that apply" - the complete set, replacing whatever is stored. */
  selected_option_ids?: number[] | null;
  answer_text?: string | null;
  /** Milliseconds the question was on screen before this first answer.
   *  Omitted where it cannot be measured honestly - see QuizStep. */
  time_to_answer_ms?: number;
}, token?: string | null): Promise<void> {
  return api.post<void>('/play/answers', input, { auth: false, headers: attemptTokenHeaders(token ?? null) });
}

/** PRACTICE ONLY. "I'm done with this question - how did I do?"
 *
 * Deliberately a separate call from saveAnswer rather than a flag on it.
 * Autosave answers "is my work safe"; this answers "how did I do", and
 * fusing them would mean a player mid-typing could be shown a verdict they
 * never asked for. It also keeps the graded path with no route that reveals
 * correctness at all. Locks the question server-side as a side effect. */
export function checkAnswer(input: {
  access_code_id: number;
  player_name: string;
  player_id?: number;
  question_id: number;
}, token?: string | null): Promise<PracticeFeedback> {
  return api.post<PracticeFeedback>('/play/check', input, { auth: false, headers: attemptTokenHeaders(token ?? null) });
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
}, token?: string | null): Promise<SaveDrawingResult> {
  return api.put<SaveDrawingResult>('/play/drawing', input, { auth: false, headers: attemptTokenHeaders(token ?? null) });
}

export interface AnswerSubmission {
  question_id: number;
  answer_text?: string | null;
  selected_option_id?: number | null;
  /** "Select all that apply" - the complete set, replacing whatever is stored. */
  selected_option_ids?: number[] | null;
  /** Re-sent at submit as the same safety net the text answers get, so one
   * failed autosave on a flaky connection does not cost the player their
   * answer. The server treats submit as authoritative and will not 409 it
   * against the player's own earlier autosave. */
  drawing?: DrawingDocument | null;
}

/** What /submit echoes back: the player-safe shape, never the coach's view of
 *  the attempt. */
export interface SubmitQuizResponse {
  attempt_id: number;
  status: 'submitted';
  submitted_at: string;
  mode: AssessmentMode;
}

export function submitQuiz(input: {
  access_code_id: number;
  player_name: string;
  player_id?: number;
  answers: AnswerSubmission[];
}, token?: string | null): Promise<SubmitQuizResponse> {
  return api.post<SubmitQuizResponse>('/play/submit', input, { auth: false, headers: attemptTokenHeaders(token ?? null) });
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

/** A player's results. When a PIN opens them, the server issues this device a
 *  token for next time - it arrives beside the results, never inside them. */
export interface PlayerResultsWithAuth extends PlayerResultsResponse {
  player_auth?: { attempt_token: string; token_header: string };
}

/** `playerId`, when known, disambiguates two same-name canonical Players -
 * a name-only lookup can't tell them apart and would return whichever
 * attempt the server happens to find first.
 *
 * `auth` proves who is asking, where that is required: the PIN the player just
 * typed, or the token this device holds. A PIN wins over a token. */
export function getPlayerResults(
  code: string,
  playerName: string,
  playerId?: number,
  auth?: { pin?: string; token?: string | null },
): Promise<PlayerResultsWithAuth> {
  const body: Record<string, unknown> = { code, player_name: playerName, player_id: playerId };
  if (auth?.pin) body.pin = auth.pin;
  return api.post<PlayerResultsWithAuth>('/play/results', body, {
    auth: false,
    headers: attemptTokenHeaders(auth?.pin ? null : auth?.token ?? null),
  });
}
