import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { getQuiz, updateQuiz } from '../../api/quizzes';
import { getErrorMessage } from '../../api/client';
import type { Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { QuestionsTab } from './QuestionsTab';
import { RosterTab } from './RosterTab';
import { AccessCodesTab } from './AccessCodesTab';
import { ResultsTab } from './ResultsTab';
import nb from '../../styles/notebook.module.css';
import styles from './QuizEditorPage.module.css';

const TABS = [
  { key: 'questions', label: 'Questions' },
  { key: 'roster', label: 'Roster' },
  { key: 'activate', label: 'Activate' },
  { key: 'results', label: 'Results' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function QuizEditorPage() {
  const { quizId } = useParams<{ quizId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeTab = (searchParams.get('tab') as TabKey) ?? 'questions';

  const reload = useCallback(async () => {
    if (!quizId) return;
    try {
      setQuiz(await getQuiz(Number(quizId)));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [quizId]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleFieldSave(field: 'title' | 'description', value: string) {
    if (!quiz) return;
    try {
      const updated = await updateQuiz(quiz.id, { [field]: value });
      setQuiz(updated);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleToggleOneAtATime() {
    if (!quiz) return;
    try {
      const updated = await updateQuiz(quiz.id, { one_question_at_a_time: !quiz.one_question_at_a_time });
      setQuiz(updated);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleToggleRequireAllAnswers() {
    if (!quiz) return;
    try {
      const updated = await updateQuiz(quiz.id, { require_all_answers: !quiz.require_all_answers });
      setQuiz(updated);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  if (!quiz) {
    return (
      <div>
        <ErrorBanner message={error} />
        {!error && <p>Loading…</p>}
      </div>
    );
  }

  return (
    <div>
      <Link to="/dashboard" className={styles.backLink}>
        ← All Quizzes
      </Link>

      <ErrorBanner message={error} />

      <div className={styles.titleRow}>
        <input
          className={styles.titleInput}
          value={quiz.title}
          onChange={(e) => setQuiz({ ...quiz, title: e.target.value })}
          onBlur={(e) => handleFieldSave('title', e.target.value)}
        />
        <Link
          to={`/quizzes/${quiz.id}/preview`}
          target="_blank"
          rel="noopener noreferrer"
          className={nb.btnSm}
          style={{ whiteSpace: 'nowrap' }}
        >
          Preview as player
        </Link>
      </div>
      <textarea
        className={styles.descriptionInput}
        placeholder="Add a description (optional)"
        value={quiz.description ?? ''}
        onChange={(e) => setQuiz({ ...quiz, description: e.target.value })}
        onBlur={(e) => handleFieldSave('description', e.target.value)}
      />

      <label className={styles.settingsRow}>
        <input type="checkbox" checked={quiz.one_question_at_a_time} onChange={handleToggleOneAtATime} />
        Show players one question at a time
      </label>

      <label className={styles.settingsRow}>
        <input type="checkbox" checked={quiz.require_all_answers} onChange={handleToggleRequireAllAnswers} />
        Require players to answer every question before submitting
      </label>

      <div className={styles.tabs}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ''}`}
            onClick={() => setSearchParams({ tab: tab.key })}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'questions' && <QuestionsTab quiz={quiz} reload={reload} />}
      {activeTab === 'roster' && <RosterTab quiz={quiz} />}
      {activeTab === 'activate' && <AccessCodesTab quiz={quiz} />}
      {activeTab === 'results' && <ResultsTab quiz={quiz} />}
    </div>
  );
}
