import { createDocument } from '../../components/drawing/drawingDocument';
import { validateDocument } from '../../components/drawing/drawingDocument';
import type { DrawingDocument, DrawingSourceImage } from '../../components/drawing/types';
import type { QuestionImage } from '../../api/types';

/** The quiz-side adapter for the drawing engine.
 *
 * `components/drawing/` deliberately knows nothing about quizzes, questions
 * or access codes (see docs/DESIGN-draw-on-image.md §11.1). Everything that
 * maps a Peira question onto the engine's generic DrawingDocument lives here
 * instead, so a future scouting report or install packet can supply its own
 * adapter without the engine changing.
 *
 * Phase 2 persists drafts to localStorage only. The backend cannot store a
 * drawing yet - `answer_drawings` exists as a migration but no route reads or
 * writes it - so this is what stops a player losing their work to a refresh
 * or an accidental back-swipe. Phase 3 replaces the storage, not the shape.
 */

const DRAFT_PREFIX = 'peira.drawing.draft';

/** Scoped per player AND per question: two players sharing a phone, or one
 * player retaking a Peira under a different code, must not inherit each
 * other's drawings. */
export function draftKey(scope: string, questionId: number): string {
  return `${DRAFT_PREFIX}:${scope}:${questionId}`;
}

/** Pins which image version the strokes were drawn against.
 *
 * `updated_at` is the image's content identity: a coach replacing the photo
 * on a question keeps the same row id but changes this, which is exactly the
 * case that would otherwise relocate a player's strokes onto a picture they
 * never saw. */
export function drawingSource(
  image: QuestionImage,
  naturalWidth: number,
  naturalHeight: number,
): DrawingSourceImage {
  return {
    image_id: String(image.id),
    image_version: image.updated_at ?? null,
    natural_width: naturalWidth,
    natural_height: naturalHeight,
  };
}

/** Reads the natural dimensions the coordinate space is derived from.
 *
 * Taken from the decoded image rather than from `canvas_width`, which records
 * the space the COACH's annotations were authored in and may legitimately
 * differ. */
export function measureImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Could not load the question image'));
    img.src = url;
  });
}

export async function createDrawingFor(image: QuestionImage, url: string): Promise<DrawingDocument> {
  const { width, height } = await measureImage(url);
  return createDocument({ source: drawingSource(image, width, height), now: new Date().toISOString() });
}

/** A stored draft, plus the server revision it was continued FROM.
 *
 *  `base_revision` is what lets resume decide between a local draft and the
 *  server's copy without ever comparing clocks. null means "this draft was
 *  never based on a successful save" - which the precedence rule reads as
 *  "cannot prove it is newer", not as "is older". */
export interface StoredDraft {
  document: DrawingDocument;
  base_revision: number | null;
}

export function loadDraft(key: string): StoredDraft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft | DrawingDocument;

    // BACKWARD COMPATIBILITY. Drafts written before Phase B are a bare
    // DrawingDocument with no envelope. They are still usable work, so they
    // are read as base_revision null - which the precedence rule treats as
    // unprovable rather than discarding it outright.
    const isEnvelope =
      typeof parsed === 'object' && parsed !== null && 'document' in parsed;
    const document = (isEnvelope ? (parsed as StoredDraft).document : parsed) as DrawingDocument;
    const baseRevision = isEnvelope ? ((parsed as StoredDraft).base_revision ?? null) : null;

    // Refuse a draft that cannot be trusted rather than rendering half of it.
    // A player is better off starting again than answering on top of a
    // document whose coordinate space or stroke data is malformed.
    if (validateDocument(document).length !== 0) return null;
    return { document, base_revision: baseRevision };
  } catch {
    // Private browsing, a full quota, or hand-edited storage. A missing draft
    // is recoverable; a thrown exception here would take the whole question
    // down with it.
    return null;
  }
}

export function saveDraft(
  key: string,
  document: DrawingDocument,
  baseRevision: number | null = null,
): boolean {
  try {
    const envelope: StoredDraft = { document, base_revision: baseRevision };
    window.localStorage.setItem(key, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* nothing to do - the draft is already unreachable */
  }
}
