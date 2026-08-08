import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  getOrganization,
  listOrganizationQuizzes,
  transferQuizOwner,
} from '../../api/organizations';
import type { OrganizationQuiz } from '../../api/organizations';
import type { OrganizationMember } from '../../api/types';
import { getErrorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { EmptyState } from '../../components/ui/EmptyState';
import nb from '../../styles/notebook.module.css';
import styles from './AdminQuizzesPage.module.css';

/** ADMIN VIEW. Every quiz in the organization, and who owns each one.
 *
 * Deliberately not a wider version of the dashboard. There is no "New Quiz"
 * box and no folder tree, because this screen answers different questions:
 * whose is this, who has what, and what belongs to nobody. Creating and
 * organising quizzes stays in Coach View, where a coach works on their own.
 *
 * Coach View remains the default everywhere - this is reachable only by
 * navigating here, and going back to /dashboard is immediately own-only again.
 */
export function AdminQuizzesPage() {
  const { coach } = useAuth();
  const [quizzes, setQuizzes] = useState<OrganizationQuiz[] | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [coachFilter, setCoachFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setQuizzes(
        await listOrganizationQuizzes({
          coachId: coachFilter === '' ? null : coachFilter === 'unassigned' ? 'unassigned' : Number(coachFilter),
          search: search.trim() || undefined,
        }),
      );
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [coachFilter, search]);

  useEffect(() => {
    getOrganization()
      .then((org) => setMembers(org.members ?? []))
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  useEffect(() => {
    // Debounced so typing in the search box does not fire a request per
    // keystroke - unlike the dashboard, this search runs server-side.
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const unassignedCount = useMemo(
    () => (quizzes ?? []).filter((q) => q.is_unassigned).length,
    [quizzes],
  );

  async function handleAssign(quiz: OrganizationQuiz, coachId: number) {
    setAssigningId(quiz.id);
    setError(null);
    try {
      await transferQuizOwner(quiz.id, coachId);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setAssigningId(null);
    }
  }

  // Enforced on the server too - this only avoids rendering a screen whose
  // every request would 403.
  if (coach && coach.role !== 'admin') return <Navigate to="/dashboard" replace />;

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={nb.heading}>Admin View</h1>
          <p className={nb.subheading}>
            Every quiz in {coach?.organization ?? 'your organization'}, and who owns it.
          </p>
        </div>
        <Link to="/dashboard" className={nb.btnSecondary}>
          Back to my quizzes
        </Link>
      </div>

      <div className={styles.controls}>
        <label className={nb.srOnly} htmlFor="admin-search">
          Search all quizzes
        </label>
        <input
          id="admin-search"
          className={nb.input}
          placeholder="Search all quizzes…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label className={nb.srOnly} htmlFor="admin-coach-filter">
          Filter by coach
        </label>
        <select
          id="admin-coach-filter"
          className={nb.input}
          value={coachFilter}
          onChange={(event) => setCoachFilter(event.target.value)}
        >
          <option value="">All coaches</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.username}
            </option>
          ))}
          <option value="unassigned">Unassigned</option>
        </select>
      </div>

      <ErrorBanner message={error} />

      {unassignedCount > 0 && coachFilter !== 'unassigned' && (
        <div className={styles.notice} role="status">
          {unassignedCount} {unassignedCount === 1 ? 'quiz has' : 'quizzes have'} no owner. Nobody
          sees {unassignedCount === 1 ? 'it' : 'them'} in their own quiz list until you assign
          {unassignedCount === 1 ? ' it' : ' them'}.
        </div>
      )}

      {quizzes === null ? (
        <LoadingState label="Loading organization quizzes" />
      ) : quizzes.length === 0 ? (
        <EmptyState message="No quizzes match this filter." />
      ) : (
        <ul className={styles.list}>
          {quizzes.map((quiz) => (
            <li
              key={quiz.id}
              className={`${nb.card} ${styles.row} ${quiz.is_unassigned ? styles.rowUnassigned : ''}`}
            >
              <div className={styles.rowMain}>
                <Link to={`/quizzes/${quiz.id}`} className={styles.rowTitle}>
                  {quiz.title}
                </Link>
                <div className={styles.rowMeta}>
                  {quiz.is_unassigned ? (
                    <span className={styles.unassignedTag}>Unassigned</span>
                  ) : (
                    <span className={styles.ownerTag}>{quiz.owner?.username}</span>
                  )}
                  <span>
                    {quiz.question_count} {quiz.question_count === 1 ? 'question' : 'questions'}
                  </span>
                </div>
              </div>

              <div className={styles.rowActions}>
                <label className={nb.srOnly} htmlFor={`assign-${quiz.id}`}>
                  Assign owner for {quiz.title}
                </label>
                <select
                  id={`assign-${quiz.id}`}
                  className={nb.input}
                  disabled={assigningId === quiz.id}
                  value=""
                  onChange={(event) =>
                    event.target.value && handleAssign(quiz, Number(event.target.value))
                  }
                >
                  <option value="">
                    {quiz.is_unassigned ? 'Assign owner…' : 'Reassign…'}
                  </option>
                  {members
                    .filter((member) => member.id !== quiz.owner?.id)
                    .map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.username}
                      </option>
                    ))}
                </select>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
