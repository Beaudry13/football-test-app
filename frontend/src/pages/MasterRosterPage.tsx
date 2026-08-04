import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  createPlayer,
  deactivatePlayer,
  listPlayers,
  reactivatePlayer,
  type PlayerInput,
} from '../api/players';
import { getErrorMessage } from '../api/client';
import type { Player } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { RosterImportPanel } from '../components/RosterImportPanel';
import nb from '../styles/notebook.module.css';
import styles from './MasterRosterPage.module.css';

const EMPTY_FORM: PlayerInput = { first_name: '', last_name: '', jersey_number: '', position: '' };

export function MasterRosterPage() {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [positionFilter, setPositionFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState<PlayerInput>(EMPTY_FORM);
  const [isCreating, setIsCreating] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const { confirm, dialog } = useConfirmDialog();

  const load = useCallback(async () => {
    try {
      const result = await listPlayers({ active: showInactive ? 'all' : 'true' });
      setPlayers(result);
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

  const filtered = (players ?? []).filter((p) => {
    if (positionFilter && p.position !== positionFilter) return false;
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      if (!p.full_name.toLowerCase().includes(needle)) return false;
    }
    return true;
  });

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

        {players === null ? (
          <p>Loading…</p>
        ) : filtered.length === 0 ? (
          <div className={`${nb.card} ${nb.empty}`}>
            {players.length === 0
              ? 'No players yet. Add one above, or import a roster.'
              : 'No players match your search.'}
          </div>
        ) : (
          <table className={nb.table}>
            <thead>
              <tr>
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
                      <button className={nb.btnSm} onClick={() => handleDeactivate(player)}>
                        Deactivate
                      </button>
                    ) : (
                      <button className={nb.btnSm} onClick={() => handleReactivate(player)}>
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
