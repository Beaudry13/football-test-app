import { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '../api/client';
import type { RosterPlayer } from '../api/types';
import { ErrorBanner } from './ErrorBanner';
import { useConfirmDialog } from './ConfirmDialog';
import nb from '../styles/notebook.module.css';
import styles from './PlayerListEditor.module.css';

interface PlayerListLike {
  players: RosterPlayer[];
}

interface PlayerListEditorProps {
  /** Fetches the current player list. Wrap in `useCallback` keyed on the
   * owning entity's id, the same way effect deps normally work. */
  load: () => Promise<PlayerListLike>;
  onSave: (names: string[]) => Promise<PlayerListLike>;
  onUploadCsv: (file: File) => Promise<PlayerListLike>;
  /** Whether the free-text name box is offered.
   *
   *  False on the modern surfaces. A name typed here becomes a roster row
   *  with no canonical Player, and an attempt made through one is invisible
   *  to the player profile and the cumulative report - so the coach is no
   *  longer offered a way to create them. CSV import stays: it now resolves
   *  every row to a master-roster Player (see services/player_matching), so
   *  it is a canonical workflow rather than a legacy one.
   *
   *  Still true where legacy names already exist, so they can be read and
   *  removed. Nothing is deleted or migrated. */
  allowNameEntry?: boolean;
  currentListTitle?: string;
  editTitle?: string;
  saveButtonLabel?: string;
}

/** Two-panel player-list editor (current list + bulk textarea + CSV upload)
 * shared by the per-quiz Roster tab and the coach-wide Group editor - both
 * are otherwise identical "one name per line, save replaces the whole
 * list" UIs over different backing entities.
 *
 * Legacy (free-text, `player_id`-less) entries only - this is the editor
 * for the pre-master-roster name list. Canonical, master-roster-linked
 * entries (`player` present) are excluded here and shown/managed instead
 * by the sibling PlayerPickerPanel, which is rendered alongside this one.
 * Mixing the two in one textarea would let a coach accidentally re-add a
 * canonical player's name as a second, legacy, player_id-less row - see
 * groups.py::_replace_group_players for the backend half of this split. */
export function PlayerListEditor({
  load,
  onSave,
  onUploadCsv,
  allowNameEntry = true,
  currentListTitle = 'Current roster',
  editTitle = 'Edit roster',
  saveButtonLabel = 'Save roster',
}: PlayerListEditorProps) {
  const [players, setPlayers] = useState<RosterPlayer[]>([]);
  const [namesText, setNamesText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [filterText, setFilterText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { confirm, dialog } = useConfirmDialog();

  const doLoad = useCallback(async () => {
    try {
      const result = await load();
      const legacy = result.players.filter((p) => !p.player);
      setPlayers(legacy);
      setNamesText(legacy.map((p) => p.player_name).join('\n'));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [load]);

  useEffect(() => {
    doLoad();
  }, [doLoad]);

  async function handleSaveManual() {
    const names = namesText
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length === 0) {
      setError('Add at least one player name.');
      return;
    }

    // Only prompt when the save would actually *drop* someone - a save that's
    // pure additions/edits shouldn't force a confirmation nobody needs.
    const lowerNames = new Set(names.map((n) => n.toLowerCase()));
    const removedNames = players.filter((p) => !lowerNames.has(p.player_name.toLowerCase()));
    if (removedNames.length > 0) {
      const count = removedNames.length;
      const list = removedNames.map((p) => p.player_name).join(', ');
      const confirmed = await confirm({
        title: `Remove ${count} Player${count === 1 ? '' : 's'}?`,
        body: `Saving drops ${count === 1 ? 'this player' : 'these players'}, no longer in the list: ${list}.`,
        confirmLabel: `Remove and Save`,
      });
      if (!confirmed) return;
    }

    setError(null);
    setIsSaving(true);
    try {
      const result = await onSave(names);
      setPlayers(result.players.filter((p) => !p.player));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCsvUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    setIsSaving(true);
    try {
      const result = await onUploadCsv(file);
      const legacy = result.players.filter((p) => !p.player);
      setPlayers(legacy);
      setNamesText(legacy.map((p) => p.player_name).join('\n'));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSaving(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  const filteredPlayers = filterText.trim()
    ? players.filter((p) => p.player_name.toLowerCase().includes(filterText.trim().toLowerCase()))
    : players;

  return (
    <div>
      {dialog}
      <ErrorBanner message={error} />
      <div className={styles.layout}>
        <div className={nb.card}>
          <h2 className={nb.subheading}>
            {currentListTitle} ({players.length})
          </h2>
          {players.length === 0 ? (
            <div className={nb.empty}>No players yet. Add names in the box on the right.</div>
          ) : (
            <>
              {players.length > 8 && (
                <input
                  className={nb.input}
                  type="text"
                  placeholder="Search players…"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  aria-label="Search players"
                />
              )}
              {filteredPlayers.length === 0 ? (
                <div className={nb.empty}>No players match "{filterText.trim()}".</div>
              ) : (
                <ul className={styles.playerList}>
                  {filteredPlayers.map((player) => (
                    <li key={player.id}>{player.player_name}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div className={nb.card}>
          <h2 className={nb.subheading}>{editTitle}</h2>
          {allowNameEntry ? (
            <>
              <p>One player name per line. Saving replaces the full list.</p>
              <textarea
                className={styles.textarea}
                value={namesText}
                onChange={(e) => setNamesText(e.target.value)}
              />
            </>
          ) : (
            <p>
              Upload a CSV of player names. Each row is matched to a player on your Master
              Roster, and anyone new is added to it.
            </p>
          )}
          <div className={styles.hint}>
            {allowNameEntry && (
              <>
                <button className={nb.btnSm} onClick={handleSaveManual} disabled={isSaving}>
                  {isSaving ? 'Saving…' : saveButtonLabel}
                </button>{' '}
              </>
            )}
            <label className={nb.btnSm} style={{ cursor: 'pointer' }}>
              Upload CSV
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                hidden
                onChange={handleCsvUpload}
                disabled={isSaving}
              />
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
