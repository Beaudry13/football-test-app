import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getErrorMessage } from '../../api/client';
import { listConceptQuestions, type ConceptQuestion } from '../../api/concepts';
import { addDecisions, makeRepFromQuiz } from '../../api/reps';
import { useMayUseMotionLab } from '../../motion-lab/motionLabAccess';
import { addRosterMembers } from '../../api/roster';
import type { Question, QuestionBreakdown } from '../../api/types';
import { TeachView, type TeachSlide } from '../../components/teach/TeachView';
import { quizTeachSlides } from './quizTeach';
import styles from './MissActions.module.css';
import { AddToInstall } from '../installs/AddToInstall';
import { buildQuizRetest, retestLabel } from '../../components/teach/retest';
import { SourcePlayLink } from '../../components/football/SourcePlayLink';
import { useGoFromHere } from '../../navigation/backTo';

/**
 * A QUIZ MISS, THEN WHAT? The coaching loop Reps have, on quiz Results:
 *
 *   Teach     the missed questions in the meeting-room view (TeachView)
 *   Make rep  the same football problem as a Situational Rep - picture,
 *             motion, tap spots, who he is, answers, right answer, concept,
 *             reason all carried over - for the players who missed it when
 *             PEIRA knows them. Nothing is sent: the Rep opens to send.
 *
 * Quiz finds the problem; the Rep reteaches and retests it.
 */
export function MissActions({
  quizId,
  questions,
  breakdown,
  title,
  repTitle,
  playerIds = [],
  extraAction,
  slides,
  teachLabel = 'Teach',
  retestTargets,
  conceptId,
  show = 'all',
  startTeaching = false,
  missed = [],
  onTeach,
}: {
  quizId: number;
  /** The questions this miss is about, in quiz order. */
  questions: Question[];
  breakdown?: QuestionBreakdown[];
  /** Teach's heading ("Motion adjustment", "Q3"). */
  title: string;
  /** The new Rep's name. */
  repTitle: string;
  /** Who missed it, when known: the Rep starts with exactly them. */
  playerIds?: number[];
  /** A further action on the Teach screen (Retest, for a concept). */
  extraAction?: ReactNode;
  /** Slides made by the caller (a concept's own wording); else built from `questions`. */
  slides?: TeachSlide[];
  teachLabel?: string;
  /** Who missed THESE questions: offers 'Retest' - the exact football problem
   *  back to them, no concept needed. The server re-checks who missed it. */
  retestTargets?: { player_id: number | null; player_name: string; display_name?: string }[];
  /** The concept this miss is about: offers 'Pick questions...' - your other
   *  quizzes' and Reps' questions on it, for a short targeted Rep. */
  conceptId?: number | null;
  /** SIMPLE ON THE SURFACE. 'all': Teach (and Retest) on the row, the rest -
   *  Make a rep, Pick questions, Open the play - behind "More". A problem card
   *  splits them: 'teach' beside its Retest, 'more' in its details. */
  show?: 'all' | 'teach' | 'more';
  /** Arrived from Home's "Teach" (?teach=<concept>): Teach opens straight away. */
  startTeaching?: boolean;
  /** WHO MISSED IT, one tap down (behind More): each name opens his profile. */
  missed?: { player_id: number | null; player_name: string; display_name?: string }[];
  /** The caller runs Teach itself (one screen that walks problem to problem). */
  onTeach?: () => void;
}) {
  const motionLab = useMayUseMotionLab();
  /** The Motion Lab play a missed question came from - the football source, one tap away. */
  const sourcePlay = questions.map((q) => q.motion_play_id ?? null).find((id): id is number => id !== null);
  /* PICK QUESTIONS - this miss's questions checked, the rest of what you have
     already written on the concept offered. One panel, no wizard. */
  const [picking, setPicking] = useState(false);
  /** 'all': the further actions are folded until the coach asks for them. */
  const [moreOpen, setMoreOpen] = useState(false);
  const [candidates, setCandidates] = useState<ConceptQuestion[] | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const go = useGoFromHere();
  const [teaching, setTeaching] = useState(startTeaching);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tappable = questions.filter((q) => q.question_type === 'multiple_choice' || q.question_type === 'true_false');
  /* A Rep made from a miss goes to the players who missed it - named by the
     caller, else the ones a retest of these questions would reach. */
  const repPlayers =
    playerIds.length > 0 ? playerIds : (retestTargets ?? []).map((p) => p.player_id).filter((id): id is number => id !== null);

  const [retesting, setRetesting] = useState(false);
  const retest = async () => {
    if (!retestTargets?.length) return;
    setRetesting(true);
    setError(null);
    try {
      go(await buildQuizRetest(quizId, { question_ids: questions.map((q) => q.id) }, retestTargets));
    } catch (err) {
      setError(getErrorMessage(err));
      setRetesting(false);
    }
  };

  /** One Rep from questions across quizzes: this quiz's first, then each other's, added. */
  const makeRepFrom = async (byQuiz: Map<number, number[]>) => {
    setMaking(true);
    setError(null);
    try {
      const [first, ...rest] = [...byQuiz.entries()].sort((a, b) => Number(b[0] === quizId) - Number(a[0] === quizId));
      const rep = await makeRepFromQuiz(first[0], first[1], repTitle);
      for (const [fromQuiz, ids] of rest) await addDecisions(rep.id, fromQuiz, ids);
      if (repPlayers.length > 0) await addRosterMembers(rep.id, repPlayers);
      go(`/reps/${rep.id}`);
    } catch (err) {
      setError(getErrorMessage(err));
      setMaking(false);
    }
  };
  const makeRep = () => makeRepFrom(new Map([[quizId, tappable.map((q) => q.id)]]));
  const openPicker = () => {
    setPicking((open) => !open);
    if (candidates || !conceptId) return;
    setChecked(tappable.map((q) => q.id));
    listConceptQuestions(conceptId)
      .then((list) =>
        setCandidates(list.filter((c) => c.question_type === 'multiple_choice' || c.question_type === 'true_false')),
      )
      .catch(() => setCandidates([]));
  };
  const makePicked = () => {
    const byQuiz = new Map<number, number[]>();
    for (const c of candidates ?? []) {
      if (checked.includes(c.question_id)) byQuiz.set(c.quiz_id, [...(byQuiz.get(c.quiz_id) ?? []), c.question_id]);
    }
    if (byQuiz.size > 0) void makeRepFrom(byQuiz);
  };

  if (questions.length === 0) return null;
  const repLabel = [
    tappable.length > 1 ? `Make a rep of all ${tappable.length}` : 'Make a rep',
    repPlayers.length > 0 ? `for the ${repPlayers.length}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const repButton = tappable.length > 0 && (
    <button type="button" className={styles.action} disabled={making} onClick={() => void makeRep()}>
      {making ? 'Making…' : repLabel}
    </button>
  );
  const retestButton = !!retestTargets?.length && (
    <button type="button" className={styles.action} disabled={retesting} onClick={() => void retest()}>
      {retesting ? 'Building…' : retestLabel(retestTargets.map((p) => p.display_name ?? p.player_name))}
    </button>
  );
  const teachPart = (
    <>
      <button type="button" className={styles.action} onClick={() => (onTeach ? onTeach() : setTeaching(true))}>
        {teachLabel}
      </button>
      {retestButton}
    </>
  );
  const hasMore = !!repButton || !!conceptId || (motionLab && sourcePlay !== undefined) || missed.length > 0;
  const morePart = (
    <>
      {missed.length > 0 && (
        <span className={styles.missed}>
          <span className={styles.pickerNote}>Who missed it:</span>{' '}
          {missed.map((p, i) => (
            <span key={p.player_id ?? `name:${p.player_name}`}>
              {i > 0 && ', '}
              {p.player_id !== null ? (
                <Link to={`/roster/${p.player_id}`} className={styles.link}>
                  {p.display_name ?? p.player_name}
                </Link>
              ) : (
                p.display_name ?? p.player_name
              )}
            </span>
          ))}
        </span>
      )}
      {repButton}
      {conceptId && tappable.length > 0 && (
        <button type="button" className={styles.link} aria-expanded={picking} onClick={openPicker}>
          Pick questions…
        </button>
      )}
      <SourcePlayLink playId={sourcePlay} className={styles.link} />
      {/* The concept into this week's install - by reference, nothing copied. */}
      {conceptId && <AddToInstall kind="concept" refId={conceptId} className={styles.link} />}
      {picking && (
        <span className={styles.picker} role="group" aria-label="Questions for the rep">
          {candidates === null ? (
            <span className={styles.pickerNote}>Finding what you have on it…</span>
          ) : (
            <>
              <span className={styles.pickerNote}>Check the ones for the rep:</span>
              {candidates.map((c) => (
                <label key={c.question_id} className={styles.pickerRow}>
                  <input
                    type="checkbox"
                    checked={checked.includes(c.question_id)}
                    onChange={(e) =>
                      setChecked((list) =>
                        e.target.checked ? [...list, c.question_id] : list.filter((id) => id !== c.question_id),
                      )
                    }
                  />
                  <span>
                    {c.question_text}
                    <span className={styles.pickerFrom}>
                      {' '}
                      · {c.quiz_id === quizId ? 'this quiz' : c.quiz_title}
                      {c.quiz_kind === 'REP' ? ' (rep)' : ''}
                    </span>
                  </span>
                </label>
              ))}
              <button
                type="button"
                className={styles.action}
                disabled={making || checked.length === 0}
                onClick={makePicked}
              >
                {making ? 'Making…' : `Make a rep of ${checked.length}`}
              </button>
            </>
          )}
        </span>
      )}
    </>
  );
  return (
    <span className={styles.actions}>
      {show !== 'more' && teachPart}
      {show === 'more' && morePart}
      {show === 'all' && hasMore && (
        <button
          type="button"
          className={styles.link}
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          {moreOpen ? 'Less' : 'More'}
        </button>
      )}
      {show === 'all' && moreOpen && morePart}
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
      {teaching && (
        <TeachView
          title={title}
          slides={slides ?? quizTeachSlides(questions, breakdown)}
          onClose={() => setTeaching(false)}
          /* WHO MISSED IT, on the teaching screen - of everyone who answered. */
          room={
            missed.length > 0
              ? {
                  missed: missed.length,
                  of: questions.length === 1 ? (breakdown?.find((r) => r.question_id === questions[0].id)?.answered_count ?? null) : null,
                  names: missed.map((p) => p.display_name ?? p.player_name),
                }
              : null
          }
          action={
            <>
              {extraAction}
              {retestButton}
              {repButton}
            </>
          }
        />
      )}
    </span>
  );
}
