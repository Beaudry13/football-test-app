import { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '../api/client';
import type { RosterPlayer } from '../api/types';
import { ErrorBanner } from './ErrorBanner';
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
  currentListTitle?: string;
  editTitle?: string;
  saveButtonLabel?: string;
}

/** Two-panel player-list editor (current list + bulk textarea + CSV upload)
 * shared by the per-quiz Roster tab and the coach-wide Group editor - both
 * are otherwise identical "one name per line, save replaces the whole
 * list" UIs over different backing entities. */
export function PlayerListEditor({
  load,
  onSave,
  onUploadCsv,
  currentListTitle = 'Current roster',
  editTitle = 'Edit roster',
  saveButtonLabel = 'Save roster',
}: PlayerListEditorProps) {
  const [players, setPlayers] = useState<RosterPlayer[]>([]);
  const [namesText, setNamesText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const doLoad = useCallback(async () => {
    try {
      const result = await load();
      setPlayers(result.players);
      setNamesText(result.players.map((p) => p.player_name).join('\n'));
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
    setError(null);
    setIsSaving(true);
    try {
      const result = await onSave(names);
      setPlayers(result.players);
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
      setPlayers(result.players);
      setNamesText(result.players.map((p) => p.player_name).join('\n'));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSaving(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div>
      <ErrorBanner message={error} />
      <div className={styles.layout}>
        <div className={nb.card}>
          <h3 className={nb.subheading}>
            {currentListTitle} ({players.length})
          </h3>
          {players.length === 0 ? (
            <p>No players yet.</p>
          ) : (
            <ul className={styles.playerList}>
              {players.map((player) => (
                <li key={player.id}>{player.player_name}</li>
              ))}
            </ul>
          )}
        </div>

        <div className={nb.card}>
          <h3 className={nb.subheading}>{editTitle}</h3>
          <p>One player name per line. Saving replaces the full list.</p>
          <textarea
            className={styles.textarea}
            value={namesText}
            onChange={(e) => setNamesText(e.target.value)}
          />
          <div className={styles.hint}>
            <button className={nb.btnSm} onClick={handleSaveManual} disabled={isSaving}>
              {isSaving ? 'Saving…' : saveButtonLabel}
            </button>{' '}
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
