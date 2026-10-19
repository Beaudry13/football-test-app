import { useCallback, useState } from 'react';
import { resolveMediaUrl } from '../../api/client';
import type { Question } from '../../api/types';
import { AnnotationViewer } from '../../components/annotation/AnnotationViewer';
import { ImageLightbox } from '../../components/ImageLightbox';
import { DrawingBoard } from '../../components/drawing/DrawingBoard';
import { hasDrawnAnswer } from '../../components/drawing/drawingDocument';
import type { DrawingDocument } from '../../components/drawing/types';
import { Icon } from '../../components/ui/Icon';
import { renderArrows } from '../../utils/typography';
import { clearDraft, createDrawingFor, draftKey, saveDraft } from './drawingDraft';
import { ClipPlayer } from '../../components/clip/ClipPlayer';
import { PlayPicture } from '../../components/football/PlayPicture';
import { TapHint, YouAre } from '../../components/football/DecisionWords';
import { usableTargets } from '../../components/football/tapTargets';
import styles from './PlayPage.module.css';


export interface PlayerAnswer {
  selected_option_id?: number;
  /** "Select all that apply" - the COMPLETE set, replaced on every change so
   *  deselecting is expressible. */
  selected_option_ids?: number[];
  answer_text?: string;
  /** Present only on `draw_response` questions. */
  drawing?: DrawingDocument;
}

/** Add or remove one option, returning a new set.
 *
 * A plain toggle: tapping a chosen row un-chooses it, which is what a checkbox
 * means everywhere else and needs no explaining. Sorted so the value a player
 * sees, the value autosaved and the value compared on resume are all the same
 * regardless of tap order. */
function toggleSelection(current: number[], optionId: number): number[] {
  return current.includes(optionId)
    ? current.filter((id) => id !== optionId)
    : [...current, optionId].sort((a, b) => a - b);
}

export function QuestionInput({
  question,
  index,
  answer,
  onChange,
  isUnanswered = false,
  drawingScope,
  locked = false,
  canRevealClip = false,
  autostartClip = true,
  showNumber = true,
  verdict = null,
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
  /** A decision-point clip may show the rest of the play. THE TRIGGER IS
   * THAT AN ANSWER EXISTS, decided by the caller with the same rule that
   * governs submitting - never whether the answer is right. */
  canRevealClip?: boolean;
  /** False on the all-questions-on-one-page layout, so a screen of clips
   * does not all start playing at once. */
  autostartClip?: boolean;
  /** False when a progress bar already says "Question 3 of 10" (one at a time). */
  showNumber?: boolean;
  /** Practice: how the checked answer went - lights the tapped man or spot
   * in the picture, as a Rep does. Never given for a graded question. */
  verdict?: boolean | null;
  /** Practice only: this question has been checked, so the answer is fixed
   * for this attempt. Shown read-only rather than hidden - a player should
   * still be able to re-read what they put and what their coach said.
   *
   * The server enforces the same lock; this is the honest UI of a rule that
   * already exists, not the rule itself. */
  locked?: boolean;
}) {
  const [isZoomed, setIsZoomed] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingError, setDrawingError] = useState<string | null>(null);
  /** Which question's motion has reached its freeze (the input outlives a question). */
  const [motionDoneFor, setMotionDoneFor] = useState<number | null>(null);
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
  /** A recorded clip is a third source of visual material, alongside an
   *  uploaded still and a masked playbook page - never combined with either.
   *  The URL is signed and short-lived, minted per access code by /play. */
  // Only renderable when the payload carried a signed URL - the coach's
  // metadata-only shape has none, and there is nothing to play without it.
  const clip = question.clip?.url ? question.clip : null;
  const canDraw = isDrawResponse && image !== null;
  /** THE PLAY, MOVING: a question made from a Motion Lab play with its
   *  pre-snap motion plays it - the same picture a Rep uses - and freezes at
   *  the coach's decision moment. Never alongside a clip or a playbook page.
   *  The answers wait for the freeze, unless one is already given (a resume,
   *  or a step back) or the question is locked for review. */
  const presnap = !clip && !maskedImageUrl && question.presnap ? question.presnap : null;
  const answered =
    !!answer &&
    (answer.selected_option_id != null ||
      (answer.selected_option_ids?.length ?? 0) > 0 ||
      !!answer.answer_text ||
      !!answer.drawing);
  const watching = !!presnap && !locked && !answered && motionDoneFor !== question.id;
  /** "Select all that apply" - read from the DELIVERED question, so a coach
   *  flipping the setting cannot change how an attempt already underway
   *  behaves. */
  const isMultiSelect = Boolean(question.allows_multiple_answers);
  /* TAP THE MAN / THE SPOT - the same answers-in-the-picture a Rep uses, on a
     one-answer multiple choice question that carries them (a picture without
     a coach's markings). The buttons below stay: either way answers it. */
  const tapTargets =
    question.question_type === 'multiple_choice' && !isMultiSelect && !clip && !maskedImageUrl && !hasAnnotations
      ? usableTargets(question.tap_targets, question.options.length, !!(presnap || image))
      : null;
  /** The coach's ring on a photo, on a picture without his other markings. */
  const marker = !presnap && image && !hasAnnotations && !clip && !maskedImageUrl ? question.subject_marker ?? null : null;
  const usePlayPicture = !!presnap || !!tapTargets || !!marker;
  /** "You're the Mike" - who the player is, when the coach said (as a Rep says it). */
  const role = (question as Question & { subject_role?: string | null }).subject_role?.trim() || null;
  const selectedIds = answer?.selected_option_ids ?? [];
  const drawing = answer?.drawing;
  const storageKey = drawingScope ? draftKey(drawingScope, question.id) : null;

  // DRAFT RESTORE LIVES IN QuizStep SINCE PHASE B, not here.
  //
  // Choosing between the local draft and the server's copy needs the server
  // REVISION, which only QuizStep holds - and doing it per input on mount
  // meant a question whose resolution was "show nothing" would immediately
  // reload the draft anyway, quietly bypassing the rule. One place decides.
  // See resumeDrawing.ts.

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
      /* NO `card` HERE. The question and its answers were peers inside one
         surface, and both were painted --color-surface, so the screen read
         as a grey box inside a grey box. The question is CONTENT, not
         chrome: it sits on the ground now, and the answer rows are the only
         filled things on screen - which is what makes them read as the
         things to touch. */
      className={`${styles.questionCard} ${isUnanswered ? styles.questionCardUnanswered : ''}`}
    >
      {/* A playbook page, already masked by the server. The unmasked page is
          never sent to a player - the black box is baked into these pixels,
          not drawn over them in CSS, so there is nothing to inspect, disable
          or right-click around. See backend/app/services/page_masking.py. */}
      {/* THE FOOTBALL, MOVING. Rendered exactly like the still above it -
          same class, same sizing rules - so a clip and a film still occupy
          the same place in the question and neither is cropped. No lightbox:
          a looping clip has nothing to enlarge into that the inline player
          does not already show. */}
      {clip && (
        <ClipPlayer
          url={resolveMediaUrl(clip.url as string)}
          posterUrl={clip.poster_url ? resolveMediaUrl(clip.poster_url) : null}
          className={styles.questionImage}
          ariaLabel="Recorded clip for this question"
          /* Read from the DELIVERED clip, so an attempt keeps the freeze it
             was given even after the coach moves or clears the live one. */
          decisionPointMs={(clip as { decision_point_ms?: number | null }).decision_point_ms}
          canReveal={canRevealClip}
          autostart={autostartClip}
        />
      )}
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
      {role && <YouAre role={role} />}
      {usePlayPicture ? (
        <PlayPicture
          marker={marker}
          image={image}
          presnap={presnap}
          targets={tapTargets}
          options={question.options}
          onTap={locked || watching ? undefined : (optionId) => onChange({ selected_option_id: optionId })}
          chosen={answer?.selected_option_id != null ? [answer.selected_option_id] : []}
          tone={verdict === true ? 'right' : verdict === false ? 'wrong' : null}
          disabled={locked || watching}
          still={locked}
          autoplay={autostartClip}
          onMotionDone={() => setMotionDoneFor(question.id)}
          className={styles.presnapPicture}
          motionKey={question.id}
        />
      ) : image && (
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
        {showNumber && (
          <span className={styles.questionNumber} aria-hidden="true">
            {index + 1}
          </span>
        )}
        {/* renderArrows is display-only - the coach's stored text keeps the
            literal "->" they typed. See utils/typography.ts. */}
        <strong className={styles.questionText}>{renderArrows(question.question_text)}</strong>
      </div>
      {isUnanswered && <div className={styles.questionRequiredNote}>Please answer this question.</div>}
      {watching && <p className={styles.watchingNote}>Watch the motion…</p>}
      {tapTargets && !watching && !locked && <TapHint targets={tapTargets} />}

      {/* Rendered only for questions the coach opted in. Everything below is
          untouched for every other question, including image questions. */}
      {isDrawResponse && !image && (
        <div className={styles.questionRequiredNote}>
          This question is missing its image. Tell your coach - you cannot answer it yet.
        </div>
      )}

      {canDraw && !watching && (
        <div className={styles.drawingRow}>
          <button
            type="button"
            className={styles.drawButton}
            onClick={() => void openBoard()}
            disabled={locked}
          >
            <Icon name="pen" size={18} />
            <span>
              {locked
                ? 'View your drawing'
                : hasDrawnAnswer(drawing)
                  ? 'Edit your drawing'
                  : 'Draw your answer'}
            </span>
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
          onChange={locked ? () => {} : handleDrawingChange}
          onClose={() => setIsDrawing(false)}
          saveState={storageKey ? 'saved' : 'idle'}
        />
      )}

      {/* Draw Response is answered by the board above and nothing else. The
          future combined-response work will add an explanation box or choices
          here behind their own per-question requirements; until then the
          absence is deliberate, not an oversight. */}
      {isDrawResponse || watching ? null : isFillBlank ? (
        /* A single line, not a textarea: a fill-in-the-blank answer is a play
           name or a call, and a multi-line box invites an essay the matcher
           would then mark wrong. */
        <input
          type="text"
          className={`${styles.writtenAnswer} ${styles.blankAnswer}`}
          aria-label="Your answer"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={answer?.answer_text ?? ''}
          onChange={(e) => onChange({ answer_text: e.target.value })}
          readOnly={locked}
        />
      ) : question.question_type === 'written' ? (
        <textarea
          className={styles.writtenAnswer}
          value={answer?.answer_text ?? ''}
          onChange={(e) => onChange({ answer_text: e.target.value })}
          readOnly={locked}
        />
      ) : (
        <div className={styles.optionList}>
          {/* THE ONLY THING ADDED FOR THE PLAYER, and only on these questions.
              Without it a player meets checkboxes and has to infer the rule;
              with it there is nothing to work out. Sits with the options
              rather than in a banner, because it describes them. */}
          {isMultiSelect && <p className={styles.selectAllHint}>Select all that apply</p>}
          {question.options.map((option) => {
            const isSelected = isMultiSelect
              ? selectedIds.includes(option.id)
              : answer?.selected_option_id === option.id;
            return (
              <label
                key={option.id}
                className={`${styles.optionRow} ${isSelected ? styles.optionRowActive : ''}`}
              >
                {/* Still a real input - styled with appearance:none rather
                    than replaced by a div, so keyboard navigation, screen
                    readers and form semantics keep working. The whole row is
                    the label, so the tap target is the row, not the box.

                    Radio to checkbox is the entire visual difference, and it
                    is the one convention every phone user already reads as
                    "you may pick several". */}
                <input
                  type={isMultiSelect ? 'checkbox' : 'radio'}
                  className={styles.optionRadio}
                  name={isMultiSelect ? undefined : `question-${question.id}`}
                  checked={isSelected}
                  onChange={() =>
                    onChange(
                      isMultiSelect
                        ? { selected_option_ids: toggleSelection(selectedIds, option.id) }
                        : { selected_option_id: option.id },
                    )
                  }
                  disabled={locked}
                />
                <span className={styles.optionText}>{renderArrows(option.option_text)}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
