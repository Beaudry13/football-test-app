import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getOrgProgress } from '../api/players';
import { getErrorMessage } from '../api/client';
import type { OrgProgress, OrgRosterPlayerRow } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { PlayerAvatar } from '../components/PlayerAvatar';
import { formatDate, formatScore, trendArrow, trendLabel } from '../utils/playerAnalyticsDisplay';
import nb from '../styles/notebook.module.css';
import styles from './OrgProgressPage.module.css';

type ActiveFilter = 'true' | 'false' | 'all';
type ReviewFilter = 'all' | 'needs_review';
type SortOption = 'last_activity' | 'average_score' | 'completion' | 'name';

/** Coach-facing Player Progress overview: a handful of summary counts plus
 * one searchable/filterable/sortable roster table. Deliberately not a
 * large executive dashboard with charts - the point is helping a coach
 * quickly find the Players who need attention, per the product brief. */
export function OrgProgressPage() {
  const [data, setData] = useState<OrgProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [positionFilter, setPositionFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('true');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [sortBy, setSortBy] = useState<SortOption>('last_activity');

  const load = useCallback(async (active: ActiveFilter) => {
    try {
      const result = await getOrgProgress({ active });
      setData(result);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    load(activeFilter);
  }, [load, activeFilter]);

  const positionOptions = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.players.map((r) => r.player.position).filter(Boolean))).sort() as string[];
  }, [data]);

  const groupOptions = useMemo(() => {
    if (!data) return [];
    const names = new Set<string>();
    for (const row of data.players) {
      for (const g of row.current_groups) names.add(g.name);
    }
    return Array.from(names).sort();
  }, [data]);

  const filteredRows = useMemo(() => {
    if (!data) return [];
    let rows = data.players.filter((row) => {
      if (search.trim() && !row.player.full_name.toLowerCase().includes(search.trim().toLowerCase())) return false;
      if (positionFilter && row.player.position !== positionFilter) return false;
      if (groupFilter && !row.current_groups.some((g) => g.name === groupFilter)) return false;
      if (reviewFilter === 'needs_review' && !row.needs_review) return false;
      return true;
    });
    rows = [...rows];
    switch (sortBy) {
      case 'average_score':
        rows.sort((a, b) => (b.average_score_percent ?? -1) - (a.average_score_percent ?? -1));
        break;
      case 'completion':
        rows.sort((a, b) => (b.completion_percent ?? -1) - (a.completion_percent ?? -1));
        break;
      case 'name':
        rows.sort((a, b) => a.player.full_name.localeCompare(b.player.full_name));
        break;
      default:
        rows.sort((a, b) => {
          if (a.last_activity_at === b.last_activity_at) return 0;
          if (a.last_activity_at === null) return 1;
          if (b.last_activity_at === null) return -1;
          return b.last_activity_at.localeCompare(a.last_activity_at);
        });
        break;
    }
    return rows;
  }, [data, search, positionFilter, groupFilter, reviewFilter, sortBy]);

  return (
    <div>
      <h1 className={nb.heading}>Player Progress</h1>
      <p className={styles.subheading}>
        How every Player is doing over time - completion, average score, and who needs a look before game day.
      </p>

      <ErrorBanner message={error} />

      {data === null ? (
        <p>Loading…</p>
      ) : (
        <>
          <div className={styles.summaryGrid}>
            <div className={nb.card}>
              <div className={styles.summaryValue}>{data.summary.total_active_players}</div>
              <div className={styles.summaryLabel}>Active Players</div>
            </div>
            <div className={nb.card}>
              <div className={styles.summaryValue}>{data.summary.players_with_incomplete_assignments}</div>
              <div className={styles.summaryLabel}>Incomplete Assignments</div>
            </div>
            <div className={nb.card}>
              <div className={styles.summaryValue}>{data.summary.players_below_threshold}</div>
              <div className={styles.summaryLabel}>Needs Review</div>
            </div>
            <div className={nb.card}>
              <div className={styles.summaryValue}>{formatScore(data.summary.average_score_percent)}</div>
              <div className={styles.summaryLabel}>Org Average Score</div>
            </div>
            <div className={nb.card}>
              <div className={styles.summaryValue}>
                {data.summary.completion_rate !== null ? `${data.summary.completion_rate}%` : '—'}
              </div>
              <div className={styles.summaryLabel}>Completion Rate</div>
            </div>
            <div className={nb.card}>
              <div className={styles.summaryValue}>{data.summary.players_with_no_recent_activity}</div>
              <div className={styles.summaryLabel}>No Recent Activity</div>
            </div>
          </div>

          <div className={styles.toolbar}>
            <input
              className={nb.input}
              type="text"
              placeholder="Search players…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search players"
            />
            {positionOptions.length > 0 && (
              <select
                className={nb.input}
                value={positionFilter}
                onChange={(e) => setPositionFilter(e.target.value)}
                aria-label="Filter by position"
              >
                <option value="">All positions</option>
                {positionOptions.map((pos) => (
                  <option key={pos} value={pos}>
                    {pos}
                  </option>
                ))}
              </select>
            )}
            {groupOptions.length > 0 && (
              <select
                className={nb.input}
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
                aria-label="Filter by group"
              >
                <option value="">All groups</option>
                {groupOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <select
              className={nb.input}
              value={activeFilter}
              onChange={(e) => setActiveFilter(e.target.value as ActiveFilter)}
              aria-label="Filter by active status"
            >
              <option value="true">Active only</option>
              <option value="false">Inactive only</option>
              <option value="all">All Players</option>
            </select>
            <select
              className={nb.input}
              value={reviewFilter}
              onChange={(e) => setReviewFilter(e.target.value as ReviewFilter)}
              aria-label="Filter by review status"
            >
              <option value="all">All</option>
              <option value="needs_review">Needs Review only</option>
            </select>
            <select
              className={nb.input}
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              aria-label="Sort roster"
            >
              <option value="last_activity">Most recently active</option>
              <option value="average_score">Average score</option>
              <option value="completion">Completion rate</option>
              <option value="name">Name</option>
            </select>
          </div>

          {filteredRows.length === 0 ? (
            <div className={`${nb.card} ${nb.empty}`}>
              {data.players.length === 0 ? 'No Players found.' : 'No Players match this filter.'}
            </div>
          ) : (
            <table className={nb.table} aria-label="Player Progress roster">
              <thead>
                <tr>
                  <th></th>
                  <th>Player</th>
                  <th>Position</th>
                  <th>Assigned</th>
                  <th>Completed</th>
                  <th>Completion</th>
                  <th>Average score</th>
                  <th>Trend</th>
                  <th>Review</th>
                  <th>Last activity</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <OrgProgressRow key={row.player.id} row={row} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function OrgProgressRow({ row }: { row: OrgRosterPlayerRow }) {
  return (
    <tr>
      <td>
        <PlayerAvatar name={row.player.full_name} photoUrl={row.player.photo_url} size="sm" />
      </td>
      <td>
        {row.player.full_name}
        {row.player.jersey_number && <span className={styles.jersey}> #{row.player.jersey_number}</span>}
      </td>
      <td>{row.player.position ?? '—'}</td>
      <td>{row.assigned_count}</td>
      <td>{row.completed_count}</td>
      <td>{row.completion_percent !== null ? `${row.completion_percent}%` : '—'}</td>
      <td>{formatScore(row.average_score_percent)}</td>
      <td>
        {row.trend_direction ? (
          <span>
            {trendArrow(row.trend_direction)} {trendLabel(row.trend_direction)}
          </span>
        ) : (
          <span className={styles.noActivity}>No Recent Activity</span>
        )}
      </td>
      <td>
        {row.needs_review && <span className={`${nb.badge} ${nb.badgeWarning}`}>Needs Review</span>}
      </td>
      <td>{formatDate(row.last_activity_at)}</td>
      <td>
        <Link to={`/roster/${row.player.id}`}>Open Profile</Link>
      </td>
    </tr>
  );
}
