/** `written` is labelled "Short Answer" in the coach UI. The stored value
 * keeps its original name - renaming it would mean a second irreversible
 * Postgres enum change plus a data migration, to alter one word. */
export type QuestionType =
  | 'true_false'
  | 'multiple_choice'
  | 'written'
  | 'draw_response'
  /** Typed text matched against accepted answers and graded automatically at
   *  answer time. Unlike `written`, no coach ever grades one by hand - that
   *  difference is the reason it is a separate type. */
  | 'fill_blank';

/** A rectangle on a playbook page that a question was built from.
 *
 * Coordinates are NORMALISED 0-1 fractions of the page, not pixels, so the
 * same region is correct at any render size. Multiply by the render size (or
 * by the element's own width) to place it. */
export interface QuestionRegion {
  id: number;
  question_id: number;
  document_page_id: number;
  shape: string;
  x: number;
  y: number;
  width: number;
  height: number;
  role: 'mask' | 'focus' | 'crop';
  position: number;
  page_number: number | null;
  source_document_id: number | null;
  render_width: number | null;
  render_height: number | null;
}

export type CoachRole = 'admin' | 'member';

export interface Coach {
  id: number;
  username: string;
  email: string;
  /** Display name of the coach's organization. */
  organization: string;
  organization_id: number;
  role: CoachRole;
  /** Peira PLATFORM ownership - a different axis from `role`, which is this
   *  coach's rank inside their own organization. Used only to decide whether
   *  to render the Owner nav control; hiding that control is cosmetic, and
   *  every /api/owner route enforces the permission server-side regardless. */
  is_platform_owner: boolean;
  created_at: string;
}

// --- Peira Owner Dashboard ------------------------------------------------
// Platform-level adoption metadata. Deliberately contains no customer
// content: no quiz titles, questions, answers, player names or playbook
// filenames. See backend/app/services/platform_metrics.py.

export interface PlatformTotals {
  organizations: number;
  coaches: number;
  active_players: number;
  players: number;
  quizzes: number;
  graded_attempts: number;
  practice_attempts: number;
  documents: number;
}

export interface PlatformWindow {
  new_organizations: number;
  new_coaches: number;
  new_quizzes: number;
  documents_uploaded: number;
  graded_attempts: number;
  practice_attempts: number;
  active_organizations: number;
}

/** How many organizations have EVER used a feature. Adoption, not frequency. */
export interface FeatureAdoption {
  key: string;
  label: string;
  organizations: number;
  /** Present only on the organization detail payload. */
  used?: boolean;
}

export interface PlatformOverview {
  totals: PlatformTotals;
  /** Keyed by window length in days - "7" and "30". */
  windows: Record<string, PlatformWindow>;
  feature_adoption: FeatureAdoption[];
  generated_at: string;
}

export interface OwnerOrganizationRow {
  id: number;
  /** The organization's own registered name. Never inferred from an email
   *  domain, IP or location. */
  name: string;
  coaches: number;
  active_players: number;
  quizzes: number;
  graded_attempts: number;
  practice_attempts: number;
  /** Null when the organization has never done anything meaningful. */
  last_activity: string | null;
  created_at: string;
  /** DATA-derived: no players, no quizzes, no attempts. Not name-derived -
   *  this is how leftover probe organizations are found. */
  is_empty: boolean;
}

export interface OwnerCoachRow {
  id: number;
  username: string;
  email: string;
  role: CoachRole;
  is_platform_owner: boolean;
  organization_id: number;
  organization_name: string;
  joined_at: string;
  quizzes_created: number;
  /** Last activity ATTRIBUTABLE to this coach - quiz created, playbook
   *  uploaded, or answer graded. NOT a login or "last seen"; Peira records
   *  neither. Null means nothing attributable exists, rendered as an em dash
   *  rather than guessed at. */
  last_attributed_activity: string | null;
}

export interface OwnerOrganizationUsage {
  coaches: number;
  active_players: number;
  players: number;
  groups: number;
  folders: number;
  quizzes: number;
  documents: number;
  graded_attempts: number;
  practice_attempts: number;
}

export interface OwnerOrganizationDetail {
  id: number;
  name: string;
  created_at: string;
  last_activity: string | null;
  usage: OwnerOrganizationUsage;
  features: FeatureAdoption[];
  coaches: OwnerCoachRow[];
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
   * it afterward, so nesting is arbitrarily deep but can never form a cycle. */
  parent_folder_id: number | null;
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
  /** What this question is about. null = Untagged - an ordinary state, not a
   *  missing value. May reference an ARCHIVED concept, which the editor still
   *  shows so a tagged question never looks untagged. */
  concept?: { id: number; name: string; is_archived: boolean } | null;
  id: number;
  quiz_id: number;
  question_text: string;
  question_type: QuestionType;
  position: number;
  options: QuestionOption[];
  image: QuestionImage | null;
  /** True for a `draw_response` question that has no image yet. Such a
   * question is answerable by nobody, so the API refuses to activate a quiz
   * containing one - the check lands at activation rather than creation
   * because an image can only be uploaded to a question that already exists. */
  needs_image?: boolean;
  /** Present when the question was built from a playbook page. */
  region?: QuestionRegion | null;
  /** STOPPED FROM FUTURE DELIVERY. New attempts do not receive this question;
   *  attempts that already received it keep it, keep their answers and keep
   *  scoring it exactly as before.
   *
   *  NOT a soft delete and NOT a reason to hide the row - the editor shows a
   *  stopped question de-emphasised with a restore action, because one a coach
   *  cannot see is one they cannot bring back. Distinct from a Phase 3
   *  exclusion, which decides whether it COUNTS for players who already have
   *  it; neither implies the other. */
  /** "Select all that apply" - a behaviour of multiple choice, not a separate
   *  question type. */
  allows_multiple_answers?: boolean;
  is_retired?: boolean;
  retired_at?: string | null;
  /** Whether any attempt was RECORDED as receiving this question, from the
   *  delivered snapshot - NOT from answer rows, because a question can be
   *  delivered and skipped. Drives the correction notice in the editor; the
   *  API is the enforcement point for what may actually be changed. */
  has_been_delivered?: boolean;
  /** The accepted answers for a `fill_blank` question. COACH-ONLY - the API
   *  omits it from every player-facing payload, so it is always undefined in
   *  the player app. */
  expected_answers?: string[];
  answer_matching?: string | null;
  /** Whether Peira can score this type itself. Read from the API rather than
   *  re-derived from question_type, so the coach UI and the player's practice
   *  feedback cannot disagree about what "we can check this" means. */
  auto_gradable?: boolean;
  /** The coach's note, shown to a player in Practice Mode after they check
   *  their answer. COACH-ONLY in every other payload - the player app only
   *  ever receives it inside a PracticeFeedback, never up front. */
  answer_explanation?: string | null;
  /** A short-lived signed URL for the page WITH its regions masked. The only
   *  image a player is ever given for a region-backed question; the unmasked
   *  page is never addressable from the player app. */
  masked_image_url?: string | null;
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

/** How a quiz is being used, not what kind of quiz it is. Chosen by the
 *  coach at activation and frozen onto every attempt started under it. */
export type AssessmentMode = 'GRADED' | 'PRACTICE';

export interface AccessCode {
  id: number;
  quiz_id: number;
  code: string;
  activated_at: string;
  expires_at: string;
  is_active: boolean;
  is_valid: boolean;
  groups: { id: number; name: string }[];
  mode: AssessmentMode;
  is_practice: boolean;
  /** Practice-only: each new attempt gets its own shuffled question
   *  order. Ignored for graded, which always uses the authored order. */
  randomize_questions: boolean;
}

/** A player's submitted drawing, as the coach-facing routes return it. */
export interface AnswerDrawing {
  id: number;
  answer_id: number;
  /** The whole versioned envelope - see components/drawing/types.ts. Typed
   * loosely here because api/types.ts must not depend on the drawing engine;
   * the viewer narrows it at the point of use. */
  document: unknown;
  revision: number;
  preview_url: string | null;
  updated_at: string | null;
}

export interface Answer {
  id: number;
  question_id: number;
  answer_text: string | null;
  selected_option_id: number | null;
  /** THE COMPLETE SELECTION SET. `selected_option_id` is null on every
   *  "Select all that apply" answer, so this is the only field that can show
   *  what such a player chose. Single-choice answers carry their one selection
   *  here too. Sorted by id - DISPLAY order is the delivered option order. */
  selected_option_ids?: number[];
  is_correct: boolean | null;
  coach_feedback: string | null;
  graded_at: string | null;
  graded_by_username: string | null;
  /** Present on a `draw_response` answer the player actually drew on. */
  drawing?: AnswerDrawing | null;
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
  /** What THIS attempt received, snapshot-backed. Present on the coach's
   *  Results payloads; absent from older cached responses, in which case the
   *  UI falls back to the live question exactly as it did before. */
  delivered_questions?: DeliveredQuestion[];
}

export interface PlayerResultAnswer {
  question_id: number | null;
  /** The player's own drawing, with the DELIVERED image it was made on.
   *  Null for anything that is not an answered Draw Response, so the caller
   *  falls back to the text line rather than mounting an empty viewer. */
  drawing?: { document: unknown; image_url: string } | null;
  /** The number this player was given, not the live position. */
  question_number: number;
  question_text: string;
  question_type: QuestionType;
  your_answer: string | null;
  correct_answer: string | null;
  is_correct: boolean | null;
  /** The coach stopped counting this question. `is_correct` is null for an
   *  excluded question exactly as it is for an ungraded one, so this flag is
   *  the only thing that tells the two states apart - never infer "excluded"
   *  from a null verdict. The coach's private reason is deliberately absent. */
  is_excluded: boolean;
  coach_feedback: string | null;
  graded_at: string | null;
}

export interface PlayerResultsResponse {
  quiz_title: string;
  player_name: string;
  submitted_at: string;
  answers: PlayerResultAnswer[];
}

/** One coach's decision to stop counting a question, as the coach sees it.
 *  `scope` is 'assignment' for a single access code, 'quiz' for every use of
 *  the quiz. `reason` is the coach's own optional note and is never sent to a
 *  player. */
export interface QuestionExclusion {
  id: number;
  question_id: number;
  access_code_id: number | null;
  scope: 'assignment' | 'quiz';
  excluded_at: string;
  restored_at: string | null;
  is_active: boolean;
  excluded_by_username: string | null;
  reason?: string | null;
}

/** An assignment a coach can scope an exclusion to. Labelled from metadata
 *  that already exists - no schema was added to name assignments. */
export interface QuizAssignment {
  access_code_id: number;
  code: string;
  activated_at: string;
  is_active: boolean;
  is_valid: boolean;
  mode: string;
  groups: { id: number; name: string }[];
  submitted_count: number;
}

/** One question AS ONE ATTEMPT RECEIVED IT.
 *
 * Read from Phase 1's delivered-question snapshot, so a coach correcting the
 * live quiz cannot retitle, renumber or re-picture a result a player already
 * has. `from_snapshot: false` means the attempt predates Phase 1 and this is
 * the live question - no history was invented for it. */
export interface DeliveredQuestion {
  question_id: number | null;
  question_number: number;
  question_text: string;
  question_type: QuestionType;
  /** Whether this attempt was given "Select all that apply". Read from the
   *  snapshot, so a coach flipping the setting later cannot change how an
   *  already-delivered answer is read. */
  allows_multiple_answers?: boolean;
  options: { id: number | null; option_text: string; is_correct_answer: boolean }[];
  image: { image_url: string; canvas_width: number | null; annotations: unknown[] } | null;
  from_snapshot: boolean;
}

export interface QuestionBreakdown {
  question_id: number;
  /** The quiz's own 1-based numbering, computed server-side over the
   *  position-sorted questions - the same rule the CSV and detailed PDF use.
   *  An excluded question KEEPS its number; never renumber from a row index. */
  question_number: number;
  question_text: string;
  question_type: QuestionType;
  /** RAW EVIDENCE, never filtered by exclusion - usually the very thing that
   *  made the coach exclude the question. */
  answered_count: number;
  correct_count: number;
  incorrect_count: number;
  ungraded_count: number;
  is_excluded: boolean;
  /** Every ACTIVE exclusion covering this question. More than one when a
   *  quiz-wide and an assignment-scoped exclusion overlap - restoring one
   *  leaves the other in force, so the UI must show both. */
  exclusions: QuestionExclusion[];
}

export interface QuizDashboard {
  quiz_id: number;
  roster_size: number;
  response_count: number;
  /** null when there is no denominator to divide by - roster_size is who is
   *  eligible under the CURRENTLY ACTIVE code, and that goes to zero once the
   *  code lapses, while response_count is every submission ever. Same rule as
   *  average_score_percent: no fabricated 0. */
  response_rate: number | null;
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
  mode: AssessmentMode;
  is_practice: boolean;
  randomize_questions: boolean;
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
  /** So the player is told this is practice before they start, not after. */
  mode: AssessmentMode;
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
  /** The COMPLETE selection set. Single-choice answers report their one
   *  selection here too, so the client has one shape to read. */
  selected_option_ids?: number[];
  answer_text: string | null;
  /** Practice only: the player has already seen this question's verdict and
   *  explanation, so it is locked. Always false on a graded attempt. */
  checked: boolean;
  /** THE SERVER-STORED DRAWING, so a resumed attempt does not depend on this
   *  device's localStorage. `revision` is the ordering mechanism for the
   *  resume precedence rule - deliberately no timestamp, because device
   *  clocks must never decide which drawing is newer.
   *  See pages/play/resumeDrawing.ts. */
  drawing?: { document: unknown; revision: number } | null;
}

/** What a practice player is told after pressing Check Answer.
 *
 *  `is_correct` is null for anything Peira cannot score - the client must
 *  show "Response recorded" there rather than inventing a verdict. The
 *  correct answer itself is never included; the coach's explanation is the
 *  teaching mechanism. */
export interface PracticeFeedback {
  question_id: number;
  auto_gradable: boolean;
  is_correct: boolean | null;
  answer_explanation: string | null;
}

/** A delivered question as a PLAYER may see it. Built by a dedicated
 *  server-side serializer that never emits answer-key fields. */
export interface DeliveredPlayerQuestion {
  id: number;
  question_text: string;
  question_type: QuestionType;
  options: { id: number; option_text: string }[];
  image: {
    /** The DELIVERED image's identity - what a Draw Response document binds to
     *  as `source.image_id`. Null on a snapshot written before Phase A. */
    id: number | null;
    image_url: string;
    canvas_width: number | null;
    annotations: unknown[];
  } | null;
  /** Region-backed questions only: a signed masked render. Comes from the LIVE
   *  region because the snapshot does not record region geometry - truthful
   *  only while region editing stays blocked after delivery. */
  masked_image_url?: string;
}

export interface AttemptState {
  attempt_id: number;
  status: 'in_progress' | 'submitted';
  /** The attempt's own frozen mode. A coach editing the code mid-session
   *  does not change the rules of work already in progress. */
  mode: AssessmentMode;
  /** The order this attempt was given, as question ids. Empty means the
   *  quiz's authored order. */
  question_order: number[];
  answers: ResumedAnswer[];
  /** Feedback already earned this attempt, so a refresh does not wipe the
   *  explanations the player was reading. Empty on a graded attempt. */
  feedback: PracticeFeedback[];
  /** THE ATTEMPT VERSION INVARIANT. What THIS attempt was delivered, from its
   *  snapshot - so refreshing mid-quiz re-renders the version the player
   *  started on rather than a correction the coach has made since. Prefer
   *  this over the questions /validate-code returned, which are live and were
   *  fetched before the player had identified themselves.
   *
   *  Player-safe: no `is_correct_answer`, no `expected_answers`. */
  questions?: DeliveredPlayerQuestion[];
}

export interface ApiErrorBody {
  error: string;
  details?: Record<string, string[]>;
  /** Machine-readable code (e.g. "expired") for a client that needs to
   * branch on the specific failure rather than just relay `error`. */
  reason?: string;
}

// --- Organization merge --------------------------------------------------
// Owner-only. Preview writes nothing; execute is the single destructive
// operation in the owner area. See backend/app/services/organization_merge.py.

export interface MergeOrganizationCounts {
  coaches: number;
  players: number;
  quizzes: number;
  groups: number;
  folders: number;
  playbooks: number;
  invitations: number;
  questions: number;
  access_codes: number;
  graded_attempts: number;
  practice_attempts: number;
  answers: number;
  answer_drawings: number;
  document_pages: number;
}

export interface MergeCoachPlan {
  coach_id: number;
  username: string;
  email: string;
  current_role: string;
  /** MEMBER unless the operator explicitly chose otherwise. */
  new_role: 'ADMIN' | 'MEMBER';
  is_platform_owner: boolean;
  /** True when this coach is currently an ADMIN, so a decision is required. */
  requires_decision: boolean;
  /** True when the chosen role grants Admin View over the destination. */
  widens_access: boolean;
}

export interface MergeDuplicatePlayer {
  normalized_name: string;
  source_player_ids: number[];
  destination_player_ids: number[];
}

export interface MergePreview {
  source: { id: number; name: string; counts: MergeOrganizationCounts };
  destination: { id: number; name: string; counts: MergeOrganizationCounts };
  coaches: MergeCoachPlan[];
  possible_duplicate_players: MergeDuplicatePlayer[];
  name_collisions: { type: string; name: string }[];
  invitations_to_revoke: number;
  resulting_destination_counts: MergeOrganizationCounts;
  warnings: string[];
  blockers: string[];
  requires_acknowledgement: {
    collisions: boolean;
    duplicate_players: boolean;
    coach_roles: number[];
  };
  /** Must be handed back to execute; the server refuses if either
   *  organization changed since the preview was generated. */
  fingerprint: string;
}

export interface MergeResult {
  merged: boolean;
  audit_id: number;
  source: { id: number; name: string };
  destination: { id: number; name: string };
  counts_moved: Record<string, number>;
  invitations_revoked: number;
}
