import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  deactivatePlayer,
  getPlayerHistory,
  reactivatePlayer,
  updatePlayer,
  uploadPlayerPhoto,
} from '../api/players';
import { getErrorMessage } from '../api/client';
import type { ComparisonStats, PlayerHistory, PlayerHistoryRow } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { PlayerAvatar } from '../components/PlayerAvatar';
import { TrendSparkline } from '../components/TrendSparkline';
import {
  formatDate,
  formatScore,
  reviewStatusBadgeVariant,
  reviewStatusLabel,
} from '../utils/playerAnalyticsDisplay';
import nb from '../styles/notebook.module.css';
import styles from './PlayerProfilePage.module.css';

type StatusFilter = 'all' | 'completed' | 'incomplete' | 'needs_review';
type SortOption = 'recent' | 'oldest' | 'highest' | 'lowest';

const DIRECT_ROSTER_FILTER = '__direct__';
const RECENT_PERFORMANCE_LIMIT = 8;

function rowSourceLabel(row: PlayerHistoryRow): string {
  return row.group_source.length > 0 ? row.group_source.map((g) => g.name).join(', ') : 'Direct roster';
}

function ComparisonRow({ label, stats }: { label: string; stats: ComparisonStats }) {
  return (
    <tr>
      <td>{label}</td>
      <td>{formatScore(stats.average_score_percent)}</td>
      <td>
        {stats.sufficient_data ? (
          `${stats.player_count} players`
        ) : (
          <span className={`${nb.badge} ${nb.badgeNeutral}`}>
            Not enough data yet ({stats.player_count} player{stats.player_count === 1 ? '' : 's'})
          </span>
        )}
      </td>
    </tr>
  );
}

export function PlayerProfilePage() {
  const { playerId } = useParams<{ playerId: string }>();
  const id = Number(playerId);
  const [history, setHistory] = useState<PlayerHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({ first_name: '', last_name: '', jersey_number: '', position: '' });
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const { confirm, dialog } = useConfirmDialog();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [groupFilter, setGroupFilter] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('recent');

  const load = useCallback(async () => {
    try {
      const data = await getPlayerHistory(id);
      setHistory(data);
      setEditForm({
        first_name: data.player.first_name,
        last_name: data.player.last_name,
        jersey_number: data.player.jersey_number ?? '',
        position: data.player.position ?? '',
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSaveEdit() {
    setIsSaving(true);
    setError(null);
    try {
      await updatePlayer(id, editForm);
      setIsEditing(false);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeactivate() {
    if (!history) return;
    try {
      await confirm({
        title: 'Deactivate Player?',
        body: `"${history.player.full_name}" will be hidden from active selection. Their history stays exactly as it is.`,
        confirmLabel: 'Deactivate',
        action: async () => {
          await deactivatePlayer(id);
          await load();
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleReactivate() {
    try {
      await reactivatePlayer(id);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handlePhotoSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    setIsUploadingPhoto(true);
    try {
      await uploadPlayerPhoto(id, file);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsUploadingPhoto(false);
    }
  }

  const groupOptions = useMemo(() => {
    if (!history) return [];
    const names = new Set<string>();
    for (const row of history.history) {
      for (const g of row.group_source) names.add(g.name);
    }
    return Array.from(names).sort();
  }, [history]);

  const filteredHistory = useMemo(() => {
    if (!history) return [];
    let rows = history.history.filter((row) => {
      if (statusFilter === 'completed' && row.completion_status !== 'completed') return false;
      if (statusFilter === 'incomplete' && row.completion_status !== 'incomplete') return false;
      if (statusFilter === 'needs_review' && row.review_status !== 'needs_review') return false;
      if (groupFilter === DIRECT_ROSTER_FILTER && row.group_source.length > 0) return false;
      if (groupFilter && groupFilter !== DIRECT_ROSTER_FILTER && !row.group_source.some((g) => g.name === groupFilter))
        return false;
      return true;
    });
    rows = [...rows];
    switch (sortBy) {
      case 'oldest':
        rows.reverse();
        break;
      case 'highest':
        rows.sort((a, b) => (b.score_percent ?? -1) - (a.score_percent ?? -1));
        break;
      case 'lowest':
        rows.sort((a, b) => (a.score_percent ?? 101) - (b.score_percent ?? 101));
        break;
      default:
        // history is already most-recent-first
        break;
    }
    return rows;
  }, [history, statusFilter, groupFilter, sortBy]);

  return (
    <div>
      {dialog}
      <Link to="/roster" className={styles.backLink}>
        ← Master Roster
      </Link>

      <ErrorBanner message={error} />

      {history === null ? (
        <p>Loading…</p>
      ) : (
        <>
          <div className={styles.headerRow}>
            <div className={styles.identity}>
              <div className={styles.photoColumn}>
                <PlayerAvatar name={history.player.full_name} photoUrl={history.player.photo_url} size="lg" />
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className={styles.hiddenFileInput}
                  onChange={handlePhotoSelected}
                  aria-label="Upload player photo"
                />
                <button
                  className={nb.btnSm}
                  onClick={() => photoInputRef.current?.click()}
                  disabled={isUploadingPhoto}
                >
                  {isUploadingPhoto ? 'Uploading…' : history.player.photo_url ? 'Replace photo' : 'Add photo'}
                </button>
              </div>
              <div>
                <h1 className={nb.heading}>{history.player.full_name}</h1>
                <p className={styles.subheading}>
                  {history.player.jersey_number && <>#{history.player.jersey_number} · </>}
                  {history.player.position ?? 'No position set'}
                  {!history.player.is_active && (
                    <>
                      {' '}
                      · <span className={`${nb.badge} ${nb.badgeNeutral}`}>Inactive</span>
                    </>
                  )}
                </p>
              </div>
            </div>
            <div className={styles.headerActions}>
              <button className={nb.btnSm} onClick={() => setIsEditing((v) => !v)}>
                {isEditing ? 'Cancel' : 'Edit'}
              </button>
              {history.player.is_active ? (
                <button className={nb.btnSm} onClick={handleDeactivate}>
                  Deactivate
                </button>
              ) : (
                <button className={nb.btnSm} onClick={handleReactivate}>
                  Reactivate
                </button>
              )}
            </div>
          </div>

          {isEditing && (
            <div className={`${nb.card} ${styles.editForm}`}>
              <input
                className={nb.input}
                placeholder="First name"
                value={editForm.first_name}
                onChange={(e) => setEditForm((f) => ({ ...f, first_name: e.target.value }))}
              />
              <input
                className={nb.input}
                placeholder="Last name"
                value={editForm.last_name}
                onChange={(e) => setEditForm((f) => ({ ...f, last_name: e.target.value }))}
              />
              <input
                className={nb.input}
                placeholder="#"
                style={{ width: 70 }}
                value={editForm.jersey_number}
                onChange={(e) => setEditForm((f) => ({ ...f, jersey_number: e.target.value }))}
              />
              <input
                className={nb.input}
                placeholder="Position"
                style={{ width: 90 }}
                value={editForm.position}
                onChange={(e) => setEditForm((f) => ({ ...f, position: e.target.value }))}
              />
              <button className={nb.btnPrimary} onClick={handleSaveEdit} disabled={isSaving}>
                {isSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}

          {history.summary.current_groups.length > 0 && (
            <p className={styles.groupsLine}>
              Groups: {history.summary.current_groups.map((g) => g.name).join(', ')}
            </p>
          )}

          {/* --- Summary --- */}
          <div className={styles.statsGrid}>
            <div className={nb.card}>
              <div className={styles.statValue}>{history.summary.assigned_count}</div>
              <div className={styles.statLabel}>Assigned</div>
            </div>
            <div className={nb.card}>
              <div className={styles.statValue}>{history.summary.completed_count}</div>
              <div className={styles.statLabel}>Completed</div>
            </div>
            <div className={nb.card}>
              <div className={styles.statValue}>
                {history.summary.completion_percent !== null ? `${history.summary.completion_percent}%` : '—'}
              </div>
              <div className={styles.statLabel}>Completion rate</div>
            </div>
            <div className={nb.card}>
              <div className={styles.statValue}>{formatScore(history.summary.average_score_percent)}</div>
              <div className={styles.statLabel}>Average score</div>
            </div>
            <div className={nb.card}>
              <div className={styles.statValue}>{history.summary.below_threshold_count}</div>
              <div className={styles.statLabel}>Needs Review</div>
            </div>
            <div className={nb.card}>
              <div className={styles.statValue}>{formatDate(history.summary.last_completed_at)}</div>
              <div className={styles.statLabel}>Last completed quiz</div>
            </div>
          </div>

          {/* --- Trend --- */}
          <h2 className={nb.subheading}>Score Trend</h2>
          {history.trend.available ? (
            <div className={`${nb.card} ${styles.trendCard}`}>
              <TrendSparkline trend={history.trend} />
            </div>
          ) : (
            <div className={`${nb.card} ${nb.empty}`}>
              Not enough completed, graded quizzes yet to show a trend - at least 2 are needed.
            </div>
          )}

          {/* --- Recent Performance --- */}
          <h2 className={nb.subheading}>Recent Performance</h2>
          {history.history.length === 0 ? (
            <div className={`${nb.card} ${nb.empty}`}>No completed Quizzes yet.</div>
          ) : (
            <table className={nb.table} aria-label="Recent Performance">
              <thead>
                <tr>
                  <th>Quiz</th>
                  <th>Date</th>
                  <th>Score</th>
                  <th>Source</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.history.slice(0, RECENT_PERFORMANCE_LIMIT).map((row) => (
                  <tr key={row.attempt_id}>
                    <td>
                      <Link to={`/quizzes/${row.quiz_id}?tab=results`}>{row.quiz_title}</Link>
                    </td>
                    <td>{formatDate(row.submitted_at ?? row.started_at)}</td>
                    <td>{formatScore(row.score_percent)}</td>
                    <td>{rowSourceLabel(row)}</td>
                    <td>
                      <span className={`${nb.badge} ${nb[reviewStatusBadgeVariant(row.review_status)]}`}>
                        {row.completion_status === 'incomplete' ? 'Incomplete' : reviewStatusLabel(row.review_status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* --- Full History --- */}
          <h2 className={nb.subheading}>Quiz History</h2>
          {history.history.length === 0 ? (
            <div className={`${nb.card} ${nb.empty}`}>No Quiz history yet.</div>
          ) : (
            <>
              <div className={styles.toolbar}>
                <select
                  className={nb.input}
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                  aria-label="Filter by status"
                >
                  <option value="all">All</option>
                  <option value="completed">Completed</option>
                  <option value="incomplete">Incomplete</option>
                  <option value="needs_review">Needs Review</option>
                </select>
                {groupOptions.length > 0 && (
                  <select
                    className={nb.input}
                    value={groupFilter}
                    onChange={(e) => setGroupFilter(e.target.value)}
                    aria-label="Filter by group"
                  >
                    <option value="">All groups &amp; roster</option>
                    <option value={DIRECT_ROSTER_FILTER}>Direct roster only</option>
                    {groupOptions.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                )}
                <select
                  className={nb.input}
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortOption)}
                  aria-label="Sort history"
                >
                  <option value="recent">Most recent</option>
                  <option value="oldest">Oldest</option>
                  <option value="highest">Highest score</option>
                  <option value="lowest">Lowest score</option>
                </select>
              </div>

              {filteredHistory.length === 0 ? (
                <div className={`${nb.card} ${nb.empty}`}>No Quizzes match this filter.</div>
              ) : (
                <table className={nb.table} aria-label="Quiz History">
                  <thead>
                    <tr>
                      <th>Quiz</th>
                      <th>Started</th>
                      <th>Completed</th>
                      <th>Score</th>
                      <th>Completion</th>
                      <th>Source</th>
                      <th>Review</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHistory.map((row) => (
                      <tr key={row.attempt_id}>
                        <td>{row.quiz_title}</td>
                        <td>{formatDate(row.started_at)}</td>
                        <td>{formatDate(row.submitted_at)}</td>
                        <td>{formatScore(row.score_percent)}</td>
                        <td>
                          <span
                            className={`${nb.badge} ${row.completion_status === 'completed' ? nb.badgeSuccess : nb.badgeNeutral}`}
                          >
                            {row.completion_status === 'completed' ? 'Completed' : 'Incomplete'}
                          </span>
                        </td>
                        <td>{rowSourceLabel(row)}</td>
                        <td>
                          {row.review_status && (
                            <span className={`${nb.badge} ${nb[reviewStatusBadgeVariant(row.review_status)]}`}>
                              {reviewStatusLabel(row.review_status)}
                            </span>
                          )}
                        </td>
                        <td>
                          {row.completion_status === 'completed' && (
                            <Link to={`/quizzes/${row.quiz_id}?tab=results`}>View Results</Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {/* --- Areas to Review --- */}
          <h2 className={nb.subheading}>Areas to Review</h2>
          {history.missed_questions.length === 0 ? (
            <div className={`${nb.card} ${nb.empty}`}>
              No missed questions on record - either no Quizzes are complete yet, or every graded answer so far
              has been correct.
            </div>
          ) : (
            <table className={nb.table} aria-label="Areas to Review">
              <thead>
                <tr>
                  <th>Quiz</th>
                  <th>Question</th>
                  <th>Times missed</th>
                </tr>
              </thead>
              <tbody>
                {history.missed_questions.map((mq) => (
                  <tr key={mq.question_id}>
                    <td>
                      <Link to={`/quizzes/${mq.quiz_id}?tab=results`}>{mq.quiz_title}</Link>
                    </td>
                    <td>
                      #{mq.question_number}: {mq.question_preview}
                    </td>
                    <td>{mq.miss_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* --- Comparisons --- */}
          <h2 className={nb.subheading}>How {history.player.first_name} Compares</h2>
          <table className={nb.table} aria-label="Comparisons">
            <thead>
              <tr>
                <th></th>
                <th>Average score</th>
                <th>Sample size</th>
              </tr>
            </thead>
            <tbody>
              <ComparisonRow label={history.player.full_name} stats={history.comparisons.player} />
              {history.comparisons.groups.map((g) => (
                <ComparisonRow key={g.group_id} label={g.group_name} stats={g} />
              ))}
              {history.comparisons.position && (
                <ComparisonRow
                  label={`${history.comparisons.position.position} (position)`}
                  stats={history.comparisons.position}
                />
              )}
              <ComparisonRow label="Organization" stats={history.comparisons.organization} />
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
