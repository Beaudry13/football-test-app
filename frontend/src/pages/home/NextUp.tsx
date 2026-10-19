import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getQuizDashboard } from '../../api/grading';
import type { RepSummary } from '../../api/reps';
import type { ConceptBreakdown, Quiz } from '../../api/types';
import nb from '../../styles/notebook.module.css';
import { pluralFor } from '../reps/audiences';
import styles from './NextUp.module.css';

/** A quiz's football problem worth leading Home with. */
interface QuizProblem {
  quiz: Quiz;
  concept: ConceptBreakdown;
}

/** The latest quiz with results - the one whose problem is freshest. */
function latestScored(quizzes: Quiz[]): Quiz | null {
  return (
    [...quizzes]
      .filter((q) => q.kind !== 'REP' && q.average_score_percent !== undefined)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null
  );
}

/**
 * NEXT UP: the one football problem to deal with now, first on Home.
 *
 *   1. a Rep problem nobody has retested yet        -> Teach it / Retest it
 *   2. a Rep retest that still has misses           -> Teach / Retest K
 *   3. else the latest quiz's weakest concept, when the sample can carry it
 *      and no retest of it is out                   -> Teach it
 *
 * One problem, one gold action. Nothing here sends anything: Retest opens the
 * Rep with its confirm up, Teach opens the teaching screen.
 */
export function NextUp({
  reps,
  quizzes,
}: {
  /** Undefined while the Reps summary loads (wait for it), null if it failed. */
  reps: RepSummary[] | null | undefined;
  /** The coach's quizzes, for the quiz fallback; null = none to consider. */
  quizzes: Quiz[] | null;
}) {
  const fresh = reps?.find((r) => r.open_problem) ?? null;
  const lingering = fresh ? null : (reps?.find((r) => r.signal?.kind === 'retest_missing') ?? null);
  const fromQuiz = !fresh && !lingering && reps !== undefined ? latestScored(quizzes ?? []) : null;
  const [quizProblem, setQuizProblem] = useState<QuizProblem | null>(null);

  useEffect(() => {
    if (!fromQuiz) return;
    let cancelled = false;
    getQuizDashboard(fromQuiz.id)
      .then((dashboard) => {
        if (cancelled || dashboard.verification) return;
        const retested = new Set((dashboard.retests ?? []).flatMap((t) => t.concept_ids));
        const concept = dashboard.concept_breakdown.find(
          (c) =>
            c.player_miss_rate !== null &&
            c.players_missed_count > 0 &&
            c.has_enough_responses &&
            c.concept_id !== null &&
            !retested.has(c.concept_id),
        );
        setQuizProblem(concept ? { quiz: fromQuiz, concept } : null);
      })
      // Home does not fail over this: no problem found, no line.
      .catch(() => !cancelled && setQuizProblem(null));
    return () => {
      cancelled = true;
    };
  }, [fromQuiz]);

  if (fresh?.open_problem) {
    const who = fresh.audience_label
      ? fresh.audience_label.toLowerCase()
      : (pluralFor(fresh.audience_positions ?? []) ?? 'players');
    const p = fresh.open_problem;
    return (
      <section className={styles.nextUp} aria-label="Next up">
        <span className={styles.lead}>Next up</span>
        <span className={styles.problem}>
          <strong className={styles.name}>{p.name}</strong> {p.missed} of {p.responded} {who} missed
          {p.taught ? ' · taught' : ''}
        </span>
        <span className={styles.actions}>
          {/* Taught already (by anyone): the next step is Retest, on the Rep page. */}
          {p.taught ? (
            <Link to={`/reps/${fresh.id}`} className={nb.btnPrimary}>
              Retest it
            </Link>
          ) : (
            <Link to={`/reps/${fresh.id}?teach=${p.concept_id ?? 'general'}`} className={nb.btnPrimary}>
              Teach it
            </Link>
          )}
        </span>
      </section>
    );
  }

  if (lingering?.signal) {
    /* DID IT STICK, AND WHAT NOW: "3 were retested, 1 still misses it". */
    const s = lingering.signal;
    const key = s.concept_id ?? 'general';
    return (
      <section className={styles.nextUp} aria-label="Next up">
        <span className={styles.lead}>Next up</span>
        <span className={styles.problem}>
          <strong className={styles.name}>{s.concept}</strong> {s.responded} {s.responded === 1 ? 'was' : 'were'} retested,{' '}
          {s.missed} still {s.missed === 1 ? 'misses' : 'miss'} it
        </span>
        <span className={styles.actions}>
          <Link to={`/reps/${lingering.id}?teach=${key}`} className={nb.btnSecondary}>
            Teach
          </Link>
          <Link to={`/reps/${lingering.id}?retest=${key}`} className={nb.btnPrimary}>
            Retest {s.missed}
          </Link>
        </span>
      </section>
    );
  }

  if (quizProblem && fromQuiz && quizProblem.quiz.id === fromQuiz.id) {
    const { quiz, concept } = quizProblem;
    return (
      <section className={styles.nextUp} aria-label="Next up">
        <span className={styles.lead}>Next up</span>
        <span className={styles.problem}>
          <strong className={styles.name}>{concept.concept_name}</strong> {concept.players_missed_count} of{' '}
          {concept.players_responded_count} missed it <span className={styles.where}>in {quiz.title}</span>
        </span>
        <span className={styles.actions}>
          <Link to={`/quizzes/${quiz.id}?tab=results&teach=${concept.concept_id}`} className={nb.btnPrimary}>
            Teach it
          </Link>
        </span>
      </section>
    );
  }

  return null;
}
