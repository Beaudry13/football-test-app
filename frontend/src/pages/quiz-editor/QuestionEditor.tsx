import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { QuestionType } from '../../api/types';
import type { QuestionInput, QuestionOptionInput } from '../../api/questions';
import { getErrorMessage } from '../../api/client';
import { ErrorBanner } from '../../components/ErrorBanner';
import nb from '../../styles/notebook.module.css';
import styles from './QuestionEditor.module.css';

const TRUE_FALSE_OPTIONS: QuestionOptionInput[] = [
  { option_text: 'True', is_correct_answer: true },
  { option_text: 'False', is_correct_answer: false },
];

interface QuestionEditorProps {
  initialText?: string;
  initialType?: QuestionType;
  initialOptions?: QuestionOptionInput[];
  initialExplanation?: string | null;
  submitLabel: string;
  onSave: (input: QuestionInput, image?: File | null) => Promise<void>;
  onCancel: () => void;
  /** Whether players have ALREADY RECEIVED this question, from the delivered
   *  snapshot rather than from answer rows - a question can be delivered and
   *  skipped, and correcting that one matters just as much.
   *
   *  Drives the explanatory notice only. It is not a lock: the API is the
   *  enforcement point and refuses the genuinely unsafe edits on its own. */
  hasBeenDelivered?: boolean;
  /** Offers an image picker whose file is held here until save.
   *
   *  Only the create flow passes this. Editing keeps its existing route to the
   *  annotation page, which does more than upload - it is where a coach draws
   *  on the image - and folding that in here would be a different change. */
  allowImage?: boolean;
}

/** The image types Peira accepts, in ONE place.
 *
 * Feeds the file picker's `accept` attribute and the validator that paste and
 * drop go through, so the three entry points cannot drift into accepting
 * different things. Mirrors the server's ALLOWED_IMAGE_EXTENSIONS - the server
 * remains the authority and rejects anything that gets past this.
 *
 * Module-local: exporting it from a component file trips fast-refresh
 * linting, and nothing outside needs it - the point is that all three
 * entry points inside THIS form share one list. */
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export function QuestionEditor({
  initialText = '',
  initialType = 'true_false',
  initialOptions,
  initialExplanation = null,
  submitLabel,
  onSave,
  onCancel,
  hasBeenDelivered = false,
  allowImage = false,
}: QuestionEditorProps) {
  const [questionText, setQuestionText] = useState(initialText);
  const [questionType, setQuestionType] = useState<QuestionType>(initialType);
  const [options, setOptions] = useState<QuestionOptionInput[]>(
    initialOptions ?? (initialType === 'true_false' ? TRUE_FALSE_OPTIONS : []),
  );
  const [explanation, setExplanation] = useState(initialExplanation ?? '');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // The file lives HERE, not on the server, until the coach saves. That is
  // what makes Cancel leave nothing behind: nothing was ever created.
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  /** Bring a failed save into view.
   *
   * The banner sits at the top of a form that can run well past a screen -
   * question, type, options, explanation, image. A coach who clicks Add
   * question from the bottom would otherwise watch nothing happen while the
   * reason scrolled off above them, which reads as a dead button rather than
   * a rejected save.
   *
   * Keyed on `error`, which is set in exactly two places and cleared at the
   * start of every submit - so this fires on a failed save attempt and on
   * nothing else. A successful save leaves it null and never scrolls.
   *
   * Focus moves with it so the message is announced rather than merely
   * visible; the container is tabIndex={-1} so it can receive focus
   * programmatically without joining the tab order.
   */
  useEffect(() => {
    if (!error) return;
    // Feature-detected rather than assumed: scrollIntoView is absent in jsdom
    // and not guaranteed in every embedded webview. An unhandled throw inside
    // this effect would take the whole form down - trading a scrolled-off
    // error for a broken screen, which is strictly worse than the bug it
    // exists to fix.
    errorRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    errorRef.current?.focus?.({ preventScroll: true });
  }, [error]);

  useEffect(() => {
    if (!image) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setPreview(url);
    // Revoked on replace and on unmount; an object URL pins the whole file in
    // memory until it is.
    return () => URL.revokeObjectURL(url);
  }, [image]);

  function clearImage() {
    setImage(null);
    setImageError(null);
    // Without this, re-picking the SAME file after removing it fires no change
    // event at all and the picker appears broken.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  /** THE ONE DOOR every image comes through - picked, pasted or dropped.
   *
   * Deliberately a single function rather than three. The brief's real risk
   * was a second, weaker upload path growing beside the first; here paste and
   * drop do not upload anything at all. They produce a File and hand it to the
   * same state the file input writes to, so the request, the validation and
   * the storage behaviour downstream are not just similar - they are the same
   * code.
   *
   * Type is checked here for a fast, clear message. SIZE deliberately is not:
   * the server owns that limit, and duplicating the number here would create
   * exactly the second source of truth this is trying to avoid. An oversized
   * paste fails identically to an oversized pick, with the server's message. */
  function acceptImage(file: File | null | undefined): boolean {
    if (!file) return false;
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setImageError(
        `That file is a ${file.type || 'unknown type'}. Images must be PNG, JPEG or WebP.`,
      );
      return false;
    }
    setImageError(null);
    setImage(file);
    return true;
  }

  /** Paste anywhere in the form attaches an image; text still pastes normally.
   *
   * Bound to the FORM, so it catches a paste while the question textarea has
   * focus - which is where a coach's cursor actually is after typing the
   * question. React's synthetic event bubbles from the field to here.
   *
   * The clipboard is only ever READ through the event's own clipboardData, and
   * only for items whose type is an image. Nothing asks the system clipboard
   * for anything it was not handed.
   *
   * If the clipboard carries text as well as an image - copying from a slide,
   * say - the default is NOT prevented, so the text still lands in the field
   * the coach was typing in AND the image attaches. Swallowing the text would
   * be the surprising half of that. */
  function handlePaste(event: React.ClipboardEvent<HTMLFormElement>) {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (!imageItem) return; // No image: ordinary text paste, untouched.

    const file = imageItem.getAsFile();
    if (!file) return;
    const carriesText = items.some((item) => item.kind === 'string');
    if (!carriesText) event.preventDefault();
    acceptImage(file);
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setIsDragging(false);
    acceptImage(event.dataTransfer.files?.[0]);
  }

  function handleTypeChange(type: QuestionType) {
    setQuestionType(type);
    if (type === 'true_false') {
      setOptions(TRUE_FALSE_OPTIONS);
    } else if (type === 'written' || type === 'draw_response') {
      // Neither is answered by picking from a list. A Draw Response question
      // converted from multiple choice may still have option rows in the
      // database - they are kept, inert, for the planned combined-response
      // work - but authoring one never creates or edits them.
      setOptions([]);
    } else {
      setOptions([
        { option_text: '', is_correct_answer: true },
        { option_text: '', is_correct_answer: false },
      ]);
    }
  }

  function updateOptionText(index: number, text: string) {
    setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, option_text: text } : o)));
  }

  function setCorrectOption(index: number) {
    setOptions((prev) => prev.map((o, i) => ({ ...o, is_correct_answer: i === index })));
  }

  function addOption() {
    setOptions((prev) => [...prev, { option_text: '', is_correct_answer: false }]);
  }

  function removeOption(index: number) {
    setOptions((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (questionType === 'multiple_choice' && options.some((o) => !o.option_text.trim())) {
      setError('Every option needs text.');
      return;
    }

    setIsSaving(true);
    try {
      await onSave(
        {
          question_text: questionText.trim(),
          question_type: questionType,
          options,
          answer_explanation: explanation.trim(),
        },
        image,
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form className={`${nb.card} ${styles.form}`} onSubmit={handleSubmit} onPaste={handlePaste}>
      {/* role=alert so the message is announced the moment it appears, and
          tabIndex=-1 so focus can be moved here programmatically without
          adding a stop to the tab order. */}
      {/* A focus/scroll target only. ErrorBanner's Alert already carries
          role=alert, and duplicating it here would announce the same message
          twice and make "which alert?" ambiguous. Rendered only when there IS
          an error so an empty region never sits in the tree. */}
      {error && (
        <div ref={errorRef} tabIndex={-1} className={styles.errorAnchor}>
          <ErrorBanner message={error} />
        </div>
      )}

      {/* EXPLAINS THE BOUNDARY, DOES NOT DISCOURAGE THE FIX.
          Deliberately a plain note rather than a warning banner: correcting a
          mistake is the behaviour we want, and dressing it as a hazard would
          push a coach toward leaving a bad question in place. It says what
          stays true first, because that is the thing a coach is actually
          unsure about.
          Shown only once players have RECEIVED the question - a never-
          delivered question has no boundary to explain. */}
      {hasBeenDelivered && (
        <p className={styles.deliveredNote}>
          <strong>This changes the question for future attempts only.</strong>{' '}
          Players who already received it keep the version they got, along with
          their answers and scores. The image players already saw is kept with
          their results.
        </p>
      )}

      <div className={nb.field}>
        <label className={nb.fieldLabel} htmlFor="question_text">
          Question
        </label>
        <textarea
          id="question_text"
          className={nb.input}
          required
          value={questionText}
          onChange={(e) => setQuestionText(e.target.value)}
        />
      </div>

      <div className={nb.field}>
        <label className={nb.fieldLabel} htmlFor="question_type">
          Type
        </label>
        <select
          id="question_type"
          className={nb.input}
          value={questionType}
          disabled={questionType === 'fill_blank'}
          onChange={(e) => handleTypeChange(e.target.value as QuestionType)}
        >
          <option value="true_false">True / False</option>
          <option value="multiple_choice">Multiple Choice</option>
          <option value="written">Short Answer</option>
          <option value="draw_response">Draw Response</option>
          {/* Present so an existing Fill in the Blank question shows its real
              type rather than falling back to the first option - but disabled,
              because one cannot be created here: it needs a rectangle on a
              playbook page, which is the Playbooks editor's job. */}
          <option value="fill_blank" disabled>
            Fill in the Blank
          </option>
        </select>
      </div>

      {questionType === 'fill_blank' && (
        <p className={styles.typeNote}>
          This question was built from a playbook page. Edit its region and accepted answers
          from Playbooks; the wording can still be changed here.
        </p>
      )}

      {questionType === 'draw_response' && (
        <p className={styles.typeNote}>
          Players answer by drawing on this question&rsquo;s image. Add an image after saving -
          the quiz cannot be activated until every Draw Response question has one.
        </p>
      )}

      {questionType === 'true_false' && (
        <div className={nb.field}>
          <span className={nb.fieldLabel}>Correct answer</span>
          {options.map((option, index) => (
            <label key={option.option_text} style={{ display: 'block', fontWeight: 400 }}>
              <input
                type="radio"
                name="correct-option"
                checked={option.is_correct_answer}
                onChange={() => setCorrectOption(index)}
              />{' '}
              {option.option_text}
            </label>
          ))}
        </div>
      )}

      {questionType === 'multiple_choice' && (
        <div className={nb.field}>
          <span className={nb.fieldLabel}>Options (mark the correct one)</span>
          {options.map((option, index) => (
            <div className={styles.optionRow} key={index}>
              <input
                type="radio"
                name="correct-option"
                checked={option.is_correct_answer}
                onChange={() => setCorrectOption(index)}
              />
              <input
                type="text"
                className={nb.input}
                placeholder={`Option ${index + 1}`}
                value={option.option_text}
                onChange={(e) => updateOptionText(index, e.target.value)}
              />
              {options.length > 2 && (
                <button
                  type="button"
                  className={styles.removeOption}
                  onClick={() => removeOption(index)}
                  aria-label="Remove option"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button type="button" className={`${nb.btnSm} ${styles.addOption}`} onClick={addOption}>
            + Add option
          </button>
        </div>
      )}

      {/* Offered for EVERY type, including the ones Peira cannot score.
          On a Short Answer or Draw Response question the player is told
          "Response recorded" rather than right/wrong, which is exactly when
          a coach's own explanation is doing the whole job of teaching. */}
      <div className={nb.field}>
        <label className={nb.fieldLabel} htmlFor="answer_explanation">
          Explanation <span className={styles.optionalTag}>(optional)</span>
        </label>
        <textarea
          id="answer_explanation"
          className={nb.input}
          rows={3}
          value={explanation}
          onChange={(e) => setExplanation(e.target.value)}
          placeholder="Why is this the answer? Shown after a player checks it in Practice."
        />
        <p className={styles.explanationHint}>
          Players see this only in Practice Mode, and only after they check their answer. It is
          never shown during a graded quiz.
        </p>
      </div>

      {allowImage && (
        <div className={nb.field}>
          <span className={nb.fieldLabel}>Image (optional)</span>
          {preview ? (
            <div className={styles.imagePreview}>
              {/* Previewed from the file itself, so the coach sees exactly what
                  they attached without a round-trip - and without anything
                  having been created yet. */}
              <img src={preview} alt="Selected question image" />
              <div className={styles.imageActions}>
                <button
                  type="button"
                  className={nb.btnSm}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Replace
                </button>
                <button
                  type="button"
                  className={`${nb.btnSm} ${nb.btnDanger}`}
                  onClick={clearImage}
                >
                  Remove
                </button>
              </div>
            </div>
          ) : (
            /* A drop target and an explanation, not a bare file input. The
               coach's real workflow is Snipping Tool then Ctrl+V, so paste is
               named FIRST and the file picker last - the reverse of the
               control's technical prominence. */
            <div
              className={`${styles.dropZone} ${isDragging ? styles.dropZoneActive : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              aria-label="Attach an image: paste, drag and drop, or choose a file"
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
            >
              <span className={styles.dropZoneTitle}>Paste an image here</span>
              <span className={styles.dropZoneKeys}>Ctrl+V / Cmd+V</span>
              <span className={styles.dropZoneOr}>or drag &amp; drop, or choose a file</span>
            </div>
          )}

          {imageError && (
            <p className={styles.imageError} role="alert">
              {imageError}
            </p>
          )}

          <p className={styles.imageHint}>
            Attached when you save this question &mdash; you can annotate it afterwards.
          </p>

          <input
            ref={fileInputRef}
            id="question_image"
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            className={nb.srOnly}
            aria-label="Question image"
            onChange={(event) => acceptImage(event.target.files?.[0])}
          />
        </div>
      )}

      <div className={styles.formActions}>
        <button type="submit" className={nb.btnPrimary} disabled={isSaving}>
          {isSaving ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className={nb.btnSecondary} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
