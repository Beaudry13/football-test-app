/**
 * Competition setup: the last screen before a room is gathered.
 *
 * Its most important job is REFUSING clearly. A quiz containing a Written or
 * Draw Response question cannot be scored live, and the coach has to learn
 * that here - while they can still edit the quiz - rather than in front of a
 * room. So the blockers are listed by position and reason, and the launch
 * button is disabled rather than hidden: a missing button raises "where is
 * it", a disabled one with a reason answers the question.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ApiError } from '../../api/client';
import * as competitionApi from '../../api/competition';
import type { CompetitionReadiness } from '../../api/competition';
import { listGroups } from '../../api/groups';
import type { Group } from '../../api/types';
import { getQuiz } from '../../api/quizzes';
import type { Quiz } from '../../api/types';
import { ActiveCompetitionBanner } from './ActiveCompetitionBanner';
import { CompetitionShell } from './CompetitionShell';
import styles from './Competition.module.css';

const QUESTION_TIME_CHOICES = [10, 20, 30, 45, 60];

type Scope = 'roster' | 'group';

export function CompetitionSetupPage() {
  const { quizId } = useParams<{ quizId: string }>();
  const navigate = useNavigate();
  const id = Number(quizId);

  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [readiness, setReadiness] = useState<CompetitionReadiness | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [scope, setScope] = useState<Scope>('roster');
  const [groupId, setGroupId] = useState<number | null>(null);
  const [questionTime, setQuestionTime] = useState(20);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loadedQuiz, loadedReadiness, loadedGroups] = await Promise.all([
          getQuiz(id),
          competitionApi.getReadiness(id),
          listGroups().catch(() => [] as Group[]),
        ]);
        if (cancelled) return;
        setQuiz(loadedQuiz);
        setReadiness(loadedReadiness);
        setGroups(loadedGroups);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load this quiz.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const session = await competitionApi.createSession(id, {
        // A group scope with nothing chosen sends no ids at all, which the
        // server reads as the whole roster - the same result the coach sees
        // described on screen, rather than an empty competition.
        group_ids: scope === 'group' && groupId ? [groupId] : [],
        question_time_seconds: questionTime,
      });
      navigate(`/compete/${session.join_code}/host`, { state: { sessionId: session.id } });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not start the competition. Please try again.',
      );
      setStarting(false);
    }
  }, [id, scope, groupId, questionTime, navigate]);

  if (loading) {
    return (
      <CompetitionShell>
        <p className={styles.subhead}>Loading…</p>
      </CompetitionShell>
    );
  }

  const blockers = readiness?.unsupported_questions ?? [];
  const canLaunch = readiness?.can_launch === true;

  return (
    <CompetitionShell>
      {/* The most valuable placement: a coach who lost the tab comes back
          HERE to start another, and would otherwise open a second lobby while
          the first is still live with players in it. */}
      <ActiveCompetitionBanner />

      <h1 className={styles.headline}>{quiz?.title ?? 'Competition'}</h1>
      <p className={styles.subhead}>
        A live, head-to-head round of this quiz. Players join from their phones with a code.
      </p>

      {error && (
        <div className={`${styles.notice} ${styles.noticeError}`} role="alert" style={{ marginTop: '1rem' }}>
          {error}
        </div>
      )}

      {blockers.length > 0 && (
        <div className={`${styles.notice} ${styles.noticeWarn}`} style={{ marginTop: '1.5rem' }}>
          <strong>This quiz can’t run as a competition yet.</strong>
          <p style={{ margin: '0.5rem 0 0' }}>
            Competition scores instantly, so every question has to be Multiple Choice or True/False.
            {' '}
            {blockers.length === 1 ? 'One question' : `${blockers.length} questions`} would need a
            coach to grade {blockers.length === 1 ? 'it' : 'them'}:
          </p>
          <ul className={styles.blockerList}>
            {blockers.map((blocker) => (
              <li key={blocker.question_id}>
                <strong>Question {blocker.position}</strong> — {blocker.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {readiness?.question_count === 0 && (
        <div className={`${styles.notice} ${styles.noticeWarn}`} style={{ marginTop: '1.5rem' }}>
          Add at least one question before starting a competition.
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Who can join</div>
        <div className={styles.radioRow}>
          <label className={styles.radioOption}>
            <input
              type="radio"
              name="scope"
              checked={scope === 'roster'}
              onChange={() => setScope('roster')}
            />
            <span>Whole roster</span>
          </label>
          <label className={styles.radioOption}>
            <input
              type="radio"
              name="scope"
              checked={scope === 'group'}
              onChange={() => setScope('group')}
              disabled={groups.length === 0}
            />
            <span>
              One group
              {groups.length === 0 && (
                <span className={styles.takenTag} style={{ marginLeft: '0.5rem' }}>
                  no groups yet
                </span>
              )}
            </span>
          </label>
        </div>

        {scope === 'group' && groups.length > 0 && (
          <div className={styles.field} style={{ marginTop: '0.75rem' }}>
            <label className={styles.fieldLabel} htmlFor="competition-group">
              Group
            </label>
            <select
              id="competition-group"
              className={styles.select}
              value={groupId ?? ''}
              onChange={(event) => setGroupId(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">Choose a group…</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className={styles.section}>
        {/* The backend stores this at session creation, so it is set here even
            though the rounds it governs arrive in M2. */}
        <div className={styles.sectionTitle}>Seconds per question</div>
        <div className={styles.field}>
          <select
            className={styles.select}
            aria-label="Seconds per question"
            value={questionTime}
            onChange={(event) => setQuestionTime(Number(event.target.value))}
          >
            {QUESTION_TIME_CHOICES.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds} seconds
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          onClick={start}
          disabled={!canLaunch || starting || (scope === 'group' && !groupId)}
        >
          {starting ? 'Opening the room…' : 'Start Competition'}
        </button>
        <button type="button" className={styles.button} onClick={() => navigate(`/quizzes/${id}`)}>
          Back to quiz
        </button>
      </div>
    </CompetitionShell>
  );
}

export default CompetitionSetupPage;
