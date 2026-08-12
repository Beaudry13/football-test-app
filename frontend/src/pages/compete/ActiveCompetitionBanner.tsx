/**
 * "You have a competition running - go back to it."
 *
 * WHY THIS EXISTS
 * ----------------
 * A coach runs the lobby from a laptop in front of a room. They close the tab,
 * or the browser restarts, or they open Peira on a different machine. Nothing
 * in that new tab knows the join code, and asking a coach to remember a
 * six-character code while thirty players wait is not a recovery plan.
 *
 * THE SERVER IS THE SOURCE OF TRUTH. This asks `/competition/active`, which
 * answers from session rows scoped to this coach's organization. It reads no
 * storage of any kind, so a brand-new browser recovers exactly as well as a
 * refreshed one.
 *
 * DELIBERATELY NOT A HISTORY LIST. Only live sessions appear, and the only
 * action is to return to one. Ending, editing, and browsing past competitions
 * are not this component's job.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import * as competitionApi from '../../api/competition';
import type { ActiveCompetition } from '../../api/competition';
import styles from './ActiveCompetitionBanner.module.css';

export function ActiveCompetitionBanner({ quizId }: { quizId?: number }) {
  const [active, setActive] = useState<ActiveCompetition[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sessions = await competitionApi.getActiveCompetitions();
        if (!cancelled) setActive(sessions);
      } catch {
        // A coach who cannot reach this endpoint still has a working
        // dashboard. Recovery is an affordance, not a prerequisite - it must
        // never break the page it sits on.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetched once, not polled: this is a recovery affordance on a page the
  // coach is passing through, not a live view of the room.
  const relevant = quizId ? active.filter((entry) => entry.quiz_id === quizId) : active;
  if (relevant.length === 0) return null;

  return (
    <>
      {relevant.map((entry) => (
        <div key={entry.id} className={styles.banner}>
          <div className={styles.pulse} aria-hidden="true" />
          <div className={styles.text}>
            <div className={styles.title}>Competition in progress</div>
            <div className={styles.detail}>
              {entry.quiz_title ?? 'Competition'} ·{' '}
              {entry.participant_count === 1
                ? '1 player joined'
                : `${entry.participant_count} players joined`}
            </div>
          </div>
          <Link className={styles.action} to={`/compete/${entry.join_code}/host`}>
            Return to competition →
          </Link>
        </div>
      ))}
    </>
  );
}

export default ActiveCompetitionBanner;
