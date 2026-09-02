import { api } from './client';
import type { AnnotationLayer, Question, QuestionImage, QuestionType } from './types';

export interface QuestionOptionInput {
  option_text: string;
  is_correct_answer: boolean;
}

export interface QuestionInput {
  /** The concept this question is about. `null` is a real value meaning
   *  Untagged, and is sent explicitly - the update route only changes the tag
   *  when the key is present, so omitting it would make clearing impossible. */
  concept_id?: number | null;
  question_text: string;
  question_type: QuestionType;
  options: QuestionOptionInput[];
  /** "Select all that apply". Multiple choice only - the server ignores it on
   *  any other type. */
  allows_multiple_answers?: boolean;
  position?: number | null;
  /** Shown to a player in Practice Mode after they check their answer, and
   *  never before. Sent as an empty string to clear it; the server stores
   *  that as null so "no explanation" has one representation, not two. */
  answer_explanation?: string | null;
  /** A PLAYBOOK PAGE AS THIS QUESTION'S PICTURE. Optional, and independent of
   *  `question_type` - a page says what the player SEES, never how they
   *  answer. */
  document_page_id?: number | null;
  /** The one thing the coach chose to hide on that page, if any. Its PRESENCE
   *  is the whole difference: absent means show the page as it is. The words
   *  mask, region and crop stay on the server's side of this boundary. */
  region?: { x: number; y: number; width: number; height: number } | null;
}

/** Creates a question, and its image if one is supplied, in ONE request.
 *
 *  The image used to be a second request against the question that had just
 *  been created, which meant a coach saved, reopened, navigated to the
 *  annotate page, uploaded and came back - and a half-made question existed in
 *  between. When `image` is given this posts multipart and the server commits
 *  both together or neither.
 *
 *  Without an image it stays plain JSON, exactly as before. */
export interface DraftClip {
  blob: Blob;
  poster: Blob | null;
  durationMs: number;
  width: number;
  height: number;
}

export function createQuestion(
  quizId: number,
  input: QuestionInput,
  image?: File | null,
  clip?: DraftClip | null,
): Promise<Question> {
  if (!image && !clip) return api.post<Question>(`/quizzes/${quizId}/questions`, input);

  const formData = new FormData();
  // The options are a nested list, which form fields cannot express without
  // inventing an encoding - so the question travels as one JSON field.
  formData.append('payload', JSON.stringify(input));
  if (image) formData.append('image', image);
  if (clip) {
    // ONE REQUEST, so the question and its clip land together or not at all.
    // Creating the question first and uploading afterwards would leave a
    // half-made question behind whenever the second call failed.
    formData.append('clip', clip.blob, 'clip.mp4');
    if (clip.poster) formData.append('clip_poster', clip.poster, 'poster.webp');
    formData.append('clip_duration_ms', String(clip.durationMs));
    formData.append('clip_width', String(clip.width));
    formData.append('clip_height', String(clip.height));
  }
  return api.postForm<Question>(`/quizzes/${quizId}/questions`, formData);
}

export function updateQuestion(
  quizId: number,
  questionId: number,
  input: Partial<QuestionInput>,
): Promise<Question> {
  return api.patch<Question>(`/quizzes/${quizId}/questions/${questionId}`, input);
}

export function deleteQuestion(quizId: number, questionId: number): Promise<void> {
  return api.delete<void>(`/quizzes/${quizId}/questions/${questionId}`);
}

export function reorderQuestions(quizId: number, questionIds: number[]): Promise<Question[]> {
  return api.post<Question[]>(`/quizzes/${quizId}/questions/reorder`, { question_ids: questionIds });
}

export function uploadQuestionImage(
  quizId: number,
  questionId: number,
  file: File,
): Promise<QuestionImage> {
  const formData = new FormData();
  formData.append('image', file);
  return api.postForm<QuestionImage>(`/quizzes/${quizId}/questions/${questionId}/image`, formData);
}

export interface QuestionClip {
  id: number;
  question_id: number;
  content_type: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  has_poster: boolean;
}

/** Uploads a recorded clip and its poster frame in one request.
 *
 * The poster is captured in the browser at record time rather than derived on
 * the server: it costs nothing there, and it is what lets the PDF export, the
 * question list and the `poster` attribute all keep working without anything
 * learning to decode video. */
export function uploadQuestionClip(
  quizId: number,
  questionId: number,
  clip: Blob,
  poster: Blob | null,
  meta: { durationMs: number; width: number; height: number },
): Promise<QuestionClip> {
  const formData = new FormData();
  formData.append('clip', clip, 'clip.mp4');
  if (poster) formData.append('poster', poster, 'poster.webp');
  formData.append('duration_ms', String(meta.durationMs));
  formData.append('width', String(meta.width));
  formData.append('height', String(meta.height));
  return api.postForm<QuestionClip>(`/quizzes/${quizId}/questions/${questionId}/clip`, formData);
}

/** Sets or clears where a clip freezes, WITHOUT re-uploading the film.
 *
 * A coach chooses this moment by watching the clip and pausing on the frame,
 * long after the bytes were uploaded. `null` clears it and the clip goes back
 * to being an ordinary looping one - it does not delete the clip. */
export function setClipDecisionPoint(
  quizId: number,
  questionId: number,
  decisionPointMs: number | null,
): Promise<QuestionClip> {
  return api.patch<QuestionClip>(
    `/quizzes/${quizId}/questions/${questionId}/clip/decision-point`,
    { decision_point_ms: decisionPointMs },
  );
}

export function deleteQuestionClip(quizId: number, questionId: number): Promise<void> {
  return api.delete<void>(`/quizzes/${quizId}/questions/${questionId}/clip`);
}

export function saveAnnotations(
  quizId: number,
  questionId: number,
  annotations: AnnotationLayer[],
  canvasWidth: number,
): Promise<QuestionImage> {
  return api.put<QuestionImage>(`/quizzes/${quizId}/questions/${questionId}/image/annotations`, {
    annotations,
    canvas_width: canvasWidth,
  });
}

export function deleteQuestionImage(quizId: number, questionId: number): Promise<void> {
  return api.delete<void>(`/quizzes/${quizId}/questions/${questionId}/image`);
}

/** Creates a Fill in the Blank question from a rectangle drawn on a playbook
 *  page. `region` is in normalised 0-1 page coordinates. */
export function createRegionQuestion(
  quizId: number,
  input: {
    document_page_id: number;
    question_text: string;
    expected_answers: string[];
    region: { x: number; y: number; width: number; height: number };
  },
): Promise<Question> {
  return api.post<Question>(`/quizzes/${quizId}/questions/from-region`, input);
}

export function updateRegionQuestion(
  quizId: number,
  questionId: number,
  input: {
    question_text?: string;
    expected_answers?: string[];
    region?: { x: number; y: number; width: number; height: number };
  },
): Promise<Question> {
  return api.patch<Question>(`/quizzes/${quizId}/questions/${questionId}/region`, input);
}

/** Stop sending this question to NEW attempts.
 *
 * Deliberately usable after players have answered - that is precisely when a
 * coach discovers a question is broken, and it is the one action safe to allow
 * then, because it changes nothing about an attempt that already received it.
 *
 * Separate from a Phase 3 exclusion (`questionExclusions.ts`), which decides
 * whether the question COUNTS for players who already have it. Neither implies
 * the other, and the UI keeps them apart. */
export function retireQuestion(quizId: number, questionId: number): Promise<Question> {
  return api.post<Question>(`/quizzes/${quizId}/questions/${questionId}/retire`, {});
}

/** Start sending it again. Safe by definition: retirement only ever affected
 *  future delivery, so undoing it cannot alter a past attempt or a score. */
export function restoreQuestion(quizId: number, questionId: number): Promise<Question> {
  return api.delete<Question>(`/quizzes/${quizId}/questions/${questionId}/retire`);
}
