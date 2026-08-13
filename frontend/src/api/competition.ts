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

/**
 * The 1 Hz payload - see the contract's §4D.
 *
 * Every field is a scalar, timestamp or boolean: no names, no ids, no question
 * content. THE LIVE COUNTERS LIVE HERE, not in the heavy payloads, because
 * they move with the clock and with every submission while `version` only
 * marks structural change. Reading `answered_count` or `answering_open` off
 * the version-gated host view froze the projector on ANSWERS LOCKED with 28
 * seconds still on the clock.
 */
export interface CompetitionPollState {
  version: number;
  status: CompetitionStatus;
  server_now: string;
  current_round: number;
  total_rounds: number;
  question_opened_at: string | null;
  question_closes_at: string | null;
  /** A COUNT, never a roster. */
  participant_count: number;
  answered_count: number;
  /** Every seat has answered. Informational - it reveals nothing by itself. */
  all_in: boolean;
  answering_open: boolean;
  podium_step: number;
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

export interface CompetitionOption {
  id: number;
  option_text: string;
  position: number;
  /** Present ONLY after the reveal - the server withholds it until then. */
  is_correct_answer?: boolean;
}

export interface CompetitionQuestion {
  id: number;
  question_text: string;
  question_type: string;
  image: { image_url: string; annotations: unknown[]; canvas_width: number | null } | null;
  options: CompetitionOption[];
  /** Reveal only. */
  answer_explanation?: string | null;
  /** Reveal only. */
  correct_option_id?: number | null;
}

export interface DistributionRow {
  option_id: number;
  option_text: string;
  count: number;
  is_correct_answer: boolean;
}

/** The host's view of the current round. `distribution` is null until reveal. */
export interface HostRound {
  round_index: number;
  round_number: number;
  total_rounds: number;
  question: CompetitionQuestion;
  answered_count: number;
  participant_count: number;
  all_in: boolean;
  answering_open: boolean;
  question_opened_at: string | null;
  question_closes_at: string | null;
  distribution: DistributionRow[] | null;
}

/** One player's own view. `result` is null until reveal. */
export interface PlayerRound {
  round_index: number;
  round_number: number;
  total_rounds: number;
  status: CompetitionStatus;
  server_now: string;
  question: CompetitionQuestion | null;
  question_opened_at: string | null;
  question_closes_at: string | null;
  answering_open: boolean;
  answered: boolean;
  selected_option_id: number | null;
  result: {
    answered: boolean;
    /** null when they never answered - not the same as being wrong. */
    is_correct: boolean | null;
    points_earned: number;
    total_points: number;
    current_streak: number;
    best_streak: number;
  } | null;
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
  round?: HostRound | null;
  available_actions?: string[];
  leaderboard_hint?: string | null;
  answered_count?: number;
  all_in?: boolean;
  answering_open?: boolean;
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
/** The coach moving the room forward. `expectedVersion` makes two tabs safe. */
export function transition(sessionId: number, action: string, expectedVersion: number) {
  return api.post<CompetitionHostView>(`/competition/sessions/${sessionId}/transition`, {
    action,
    expected_version: expectedVersion,
  });
}

/** The current question for this player, plus their own state. Token-addressed. */
export function getPlayerRound(joinCode: string, reconnectToken: string) {
  return api.get<PlayerRound>(`/competition/${encodeURIComponent(joinCode)}/round`, {
    auth: false,
    headers: { 'X-Competition-Token': reconnectToken },
  });
}

/**
 * Submit an answer.
 *
 * Carries a round and an option and NOTHING else - no participant id, no
 * correctness, no timing. The server rejects unknown fields outright.
 */
export function submitAnswer(
  joinCode: string,
  reconnectToken: string,
  roundIndex: number,
  optionId: number,
) {
  return api.post<{ accepted: boolean; locked: boolean; selected_option_id: number }>(
    `/competition/${encodeURIComponent(joinCode)}/answer`,
    { round_index: roundIndex, option_id: optionId },
    { auth: false, headers: { 'X-Competition-Token': reconnectToken } },
  );
}

export function resumeCompetition(joinCode: string, reconnectToken: string) {
  return api.get<ResumeResult>(`/competition/${encodeURIComponent(joinCode)}/me`, {
    auth: false,
    headers: { 'X-Competition-Token': reconnectToken },
  });
}
