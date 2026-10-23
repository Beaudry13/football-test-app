import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getErrorMessage } from '../../api/client';
import { listQuizzes } from '../../api/quizzes';
import { listOrganizationQuizzes, type OrganizationQuiz } from '../../api/organizations';
import { useAuth } from '../../auth/AuthContext';
import { makeRepFromQuiz } from '../../api/reps';
import type { Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useMayUseMotionLab } from '../../motion-lab/motionLabAccess';
import nb from '../../styles/notebook.module.css';
import styles from './RepsPage.module.css';
import { ConceptTrends } from './ConceptTrends';
import { TidyConcepts } from './TidyConcepts';

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
  /* MY REPS | ALL REPS - an admin may open any Rep in the organization, so he
     may list them too; everyone else sees his own. Home stays his own. */
  const isAdmin = useAuth().coach?.role === 'admin';
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [everyone, setEveryone] = useState<OrganizationQuiz[] | null>(null);
  /* FIND ONE BY NAME - the quiz to make a Rep from, and (once the list is
     long) a Rep: a few typed letters instead of scrolling. */
  const [findQuiz, setFindQuiz] = useState('');
  const [findRep, setFindRep] = useState('');

  useEffect(() => {
    listQuizzes()
      .then((list) => setAll([...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at))))
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  useEffect(() => {
    if (scope !== 'all' || everyone !== null) return;
    listOrganizationQuizzes()
      .then((tree) => setEveryone(tree.quizzes.filter((q) => q.kind === 'REP')))
      .catch((err) => setError(getErrorMessage(err)));
  }, [scope, everyone]);

  const named = (needle: string) => (q: { title: string }) => !needle.trim() || q.title.toLowerCase().includes(needle.trim().toLowerCase());
  const mine = all?.filter((q) => q.kind === 'REP') ?? null;
  const allReps: (Quiz & { owner?: OrganizationQuiz['owner'] })[] | null = scope === 'all' ? everyone : mine;
  const reps = allReps?.filter(named(findRep)) ?? null;
  const quizzes = all?.filter((q) => q.kind !== 'REP' && q.question_count > 0) ?? [];
  const pickable = quizzes.filter(named(findQuiz));

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
          {quizzes.length > 12 && (
            <input
              className={`${nb.input} ${styles.find}`}
              type="search"
              value={findQuiz}
              onChange={(e) => setFindQuiz(e.target.value)}
              placeholder="Find a quiz…"
              aria-label="Find a quiz"
            />
          )}
          {quizzes.length === 0 ? (
            <p className={styles.pickerHint}>No quizzes with questions yet.</p>
          ) : pickable.length === 0 ? (
            <p className={styles.pickerHint}>No quiz by that name.</p>
          ) : (
            <ul className={styles.pickList}>
              {pickable.slice(0, 12).map((quiz) => (
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
      {/* One "Motion adjustment", not five: offered when concepts look alike. */}
      <TidyConcepts />
      {isAdmin && (
        <div className={styles.scope} role="radiogroup" aria-label="Whose reps">
          {(['mine', 'all'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              className={scope === s ? `${styles.scopeButton} ${styles.scopeOn}` : styles.scopeButton}
              onClick={() => setScope(s)}
            >
              {s === 'mine' ? 'My reps' : 'All reps'}
            </button>
          ))}
        </div>
      )}
      {(allReps?.length ?? 0) > 8 && (
        <input
          className={`${nb.input} ${styles.find}`}
          type="search"
          value={findRep}
          onChange={(e) => setFindRep(e.target.value)}
          placeholder="Find a rep…"
          aria-label="Find a rep"
        />
      )}
      {allReps === null && !error && <LoadingState />}
      {allReps !== null && allReps.length > 0 && reps?.length === 0 && <p className={styles.empty}>No rep by that name.</p>}
      {scope === 'all' && allReps?.length === 0 && <p className={styles.empty}>Nobody in your program has made a rep yet.</p>}
      {scope === 'mine' && allReps?.length === 0 && !picking && (
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
                {scope === 'all' && rep.owner ? ` · ${rep.owner.username}` : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
