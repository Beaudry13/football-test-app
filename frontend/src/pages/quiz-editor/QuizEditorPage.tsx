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
import { LoadingState } from '../../components/ui/LoadingState';
import { Icon } from '../../components/ui/Icon';

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
  /* Results is the one tab a coach READS rather than edits, and the only one
     with an action of its own competing for the top of the screen. */
  const readingResults = activeTab === 'results';

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
        {!error && <LoadingState />}
      </div>
    );
  }

  return (
    <div>
      <Link to="/dashboard" className={styles.backLink}>
        <Icon name="back" size={14} /> All Quizzes
      </Link>

      <ErrorBanner message={error} />

      {/* The visible title is an inline-editable input, so the page would
          otherwise have no <h1> at all and the field no accessible name.
          A visually-hidden heading gives the document real structure
          without changing the editing UI. */}
      <h1 className={nb.srOnly}>{quiz.title}</h1>

      <div className={styles.titleRow}>
        <input
          className={styles.titleInput}
          aria-label="Quiz title"
          value={quiz.title}
          onChange={(e) => setQuiz({ ...quiz, title: e.target.value })}
          onBlur={(e) => handleFieldSave('title', e.target.value)}
        />
        {/* WHY THIS DRAFT EXISTS.
          Peira builds a retest and drops the coach into the ordinary editor,
          which is deliberate - a second editor would be the thing this feature
          avoids - but the draft arrived looking like any other quiz. The only
          hint was the title, and who it was for lived one tab away on the
          roster.

          One line, three facts, and nothing on an ordinary quiz. */}
      {quiz.retest_of && (
        <p className={styles.retestContext}>
          Retest of <strong>{quiz.retest_of.title}</strong>
          {quiz.retest_of.concept_name && (
            <> &middot; {quiz.retest_of.concept_name}</>
          )}
          {' '}&middot; {quiz.retest_of.player_count}{' '}
          player{quiz.retest_of.player_count === 1 ? '' : 's'}
          {quiz.retest_of.stopped_in_parent > 0 && (
            /* Present tense, because that is what is actually knowable: these
               questions are stopped NOW. What was skipped on the day it was
               built was never recorded. */
            <>
              {' '}&middot; {quiz.retest_of.stopped_in_parent} stopped question
              {quiz.retest_of.stopped_in_parent === 1 ? " isn't" : "s aren't"} included
            </>
          )}
        </p>
      )}

      {/* AUTHORING CONTROLS, HIDDEN WHILE READING RESULTS.
            Not removed and not moved - one tap away on the tabs they belong
            to. On a 375px phone this block plus the settings below it pushed
            "Teach next" past the halfway mark of the screen and the action
            below the fold entirely, so a coach opening Results had to scroll
            before seeing the answer and again before acting on it. Nothing
            here helps read a result. */}
        {!readingResults && (
          <>
            <Link
              to={`/quizzes/${quiz.id}/preview`}
              target="_blank"
              rel="noopener noreferrer"
              className={nb.btnSm}
              style={{ whiteSpace: 'nowrap' }}
            >
              Preview as player
            </Link>
            {/* The entry point into Competition. Same tab, because the coach is
                about to run the room from this screen - a background tab is the
                last place a live join code should live. */}
            <Link
              to={`/quizzes/${quiz.id}/compete`}
              className={nb.btnSm}
              style={{ whiteSpace: 'nowrap' }}
            >
              Start Competition
            </Link>
          </>
        )}
      </div>
      {/* The description and the two delivery settings describe how this quiz
          is WRITTEN and SENT. Both are editable from every other tab, and
          neither is readable information once players have answered. */}
      {!readingResults && (
        <>
          <textarea
            className={styles.descriptionInput}
            placeholder="Add a description (optional)"
            value={quiz.description ?? ''}
            onChange={(e) => setQuiz({ ...quiz, description: e.target.value })}
            onBlur={(e) => handleFieldSave('description', e.target.value)}
          />

          <label className={styles.settingsRow}>
            <input
              type="checkbox"
              checked={quiz.one_question_at_a_time}
              onChange={handleToggleOneAtATime}
            />
            Show players one question at a time
          </label>

          <label className={styles.settingsRow}>
            <input
              type="checkbox"
              checked={quiz.require_all_answers}
              onChange={handleToggleRequireAllAnswers}
            />
            Require players to answer every question before submitting
          </label>
        </>
      )}

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
