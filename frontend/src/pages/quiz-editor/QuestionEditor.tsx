import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { QuestionType } from '../../api/types';
import type { QuestionInput, QuestionOptionInput } from '../../api/questions';
import { getErrorMessage, resolveMediaUrl } from '../../api/client';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { IMAGE_FILE_ACCEPT, describeUnsupportedImage } from '../../utils/imageFormat';
import { ErrorBanner } from '../../components/ErrorBanner';
import type { DocumentPage } from '../../api/documents';
import { PlaybookPicker } from './PlaybookPicker';
import { RegionDraw, type NormalisedRect } from '../documents/RegionDraw';
import nb from '../../styles/notebook.module.css';
import styles from './QuestionEditor.module.css';

const TRUE_FALSE_OPTIONS: QuestionOptionInput[] = [
  { option_text: 'True', is_correct_answer: true },
  { option_text: 'False', is_correct_answer: false },
];

interface QuestionEditorProps {
  /** Put the cursor in the question field as soon as the form appears.
   *
   *  Set only by the caller that OPENED the form. An editor rendered inline
   *  for an EXISTING question must never steal focus - the coach opened that
   *  one to change one word, and yanking the cursor (and, on a phone, the
   *  keyboard) is the opposite of helpful. */
  autoFocusQuestion?: boolean;
  initialText?: string;
  initialType?: QuestionType;
  initialOptions?: QuestionOptionInput[];
  initialAllowsMultiple?: boolean;
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

export function QuestionEditor({
  autoFocusQuestion = false,
  initialText = '',
  initialType = 'true_false',
  initialOptions,
  initialAllowsMultiple = false,
  initialExplanation = null,
  submitLabel,
  onSave,
  onCancel,
  hasBeenDelivered = false,
  allowImage = false,
}: QuestionEditorProps) {
  const [questionText, setQuestionText] = useState(initialText);
  /** "Select all that apply". Multiple choice only - see the control below. */
  const [allowsMultiple, setAllowsMultiple] = useState(initialAllowsMultiple);
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
  /** A PLAYBOOK PAGE AS THE PICTURE, and the one thing hidden on it if the
   *  coach chose to hide anything. Held here until save, exactly as an
   *  uploaded file is - nothing is created until the question is. */
  const [playbookPage, setPlaybookPage] = useState<
    { page: DocumentPage; documentTitle: string } | null
  >(null);
  const [hidden, setHidden] = useState<NormalisedRect | null>(null);
  const [isPicking, setIsPicking] = useState(false);
  const [isHiding, setIsHiding] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const onPhone = useCoarsePointer();
  const questionRef = useRef<HTMLTextAreaElement>(null);

  /* THE FORM OPENS WITH THE CURSOR ALREADY IN IT.
     Tapping "+ Add question" used to bring the form into view and stop there,
     leaving the coach one more tap from typing - and on a phone that tap is
     into a field they must first find. Focusing it also raises the keyboard,
     which is what a coach who just chose to add a question wants next.

     preventScroll: the caller has just scrolled this form into view on
     purpose, at block:'center'. Letting focus() perform its own scroll would
     fight that and land somewhere else. */
  useEffect(() => {
    if (!autoFocusQuestion) return;
    questionRef.current?.focus?.({ preventScroll: true });
  }, [autoFocusQuestion]);
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

  function clearPlaybookPage() {
    setPlaybookPage(null);
    setHidden(null);
    setIsHiding(false);
  }

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
    const unsupported = describeUnsupportedImage(file);
    if (unsupported) {
      setImageError(unsupported);
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
    setOptions((prev) =>
      allowsMultiple
        ? // Several answers may be right, so this toggles one independently.
          prev.map((o, i) => (i === index ? { ...o, is_correct_answer: !o.is_correct_answer } : o))
        : // Exactly one right answer: picking a new one un-picks the old.
          prev.map((o, i) => ({ ...o, is_correct_answer: i === index })),
    );
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
          // Only meaningful on multiple choice; the server drops it elsewhere,
          // but sending a truthful value is cheaper than sending a stale one.
          allows_multiple_answers: questionType === 'multiple_choice' && allowsMultiple,
          answer_explanation: explanation.trim(),
          // The page the coach chose, and the one thing they hid on it. Both
          // omitted entirely when no playbook was used, so an ordinary
          // question's payload is byte-for-byte what it was before.
          ...(playbookPage
            ? {
                document_page_id: playbookPage.page.id,
                // PRESENCE IS THE MEANING: a rectangle says "hide this", its
                // absence says "show the page as it is". No role, no mode.
                ...(hidden ? { region: hidden } : {}),
              }
            : {}),
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
          ref={questionRef}
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
          <span className={nb.fieldLabel}>
            {allowsMultiple ? 'Options (mark every correct one)' : 'Options (mark the correct one)'}
          </span>
          {options.map((option, index) => (
            <div className={styles.optionRow} key={index}>
              {/* Radio to checkbox is the whole visual change, and it is the
                  interaction every coach already knows for "one of these" vs
                  "any of these". No new terminology, no explanation needed. */}
              <input
                type={allowsMultiple ? 'checkbox' : 'radio'}
                name={allowsMultiple ? undefined : 'correct-option'}
                checked={option.is_correct_answer}
                onChange={() => setCorrectOption(index)}
                aria-label={`Option ${index + 1} is correct`}
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

          {/* THE WHOLE FEATURE, from the coach's side: one checkbox, below the
              options it affects, only on multiple choice.

              Named for the QUESTION FORMAT, not the mechanics of the setting.
              "Select all that apply" is a phrase coaches already write on
              their own material, so it needs no explaining; an earlier draft
              said "Allow more than one answer", which described what the
              checkbox DOES rather than what the question IS. The supporting
              line then covers the consequence in one sentence - no tooltip, no
              help link, no modal.

              Nothing can infer this: radios physically prevent marking two
              answers, so the coach has to say so first. */}
          <label className={styles.allowMultiple}>
            <input
              type="checkbox"
              checked={allowsMultiple}
              onChange={(e) => setAllowsMultiple(e.target.checked)}
            />
            <span>
              Select all that apply
              <small>Players can choose more than one answer.</small>
            </span>
          </label>
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

          {isPicking ? (
            <PlaybookPicker
              onCancel={() => setIsPicking(false)}
              onPicked={(choice) => {
                // An uploaded file and a playbook page are two answers to the
                // same question, so choosing one clears the other rather than
                // leaving the coach to wonder which will win.
                clearImage();
                setPlaybookPage(choice);
                setHidden(null);
                setIsPicking(false);
              }}
            />
          ) : playbookPage ? (
            <div className={styles.imagePreview}>
              {isHiding ? (
                <RegionDraw
                  existing={hidden ? [{ id: 1, rect: hidden, label: 'Hidden' }] : []}
                  selectedId={hidden ? 1 : null}
                  onClick={() => {}}
                  onSelect={() => {}}
                  onDrawn={(rect) => {
                    setHidden(rect);
                    setIsHiding(false);
                  }}
                  onRegionChanged={(_id, rect) => setHidden(rect)}
                >
                  <img
                    src={resolveMediaUrl(playbookPage.page.image_url ?? '')}
                    alt={`${playbookPage.documentTitle}, page ${playbookPage.page.page_number}`}
                  />
                </RegionDraw>
              ) : (
                <img
                  src={resolveMediaUrl(playbookPage.page.image_url ?? '')}
                  alt={`${playbookPage.documentTitle}, page ${playbookPage.page.page_number}`}
                />
              )}
              <p className={styles.imageHint}>
                {playbookPage.documentTitle}, page {playbookPage.page.page_number}
                {hidden ? ' · one part hidden from players' : ''}
              </p>
              <div className={styles.imageActions}>
                {/* THE OPTIONAL HALF. A page that gives nothing away needs
                    none of this, so the coach is never asked - the action
                    simply sits here if they want it.
                    There is deliberately NO "change page" here. Picking the
                    wrong page is an uncommon correction, and Remove then
                    choose again already does it; a third permanent button on
                    every playbook question is the higher price. Optimise the
                    common path, not every possible one. */}
                {hidden ? (
                  <button type="button" className={nb.btnSm} onClick={() => setHidden(null)}>
                    Show it again
                  </button>
                ) : (
                  <button
                    type="button"
                    className={nb.btnSm}
                    onClick={() => setIsHiding(true)}
                  >
                    {isHiding ? 'Drag over what to hide' : 'Hide something from players'}
                  </button>
                )}
                <button
                  type="button"
                  className={`${nb.btnSm} ${nb.btnDanger}`}
                  onClick={clearPlaybookPage}
                >
                  Remove
                </button>
              </div>
            </div>
          ) : preview ? (
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
            onPhone ? (
            /* THE PHONE VERSION, and it is a different thing rather than the
               same thing restyled. A coach standing on a field has a camera in
               their hand and no clipboard, no Ctrl+V and nothing to drag. The
               desktop box named paste FIRST because that is that coach's real
               workflow; naming it here would be naming something they cannot
               do, at the exact moment the whole feature is supposed to be one
               tap. So the camera is the primary button and the library is the
               secondary one, and nothing else is said. */
            <div className={styles.captureRow}>
              <button
                type="button"
                className={nb.btnPrimary}
                onClick={() => cameraInputRef.current?.click()}
              >
                Take photo
              </button>
              <button
                type="button"
                className={nb.btnSecondary}
                onClick={() => fileInputRef.current?.click()}
              >
                Choose image
              </button>
            </div>
            ) : (
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
            )
          )}

          {/* THE ONLY PERMANENT UI THIS FEATURE ADDS: one more line beside the
              two ways of supplying a picture the coach already has. A coach who
              never opens a playbook reads six extra words and is otherwise
              unaffected. */}
          {!isPicking && !playbookPage && !preview && (
            <button
              type="button"
              className={styles.playbookLink}
              onClick={() => setIsPicking(true)}
            >
              or choose from a Playbook
            </button>
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
            accept={IMAGE_FILE_ACCEPT}
            className={nb.srOnly}
            aria-label="Question image"
            onChange={(event) => acceptImage(event.target.files?.[0])}
          />

          {/* A SECOND INPUT, not a toggled attribute on the first. `capture`
              is a hint the browser reads when the picker opens, so a single
              input would have to be re-rendered between the two buttons and
              re-opened - and Safari has historically kept the first value.
              Two inputs means each button always opens what it says.

              Rendered only where it is real: a desktop browser given `capture`
              may offer a webcam, which is not what "Take photo" means here. */}
          {onPhone && (
            <input
              ref={cameraInputRef}
              id="question_image_camera"
              type="file"
              accept={IMAGE_FILE_ACCEPT}
              capture="environment"
              className={nb.srOnly}
              aria-label="Take a photo for this question"
              onChange={(event) => acceptImage(event.target.files?.[0])}
            />
          )}
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
