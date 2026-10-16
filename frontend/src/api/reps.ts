import { api } from './client';
import { attemptTokenHeaders } from '../pages/play/attemptToken';
import type { Quiz, QuestionImage } from './types';

/**
 * SITUATIONAL REP - "put me in the play, make me prove I know my job".
 *
 * A Rep is a quiz with kind REP: created, edited, sent and played through the
 * ordinary routes. These two calls are what a Rep adds: the coach's diagnosis
 * (the football problem, from each player's first try) and a one-tap Retest.
 */

export interface RepPlayer {
  /** Stable per person: `p<id>` for a roster player, `n:<name>` otherwise. */
  key: string;
  player_id: number | null;
  display_name: string;
  position: string | null;
  jersey_number: string | null;
}

export interface RepPlayerSummary extends RepPlayer {
  correct: number;
  answered: number;
  /** How many times he ran it. Only the first try is scored. */
  attempts: number;
  total_ms: number | null;
}

export interface RepChoice {
  option_id: number;
  text: string;
  is_correct: boolean;
  count: number;
  players: RepPlayer[];
}

export interface RepDecision {
  question_id: number;
  number: number;
  question_text: string;
  question_type: string;
  subject_role: string | null;
  concept: { id: number; name: string } | null;
  motion_play_id: number | null;
  answer_explanation: string | null;
  image: QuestionImage | null;
  /** The pre-snap moment (motion-lab/presnap.ts), when the decision has motion. */
  presnap?: Record<string, unknown> | null;
  /** A player has received it: answers can be reworded or added, the right one is locked. */
  delivered?: boolean;
  is_retired: boolean;
  correct_text: string[];
  responded: number;
  missed: number;
  median_ms: number | null;
  choices: RepChoice[];
  answers: { player: RepPlayer; is_correct: boolean | null; chose: string[]; time_ms: number | null }[];
}

export interface RepMiss extends RepPlayer {
  answers: { question_id: number; number: number; chose: string[]; time_ms: number | null }[];
}

/** One football problem: the decisions a coach tagged with one concept. */
export interface RepConcept {
  concept: { id: number; name: string } | null;
  /** The concept's name, or "General" for untagged decisions. */
  name: string;
  responded: number;
  missed: number;
  players_missed: RepMiss[];
  most_common_wrong: { text: string; question_id: number; count: number } | null;
  question_ids: number[];
  /** The Motion Lab play to teach it from, when a decision came from one. */
  motion_play_id: number | null;
  /** THE NEXT STEP: the latest Retest of this concept and how it went (first tries). */
  retest?: { id: number; title: string; invited: number; ran: number; responded: number; missed: number } | null;
  /** Taught on this Rep (by any coach, on any device): Retest is the next step. */
  taught?: RepTaught | null;
}

/** When a problem was last taught, and by whom (the coach's username). */
export interface RepTaught {
  at: string;
  by: string | null;
}

export interface RepResults {
  quiz_id: number;
  title: string;
  players: RepPlayerSummary[];
  decisions: RepDecision[];
  /** Worst first. */
  concepts: RepConcept[];
  audience: {
    /** The one group's name when it went to exactly one group ("Safeties"). */
    label: string | null;
    invited: number;
    /** The live code, when players can still open it. */
    code: string | null;
    people: { player_id: number | null; name: string | null; position?: string | null }[];
    /** The positions it went to, as the roster has them. */
    positions?: string[];
  };
  /** DID IT STICK? Present on a Rep built by Retest: the Rep it re-asked and,
   *  per concept, how many missed it there. */
  retest_of: {
    id: number;
    title: string;
    concepts: {
      concept: { id: number; name: string } | null;
      name: string;
      missed_before: number | null;
      responded_before: number | null;
    }[];
  } | null;
}

export function getRepResults(quizId: number): Promise<RepResults> {
  return api.get<RepResults>(`/quizzes/${quizId}/rep-results`);
}

/** One recent Rep for Home: who has run it and its worst football problem. */
export interface RepSummary {
  id: number;
  title: string;
  decisions: number;
  ran: number;
  invited: number;
  live: boolean;
  audience_label: string | null;
  audience_positions?: string[];
  is_retest: boolean;
  worst: { name: string; concept_id: number | null; missed: number; responded: number; most_common_wrong: string | null } | null;
  /** The worst problem nobody has retested yet (originals only) - what Next up offers. */
  open_problem?: {
    name: string;
    concept_id: number | null;
    missed: number;
    responded: number;
    taught?: RepTaught | null;
  } | null;
  /** How a retest went, when that is the thing to say (see routes/reps._signal). */
  signal: {
    kind: 'retest_fixed' | 'retest_missing' | 'retested';
    concept: string;
    missed: number;
    responded: number;
    before_pct: number | null;
    now_pct: number | null;
    retest_id?: number;
  } | null;
}

/** One run of a Rep, for the player who made it. */
export interface RepRunSummary {
  correct: number;
  answered: number;
  missed_concepts: string[];
  mastered_concepts: string[];
}

/** The player's own progress: his run before this one; on a Retest, his first try on the original. */
export interface RepProgress {
  previous: RepRunSummary | null;
  original: (RepRunSummary & { title: string }) | null;
}

export function getRepProgress(
  input: { access_code_id: number; player_name: string; player_id?: number },
  token?: string | null,
): Promise<RepProgress> {
  return api.post<RepProgress>('/play/rep-progress', input, { auth: false, headers: attemptTokenHeaders(token ?? null) });
}

/** The Reps already holding a decision made from this Motion Lab play, newest first. */
export function getRepsForPlay(playId: number): Promise<{ id: number; title: string; question_count: number }[]> {
  return api.get(`/quizzes/reps-for-play/${playId}`);
}

/** One football problem across recent Reps: first try on the first and the latest. */
export interface ConceptTrend {
  concept_id: number;
  name: string;
  reps: number;
  first_pct: number | null;
  last_pct: number | null;
  last_missed: number;
  last_rep_id: number;
}

/** One Rep that tested a concept, on its history page (first tries). */
export interface ConceptPoint {
  rep_id: number;
  title: string;
  at: string | null;
  pct: number;
  responded: number;
  missed: number;
  is_retest: boolean;
}

/** ONE FOOTBALL PROBLEM OVER TIME (routes/reps.get_concept_history). */
export interface ConceptHistory {
  concept: { id: number; name: string; is_archived: boolean };
  /** Oldest first. */
  points: ConceptPoint[];
  /** Newest first, up to five. */
  recent: ConceptPoint[];
  /** Each player whose latest first try on it was a miss. */
  still_missing: (RepPlayer & { rep_id: number })[];
  /** The next step, from the latest Rep that tested it. */
  latest: {
    rep_id: number;
    title: string;
    missed: number;
    responded: number;
    taught: RepTaught | null;
    retest: RepConcept['retest'];
  } | null;
}

export function getConceptHistory(conceptId: number): Promise<ConceptHistory> {
  return api.get<ConceptHistory>(`/quizzes/concept-history/${conceptId}`);
}

export function getConceptTrends(): Promise<ConceptTrend[]> {
  return api.get<ConceptTrend[]>('/quizzes/concept-trends');
}

export function getRepsSummary(): Promise<RepSummary[]> {
  return api.get<RepSummary[]>('/quizzes/reps-summary');
}

export interface RepRetest extends Quiz {
  player_count: number;
}

export interface RepFromQuiz extends Quiz {
  /** Questions a Rep cannot judge on the spot (draw, written...), left in the quiz. */
  left_behind: number;
}

/** EXISTING CONTENT -> REP: a quiz's tap-an-answer questions, copied into a new Rep. */
export function makeRepFromQuiz(quizId: number, questionIds?: number[]): Promise<RepFromQuiz> {
  return api.post<RepFromQuiz>(`/quizzes/${quizId}/make-rep`, questionIds ? { question_ids: questionIds } : {});
}

/** Questions from a quiz, added to a Rep that already exists (after its own decisions). */
export function addDecisions(repId: number, fromQuizId: number, questionIds: number[]): Promise<Quiz & { added: number }> {
  return api.post<Quiz & { added: number }>(`/quizzes/${repId}/add-decisions`, {
    from_quiz_id: fromQuizId,
    question_ids: questionIds,
  });
}

/** A new Rep: this concept's decisions, for exactly the players who missed it. Built, not sent. */
/** TEACH, REMEMBERED: mark this problem taught on this Rep (null = the untagged decisions). */
export function markRepTaught(quizId: number, conceptId: number | null): Promise<{ concept_key: string; taught: RepTaught }> {
  return api.post(`/quizzes/${quizId}/rep-teach`, { concept_id: conceptId });
}

export function createRepRetest(quizId: number, conceptId: number | null): Promise<RepRetest> {
  return api.post<RepRetest>(`/quizzes/${quizId}/rep-retest`, { concept_id: conceptId });
}
