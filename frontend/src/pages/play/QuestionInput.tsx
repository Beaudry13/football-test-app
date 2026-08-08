import { useCallback, useEffect, useState } from 'react';
import { resolveMediaUrl } from '../../api/client';
import type { Question } from '../../api/types';
import { AnnotationViewer } from '../../components/annotation/AnnotationViewer';
import { ImageLightbox } from '../../components/ImageLightbox';
import { DrawingBoard } from '../../components/drawing/DrawingBoard';
import { hasDrawnAnswer } from '../../components/drawing/drawingDocument';
import type { DrawingDocument } from '../../components/drawing/types';
import { Icon } from '../../components/ui/Icon';
import { renderArrows } from '../../utils/typography';
import { clearDraft, createDrawingFor, draftKey, loadDraft, saveDraft } from './drawingDraft';
import styles from './PlayPage.module.css';

export interface PlayerAnswer {
  selected_option_id?: number;
  answer_text?: string;
  /** Present only on `draw_response` questions. */
  drawing?: DrawingDocument;
}

export function QuestionInput({
  question,
  index,
  answer,
  onChange,
  isUnanswered = false,
  drawingScope,
}: {
  question: Question;
  index: number;
  answer: PlayerAnswer | undefined;
  onChange: (answer: PlayerAnswer) => void;
  /** True once a blocked submit attempt has flagged this question as
   * required and still blank - not a general "invalid" state. */
  isUnanswered?: boolean;
  /** Namespaces this player's drawing drafts in localStorage. Omitted by the
   * coach's preview, which deliberately keeps nothing. */
  drawingScope?: string;
}) {
  const [isZoomed, setIsZoomed] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingError, setDrawingError] = useState<string | null>(null);
  const image = question.image;
  const hasAnnotations = (image?.annotations.length ?? 0) > 0;

  // A Draw Response question is answered by drawing, but it still needs
  // something to draw on. The API refuses to activate a quiz whose Draw
  // Response question has no image, so a player should never meet this - and
  // if one slips through (an image deleted mid-session), it degrades to a
  // question with a clear message rather than an empty board.
  const isDrawResponse = question.question_type === 'draw_response';
  const isFillBlank = question.question_type === 'fill_blank';
  // Only ever the MASKED render. There is deliberately no fallback to a page
  // image here: if the server did not supply one, the right outcome is a
  // question with no picture, never an unmasked page.
  const maskedImageUrl = question.masked_image_url ?? null;
  const canDraw = isDrawResponse && image !== null;
  const drawing = answer?.drawing;
  const storageKey = drawingScope ? draftKey(drawingScope, question.id) : null;

  // Restore a draft once, on mount. Runs only for drawing questions, so an
  // ordinary image question touches localStorage not at all.
  useEffect(() => {
    if (!canDraw || !storageKey || drawing) return;
    const restored = loadDraft(storageKey);
    if (restored) onChange({ ...answer, drawing: restored });
    // Mount-only by design: re-running would fight the player's live edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDraw, storageKey]);

  const openBoard = useCallback(async () => {
    if (!image) return;
    setDrawingError(null);
    try {
      // A document is only created when the player actually opens the board,
      // so merely viewing a drawing question never fabricates an empty answer
      // that the submit guard would then treat as answered.
      if (!drawing) {
        const created = await createDrawingFor(image, resolveMediaUrl(image.image_url));
        onChange({ ...answer, drawing: created });
      }
      setIsDrawing(true);
    } catch {
      setDrawingError('Could not open the drawing board. Check your connection and try again.');
    }
  }, [image, drawing, answer, onChange]);

  const handleDrawingChange = useCallback(
    (next: DrawingDocument) => {
      onChange({ ...answer, drawing: next });
      if (storageKey) {
        if (hasDrawnAnswer(next)) saveDraft(storageKey, next);
        // An emptied drawing is a deliberate erase - keeping the old draft
        // would resurrect it on the next visit.
        else clearDraft(storageKey);
      }
    },
    [answer, onChange, storageKey],
  );

  return (
    <div
      id={`question-${question.id}`}
      className={`card ${styles.questionCard} ${isUnanswered ? styles.questionCardUnanswered : ''}`}
    >
      {/* A playbook page, already masked by the server. The unmasked page is
          never sent to a player - the black box is baked into these pixels,
          not drawn over them in CSS, so there is nothing to inspect, disable
          or right-click around. See backend/app/services/page_masking.py. */}
      {maskedImageUrl && (
        <>
          <img
            src={resolveMediaUrl(maskedImageUrl)}
            alt="Playbook page with the answer covered"
            onClick={() => setIsZoomed(true)}
            className={styles.questionImage}
          />
          {isZoomed && (
            <ImageLightbox
              src={resolveMediaUrl(maskedImageUrl)}
              alt="Playbook page, enlarged"
              annotations={[]}
              onClose={() => setIsZoomed(false)}
            />
          )}
        </>
      )}
      {image && (
        <>
          {hasAnnotations ? (
            <AnnotationViewer
              imageUrl={resolveMediaUrl(image.image_url)}
              annotations={image.annotations}
              canvasWidth={image.canvas_width}
              alt="Film still with coach's annotations"
              onClick={() => setIsZoomed(true)}
              className={styles.questionImage}
            />
          ) : (
            <img
              src={resolveMediaUrl(image.image_url)}
              alt="Film still"
              onClick={() => setIsZoomed(true)}
              className={styles.questionImage}
            />
          )}
          {isZoomed && (
            <ImageLightbox
              src={resolveMediaUrl(image.image_url)}
              alt="Film still, enlarged"
              annotations={image.annotations}
              canvasWidth={image.canvas_width}
              onClose={() => setIsZoomed(false)}
            />
          )}
        </>
      )}
      {/* The number is a separate badge rather than "1." run into the text:
          at a glance a player should be able to find where they are without
          reading the question, and an inline number disappears into the
          sentence on a small screen. */}
      <div className={styles.questionHeader}>
        <span className={styles.questionNumber} aria-hidden="true">
          {index + 1}
        </span>
        {/* renderArrows is display-only - the coach's stored text keeps the
            literal "->" they typed. See utils/typography.ts. */}
        <strong className={styles.questionText}>{renderArrows(question.question_text)}</strong>
      </div>
      {isUnanswered && <div className={styles.questionRequiredNote}>Please answer this question.</div>}

      {/* Rendered only for questions the coach opted in. Everything below is
          untouched for every other question, including image questions. */}
      {isDrawResponse && !image && (
        <div className={styles.questionRequiredNote}>
          This question is missing its image. Tell your coach - you cannot answer it yet.
        </div>
      )}

      {canDraw && (
        <div className={styles.drawingRow}>
          <button type="button" className={styles.drawButton} onClick={() => void openBoard()}>
            <Icon name="pen" size={18} />
            <span>{hasDrawnAnswer(drawing) ? 'Edit your drawing' : 'Draw your answer'}</span>
          </button>
          {hasDrawnAnswer(drawing) && (
            <span className={styles.drawingStatus}>
              <Icon name="check" size={14} />
              {drawing!.strokes.length} {drawing!.strokes.length === 1 ? 'mark' : 'marks'}
            </span>
          )}
        </div>
      )}
      {drawingError && <div className={styles.questionRequiredNote}>{drawingError}</div>}

      {isDrawing && image && drawing && (
        <DrawingBoard
          imageUrl={resolveMediaUrl(image.image_url)}
          document={drawing}
          onChange={handleDrawingChange}
          onClose={() => setIsDrawing(false)}
          saveState={storageKey ? 'saved' : 'idle'}
        />
      )}

      {/* Draw Response is answered by the board above and nothing else. The
          future combined-response work will add an explanation box or choices
          here behind their own per-question requirements; until then the
          absence is deliberate, not an oversight. */}
      {isDrawResponse ? null : isFillBlank ? (
        /* A single line, not a textarea: a fill-in-the-blank answer is a play
           name or a call, and a multi-line box invites an essay the matcher
           would then mark wrong. */
        <input
          type="text"
          className={styles.writtenAnswer}
          aria-label="Your answer"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={answer?.answer_text ?? ''}
          onChange={(e) => onChange({ answer_text: e.target.value })}
        />
      ) : question.question_type === 'written' ? (
        <textarea
          className={styles.writtenAnswer}
          value={answer?.answer_text ?? ''}
          onChange={(e) => onChange({ answer_text: e.target.value })}
        />
      ) : (
        <div className={styles.optionList}>
          {question.options.map((option) => (
            <label
              key={option.id}
              className={`${styles.optionRow} ${
                answer?.selected_option_id === option.id ? styles.optionRowActive : ''
              }`}
            >
              {/* Still a real <input type="radio"> - it is styled with
                  appearance:none rather than replaced by a div, so keyboard
                  navigation, screen readers and form semantics all keep
                  working exactly as before. */}
              <input
                type="radio"
                className={styles.optionRadio}
                name={`question-${question.id}`}
                checked={answer?.selected_option_id === option.id}
                onChange={() => onChange({ selected_option_id: option.id })}
              />
              <span className={styles.optionText}>{renderArrows(option.option_text)}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
