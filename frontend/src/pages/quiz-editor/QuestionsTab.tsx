import { useState } from 'react';
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
import type { Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useConfirmDialog } from '../../components/ConfirmDialog';
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
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();
  // The annotate screen is a route, so the menu navigates rather than linking.
  const navigate = useNavigate();

  const questions = quiz.questions ?? [];

  async function handleCreate(input: QuestionInput, image?: File | null) {
    // One call. The question and its image are committed together server-side,
    // so a rejected image leaves no half-made question to clean up.
    await createQuestion(quiz.id, input, image);
    setIsAdding(false);
    await reload();
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
      {dialog}
      <ErrorBanner message={error} />

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
              hasBeenDelivered={question.has_been_delivered ?? false}
              submitLabel="Save question"
              onSave={(input) => handleUpdate(question.id, input)}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div
              key={question.id}
              className={`${nb.card} ${styles.questionCard} ${
                question.is_retired ? styles.retiredCard : ''
              }`}
            >
              {question.image && (
                <img className={styles.thumb} src={resolveMediaUrl(question.image.image_url)} alt="Question film" />
              )}
              <div className={styles.questionBody}>
                <div className={styles.questionMeta}>
                  {/* Derived from live list order, so it stays right after an
                      add, delete, or reorder without any extra bookkeeping. */}
                  <span className={styles.questionNumber}>Question {index + 1}</span>
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

      {isAdding ? (
        <QuestionEditor
          submitLabel="Add question"
          allowImage
          onSave={handleCreate}
          onCancel={() => setIsAdding(false)}
        />
      ) : (
        <button className={nb.btnPrimary} onClick={() => setIsAdding(true)}>
          + Add question
        </button>
      )}
    </div>
  );
}
