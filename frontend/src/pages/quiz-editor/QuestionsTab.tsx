import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  createQuestion,
  deleteQuestion,
  reorderQuestions,
  restoreQuestion,
  retireQuestion,
  updateQuestion,
  type QuestionInput,
} from '../../api/questions';
import { getErrorMessage, resolveMediaUrl } from '../../api/client';
import type { Question, Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/ui/Modal';
import { ClipRecorder, type RecordedClip } from '../../components/clip/ClipRecorder';
import { ClipThumbnail } from '../../components/clip/ClipPlayer';
import { deleteQuestionClip, uploadQuestionClip } from '../../api/questions';
import { QuestionEditor } from './QuestionEditor';
import { Icon } from '../../components/ui/Icon';
import { MenuButton, MenuItem } from '../../components/ui/MenuButton';
import nb from '../../styles/notebook.module.css';
import styles from './QuestionsTab.module.css';
import { EmptyState } from '../../components/ui/EmptyState';

const TYPE_LABELS: Record<string, string> = {
  true_false: 'True / False',
  multiple_choice: 'Multiple Choice',
  // Labelled "Short Answer" for the coach; the stored value stays `written`.
  written: 'Short Answer',
  draw_response: 'Draw Response',
  fill_blank: 'Fill in the Blank',
};


/**
 * "Move to position 1" without clicking Move up nineteen times.
 *
 * THE PROBLEM THIS SOLVES IS A COUNT, NOT A CONTROL. Move up / Move down are
 * right for the adjustment a coach makes constantly while writing - nudge this
 * one above that one. They are hopeless for the move a coach makes occasionally
 * and decisively: this question belongs first. Nineteen clicks, each one a
 * round trip, is not an interaction; it is a punishment.
 *
 * A NUMBER, NOT A DROPDOWN, and not drag-and-drop. A twenty-item select is a
 * list to hunt through; dragging is a whole interaction system with a touch
 * story and a keyboard story attached. A coach who wants question twenty first
 * already knows the number they want.
 *
 * ONE-BASED, because that is what the screen says. "Question 1" is the label a
 * coach reads; the zero-based index underneath is ours to keep to ourselves.
 *
 * REFUSES RATHER THAN GUESSES. Out of range, empty, or the position it already
 * occupies - the button simply does not act. Clamping 0 to 1 would move a
 * question somewhere the coach did not ask for and look like success.
 */
function MoveToPosition({
  currentPosition,
  total,
  onMove,
}: {
  /** One-based, as shown on the card. */
  currentPosition: number;
  total: number;
  onMove: (oneBasedTarget: number) => void;
}) {
  const [value, setValue] = useState('');
  const parsed = Number(value);
  const isValid =
    value.trim() !== '' &&
    Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= total &&
    parsed !== currentPosition;

  return (
    <div className={styles.moveToField}>
      <label className={styles.moveToLabel} htmlFor={`move-to-${currentPosition}`}>
        Move to position
      </label>
      <div className={styles.moveToControls}>
        <input
          id={`move-to-${currentPosition}`}
          className={nb.input}
          type="number"
          inputMode="numeric"
          min={1}
          max={total}
          placeholder={`1-${total}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isValid) {
              e.preventDefault();
              onMove(parsed);
            }
          }}
        />
        <button
          type="button"
          className={nb.btnSm}
          disabled={!isValid}
          onClick={() => onMove(parsed)}
        >
          Move
        </button>
      </div>
    </div>
  );
}

export function QuestionsTab({ quiz, reload }: { quiz: Quiz; reload: () => Promise<void> }) {
  const [isAdding, setIsAdding] = useState(false);
  /* The add form lives at the BOTTOM, because that is where a new question
     lands. The control at the top opens that same form and brings it into
     view, rather than opening a second form somewhere the question will not
     appear - an add box above the list would be telling the coach the
     question goes there, and it does not. */
  const addFormRef = useRef<HTMLDivElement>(null);
  /* Not a boolean any more: a COUNTER. Two different controls open this form,
     and a coach who cancels and immediately taps Add again must be taken to it
     the second time too - with a boolean that reset itself, the second tap set
     a flag that was already being cleared and the scroll silently did nothing
     every other time. Bumping a number always changes the effect's input. */
  const [addFormRequest, setAddFormRequest] = useState(0);
  /** The question just created WITH a picture, until the coach moves on. */
  const [justPhotographed, setJustPhotographed] = useState<Question | null>(null);

  function openAddForm() {
    // Adding another question IS moving on - the offer is about the one just
    // saved, and leaving it up over a fresh empty form would be pointing at
    // something that is no longer on screen.
    setJustPhotographed(null);
    setAddFormRequest((n) => n + 1);
    setIsAdding(true);
  }

  useEffect(() => {
    if (!isAdding || addFormRequest === 0) return;
    /* SMOOTH IS A PREFERENCE, NOT A GUARANTEE. Where the platform suppresses
       smooth scrolling the call can complete having moved nothing at all, and
       the coach is left looking at the same screen wondering whether the tap
       registered. Honour reduced-motion explicitly and jump instead, which is
       both the accessible behaviour and the one that cannot silently no-op. */
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const target = addFormRef.current;
    // Optional call: jsdom has no scrollIntoView, and a test that adds a
    // question should not fail on the scroll that made it visible.
    target?.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });

    /* AND THEN CHECK THAT IT ACTUALLY MOVED.
       A smooth scroll is a request, not a promise: measured in a headless
       Chromium here, scrollIntoView({behavior:'smooth'}) returned having moved
       the page zero pixels, while 'auto' moved it 4830. Whatever the cause,
       the failure mode is the one this whole change exists to remove - the
       coach taps Add question and the screen does not change.

       So a moment later, look. If the form still is not on screen, jump to it.
       On every device where smooth works this sees the form already in view
       and does nothing. */
    if (!target?.getBoundingClientRect) return;
    const settle = window.setTimeout(() => {
      const box = target.getBoundingClientRect();
      const onScreen = box.bottom > 0 && box.top < window.innerHeight;
      if (!onScreen) target.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    }, 600);
    return () => window.clearTimeout(settle);
  }, [isAdding, addFormRequest]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();
  /* Which question is being recorded for, or null. One at a time - a coach
     records for the question in front of them, and a second recorder open
     behind the first would be a way to lose a take. */
  const [recordingFor, setRecordingFor] = useState<number | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);

  async function handleUseClip(questionId: number, recorded: RecordedClip) {
    setClipError(null);
    try {
      await uploadQuestionClip(quiz.id, questionId, recorded.blob, recorded.poster, {
        durationMs: recorded.durationMs,
        width: recorded.width,
        height: recorded.height,
      });
      URL.revokeObjectURL(recorded.previewUrl);
      setRecordingFor(null);
      await reload();
    } catch (err) {
      setClipError(getErrorMessage(err));
    }
  }

  async function handleRemoveClip(questionId: number) {
    const ok = await confirm({
      title: 'Remove this clip?',
      body: 'The question keeps everything else. You can record another one.',
      confirmLabel: 'Remove clip',
    });
    if (!ok) return;
    try {
      await deleteQuestionClip(quiz.id, questionId);
      await reload();
    } catch (err) {
      setClipError(getErrorMessage(err));
    }
  }
  // The annotate screen is a route, so the menu navigates rather than linking.
  const navigate = useNavigate();

  const questions = quiz.questions ?? [];

  async function handleCreate(
    input: QuestionInput,
    image?: File | null,
    clip?: RecordedClip | null,
  ) {
    // One call. The question and its image are committed together server-side,
    // so a rejected image leaves no half-made question to clean up.
    const created = await createQuestion(quiz.id, input, image, clip ?? null);
    setIsAdding(false);
    await reload();
    /* THE PHOTO IS NOT THE POINT - MARKING IT UP IS. Until now the route from
       "I just photographed this play" to "let me circle the safety" ran back
       through the question list, into a row's ... menu, and out again via Edit
       image. On a field that is three taps and a hunt, for the thing the coach
       took the photo IN ORDER to do.
       Offered, never forced: a coach who wanted a plain picture carries on and
       this disappears the moment they do anything else. */
    if (created?.image) setJustPhotographed(created);
  }

  async function handleUpdate(questionId: number, input: QuestionInput) {
    await updateQuestion(quiz.id, questionId, input);
    setEditingId(null);
    await reload();
  }


  async function handleDelete(questionId: number, number: number) {
    setError(null);
    try {
      await confirm({
        title: 'Delete Question?',
        body: `Question ${number}, its answer options, and any image annotations will be removed. This action cannot be undone.`,
        confirmLabel: 'Delete Question',
        action: async () => {
          await deleteQuestion(quiz.id, questionId);
          await reload();
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleRetire(questionId: number, number: number) {
    setError(null);
    try {
      await confirm({
        title: 'Stop sending this question?',
        // Says what stays true as plainly as what changes. A coach reaching
        // for this has just found a broken question and needs to know they are
        // not about to disturb results that already exist - and that this is
        // NOT the same button as "don't count it", which lives on Results.
        body:
          `Question ${number} won't be included in any new Peira from now on. ` +
          'Players who already received it keep the question, their answer and ' +
          "their score - this doesn't change anything they've already done. " +
          'You can start sending it again at any time.',
        confirmLabel: 'Stop sending it',
        action: async () => {
          await retireQuestion(quiz.id, questionId);
          await reload();
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleRestore(questionId: number) {
    // No confirmation: restoring only ever adds a question back to FUTURE
    // Peiras, so there is nothing to warn about and nothing to undo.
    setError(null);
    try {
      await restoreQuestion(quiz.id, questionId);
      await reload();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleMove(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= questions.length) return;
    const ids = questions.map((q) => q.id);
    [ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]];
    setError(null);
    try {
      await reorderQuestions(quiz.id, ids);
      await reload();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  /** Move one question to a one-based position, keeping every other question
   *  in its existing relative order. Same `reorderQuestions` call the arrows
   *  use - one ordered list of ids - so there is no second idea of what
   *  ordering means. */
  async function handleMoveTo(index: number, oneBasedTarget: number) {
    const targetIndex = oneBasedTarget - 1;
    if (targetIndex < 0 || targetIndex >= questions.length || targetIndex === index) return;
    const ids = questions.map((q) => q.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(targetIndex, 0, moved);
    setError(null);
    try {
      await reorderQuestions(quiz.id, ids);
      await reload();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  return (
    <div>
      {clipError && <ErrorBanner message={clipError} />}
      {recordingFor !== null && (
        <Modal
          onDismiss={() => setRecordingFor(null)}
          ariaLabel="Record a clip for this question"
          showCloseButton
        >
          <ClipRecorder
            onUse={(recorded) => void handleUseClip(recordingFor, recorded)}
            onCancel={() => setRecordingFor(null)}
          />
        </Modal>
      )}

      {dialog}
      <ErrorBanner message={error} />

      {/* A COACH BUILDING A QUIZ SHOULD NOT SCROLL THE QUIZ TO EXTEND IT.
          With 20 questions the only "+ Add question" was at y=4922 on a
          375px phone - six screens down, past every question already
          written. This is the same control at the near end of the list.

          Not a floating button, and not sticky: both spend permanent screen
          space, on a surface whose problem is that it has too little. Hidden
          while the form is open, so there is only ever one way to cancel,
          and absent on an empty quiz, where the two controls would be
          adjacent and one of them redundant. */}
      {questions.length > 0 && !isAdding && (
        <div className={styles.addRow}>
          <button
            className={nb.btnSecondary}
            onClick={openAddForm}
          >
            + Add question
          </button>
        </div>
      )}

      {justPhotographed && (
        <div className={`${nb.card} ${styles.annotateOffer}`} role="status">
          <div className={styles.annotateOfferText}>
            <strong>Question added, with your photo.</strong>
            <span>Draw on it now, or carry on and mark it up later.</span>
          </div>
          <div className={styles.annotateOfferActions}>
            <button
              type="button"
              className={nb.btnPrimary}
              onClick={() =>
                navigate(`/quizzes/${quiz.id}/questions/${justPhotographed.id}/annotate`)
              }
            >
              Annotate now
            </button>
            <button
              type="button"
              className={nb.btnSecondary}
              onClick={() => setJustPhotographed(null)}
            >
              Not now
            </button>
          </div>
        </div>
      )}

      <div className={styles.list}>
        {questions.length === 0 && !isAdding && (
          <EmptyState message="No questions yet. Add your first one below." />
        )}

        {questions.map((question, index) =>
          editingId === question.id ? (
            <QuestionEditor
              key={question.id}
              initialText={question.question_text}
              initialType={question.question_type}
              initialOptions={question.options.map((o) => ({
                option_text: o.option_text,
                is_correct_answer: Boolean(o.is_correct_answer),
              }))}
              initialAllowsMultiple={question.allows_multiple_answers ?? false}
              initialExplanation={question.answer_explanation ?? null}
              initialConcept={question.concept ?? null}
              hasBeenDelivered={question.has_been_delivered ?? false}
              submitLabel="Save question"
              onSave={(input) => handleUpdate(question.id, input)}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div
              key={question.id}
              className={`${styles.questionRow} ${
                question.is_retired ? styles.retiredRow : ''
              }`}
            >
              {/* THE NUMBER IS THE STRUCTURE, so it lives in its own column
                  rather than on the metadata line. Derived from live list
                  order, exactly as before, so it stays right after an add,
                  delete or reorder without any extra bookkeeping. */}
              <div className={styles.qNum}>
                {/* The full label for assistive tech, the bare numeral on
                    screen. Split as two whole strings rather than a hidden
                    prefix plus a visible digit: a screen reader announces one
                    phrase instead of two fragments, and "Question 7" stays a
                    single text node for anything reading the DOM. */}
                <span className={nb.srOnly}>Question {index + 1}</span>
                <span aria-hidden="true">{index + 1}</span>
              </div>
              {/* TWO KINDS OF PICTURE, AND THIS ONLY EVER RENDERED ONE.
                  An uploaded film still lives in `image`. A question built
                  from a playbook page has no uploaded image at all - its
                  picture is the masked render the server derives from the
                  region, and it arrives as `masked_image_url`. Players have
                  always been shown it; this list never read it, so a question
                  a coach had just cut from a playbook page appeared here as
                  plain text while the player got the page.

                  Same URL and same alt text as QuestionInput uses, so the
                  coach's copy and the player's cannot disagree about what the
                  picture is. And no fallback to an unmasked page, matching
                  that file: if the server supplied no masked render, the right
                  outcome is a question with no picture. */}
              {question.clip ? (
                /* THE POSTER, NOT THE VIDEO. This list can hold twenty
                   questions, and twenty simultaneously looping clips is real
                   decoding work for a surface that is scanned rather than
                   watched. */
                <ClipThumbnail
                  posterUrl={
                    question.clip.poster_url ? resolveMediaUrl(question.clip.poster_url) : null
                  }
                  className={styles.thumb}
                  alt="Still frame from the recorded clip"
                />
              ) : question.image ? (
                <img className={styles.thumb} src={resolveMediaUrl(question.image.image_url)} alt="Question film" />
              ) : question.masked_image_url ? (
                <img
                  className={`${styles.thumb} ${styles.thumbPage}`}
                  src={resolveMediaUrl(question.masked_image_url)}
                  alt="Playbook page with the answer covered"
                />
              ) : null}
              <div className={styles.questionBody}>
                <div className={styles.questionText}>{question.question_text}</div>
                {question.options.length > 0 && (
                  <ul className={styles.optionsList}>
                    {question.options.map((option) => (
                      <li key={option.id} className={option.is_correct_answer ? styles.correctOption : ''}>
                        {/* The checkmark is decorative - "Correct answer:" is
                            announced by the visually-hidden label instead, so
                            correctness is never conveyed by the icon (or its
                            color) alone. */}
                        {option.is_correct_answer ? (
                          <>
                            <span className={nb.srOnly}>Correct answer: </span>
                            <Icon name="check" size={13} />{' '}
                          </>
                        ) : (
                          <span className={styles.optionBullet} aria-hidden="true">
                            ·{' '}
                          </span>
                        )}
                        {option.option_text}
                      </li>
                    ))}
                  </ul>
                )}
                {/* A Draw Response question with no image is answerable by
                    nobody, and the API refuses to activate a quiz containing
                    one. Surfaced on the card so the coach fixes it while
                    authoring rather than discovering it at activation. */}
                {question.needs_image && (
                  <div className={styles.needsImage}>
                    <Icon name="info" size={14} />
                    <span>Needs an image before players can draw on it.</span>
                  </div>
                )}
                {/* WHAT A COACH DOES TO A QUESTION, AND WHAT THEY DO TO IT ONCE.
                    Edit is the job - changing what players are asked - so it
                    stays. Attaching a picture, stopping a question mid-season
                    and deleting one are each things a coach does once or never,
                    and six permanent controls per question meant 120 of them on
                    a twenty-question quiz. Same "..." a quiz card uses, so the
                    pattern is learned once. */}
                <div className={styles.questionMeta}>
                  <span className={`${nb.badge} ${nb.badgeNeutral}`}>{TYPE_LABELS[question.question_type]}</span>
                  {/* State, not a warning. Stopping a question is a normal
                      authoring decision, so this reads as a label rather than
                      an error - and it is always visible, because a stopped
                      question a coach cannot see is one they cannot restore. */}
                  {question.is_retired && (
                    <span className={`${nb.badge} ${styles.retiredBadge}`}>
                      Not sent to new Peiras
                    </span>
                  )}
                </div>
                <div className={styles.formActions}>
                  <button className={nb.btnSm} onClick={() => setEditingId(question.id)}>
                    Edit
                  </button>

                  {/* THE ONE EXCEPTION, and the reason it is not in the menu:
                      the card above says this question is unanswerable without
                      a picture, and a fix hidden behind a menu is a warning
                      with no button. Once an image exists, changing it is
                      maintenance and moves inside. */}
                  {!question.region && question.needs_image && (
                    <Link
                      className={nb.btnSm}
                      to={`/quizzes/${quiz.id}/questions/${question.id}/annotate`}
                    >
                      Add image
                    </Link>
                  )}

                  <MenuButton label={`More actions for question ${index + 1}`}>
                    {/* Hidden for a question built from a playbook page: it
                        already has an image, from its region, and a question
                        may have only one source. The API refuses the upload
                        too - this just avoids offering a rejected action. */}
                    {!question.region && !question.needs_image && (
                      <MenuItem
                        onSelect={() =>
                          navigate(`/quizzes/${quiz.id}/questions/${question.id}/annotate`)
                        }
                      >
                        {question.image ? 'Edit image' : 'Add image'}
                      </MenuItem>
                    )}
                    {/* A clip is a third source of visual material and
                        replaces the other two rather than joining them, so it
                        is offered only where the API would accept it: not on
                        a playbook-backed question, not alongside a still, and
                        never on Draw Response - which needs a fixed frame to
                        bind strokes to. The server refuses all three cases
                        regardless; this only avoids offering a rejected
                        action. */}
                    {!question.region &&
                      !question.image &&
                      !question.clip &&
                      question.question_type !== 'draw_response' && (
                        <MenuItem onSelect={() => setRecordingFor(question.id)}>
                          Record clip
                        </MenuItem>
                      )}
                    {question.clip && (
                      <MenuItem onSelect={() => void handleRemoveClip(question.id)}>
                        Remove clip
                      </MenuItem>
                    )}
                    {/* Only worth offering when there is somewhere else to go. */}
                    {questions.length > 1 && (
                      <MoveToPosition
                        currentPosition={index + 1}
                        total={questions.length}
                        onMove={(target) => handleMoveTo(index, target)}
                      />
                    )}
                    {/* Edit changes what future players are asked. Stop sending
                        changes whether they are asked it at all. "Don't count
                        this question" - which changes scoring for players who
                        ALREADY answered - deliberately does not live here; it
                        is on Results, next to the players it affects. */}
                    {question.is_retired ? (
                      <MenuItem onSelect={() => handleRestore(question.id)}>
                        Start sending it again
                      </MenuItem>
                    ) : (
                      <MenuItem onSelect={() => handleRetire(question.id, index + 1)}>
                        Stop sending it
                      </MenuItem>
                    )}
                    <MenuItem destructive onSelect={() => handleDelete(question.id, index + 1)}>
                      Delete
                    </MenuItem>
                  </MenuButton>
                </div>
              </div>
              <div className={styles.reorderActions}>
                <button onClick={() => handleMove(index, -1)} disabled={index === 0} aria-label="Move up">
                  <Icon name="chevronUp" size={14} />
                </button>
                <button
                  onClick={() => handleMove(index, 1)}
                  disabled={index === questions.length - 1}
                  aria-label="Move down"
                >
                  <Icon name="chevronDown" size={14} />
                </button>
              </div>
            </div>
          ),
        )}
      </div>

      <div ref={addFormRef}>
        {isAdding ? (
          <QuestionEditor
            autoFocusQuestion
            submitLabel="Add question"
            allowImage
            onSave={handleCreate}
            onCancel={() => setIsAdding(false)}
          />
        ) : (
          /* Same handler as the control at the top of the list. This one is
             already on screen when a coach reaches it, but it must still focus
             the field - and going through one function is what keeps the two
             entry points from drifting apart again. */
          <button className={nb.btnPrimary} onClick={openAddForm}>
            + Add question
          </button>
        )}
      </div>
    </div>
  );
}
