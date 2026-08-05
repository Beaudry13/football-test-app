import { useEffect, useMemo, useState } from 'react';
import { listPlayers } from '../api/players';
import { getErrorMessage } from '../api/client';
import type { Player, RosterPlayer } from '../api/types';
import { ErrorBanner } from './ErrorBanner';
import { PlayerAvatar } from './PlayerAvatar';
import nb from '../styles/notebook.module.css';
import styles from './RosterSelectPanel.module.css';
import { LoadingState } from './ui/LoadingState';

type ViewFilter = 'all' | 'not_in_group' | 'in_group';

function sortRoster(players: Player[]): Player[] {
  return [...players].sort((a, b) => {
    const jerseyA = a.jersey_number ? Number(a.jersey_number) : null;
    const jerseyB = b.jersey_number ? Number(b.jersey_number) : null;
    const aHasJersey = jerseyA !== null && !Number.isNaN(jerseyA);
    const bHasJersey = jerseyB !== null && !Number.isNaN(jerseyB);
    if (aHasJersey && bHasJersey && jerseyA !== jerseyB) return jerseyA! - jerseyB!;
    if (aHasJersey !== bHasJersey) return aHasJersey ? -1 : 1;
    const lastCompare = a.last_name.localeCompare(b.last_name);
    if (lastCompare !== 0) return lastCompare;
    return a.first_name.localeCompare(b.first_name);
  });
}

/** A full, browsable Master Roster picker for adding canonical Players to a
 * Group - the visual-scan alternative to search-only selection, so a coach
 * working through a real roster doesn't have to already know every name to
 * type. Group membership itself is unchanged from PlayerPickerPanel's model
 * (player_id-linked GroupPlayer rows); this only changes how a coach finds
 * and selects who to add. */
export function RosterSelectPanel({
  members,
  onAddMany,
  onRemove,
}: {
  /** The Group's current player list (both legacy and canonical rows) -
   * this panel only concerns itself with the canonical (`player` present)
   * ones, same split PlayerPickerPanel and PlayerListEditor already use. */
  members: RosterPlayer[];
  onAddMany: (playerIds: number[]) => Promise<void>;
  onRemove: (playerId: number) => Promise<void>;
}) {
  const [allPlayers, setAllPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [positionFilter, setPositionFilter] = useState('');
  const [viewFilter, setViewFilter] = useState<ViewFilter>('all');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isAdding, setIsAdding] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);

  useEffect(() => {
    listPlayers({ active: 'true' })
      .then((players) => setAllPlayers(sortRoster(players)))
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  const memberIds = useMemo(
    () => new Set(members.filter((p): p is RosterPlayer & { player: Player } => p.player !== undefined).map((p) => p.player.id)),
    [members],
  );

  const positions = useMemo(
    () => Array.from(new Set((allPlayers ?? []).map((p) => p.position).filter(Boolean))).sort() as string[],
    [allPlayers],
  );

  const visiblePlayers = useMemo(() => {
    const players = allPlayers ?? [];
    const needle = search.trim().toLowerCase();
    return players.filter((p) => {
      if (needle && !p.full_name.toLowerCase().includes(needle)) return false;
      if (positionFilter && p.position !== positionFilter) return false;
      const isMember = memberIds.has(p.id);
      if (viewFilter === 'not_in_group' && isMember) return false;
      if (viewFilter === 'in_group' && !isMember) return false;
      return true;
    });
  }, [allPlayers, search, positionFilter, viewFilter, memberIds]);

  function toggleSelected(playerId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  }

  function handleSelectAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const p of visiblePlayers) {
        if (!memberIds.has(p.id)) next.add(p.id);
      }
      return next;
    });
  }

  function handleClearSelection() {
    setSelectedIds(new Set());
  }

  async function handleAddSelected() {
    if (selectedIds.size === 0) return;
    setError(null);
    setIsAdding(true);
    try {
      await onAddMany(Array.from(selectedIds));
      setSelectedIds(new Set());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsAdding(false);
    }
  }

  async function handleRemove(playerId: number) {
    setError(null);
    setRemovingId(playerId);
    try {
      await onRemove(playerId);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setRemovingId(null);
    }
  }

  const masterRosterCount = allPlayers?.length ?? 0;
  const inGroupCount = memberIds.size;
  const availableCount = Math.max(masterRosterCount - inGroupCount, 0);

  return (
    <div className={nb.card}>
      <h2 className={nb.subheading}>Add Players from Master Roster</h2>
      <ErrorBanner message={error} />

      <div className={styles.summaryRow}>
        <span data-testid="stat-master-roster">
          Master Roster: <strong>{masterRosterCount}</strong> Player{masterRosterCount === 1 ? '' : 's'}
        </span>
        <span data-testid="stat-in-group">
          In This Group: <strong>{inGroupCount}</strong>
        </span>
        <span data-testid="stat-available">
          Available: <strong>{availableCount}</strong>
        </span>
      </div>

      <div className={styles.controlsRow}>
        <input
          className={nb.input}
          type="text"
          placeholder="Search players…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search Players"
        />
        <select
          className={nb.input}
          value={positionFilter}
          onChange={(e) => setPositionFilter(e.target.value)}
          aria-label="Position filter"
        >
          <option value="">All positions</option>
          {positions.map((pos) => (
            <option key={pos} value={pos}>
              {pos}
            </option>
          ))}
        </select>
        <div className={styles.viewFilter} role="group" aria-label="View filter">
          <button
            type="button"
            className={`${nb.btnSm} ${viewFilter === 'all' ? styles.viewFilterActive : ''}`}
            onClick={() => setViewFilter('all')}
          >
            All Players
          </button>
          <button
            type="button"
            className={`${nb.btnSm} ${viewFilter === 'not_in_group' ? styles.viewFilterActive : ''}`}
            onClick={() => setViewFilter('not_in_group')}
          >
            Not In Group
          </button>
          <button
            type="button"
            className={`${nb.btnSm} ${viewFilter === 'in_group' ? styles.viewFilterActive : ''}`}
            onClick={() => setViewFilter('in_group')}
          >
            Already In Group
          </button>
        </div>
      </div>

      <div className={styles.selectionRow}>
        <span className={styles.selectedCount} data-testid="stat-selected">
          Selected: <strong>{selectedIds.size}</strong> Player{selectedIds.size === 1 ? '' : 's'}
        </span>
        <div className={styles.selectionButtons}>
          <button type="button" className={nb.btnSm} onClick={handleSelectAllVisible} disabled={visiblePlayers.length === 0}>
            Select All Visible
          </button>
          <button type="button" className={nb.btnSm} onClick={handleClearSelection} disabled={selectedIds.size === 0}>
            Clear Selection
          </button>
          <button
            type="button"
            className={nb.btnPrimary}
            onClick={handleAddSelected}
            disabled={selectedIds.size === 0 || isAdding}
          >
            {isAdding ? 'Adding…' : 'Add Selected Players'}
          </button>
        </div>
      </div>

      {allPlayers === null ? (
        <LoadingState />
      ) : visiblePlayers.length === 0 ? (
        <div className={nb.empty}>No players match your search and filters.</div>
      ) : (
        <div className={styles.rosterScroll}>
          <table className={nb.table}>
            <thead>
              <tr>
                <th></th>
                <th></th>
                <th>Player</th>
                <th>#</th>
                <th>Position</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visiblePlayers.map((player) => {
                const isMember = memberIds.has(player.id);
                return (
                  <tr key={player.id} className={isMember ? styles.memberRow : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={isMember || selectedIds.has(player.id)}
                        disabled={isMember}
                        onChange={() => toggleSelected(player.id)}
                        aria-label={`Select ${player.full_name}`}
                      />
                    </td>
                    <td>
                      <PlayerAvatar name={player.full_name} photoUrl={player.photo_url} size="sm" />
                    </td>
                    <td>{player.full_name}</td>
                    <td>{player.jersey_number ? `#${player.jersey_number}` : '—'}</td>
                    <td>{player.position ?? '—'}</td>
                    <td>
                      {isMember ? (
                        <div className={styles.memberActions}>
                          <span className={`${nb.badge} ${nb.badgeNeutral}`}>Already in Group</span>
                          <button
                            type="button"
                            className={nb.btnSm}
                            onClick={() => handleRemove(player.id)}
                            disabled={removingId === player.id}
                          >
                            {removingId === player.id ? 'Removing…' : 'Remove'}
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
