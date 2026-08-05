import { useCallback, useEffect, useState } from 'react';
import { listPlayers } from '../api/players';
import { getErrorMessage } from '../api/client';
import type { Player, RosterPlayer } from '../api/types';
import { ErrorBanner } from './ErrorBanner';
import { PlayerAvatar } from './PlayerAvatar';
import nb from '../styles/notebook.module.css';
import styles from './PlayerPickerPanel.module.css';

interface PlayerListLike {
  players: RosterPlayer[];
}

interface PlayerPickerPanelProps {
  /** Fetches the current player list - same shape/convention as
   * PlayerListEditor's `load`, since both editors read the same
   * Group/Roster `players` array and simply act on disjoint rows within it
   * (legacy name-only vs. canonical player_id-linked - see
   * groups.py::_replace_group_players). */
  load: () => Promise<PlayerListLike>;
  onAdd: (playerId: number) => Promise<PlayerListLike>;
  onRemove: (playerId: number) => Promise<void>;
}

const SEARCH_DEBOUNCE_MS = 300;

function optionLabel(player: Player): string {
  const tag = [player.jersey_number ? `#${player.jersey_number}` : null, player.position]
    .filter(Boolean)
    .join(' · ');
  return tag ? `${player.full_name} (${tag})` : player.full_name;
}

/** Lets a coach attach/detach canonical master-roster Players (by id) to a
 * Group or a quiz's direct Roster - the picker counterpart to
 * PlayerListEditor's legacy whole-list-of-names textarea. The two are meant
 * to be rendered side by side: this one only ever touches player_id-linked
 * rows, so it can't step on anything the legacy editor owns. */
export function PlayerPickerPanel({ load, onAdd, onRemove }: PlayerPickerPanelProps) {
  const [players, setPlayers] = useState<RosterPlayer[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Player[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);

  const doLoad = useCallback(async () => {
    try {
      const result = await load();
      setPlayers(result.players);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [load]);

  useEffect(() => {
    doLoad();
  }, [doLoad]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      setIsSearching(true);
      try {
        setResults(await listPlayers({ q: query.trim() }));
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setIsSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const canonicalMembers = players.filter(
    (p): p is RosterPlayer & { player: Player } => p.player !== undefined,
  );
  const memberIds = new Set(canonicalMembers.map((p) => p.player.id));
  const visibleResults = results.filter((p) => !memberIds.has(p.id));

  async function handleAdd(playerId: number) {
    setError(null);
    setPendingId(playerId);
    try {
      const result = await onAdd(playerId);
      setPlayers(result.players);
      setQuery('');
      setResults([]);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setPendingId(null);
    }
  }

  async function handleRemove(playerId: number) {
    setError(null);
    setPendingId(playerId);
    try {
      await onRemove(playerId);
      setPlayers((prev) => prev.filter((p) => p.player?.id !== playerId));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className={nb.card}>
      <h2 className={nb.subheading}>Master Roster players ({canonicalMembers.length})</h2>
      <p>
        Add players from the org's master roster - their stats and history stay unified across every
        group and quiz they're on.
      </p>
      <ErrorBanner message={error} />
      {canonicalMembers.length > 0 && (
        <ul className={styles.memberList}>
          {canonicalMembers.map((entry) => (
            <li key={entry.player.id}>
              <span className={styles.playerLabel}>
                <PlayerAvatar name={entry.player.full_name} photoUrl={entry.player.photo_url} size="sm" />
                {optionLabel(entry.player)}
              </span>
              <button
                className={nb.btnSm}
                onClick={() => handleRemove(entry.player.id)}
                disabled={pendingId === entry.player.id}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.searchRow}>
        <input
          className={nb.input}
          type="text"
          placeholder="Search master roster by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search master roster"
        />
        {isSearching && <span className={styles.searching}>Searching…</span>}
      </div>
      {query.trim() &&
        !isSearching &&
        (visibleResults.length === 0 ? (
          <div className={nb.empty}>No matching active players{memberIds.size > 0 ? ' left to add' : ''}.</div>
        ) : (
          <ul className={styles.resultList}>
            {visibleResults.map((player) => (
              <li key={player.id}>
                <span className={styles.playerLabel}>
                  <PlayerAvatar name={player.full_name} photoUrl={player.photo_url} size="sm" />
                  {optionLabel(player)}
                </span>
                <button className={nb.btnSm} onClick={() => handleAdd(player.id)} disabled={pendingId === player.id}>
                  Add
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
