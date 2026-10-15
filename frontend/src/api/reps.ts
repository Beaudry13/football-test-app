import { api } from './client';
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
    people: { player_id: number | null; name: string | null }[];
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

/** A new Rep: this concept's decisions, for exactly the players who missed it. Built, not sent. */
export function createRepRetest(quizId: number, conceptId: number | null): Promise<RepRetest> {
  return api.post<RepRetest>(`/quizzes/${quizId}/rep-retest`, { concept_id: conceptId });
}
