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
import nb from '../../styles/notebook.module.css';
import styles from './QuestionsTab.module.css';

const TYPE_LABELS: Record<string, string> = {
  true_false: 'True / False',
  multiple_choice: 'Multiple choice',
  written: 'Written response',
};

export function QuestionsTab({ quiz, reload }: { quiz: Quiz; reload: () => Promise<void> }) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();

  const questions = quiz.questions ?? [];

  async function handleCreate(input: QuestionInput) {
    await createQuestion(quiz.id, input);
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
          <div className={`${nb.card} ${nb.empty}`}>No questions yet. Add your first one below.</div>
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
                        {option.is_correct_answer ? '✓ ' : '· '}
                        {option.option_text}
                      </li>
                    ))}
                  </ul>
                )}
                <div className={styles.formActions}>
                  <button className={nb.btnSm} onClick={() => setEditingId(question.id)}>
                    Edit
                  </button>
                  <Link
                    className={nb.btnSm}
                    to={`/quizzes/${quiz.id}/questions/${question.id}/annotate`}
                  >
                    {question.image ? 'Edit image' : 'Add image'}
                  </Link>
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
                  ▲
                </button>
                <button
                  onClick={() => handleMove(index, 1)}
                  disabled={index === questions.length - 1}
                  aria-label="Move down"
                >
                  ▼
                </button>
              </div>
            </div>
          ),
        )}
      </div>

      {isAdding ? (
        <QuestionEditor submitLabel="Add question" onSave={handleCreate} onCancel={() => setIsAdding(false)} />
      ) : (
        <button className={nb.btnPrimary} onClick={() => setIsAdding(true)}>
          + Add question
        </button>
      )}
    </div>
  );
}
