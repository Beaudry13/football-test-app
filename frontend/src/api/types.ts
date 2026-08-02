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
  folder_id: number | null;
  question_count: number;
  created_at: string;
  updated_at: string;
  /** Only present on list_quizzes - whether the quiz currently has a live,
   * unexpired access code. Omitted (not just false) on single-quiz
   * responses (get/create/update), which don't compute it. */
  is_active?: boolean;
  questions?: Question[];
}

export interface Folder {
  id: number;
  organization_id: number;
  /** Creator, for attribution only - folders are org-shared and any member
   * can edit them. Null if that coach has left the org. */
  coach_id: number | null;
  name: string;
  quiz_count: number;
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
  type: 'line' | 'group' | 'ellipse' | 'rect' | 'path' | 'textbox' | 'polyline';
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
}

export interface RosterPlayer {
  id: number;
  player_name: string;
  position: number;
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
}

export interface PlayerResponse {
  id: number;
  quiz_id: number;
  access_code_id: number;
  player_name: string;
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
}

export interface ValidateCodeResponse {
  access_code_id: number;
  expires_at: string;
  quiz: Quiz;
  roster_players: string[];
}

export interface ApiErrorBody {
  error: string;
  details?: Record<string, string[]>;
}
