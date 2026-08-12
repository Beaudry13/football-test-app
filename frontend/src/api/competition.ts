/**
 * Competition Mode API client.
 *
 * The contract is frozen in `docs/COMPETITION-API.md`. Two rules from it are
 * enforced here rather than left to each caller:
 *
 * 1. The seat token travels in the `X-Competition-Token` HEADER. There is no
 *    function in this file that puts it in a path or a query string, and
 *    there is a test asserting that.
 * 2. `player_id` and `participant_id` are identifiers, never credentials.
 *    Nothing here authenticates with either.
 */

import { api } from './client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The M1 states. M2 adds QUESTION_OPEN / QUESTION_REVEAL / LEADERBOARD. */
export type CompetitionStatus =
  | 'LOBBY'
  | 'QUESTION_OPEN'
  | 'QUESTION_REVEAL'
  | 'LEADERBOARD'
  | 'COMPLETE'
  | 'ABANDONED';

export const TERMINAL_STATUSES: CompetitionStatus[] = ['COMPLETE', 'ABANDONED'];

export function isTerminal(status: CompetitionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** The 1 Hz payload. Exactly six fields - see the contract's §4D. */
export interface CompetitionPollState {
  version: number;
  status: CompetitionStatus;
  server_now: string;
  current_round: number;
  question_closes_at: string | null;
  /**
   * A COUNT, never a roster. This exists so the waiting room can show how many
   * players are in the room without fetching the room - it is computed as a
   * correlated subquery inside the poll's single SELECT.
   */
  participant_count: number;
}

export interface UnsupportedQuestion {
  question_id: number;
  position: number;
  question_type: string;
  reason: string;
}

export interface CompetitionReadiness {
  quiz_id: number;
  question_count: number;
  supported_question_count: number;
  unsupported_questions: UnsupportedQuestion[];
  can_launch: boolean;
}

export interface RosterEntry {
  player_id: number;
  display_name: string;
  taken: boolean;
}

export interface CompetitionParticipant {
  id: number;
  player_id: number;
  display_name: string;
  joined_at: string;
  total_points: number;
  current_streak: number;
  best_streak: number;
}

/** The player-facing lobby. Fetched on version change, never on the timer. */
export interface CompetitionLobby {
  join_code: string;
  status: CompetitionStatus;
  version: number;
  quiz_title: string | null;
  question_time_seconds: number;
  server_now: string;
  roster: RosterEntry[];
  participants: { id: number; display_name: string }[];
}

export interface CompetitionHostView {
  id: number;
  quiz_id: number;
  quiz_title: string | null;
  join_code: string;
  status: CompetitionStatus;
  version: number;
  current_round: number;
  question_time_seconds: number;
  participant_count: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  expires_at: string;
  participants: CompetitionParticipant[];
  eligible_count: number;
  not_joined: { player_id: number; display_name: string }[];
}

export interface JoinResult {
  participant: CompetitionParticipant;
  /** THE ONLY place a token is ever returned. Store it, never display it. */
  reconnect_token: string;
  join_code: string;
  status: CompetitionStatus;
  version: number;
}

export interface ResumeResult {
  participant: CompetitionParticipant;
  status: CompetitionStatus;
  version: number;
  server_now: string;
}

// ---------------------------------------------------------------------------
// Coach (JWT)
// ---------------------------------------------------------------------------

export function getReadiness(quizId: number) {
  return api.get<CompetitionReadiness>(`/competition/quizzes/${quizId}/readiness`);
}

export function createSession(
  quizId: number,
  options: { group_ids?: number[]; question_time_seconds?: number } = {},
) {
  return api.post<CompetitionHostView>(`/competition/quizzes/${quizId}`, options);
}

/**
 * The coach's reconnect path: join code -> host view.
 *
 * The host lobby URL carries the code, not the session id, so a refresh has
 * nothing else to go on. Same ownership check as every other host route.
 */
/** A live competition this coach can walk back into. */
export interface ActiveCompetition {
  id: number;
  join_code: string;
  quiz_id: number;
  quiz_title: string | null;
  status: CompetitionStatus;
  participant_count: number;
  created_at: string;
  expires_at: string;
}

/**
 * What is live for this coach right now.
 *
 * The server is the source of truth: a coach who closed the tab has nothing
 * in storage and may not remember the code. Returns only non-terminal,
 * unexpired sessions this coach may control.
 */
export function getActiveCompetitions() {
  return api.get<ActiveCompetition[]>('/competition/active');
}

export function getHostViewByCode(joinCode: string) {
  return api.get<CompetitionHostView>(
    `/competition/sessions/by-code/${encodeURIComponent(joinCode)}`,
  );
}

export function getHostView(sessionId: number) {
  return api.get<CompetitionHostView>(`/competition/sessions/${sessionId}`);
}

export function getHostState(sessionId: number) {
  return api.get<CompetitionPollState>(`/competition/sessions/${sessionId}/state`);
}

export function removeParticipant(sessionId: number, participantId: number) {
  return api.delete<CompetitionHostView>(
    `/competition/sessions/${sessionId}/participants/${participantId}`,
  );
}

export function endSession(sessionId: number) {
  return api.post<CompetitionHostView>(`/competition/sessions/${sessionId}/end`);
}

// ---------------------------------------------------------------------------
// Player (public; the join code is the address, the token is the credential)
// ---------------------------------------------------------------------------

/**
 * THE 1 Hz POLL. `auth: false` because a player has no account - sending a
 * coach's JWT from a shared device would be both useless and careless.
 */
export function pollState(joinCode: string) {
  return api.get<CompetitionPollState>(`/competition/${encodeURIComponent(joinCode)}/state`, {
    auth: false,
  });
}

export function getLobby(joinCode: string) {
  return api.get<CompetitionLobby>(`/competition/${encodeURIComponent(joinCode)}`, {
    auth: false,
  });
}

/**
 * Claim a seat.
 *
 * `reconnectToken` is sent ONLY when this client already believes it holds
 * this seat and is retrying after a lost response. Omitting it on a genuinely
 * taken identity is what produces `409 identity_taken` - which is the correct
 * answer, not an error to work around.
 */
export function joinCompetition(joinCode: string, playerId: number, reconnectToken?: string) {
  return api.post<JoinResult>(
    `/competition/${encodeURIComponent(joinCode)}/join`,
    { player_id: playerId },
    {
      auth: false,
      headers: reconnectToken ? { 'X-Competition-Token': reconnectToken } : undefined,
    },
  );
}

/**
 * Restore a seat after a refresh. Addressed by TOKEN only.
 *
 * There is deliberately no variant of this that accepts a player id or a
 * participant id - both are public, so both would authenticate nothing.
 */
export function resumeCompetition(joinCode: string, reconnectToken: string) {
  return api.get<ResumeResult>(`/competition/${encodeURIComponent(joinCode)}/me`, {
    auth: false,
    headers: { 'X-Competition-Token': reconnectToken },
  });
}
