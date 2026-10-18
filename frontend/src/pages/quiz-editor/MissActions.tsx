import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { getErrorMessage } from '../../api/client';
import { makeRepFromQuiz } from '../../api/reps';
import { createRetest } from '../../api/retests';
import { addRosterMembers } from '../../api/roster';
import type { Question, QuestionBreakdown } from '../../api/types';
import { TeachView, type TeachSlide } from '../../components/teach/TeachView';
import { quizTeachSlides } from './quizTeach';
import styles from './MissActions.module.css';

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
  retestTargets?: { player_id: number | null; player_name: string }[];
}) {
  const navigate = useNavigate();
  const [teaching, setTeaching] = useState(false);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tappable = questions.filter((q) => q.question_type === 'multiple_choice' || q.question_type === 'true_false');

  const [retesting, setRetesting] = useState(false);
  const retest = async () => {
    if (!retestTargets?.length) return;
    setRetesting(true);
    setError(null);
    try {
      const draft = await createRetest(quizId, {
        question_ids: questions.map((q) => q.id),
        player_ids: retestTargets.map((p) => p.player_id).filter((id): id is number => id !== null),
        player_names: retestTargets.filter((p) => p.player_id === null).map((p) => p.player_name),
      });
      navigate(`/quizzes/${draft.id}?tab=questions`);
    } catch (err) {
      setError(getErrorMessage(err));
      setRetesting(false);
    }
  };

  const makeRep = async () => {
    setMaking(true);
    setError(null);
    try {
      const rep = await makeRepFromQuiz(quizId, tappable.map((q) => q.id), repTitle);
      if (playerIds.length > 0) await addRosterMembers(rep.id, playerIds);
      navigate(`/reps/${rep.id}`);
    } catch (err) {
      setError(getErrorMessage(err));
      setMaking(false);
    }
  };

  if (questions.length === 0) return null;
  const repButton = tappable.length > 0 && (
    <button type="button" className={styles.action} disabled={making} onClick={() => void makeRep()}>
      {making ? 'Making…' : playerIds.length > 0 ? `Make a rep for the ${playerIds.length}` : 'Make rep'}
    </button>
  );
  const retestButton = !!retestTargets?.length && (
    <button type="button" className={styles.action} disabled={retesting} onClick={() => void retest()}>
      {retesting ? 'Building…' : retestTargets.length === 1 ? 'Retest the 1' : `Retest the ${retestTargets.length}`}
    </button>
  );
  return (
    <span className={styles.actions}>
      <button type="button" className={styles.action} onClick={() => setTeaching(true)}>
        {teachLabel}
      </button>
      {retestButton}
      {repButton}
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
