import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listOwnerOrganizations } from '../../api/owner';
import { getErrorMessage } from '../../api/client';
import type { OwnerOrganizationRow } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { count, exactTime, relativeDay, shortDate } from './ownerFormat';
import styles from './Owner.module.css';

type SortKey = keyof Pick<
  OwnerOrganizationRow,
  | 'name'
  | 'coaches'
  | 'active_players'
  | 'quizzes'
  | 'graded_attempts'
  | 'practice_attempts'
  | 'last_activity'
  | 'created_at'
>;

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'name', label: 'Organization' },
  { key: 'coaches', label: 'Coaches', numeric: true },
  { key: 'active_players', label: 'Active players', numeric: true },
  { key: 'quizzes', label: 'Quizzes', numeric: true },
  { key: 'graded_attempts', label: 'Graded', numeric: true },
  { key: 'practice_attempts', label: 'Practice', numeric: true },
  { key: 'last_activity', label: 'Last activity' },
  { key: 'created_at', label: 'Created' },
];

/** Sorts nulls LAST regardless of direction.
 *
 * An organization with no activity is not "the oldest" - it is unknown, and
 * burying it under a descending sort would be as misleading as printing a
 * date for it. Same reason the cell renders an em dash. */
function compare(a: OwnerOrganizationRow, b: OwnerOrganizationRow, key: SortKey): number {
  const left = a[key];
  const right = b[key];
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

/** Every organization on the platform, with its usage rolled up.
 *
 * Search and the Empty filter run server-side so their definitions live with
 * the metrics; sorting runs here because it is presentation. */
export function OwnerOrganizationsPage() {
  const [rows, setRows] = useState<OwnerOrganizationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [emptyOnly, setEmptyOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('last_activity');
  const [ascending, setAscending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listOwnerOrganizations({
      search: search || undefined,
      filter: emptyOnly ? 'empty' : undefined,
    })
      .then((result) => {
        if (!cancelled) setRows(result.organizations);
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [search, emptyOnly]);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const copy = [...rows];
    copy.sort((a, b) => (ascending ? compare(a, b, sortKey) : compare(b, a, sortKey)));
    return copy;
  }, [rows, sortKey, ascending]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setAscending((value) => !value);
    } else {
      setSortKey(key);
      setAscending(key === 'name');
    }
  }

  return (
    <div>
      <ErrorBanner message={error} />

      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="search"
          placeholder="Search organizations"
          aria-label="Search organizations"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          type="button"
          className={`${styles.toggle} ${emptyOnly ? styles.toggleActive : ''}`}
          aria-pressed={emptyOnly}
          onClick={() => setEmptyOnly((value) => !value)}
          title="No players, no quizzes and no attempts. Derived from data, not from the name."
        >
          Empty only
        </button>
        {sorted && <span className={styles.resultCount}>{count(sorted.length)} shown</span>}
      </div>

      {!sorted ? (
        <LoadingState />
      ) : sorted.length === 0 ? (
        <div className={styles.tableWrap}>
          <p className={styles.empty}>No organizations match.</p>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column.key} className={column.numeric ? styles.num : undefined}>
                    <button
                      type="button"
                      className={styles.sortButton}
                      onClick={() => toggleSort(column.key)}
                    >
                      {column.label}
                      {sortKey === column.key ? (ascending ? ' ▲' : ' ▼') : ''}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((org) => (
                <tr key={org.id}>
                  <td>
                    <Link className={styles.orgLink} to={`/owner/organizations/${org.id}`}>
                      {org.name}
                    </Link>{' '}
                    {org.is_empty && (
                      <span
                        className={`${styles.tag} ${styles.tagEmpty}`}
                        title="No players, quizzes or attempts"
                      >
                        Empty
                      </span>
                    )}
                  </td>
                  <td className={styles.num}>{count(org.coaches)}</td>
                  <td className={styles.num}>{count(org.active_players)}</td>
                  <td className={styles.num}>{count(org.quizzes)}</td>
                  <td className={styles.num}>{count(org.graded_attempts)}</td>
                  <td className={styles.num}>{count(org.practice_attempts)}</td>
                  <td
                    className={org.last_activity ? undefined : styles.unknown}
                    title={exactTime(org.last_activity)}
                  >
                    {relativeDay(org.last_activity)}
                  </td>
                  <td title={exactTime(org.created_at)}>{shortDate(org.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.sectionNote} style={{ marginTop: 12 }}>
        <strong>Empty</strong> is derived from data &mdash; zero players, zero quizzes and zero
        attempts &mdash; never from the organization&rsquo;s name. Nothing on this dashboard deletes
        anything.
      </p>
    </div>
  );
}
