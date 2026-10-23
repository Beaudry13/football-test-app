import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getErrorMessage } from '../api/client';
import { getGroupNeeds, type GroupNeed, type GroupNeeds } from '../api/players';
import { addRosterMembers } from '../api/roster';
import { addDecisions, makeRepFromQuiz } from '../api/reps';
import { getQuiz } from '../api/quizzes';
import type { Question, Quiz } from '../api/types';
import { TeachView, type TeachSlide } from '../components/teach/TeachView';
import { quizTeachSlides, teachable } from './quiz-editor/quizTeach';
import { distinctFootball } from '../components/teach/sameFootball';
import styles from './PositionNeeds.module.css';

/** How many concepts the panel names before counting the rest. */
const SHOWN = 4;

/**
 * "SHOW ME MY SAFETIES. WHAT ARE THEY MISSING? SEND THOSE GUYS THIS WORK."
 *
 * Under the roster's position filter: the concepts these players are still
 * working on - by the same rows each player's profile shows - who, and the
 * next step one tap away:
 *   Teach       right here, in the meeting-room view: the football they
 *               missed (from the quizzes and Reps where they missed it), who,
 *               Retest them, and Next - the group's next problem - without
 *               leaving the roster;
 *   Retest them the decisions each of them missed, as one Rep for exactly
 *               them - built, not sent (the Rep page's Send is the next tap).
 * Not a report and not a ranking; nothing here when nothing is open.
 */
export function PositionNeeds({ label, plural, playerIds }: { label: string; plural: string; playerIds: number[] }) {
  const navigate = useNavigate();
  const [needs, setNeeds] = useState<GroupNeeds | null>(null);
  const [making, setMaking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** TEACH, IN PLACE: the concept on the screen and its football. */
  const [teaching, setTeaching] = useState<{ need: GroupNeed; slides: TeachSlide[] } | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const quizzes = useRef(new Map<number, Promise<Quiz>>());
  const ids = [...playerIds].sort((a, b) => a - b).join(',');

  useEffect(() => {
    let live = true;
    setNeeds(null);
    getGroupNeeds(ids ? ids.split(',').map(Number) : [])
      .then((data) => {
        if (live) setNeeds(data);
      })
      .catch(() => {
        if (live) setNeeds(null);
      });
    return () => {
      live = false;
    };
  }, [ids]);

  if (!needs || needs.players === 0) return null;

  /** RETEST THEM: each one's missed decisions, one Rep, for exactly them. */
  const retest = async (need: GroupNeed) => {
    setMaking(need.concept_id);
    setError(null);
    try {
      const byQuiz = new Map<number, Set<number>>();
      for (const m of need.missing) {
        const set = byQuiz.get(m.last.quiz_id) ?? new Set<number>();
        m.last.question_ids.forEach((id) => set.add(id));
        byQuiz.set(m.last.quiz_id, set);
      }
      const [[firstQuiz, firstIds], ...rest] = [...byQuiz.entries()].filter(([, set]) => set.size > 0);
      const rep = await makeRepFromQuiz(firstQuiz, [...firstIds], `${need.name} - ${label}`);
      for (const [quizId, set] of rest) await addDecisions(rep.id, quizId, [...set]);
      await addRosterMembers(rep.id, need.missing.map((m) => m.player_id));
      navigate(`/reps/${rep.id}`);
    } catch (err) {
      setError(getErrorMessage(err));
      setMaking(null);
    }
  };

  /** THE FOOTBALL THEY MISSED: the concept's questions where each last missed
   *  it - newest first, the ones they missed (else the concept's) - from the
   *  quizzes and Reps themselves, so Teach shows exactly what they saw. */
  const slidesFor = async (need: GroupNeed): Promise<TeachSlide[]> => {
    const byQuiz = new Map<number, { ids: Set<number>; at: string }>();
    for (const m of need.missing) {
      const entry = byQuiz.get(m.last.quiz_id) ?? { ids: new Set<number>(), at: '' };
      m.last.question_ids.forEach((id) => entry.ids.add(id));
      if ((m.last.at ?? '') > entry.at) entry.at = m.last.at ?? '';
      byQuiz.set(m.last.quiz_id, entry);
    }
    const ordered = [...byQuiz.entries()].sort((a, b) => b[1].at.localeCompare(a[1].at));
    const gathered: { quiz: Quiz; question: Question }[] = [];
    for (const [quizId, { ids }] of ordered) {
      if (!quizzes.current.has(quizId)) quizzes.current.set(quizId, getQuiz(quizId));
      const quiz = await quizzes.current.get(quizId)!;
      const inConcept = (quiz.questions ?? []).filter((q) => q.concept?.id === need.concept_id && !q.is_retired && teachable(q));
      const missedHere = inConcept.filter((q) => ids.has(q.id));
      for (const question of missedHere.length > 0 ? missedHere : inConcept) gathered.push({ quiz, question });
    }
    // A retest re-asks the same football as a copy: taught once, by its
    // source identity - never merged just because two questions share words.
    return quizTeachSlides(distinctFootball(gathered));
  };

  const teach = async (need: GroupNeed) => {
    setOpening(need.concept_id);
    setError(null);
    try {
      const slides = await slidesFor(need);
      if (slides.length === 0) navigate(teachHref(need));
      else setTeaching({ need, slides });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setOpening(null);
    }
  };

  /** Where the latest of them missed it - Teach there when nothing here has football to show. */
  const teachHref = (need: GroupNeed) => {
    const latest = [...need.missing].sort((a, b) => (b.last.at ?? '').localeCompare(a.last.at ?? ''))[0].last;
    return latest.kind === 'REP'
      ? `/reps/${latest.quiz_id}?teach=${need.concept_id}`
      : `/quizzes/${latest.quiz_id}?tab=results&teach=${need.concept_id}`;
  };

  return (
    <section className={styles.needs} aria-label={`What your ${plural} need`}>
      <h2 className={styles.title}>What your {plural} need</h2>
      {needs.concepts.length === 0 ? (
        <p className={styles.none}>Nothing open on what you have tested them on.</p>
      ) : (
        <ul className={styles.list}>
          {needs.concepts.slice(0, SHOWN).map((need) => {
            const retestable = need.missing.some((m) => m.last.question_ids.length > 0);
            return (
              <li key={need.concept_id} className={styles.row}>
                <div className={styles.what}>
                  <strong>{need.name}</strong>
                  <span className={styles.count}>
                    {need.missing.length} of {needs.players} still working on it
                  </span>
                </div>
                <div className={styles.who}>
                  {need.missing.map((m, i) => (
                    <span key={m.player_id}>
                      {i > 0 && ', '}
                      <Link to={`/roster/${m.player_id}`}>{m.name}</Link>
                    </span>
                  ))}
                </div>
                <div className={styles.actions}>
                  <button type="button" className={styles.action} disabled={opening !== null} onClick={() => void teach(need)}>
                    {opening === need.concept_id ? 'Opening…' : 'Teach'}
                  </button>
                  {retestable && (
                    <button type="button" className={styles.action} disabled={making !== null} onClick={() => void retest(need)}>
                      {making === need.concept_id
                        ? 'Making…'
                        : need.missing.length === 1
                          ? `Retest ${need.missing[0].name.split(' ')[0]}`
                          : `Retest the ${need.missing.length}`}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
          {needs.concepts.length > SHOWN && (
            <li className={styles.more}>
              and {needs.concepts.length - SHOWN} more - each player&rsquo;s profile has the rest
            </li>
          )}
        </ul>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {teaching && (() => {
        const { need } = teaching;
        const index = needs.concepts.findIndex((c) => c.concept_id === need.concept_id);
        const following = needs.concepts[index + 1] ?? null;
        const retestable = need.missing.some((m) => m.last.question_ids.length > 0);
        return (
          <TeachView
            title={need.name}
            slides={teaching.slides}
            onClose={() => setTeaching(null)}
            room={{ missed: need.missing.length, of: needs.players, names: need.missing.map((m) => m.name), verb: 'still working on it' }}
            action={
              retestable ? (
                <button type="button" disabled={making !== null} onClick={() => void retest(need)}>
                  {making === need.concept_id ? 'Making…' : `Retest the ${need.missing.length}`}
                </button>
              ) : undefined
            }
            next={
              following
                ? { label: `${following.name} · ${following.missing.length} of ${needs.players}`, onGo: () => void teach(following) }
                : null
            }
          />
        );
      })()}
    </section>
  );
}
