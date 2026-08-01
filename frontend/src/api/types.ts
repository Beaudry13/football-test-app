export type QuestionType = 'true_false' | 'multiple_choice' | 'written';

export interface Coach {
  id: number;
  username: string;
  email: string;
  organization: string;
  created_at: string;
}

export interface Quiz {
  id: number;
  coach_id: number;
  title: string;
  description: string | null;
  one_question_at_a_time: boolean;
  question_count: number;
  created_at: string;
  updated_at: string;
  questions?: Question[];
}

export interface QuestionOption {
  id: number;
  question_id: number;
  option_text: string;
  position: number;
  is_correct_answer?: boolean;
}

export interface AnnotationLayer {
  id: string;
  type: 'line' | 'arrow' | 'circle' | 'rectangle' | 'text' | 'path';
  [key: string]: unknown;
}

export interface QuestionImage {
  id: number;
  question_id: number;
  image_url: string;
  annotations: AnnotationLayer[];
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

export interface AccessCode {
  id: number;
  quiz_id: number;
  code: string;
  activated_at: string;
  expires_at: string;
  is_active: boolean;
  is_valid: boolean;
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
