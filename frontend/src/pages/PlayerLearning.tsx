import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getErrorMessage } from '../api/client';
import { addRosterMembers, getPlayerLearning, type LearningEvent, type PlayerLearning as Learning } from '../api/players';
import { makeRepFromQuiz } from '../api/reps';
import nb from '../styles/notebook.module.css';
import styles from './PlayerLearning.module.css';

/** "Missed" / "Got it" / "Retest correct" - one sitting, in a coach's words. */
function said(event: LearningEvent) {
  if (event.outcome === 'got') return event.is_retest ? 'Retest correct' : 'Got it';
  return event.is_retest ? 'Missed the retest' : 'Missed';
}

/**
 * WHAT DOES THIS PLAYER KNOW, AND WHAT IS HE STILL MISSING? By the concepts
 * the coach tagged, from the coach's own quizzes (graded) and Reps (first
 * try): HAS, WORK ON with the next coaching step one tap away, and how each
 * concept changed. Not a season report and not a ranking - and a failure here
 * hides the panel rather than costing the profile.
 */
export function PlayerLearning({ playerId, firstName }: { playerId: number; firstName: string }) {
  const navigate = useNavigate();
  const [learning, setLearning] = useState<Learning | null>(null);
  const [making, setMaking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getPlayerLearning(playerId)
      .then((data) => {
        if (live) setLearning(data);
      })
      .catch(() => {
        if (live) setLearning(null);
      });
    return () => {
      live = false;
    };
  }, [playerId]);

  if (!learning || learning.has.length + learning.work_on.length === 0) return null;

  /** RETEST HIM: the decisions he missed, as a Rep for just this player - built, not sent. */
  const retest = async (conceptId: number, name: string, last: LearningEvent) => {
    setMaking(conceptId);
    setError(null);
    try {
      const rep = await makeRepFromQuiz(last.quiz_id, last.question_ids, `${name} - ${firstName}`);
      await addRosterMembers(rep.id, [playerId]);
      navigate(`/reps/${rep.id}`);
    } catch (err) {
      setError(getErrorMessage(err));
      setMaking(null);
    }
  };

  return (
    <section className={`${nb.card} ${styles.learning}`} aria-label={`What ${firstName} knows`}>
      <h2 className={styles.title}>What {firstName} knows</h2>
      {learning.has.length > 0 && (
        <div className={styles.group}>
          <span className={styles.label}>Has it</span>
          <ul className={styles.chips}>
            {learning.has.map((c) => (
              <li key={c.concept_id} className={styles.has}>
                <span aria-hidden="true">✓</span> {c.name}
              </li>
            ))}
          </ul>
        </div>
      )}
      {learning.work_on.length > 0 && (
        <div className={styles.group}>
          <span className={styles.label}>Work on</span>
          <ul className={styles.rows}>
            {learning.work_on.map((c) => (
              <li key={c.concept_id} className={styles.row}>
                <span className={styles.name}>{c.name}</span>
                <span className={styles.where}>
                  {said(c.last)} in {c.last.quiz_title}
                </span>
                <span className={styles.actions}>
                  <Link
                    className={styles.action}
                    to={
                      c.last.kind === 'REP'
                        ? `/reps/${c.last.quiz_id}?teach=${c.concept_id}`
                        : `/quizzes/${c.last.quiz_id}?tab=results`
                    }
                  >
                    Teach
                  </Link>
                  {c.last.question_ids.length > 0 && (
                    <button
                      type="button"
                      className={styles.action}
                      disabled={making !== null}
                      onClick={() => void retest(c.concept_id, c.name, c.last)}
                    >
                      {making === c.concept_id ? 'Making…' : `Retest ${firstName}`}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* HOW IT CHANGED, one level down: what he knows and what he needs is
          the answer; the trail behind it is there when a coach asks. */}
      {learning.recent.length > 0 && (
        <details className={styles.group}>
          <summary className={styles.label}>How it changed</summary>
          <ul className={styles.rows}>
            {learning.recent.map((r) => (
              <li key={r.concept_id} className={styles.trail}>
                <span className={styles.name}>{r.name}</span>{' '}
                {r.trail.map((t, i) => (
                  <span key={i}>
                    {i > 0 && <span className={styles.arrow}> → </span>}
                    <span className={t.outcome === 'got' ? styles.got : styles.missed}>{said(t)}</span>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </section>
  );
}
