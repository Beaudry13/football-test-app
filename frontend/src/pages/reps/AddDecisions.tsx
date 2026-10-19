import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getErrorMessage } from '../../api/client';
import { listMotionPlays, type MotionPlayRow } from '../../api/motionLab';
import { getQuiz, listQuizzes } from '../../api/quizzes';
import { addDecisions } from '../../api/reps';
import type { Question, Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useMayUseMotionLab } from '../../motion-lab/motionLabAccess';
import nb from '../../styles/notebook.module.css';
import styles from './RepPage.module.css';

/** One tap, one right answer: what a Rep can judge on the spot. */
const tappable = (q: Question) =>
  !q.is_retired && (q.question_type === 'true_false' || (q.question_type === 'multiple_choice' && !q.allows_multiple_answers));

/**
 * BUILD A REP FROM WHAT YOU ALREADY HAVE: tick questions from any quiz and
 * add them; or open a Motion Lab play with Make rep already pointed at this
 * Rep. No wizard - pick, add, repeat; reorder on the page.
 */
export function AddDecisions({ repId, onAdded }: { repId: number; onAdded: () => void }) {
  const motionLab = useMayUseMotionLab();
  const [from, setFrom] = useState<'quiz' | 'play'>('quiz');
  const [quizzes, setQuizzes] = useState<Quiz[] | null>(null);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [plays, setPlays] = useState<MotionPlayRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listQuizzes()
      .then((list) =>
        setQuizzes(
          list.filter((q) => q.kind !== 'REP' && q.question_count > 0).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
        ),
      )
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  useEffect(() => {
    if (from !== 'play' || plays !== null) return;
    listMotionPlays()
      .then((rows) => setPlays([...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at))))
      .catch((err) => setError(getErrorMessage(err)));
  }, [from, plays]);

  const openQuiz = (q: Quiz) => {
    setPicked([]);
    setError(null);
    getQuiz(q.id)
      .then(setQuiz)
      .catch((err) => setError(getErrorMessage(err)));
  };

  const add = async () => {
    if (!quiz || picked.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await addDecisions(repId, quiz.id, picked);
      setPicked([]);
      setQuiz(null);
      onAdded();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const questions = (quiz?.questions ?? []).filter(tappable);

  return (
    <section className={styles.adder} aria-label="Add decisions">
      {motionLab && (
        <div className={styles.adderTabs} role="tablist" aria-label="Add from">
          <button type="button" role="tab" aria-selected={from === 'quiz'} onClick={() => setFrom('quiz')}>
            From a quiz
          </button>
          <button type="button" role="tab" aria-selected={from === 'play'} onClick={() => setFrom('play')}>
            From a Motion Lab play
          </button>
        </div>
      )}
      <ErrorBanner message={error} />

      {from === 'quiz' && !quiz && (
        <ul className={styles.adderList} aria-label="Quizzes">
          {(quizzes ?? []).slice(0, 12).map((q) => (
            <li key={q.id}>
              <button type="button" className={styles.adderRow} onClick={() => openQuiz(q)}>
                <span>{q.title}</span>
                <span className={styles.adderMeta}>{q.question_count} questions</span>
              </button>
            </li>
          ))}
          {quizzes?.length === 0 && <li className={styles.adderMeta}>No quizzes with questions yet.</li>}
        </ul>
      )}

      {from === 'quiz' && quiz && (
        <div className={styles.adderPick}>
          <div className={styles.adderPickHead}>
            <button type="button" className={nb.btnSm} onClick={() => setQuiz(null)}>
              ← Quizzes
            </button>
            <strong>{quiz.title}</strong>
          </div>
          {questions.length === 0 ? (
            <p className={styles.adderMeta}>No tap-an-answer questions here - a Rep judges on the spot.</p>
          ) : (
            <ul className={styles.adderList} aria-label={`Questions in ${quiz.title}`}>
              {questions.map((q) => {
                const on = picked.includes(q.id);
                return (
                  <li key={q.id}>
                    <label className={on ? `${styles.adderQuestion} ${styles.adderQuestionOn}` : styles.adderQuestion}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => setPicked((list) => (on ? list.filter((x) => x !== q.id) : [...list, q.id]))}
                      />
                      <span>{q.question_text}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <button type="button" className={nb.btnPrimary} disabled={busy || picked.length === 0} onClick={() => void add()}>
            {busy ? 'Adding…' : picked.length === 0 ? 'Tick the ones to add' : `Add ${picked.length} to this rep`}
          </button>
        </div>
      )}

      {from === 'play' && (
        <ul className={styles.adderList} aria-label="Motion Lab plays">
          {(plays ?? []).slice(0, 12).map((p) => (
            <li key={p.id}>
              {/* Make rep, already pointed at this Rep. */}
              <Link to={`/motion-lab/plays/${p.id}?rep=${repId}`} className={styles.adderRow}>
                <span>{p.name}</span>
                <span className={styles.adderMeta}>Make a decision from it →</span>
              </Link>
            </li>
          ))}
          {plays?.length === 0 && <li className={styles.adderMeta}>No Motion Lab plays yet.</li>}
        </ul>
      )}
    </section>
  );
}
