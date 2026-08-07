export type QuestionType = 'true_false' | 'multiple_choice' | 'written';

export type CoachRole = 'admin' | 'member';

export interface Coach {
  id: number;
  username: string;
  email: string;
  /** Display name of the coach's organization. */
  organization: string;
  organization_id: number;
  role: CoachRole;
  created_at: string;
}

export interface OrganizationMember {
  id: number;
  username: string;
  email: string;
  role: CoachRole;
}

export interface Organization {
  id: number;
  name: string;
  members: OrganizationMember[];
  created_at: string;
  updated_at: string;
}

export interface OrganizationInvite {
  id: number;
  organization_id: number;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  is_revoked: boolean;
  is_usable: boolean;
  created_by: string | null;
  accepted_by: string | null;
  /** Only returned once, on creation - the list endpoint omits it. */
  code?: string;
}

export interface Quiz {
  id: number;
  organization_id: number;
  /** Creator. Null if that coach has since been removed from the org. */
  coach_id: number | null;
  created_by_username: string | null;
  title: string;
  description: string | null;
  one_question_at_a_time: boolean;
  require_all_answers: boolean;
  folder_id: number | null;
  question_count: number;
  created_at: string;
  updated_at: string;
  /** Only present on list_quizzes - whether the quiz currently has a live,
   * unexpired access code. Omitted (not just false) on single-quiz
   * responses (get/create/update), which don't compute it. */
  is_active?: boolean;
  /** Only present on list_quizzes, same reasoning as is_active. Counts only
   * SUBMITTED attempts (matching the quiz dashboard's own definition). */
  completed_count?: number;
  roster_size?: number;
  /** Omitted (not 0) until at least one gradeable answer exists - a brand
   * new quiz has no score to report yet. */
  average_score_percent?: number;
  questions?: Question[];
}

export interface Folder {
  id: number;
  organization_id: number;
  /** Creator, for attribution only - folders are org-shared and any member
   * can edit them. Null if that coach has left the org. */
  coach_id: number | null;
  name: string;
  /** Null = root folder. Fixed at creation - there is no route to change
   * it afterward, so a folder is at most one level deep, always. */
  parent_folder_id: number | null;
  quiz_count: number;
  subfolder_count: number;
  created_at: string;
  updated_at: string;
}

export interface QuestionOption {
  id: number;
  question_id: number;
  option_text: string;
  position: number;
  is_correct_answer?: boolean;
}

/**
 * One Fabric.js object as serialized by `canvas.toObject(['id'])` - the
 * annotation tool's own native format (see AnnotationCanvas), not a
 * hand-rolled schema. `type` values are Fabric's own class names, not our
 * tool names: an "arrow" is a `group` (line + triangle), a "circle" is an
 * `ellipse`, a "rectangle" is a `rect`, and "text" is a `textbox`.
 */
export interface AnnotationLayer {
  id: string;
  // Fabric's toObject() serializes with capitalized class names (e.g.
  // 'Polyline'), distinct from the lowercase 'polyline' a live in-canvas
  // Fabric object reports via its own .type getter - this is the
  // serialized/saved shape, not the live-canvas one.
  type: 'Line' | 'Group' | 'Ellipse' | 'Rect' | 'Path' | 'Textbox' | 'Polyline';
  [key: string]: unknown;
}

export interface QuestionImage {
  id: number;
  question_id: number;
  image_url: string;
  annotations: AnnotationLayer[];
  canvas_width: number | null;
  updated_at: string;
}

export interface Question {
  id: number;
  quiz_id: number;
  question_text: string;
  question_type: QuestionType;
  position: number;
  options: QuestionOption[];
  image: QuestionImage | null;
  /** "Let players draw their answer on this question's image."
   *
   * Deliberately a flag on any question rather than a question type, so it
   * composes - a multiple-choice question can ask for a drawing as well as an
   * option. Only meaningful alongside `image`; the API rejects enabling it
   * otherwise. Optional here so a response from a backend that predates the
   * column still parses. */
  allow_drawing?: boolean;
}

/** A canonical master-roster identity - see Player.id as the only real
 * identity key. Two players may share every other field. */
export interface Player {
  id: number;
  organization_id: number;
  first_name: string;
  last_name: string;
  full_name: string;
  jersey_number: string | null;
  position: string | null;
  photo_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RosterPlayer {
  id: number;
  player_name: string;
  position: number;
  /** Present only when this slot links to a canonical Player (see
   * Player.id) - undefined/absent means a legacy, name-only slot. */
  player?: Player;
}

export interface Roster {
  id: number | null;
  quiz_id: number;
  players: RosterPlayer[];
}

export interface Group {
  id: number;
  organization_id: number;
  /** Creator, for attribution only - groups are org-shared. */
  coach_id: number | null;
  name: string;
  players: RosterPlayer[];
  created_at: string;
  updated_at: string;
}

export interface PlayerHistoryResult {
  quiz_id: number;
  quiz_title: string;
  attempt_id: number;
  submitted_at: string | null;
  score_percent: number | null;
  graded_answer_count: number;
  correct_answer_count: number;
  pending_grading_count: number;
}

export interface PlayerHistory {
  player: Player;
  current_groups: { id: number; name: string }[];
  assigned_count: number;
  completed_count: number;
  completion_percent: number | null;
  average_score_percent: number | null;
  recent_results: PlayerHistoryResult[];
}

export interface ImportPreviewRow {
  row_number: number;
  first_name: string;
  last_name: string;
  jersey_number: string | null;
  position: string | null;
  full_name_parsed: boolean;
  is_valid: boolean;
  errors: string[];
  possible_duplicates: {
    player_id: number;
    first_name: string;
    last_name: string;
    jersey_number: string | null;
    position: string | null;
    strong_match: boolean;
  }[];
  // 'review' is a placeholder state, never sent back to /import/confirm -
  // it means "an ambiguous same-name match exists; the coach must
  // explicitly resolve this row" (see roster_import.py::build_preview).
  default_action: 'create' | 'skip' | 'review';
}

export interface ImportPreviewResponse {
  detected_mapping: Record<string, string | null>;
  available_columns: string[];
  total_rows: number;
  valid_count: number;
  invalid_count: number;
  rows: ImportPreviewRow[];
}

export interface ImportConfirmRow {
  first_name: string;
  last_name: string;
  jersey_number?: string | null;
  position?: string | null;
  action: 'create' | 'update' | 'skip';
  existing_player_id?: number | null;
}

export interface ImportConfirmResponse {
  success: boolean;
  created: number;
  updated: number;
  players: Player[];
}

export interface AccessCode {
  id: number;
  quiz_id: number;
  code: string;
  activated_at: string;
  expires_at: string;
  is_active: boolean;
  is_valid: boolean;
  groups: { id: number; name: string }[];
}

export interface Answer {
  id: number;
  question_id: number;
  answer_text: string | null;
  selected_option_id: number | null;
  is_correct: boolean | null;
  coach_feedback: string | null;
  graded_at: string | null;
  graded_by_username: string | null;
}

export interface PlayerResponse {
  id: number;
  quiz_id: number;
  access_code_id: number;
  // Historical snapshot, kept for backward compatibility - coach-facing
  // UI should render `display_name` instead (the canonical Player's
  // current name when one is linked, falling back to this snapshot for a
  // legacy or since-deleted Player). See PlayerAttempt.display_name.
  player_name: string;
  display_name: string;
  submitted_at: string;
  answers?: Answer[];
}

export interface PlayerResultAnswer {
  question_id: number;
  question_text: string;
  question_type: QuestionType;
  your_answer: string | null;
  correct_answer: string | null;
  is_correct: boolean | null;
  coach_feedback: string | null;
  graded_at: string | null;
}

export interface PlayerResultsResponse {
  quiz_title: string;
  player_name: string;
  submitted_at: string;
  answers: PlayerResultAnswer[];
}

export interface QuestionBreakdown {
  question_id: number;
  question_text: string;
  question_type: QuestionType;
  answered_count: number;
  correct_count: number;
  incorrect_count: number;
  ungraded_count: number;
}

export interface QuizDashboard {
  quiz_id: number;
  roster_size: number;
  response_count: number;
  response_rate: number;
  missing_players: string[];
  question_breakdown: QuestionBreakdown[];
}

export interface PlayerHistoryEntry {
  quiz_id: number;
  quiz_title: string;
  response_id: number;
  submitted_at: string;
  graded_answer_count: number;
  correct_answer_count: number;
  pending_grading_count: number;
}

export interface ActiveAttemptSummary {
  player_name: string;
  /** Present on `submitted`, absent on `in_progress` entries. */
  submitted_at?: string;
  /** Present on `in_progress`, absent on `submitted` entries. */
  started_at?: string;
}

export interface ActiveQuizStatus {
  quiz_id: number;
  quiz_title: string;
  access_code_id: number;
  code: string;
  expires_at: string;
  /** Empty means "whole roster" - no Group is linked to this activation. */
  group_names: string[];
  roster_size: number;
  submitted: ActiveAttemptSummary[];
  in_progress: ActiveAttemptSummary[];
  not_started: string[];
}

/** One eligible player at join time, canonical-identity-aware. `player_id`
 * is set for a master-roster entry (submit it back on /start so two
 * same-name Players never collide) and null for a legacy, name-only one. */
export interface RosterPlayerOption {
  player_id: number | null;
  name: string;
  /** Disambiguates two canonical Players who share a display name (e.g.
   * two "Chris Smith"s) - both null for a legacy, name-only entry. */
  jersey_number: string | null;
  position: string | null;
  photo_url: string | null;
}

export interface ValidateCodeResponse {
  access_code_id: number;
  expires_at: string;
  quiz: Quiz;
  roster_players: string[];
  /** Additive alongside roster_players (unchanged, kept for compatibility) -
   * see RosterPlayerOption. */
  roster_players_v2: RosterPlayerOption[];
}

/** A player's saved answer as returned by /play/start and /play/answers -
 * deliberately never includes is_correct: a player must not learn which
 * answers are correct before they submit, even though grading now happens
 * at autosave time rather than being deferred to submit. */
export interface ResumedAnswer {
  question_id: number;
  selected_option_id: number | null;
  answer_text: string | null;
}

export interface AttemptState {
  attempt_id: number;
  status: 'in_progress' | 'submitted';
  answers: ResumedAnswer[];
}

export interface ApiErrorBody {
  error: string;
  details?: Record<string, string[]>;
  /** Machine-readable code (e.g. "expired") for a client that needs to
   * branch on the specific failure rather than just relay `error`. */
  reason?: string;
}
