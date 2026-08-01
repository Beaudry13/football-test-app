import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { createQuiz, deleteQuiz, duplicateQuiz, listQuizzes } from '../api/quizzes';
import { getErrorMessage } from '../api/client';
import type { Quiz } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import styles from './DashboardPage.module.css';

export function DashboardPage() {
  const [quizzes, setQuizzes] = useState<Quiz[] | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    try {
      setQuizzes(await listQuizzes());
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!newTitle.trim()) return;
    setIsCreating(true);
    setError(null);
    try {
      await createQuiz({ title: newTitle.trim() });
      setNewTitle('');
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleDuplicate(quizId: number) {
    setError(null);
    try {
      await duplicateQuiz(quizId);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleDelete(quizId: number, title: string) {
    if (!window.confirm(`Delete "${title}"? This removes its questions, roster, and results.`)) return;
    setError(null);
    try {
      await deleteQuiz(quizId);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  return (
    <div>
      <div className={styles.header}>
        <h1>Your quizzes</h1>
      </div>

      <ErrorBanner message={error} />

      <form className={styles.newQuizForm} onSubmit={handleCreate}>
        <input
          type="text"
          placeholder="New quiz title, e.g. Week 3 Prep"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={isCreating || !newTitle.trim()}>
          {isCreating ? 'Creating…' : 'New quiz'}
        </button>
      </form>

      {quizzes === null ? (
        <p>Loading…</p>
      ) : quizzes.length === 0 ? (
        <div className={`card ${styles.empty}`}>No quizzes yet. Create your first one above.</div>
      ) : (
        <div className={styles.list}>
          {quizzes.map((quiz) => (
            <div key={quiz.id} className={`card ${styles.quizCard}`}>
              <Link to={`/quizzes/${quiz.id}`} className={styles.quizInfo} style={{ flex: 1 }}>
                <h3>{quiz.title}</h3>
                <div className={styles.quizMeta}>
                  {quiz.question_count} question{quiz.question_count === 1 ? '' : 's'} · updated{' '}
                  {new Date(quiz.updated_at).toLocaleDateString()}
                </div>
              </Link>
              <div className={styles.actions}>
                <button className="btn btn-secondary btn-sm" onClick={() => handleDuplicate(quiz.id)}>
                  Duplicate
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(quiz.id, quiz.title)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
