import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createQuestion,
  deleteQuestion,
  reorderQuestions,
  updateQuestion,
  type QuestionInput,
} from '../../api/questions';
import { getErrorMessage, resolveMediaUrl } from '../../api/client';
import type { Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { QuestionEditor } from './QuestionEditor';
import { Icon } from '../../components/ui/Icon';
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

export function QuestionsTab({ quiz, reload }: { quiz: Quiz; reload: () => Promise<void> }) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();

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
              initialExplanation={question.answer_explanation ?? null}
              submitLabel="Save question"
              onSave={(input) => handleUpdate(question.id, input)}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div key={question.id} className={`${nb.card} ${styles.questionCard}`}>
              {question.image && (
                <img className={styles.thumb} src={resolveMediaUrl(question.image.image_url)} alt="Question film" />
              )}
              <div className={styles.questionBody}>
                <div className={styles.questionMeta}>
                  {/* Derived from live list order, so it stays right after an
                      add, delete, or reorder without any extra bookkeeping. */}
                  <span className={styles.questionNumber}>Question {index + 1}</span>
                  <span className={`${nb.badge} ${nb.badgeNeutral}`}>{TYPE_LABELS[question.question_type]}</span>
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
                <div className={styles.formActions}>
                  <button className={nb.btnSm} onClick={() => setEditingId(question.id)}>
                    Edit
                  </button>
                  {/* Hidden for a question built from a playbook page: it
                      already has an image, from its region, and a question may
                      have only one source. The API refuses the upload too - this
                      just avoids offering an action that would be rejected. */}
                  {!question.region && (
                  <Link
                    className={nb.btnSm}
                    to={`/quizzes/${quiz.id}/questions/${question.id}/annotate`}
                  >
                    {question.image ? 'Edit image' : 'Add image'}
                  </Link>
                  )}
                  <button
                    className={`${nb.btnSm} ${nb.btnDanger}`}
                    onClick={() => handleDelete(question.id, index + 1)}
                  >
                    Delete
                  </button>
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
