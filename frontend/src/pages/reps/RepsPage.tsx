import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getErrorMessage } from '../../api/client';
import { listQuizzes } from '../../api/quizzes';
import { makeRepFromQuiz } from '../../api/reps';
import type { Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useMayUseMotionLab } from '../../motion-lab/motionLabAccess';
import nb from '../../styles/notebook.module.css';
import styles from './RepsPage.module.css';
import { ConceptTrends } from './ConceptTrends';

/**
 * EVERY SITUATIONAL REP - newest first, each one tap from its football
 * problems - and the fastest way to make one: from a quiz you already wrote
 * (one tap), or from a Motion Lab play for coaches who have Motion Lab.
 */
export function RepsPage() {
  useDocumentTitle('Reps');
  const navigate = useNavigate();
  const motionLab = useMayUseMotionLab();
  const [all, setAll] = useState<Quiz[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [making, setMaking] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{ id: number; message: string } | null>(null);

  useEffect(() => {
    listQuizzes()
      .then((list) => setAll([...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at))))
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  const reps = all?.filter((q) => q.kind === 'REP') ?? null;
  const quizzes = all?.filter((q) => q.kind !== 'REP' && q.question_count > 0) ?? [];

  const make = async (quiz: Quiz) => {
    setMaking(quiz.id);
    setRowError(null);
    try {
      const rep = await makeRepFromQuiz(quiz.id);
      navigate(`/reps/${rep.id}`);
    } catch (err) {
      setRowError({ id: quiz.id, message: getErrorMessage(err) });
      setMaking(null);
    }
  };

  return (
    <div>
      <header className={styles.head}>
        <div>
          <h1 className={nb.heading}>Reps</h1>
          <p className={styles.tag}>Put them in the play. See who knows their job.</p>
        </div>
        <div className={styles.makeRow}>
          <button type="button" className={nb.btnPrimary} aria-expanded={picking} onClick={() => setPicking((open) => !open)}>
            Make a rep from a quiz
          </button>
          {motionLab && (
            <Link to="/motion-lab" className={`${nb.btnSecondary} ${styles.linkButton}`}>
              From a Motion Lab play
            </Link>
          )}
        </div>
      </header>
      <ErrorBanner message={error} />

      {picking && (
        <section className={styles.picker} aria-label="Make a rep from a quiz">
          <p className={styles.pickerHint}>Its tap-an-answer questions become the Rep. The quiz stays as it is.</p>
          {quizzes.length === 0 ? (
            <p className={styles.pickerHint}>No quizzes with questions yet.</p>
          ) : (
            <ul className={styles.pickList}>
              {quizzes.slice(0, 12).map((quiz) => (
                <li key={quiz.id} className={styles.pickRow}>
                  <span className={styles.title}>{quiz.title}</span>
                  <span className={styles.meta}>
                    {quiz.question_count} {quiz.question_count === 1 ? 'question' : 'questions'}
                  </span>
                  <button
                    type="button"
                    className={nb.btnSm}
                    disabled={making !== null}
                    onClick={() => void make(quiz)}
                    aria-label={`Make a rep from ${quiz.title}`}
                  >
                    {making === quiz.id ? 'Making…' : 'Make rep'}
                  </button>
                  {rowError?.id === quiz.id && <span className={styles.rowError} role="alert">{rowError.message}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Is it getting better? One line per football problem. */}
      <ConceptTrends />
      {reps === null && !error && <LoadingState />}
      {reps?.length === 0 && !picking && (
        <p className={styles.empty}>
          No reps yet. Tap <strong>Make a rep from a quiz</strong> - its tap-an-answer questions become decisions your
          players run one at a time{motionLab ? ', or put a player in a Motion Lab play' : ''}.
        </p>
      )}
      <ul className={styles.list}>
        {(reps ?? []).map((rep) => (
          <li key={rep.id}>
            <Link to={`/reps/${rep.id}`} className={styles.row}>
              <span className={styles.title}>{rep.title}</span>
              <span className={styles.meta}>
                {rep.question_count} {rep.question_count === 1 ? 'decision' : 'decisions'}
                {rep.is_active ? ' · out now' : ''}
                {rep.retest_of ? ' · retest' : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
