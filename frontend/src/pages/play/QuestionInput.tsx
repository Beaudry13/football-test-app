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
  /** Present only on questions with `allow_drawing`. Phase 2 keeps this
   * client-side; the backend cannot store it yet. */
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

  // Drawing needs both halves: the toggle AND something to draw on. The API
  // enforces that pairing, but a question edited by an older client, or an
  // image deleted between load and render, must degrade to an ordinary
  // question rather than opening an empty board.
  const canDraw = Boolean(question.allow_drawing && image);
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

      {question.question_type === 'written' ? (
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
