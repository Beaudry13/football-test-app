import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  createPlayer,
  deactivatePlayer,
  downloadPerformanceReport,
  listPlayers,
  reactivatePlayer,
  type PlayerInput,
} from '../api/players';
import { getErrorMessage } from '../api/client';
import type { Player } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { RosterImportPanel } from '../components/RosterImportPanel';
import { PlayerAvatar } from '../components/PlayerAvatar';
import { downloadBlob } from '../utils/download';
import nb from '../styles/notebook.module.css';
import styles from './MasterRosterPage.module.css';
import { LoadingState } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';

const EMPTY_FORM: PlayerInput = { first_name: '', last_name: '', jersey_number: '', position: '' };

export function MasterRosterPage() {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [positionFilter, setPositionFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState<PlayerInput>(EMPTY_FORM);
  const [isCreating, setIsCreating] = useState(false);
  const [searchParams] = useSearchParams();
  // `?import=1` arrives from the setup checklist's "Upload a roster" button.
  // Read once as the initial value rather than watched: the coach can close
  // the panel afterwards, and a live binding would fight them for it while
  // the parameter is still in the URL.
  const [showImport, setShowImport] = useState(() => searchParams.get('import') === '1');
  // Selection for the cumulative performance report. Ids rather than the
  // Player objects, so a reload or a filter change cannot leave a stale copy
  // of somebody's record selected.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);
  const { confirm, dialog } = useConfirmDialog();

  const load = useCallback(async () => {
    try {
      const result = await listPlayers({ active: showInactive ? 'all' : 'true' });
      setPlayers(result);
      // Selection is scoped to the players currently listed. Without this a
      // deactivated player stays selected while invisible: the count reports
      // somebody the coach cannot see, and the report quietly includes them.
      const listed = new Set(result.map((player) => player.id));
      setSelectedIds((prev) => {
        const kept = new Set([...prev].filter((id) => listed.has(id)));
        // Same Set when nothing was dropped, so this never causes a needless
        // re-render on an ordinary refresh.
        return kept.size === prev.size ? prev : kept;
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [showInactive]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!form.first_name.trim() && !form.last_name.trim()) return;
    setIsCreating(true);
    setError(null);
    try {
      await createPlayer(form);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleDeactivate(player: Player) {
    setError(null);
    try {
      await confirm({
        title: 'Deactivate Player?',
        body: `"${player.full_name}" will be hidden from active selection, but every past Quiz they've taken - scores, answers, results - stays exactly as it is. You can reactivate them anytime.`,
        confirmLabel: 'Deactivate',
        action: async () => {
          await deactivatePlayer(player.id);
          await load();
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleReactivate(player: Player) {
    setError(null);
    try {
      await reactivatePlayer(player.id);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  function toggleSelected(playerId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  }

  async function handleGenerateReport() {
    setIsGenerating(true);
    setError(null);
    try {
      // Ordered so the request is stable and cache-friendly; the PDF itself
      // is ordered by name on the server.
      const ids = [...selectedIds].sort((a, b) => a - b);
      const blob = await downloadPerformanceReport(ids);
      downloadBlob(blob, `performance-report-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsGenerating(false);
    }
  }

  const filtered = (players ?? []).filter((p) => {
    if (positionFilter && p.position !== positionFilter) return false;
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      if (!p.full_name.toLowerCase().includes(needle)) return false;
    }
    return true;
  });

  // Selection only ever covers what the coach can currently SEE - both here
  // and in `load`, which prunes anything that has left the list. Selecting
  // rows hidden behind a search or an inactive filter would put players in
  // the report who never appeared on screen, so the control says "shown".
  const visibleIds = filtered.map((p) => p.id);
  const selectedCount = selectedIds.size;
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id));

  function toggleAllVisible(checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  const positions = Array.from(new Set((players ?? []).map((p) => p.position).filter(Boolean))) as string[];

  return (
    <div>
      {dialog}
      <div className={styles.header}>
          <h1 className={nb.heading}>Master Roster</h1>
          <span className={nb.countBadge}>
            {(players ?? []).length} Player{(players ?? []).length === 1 ? '' : 's'}
          </span>
        </div>
        <p className={styles.subheading}>
          Every player exists here once. Groups and Quiz rosters select players from this list, so the
          same person's activity - across every Group they're in - always lands on one Player Profile.
        </p>

        <ErrorBanner message={error} />

        <div className={styles.toolbar}>
          <input
            className={nb.input}
            type="text"
            placeholder="Search players…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search players"
          />
          {positions.length > 0 && (
            <select
              className={nb.input}
              value={positionFilter}
              onChange={(e) => setPositionFilter(e.target.value)}
              aria-label="Filter by position"
            >
              <option value="">All positions</option>
              {positions.map((pos) => (
                <option key={pos} value={pos}>
                  {pos}
                </option>
              ))}
            </select>
          )}
          <label className={styles.inactiveToggle}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show inactive
          </label>
          <button className={nb.btnSm} onClick={() => setShowImport((v) => !v)}>
            {showImport ? 'Close import' : 'Import roster'}
          </button>
        </div>

        {showImport && (
          <RosterImportPanel
            onImported={() => {
              setShowImport(false);
              load();
            }}
          />
        )}

        <form className={styles.addForm} onSubmit={handleCreate}>
          <input
            className={nb.input}
            placeholder="First name"
            value={form.first_name}
            onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
            aria-label="New player first name"
          />
          <input
            className={nb.input}
            placeholder="Last name"
            value={form.last_name}
            onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))}
            aria-label="New player last name"
          />
          <input
            className={nb.input}
            placeholder="#"
            style={{ width: 70 }}
            value={form.jersey_number ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, jersey_number: e.target.value }))}
            aria-label="New player jersey number"
          />
          <input
            className={nb.input}
            placeholder="Pos"
            style={{ width: 90 }}
            value={form.position ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))}
            aria-label="New player position"
          />
          <button
            type="submit"
            className={nb.btnPrimary}
            disabled={isCreating || (!form.first_name.trim() && !form.last_name.trim())}
          >
            {isCreating ? 'Adding…' : 'Add Player'}
          </button>
        </form>

        {/* Selection bar. Only appears once there is a roster to select
            from - an empty roster has nothing to report on, and a permanent
            disabled toolbar is noise on the page a coach visits most. */}
        {filtered.length > 0 && (
          <div className={styles.reportBar}>
            <label className={styles.selectAll}>
              <input
                type="checkbox"
                checked={allVisibleSelected}
                // Some-but-not-all reads as indeterminate rather than as
                // "none selected", which is what an unchecked box claims.
                ref={(el) => {
                  if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected;
                }}
                onChange={(e) => toggleAllVisible(e.target.checked)}
                aria-label="Select all shown"
              />
              Select all shown
            </label>
            <span className={styles.selectedCount}>
              {selectedCount === 0
                ? 'No players selected'
                : `${selectedCount} selected`}
            </span>
            {selectedCount > 0 && (
              <button type="button" className={nb.btnSm} onClick={() => setSelectedIds(new Set())}>
                Clear all
              </button>
            )}
            <button
              type="button"
              className={nb.btnPrimary}
              onClick={handleGenerateReport}
              disabled={selectedCount === 0 || isGenerating}
            >
              {isGenerating ? 'Generating…' : 'Generate Performance Report'}
            </button>
          </div>
        )}

        {players === null ? (
          <LoadingState />
        ) : filtered.length === 0 ? (
          <EmptyState
            message={
              players.length === 0
                ? 'No players yet. Add one above, or import a roster.'
                : 'No players match your search.'
            }
          />
        ) : (
          <table className={nb.table}>
            <thead>
              <tr>
                <th></th>
                <th></th>
                <th>Player</th>
                <th>#</th>
                <th>Position</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((player) => (
                <tr key={player.id} className={player.is_active ? '' : styles.inactiveRow}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(player.id)}
                      onChange={() => toggleSelected(player.id)}
                      aria-label={`Select ${player.full_name}`}
                    />
                  </td>
                  <td>
                    <PlayerAvatar name={player.full_name} photoUrl={player.photo_url} size="sm" />
                  </td>
                  <td>
                    <Link to={`/roster/${player.id}`}>{player.full_name}</Link>
                  </td>
                  <td>{player.jersey_number ?? '—'}</td>
                  <td>{player.position ?? '—'}</td>
                  <td>
                    {player.is_active ? (
                      <span className={`${nb.badge} ${nb.badgeSuccess}`}>Active</span>
                    ) : (
                      <span className={`${nb.badge} ${nb.badgeNeutral}`}>Inactive</span>
                    )}
                  </td>
                  <td>
                    {player.is_active ? (
                      <button
                        className={nb.btnSm}
                        onClick={() => handleDeactivate(player)}
                        // Every row's button read simply "Deactivate", so a
                        // screen reader announced a column of identical
                        // controls with no way to tell whose row it was on.
                        aria-label={`Deactivate ${player.full_name}`}
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        className={nb.btnSm}
                        onClick={() => handleReactivate(player)}
                        aria-label={`Reactivate ${player.full_name}`}
                      >
                        Reactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}
