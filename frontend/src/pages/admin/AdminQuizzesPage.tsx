import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  getOrganization,
  listOrganizationQuizzes,
  transferQuizOwner,
} from '../../api/organizations';
import type { OrganizationQuiz } from '../../api/organizations';
import type { Folder, OrganizationMember } from '../../api/types';
import { getErrorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { EmptyState } from '../../components/ui/EmptyState';
import { FolderTree } from './FolderTree';
import { allFolderIds, buildTree, filterTree, quizMatchesSearch } from './adminTree';
import nb from '../../styles/notebook.module.css';
import styles from './AdminQuizzesPage.module.css';

const EXPANDED_KEY = 'peira.admin.expandedFolders';

/** ADMIN VIEW. The organization as a folder tree.
 *
 * Deliberately not a wider version of the dashboard, and deliberately not a
 * flat list of every quiz: an organization with hundreds of them is unreadable
 * that way. Top-level folders start collapsed and the admin opens what they
 * need.
 *
 * ONE REQUEST. Folders and quizzes arrive together and the tree, its counts,
 * the coach filter and search are all computed locally - so expanding a branch
 * costs nothing and typing in search does not hit the network. See
 * listOrganizationQuizzes.
 *
 * Coach View is untouched by any of this and remains the default: this page is
 * reachable only by navigating to it.
 */
export function AdminQuizzesPage() {
  const { coach } = useAuth();
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [quizzes, setQuizzes] = useState<OrganizationQuiz[]>([]);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [coachFilter, setCoachFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<number | null>(null);

  // Session-scoped, so re-opening the page mid-session lands where the admin
  // left off, but a fresh session starts collapsed as the default demands.
  const [expanded, setExpanded] = useState<Set<number | null>>(() => {
    try {
      const stored = sessionStorage.getItem(EXPANDED_KEY);
      return stored ? new Set(JSON.parse(stored) as Array<number | null>) : new Set();
    } catch {
      return new Set();
    }
  });

  const load = useCallback(async () => {
    try {
      setError(null);
      const tree = await listOrganizationQuizzes();
      setFolders(tree.folders);
      setQuizzes(tree.quizzes);
    } catch (err) {
      setError(getErrorMessage(err));
      setFolders([]);
    }
  }, []);

  useEffect(() => {
    void load();
    getOrganization()
      .then((org) => setMembers(org.members ?? []))
      .catch((err) => setError(getErrorMessage(err)));
  }, [load]);

  useEffect(() => {
    try {
      sessionStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
    } catch {
      // A full or disabled sessionStorage must not break the page - losing
      // the expansion memory is the whole cost.
    }
  }, [expanded]);

  const fullTree = useMemo(() => buildTree(folders ?? [], quizzes), [folders, quizzes]);

  const searching = search.trim().length > 0;
  const filtering = searching || coachFilter !== '';
  const visibleTree = useMemo(() => {
    const coachId = coachFilter === '' ? null : coachFilter;
    if (!coachId && !searching) return fullTree;

    return filterTree(fullTree, (quiz) => {
      const byCoach =
        !coachId ||
        (coachId === 'unassigned'
          ? quiz.is_unassigned
          : quiz.owner?.id === Number(coachId));
      return byCoach && quizMatchesSearch(quiz, search);
    });
  }, [fullTree, coachFilter, search, searching]);

  // Any active filter reveals the path to whatever survived it, rather than
  // switching to a flat result list with breadcrumbs: the tree already
  // communicates location, and changing layout mid-interaction makes the admin
  // re-orient every time.
  //
  // This covers the COACH FILTER as well as search. Narrowing to one coach and
  // then being handed a collapsed "2026 Season" answers the wrong question -
  // the reason to filter by coach is to see where their work actually sits.
  const effectiveExpanded = useMemo(
    () => (filtering ? new Set(allFolderIds(visibleTree)) : expanded),
    [filtering, visibleTree, expanded],
  );

  function toggle(id: number | null) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  const unassignedCount = quizzes.filter((q) => q.is_unassigned).length;

  // Enforced on the server too - this only avoids rendering a screen whose
  // every request would 403.
  if (coach && coach.role !== 'admin') return <Navigate to="/dashboard" replace />;

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={nb.heading}>Admin View</h1>
          <p className={nb.subheading}>
            {coach?.organization ?? 'Your organization'} · {quizzes.length}{' '}
            {quizzes.length === 1 ? 'quiz' : 'quizzes'} across {folders?.length ?? 0}{' '}
            {folders?.length === 1 ? 'folder' : 'folders'}
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
        {filtering && (
          <button
            type="button"
            className={nb.btnSm}
            onClick={() => {
              setSearch('');
              setCoachFilter('');
            }}
          >
            Clear
          </button>
        )}
      </div>

      <ErrorBanner message={error} />

      {unassignedCount > 0 && coachFilter !== 'unassigned' && (
        <div className={styles.notice}>
          {unassignedCount} {unassignedCount === 1 ? 'quiz has' : 'quizzes have'} no owner. Nobody
          sees {unassignedCount === 1 ? 'it' : 'them'} in their own quiz list until you assign
          {unassignedCount === 1 ? ' it' : ' them'}.
        </div>
      )}

      {folders === null ? (
        <LoadingState label="Loading organization quizzes" />
      ) : visibleTree.length === 0 ? (
        <EmptyState
          message={
            filtering
              ? 'No quizzes match this filter.'
              : 'This organization has no quizzes yet.'
          }
        />
      ) : (
        <div className={styles.tree}>
          <FolderTree
            nodes={visibleTree}
            expanded={effectiveExpanded}
            onToggle={toggle}
            members={members}
            onAssign={handleAssign}
            assigningId={assigningId}
          />
        </div>
      )}
    </div>
  );
}
