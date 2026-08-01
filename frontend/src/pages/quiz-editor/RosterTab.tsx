import { useCallback, useEffect, useRef, useState } from 'react';
import { getRoster, setRoster, uploadRosterCsv } from '../../api/roster';
import { getErrorMessage } from '../../api/client';
import type { Quiz, RosterPlayer } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import styles from './RosterTab.module.css';

export function RosterTab({ quiz }: { quiz: Quiz }) {
  const [players, setPlayers] = useState<RosterPlayer[]>([]);
  const [namesText, setNamesText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const roster = await getRoster(quiz.id);
      setPlayers(roster.players);
      setNamesText(roster.players.map((p) => p.player_name).join('\n'));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [quiz.id]);

  useEffect(() => {
    load();
  }, [load]);

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
      const roster = await setRoster(quiz.id, names);
      setPlayers(roster.players);
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
      const roster = await uploadRosterCsv(quiz.id, file);
      setPlayers(roster.players);
      setNamesText(roster.players.map((p) => p.player_name).join('\n'));
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
        <div className="card">
          <h3>Current roster ({players.length})</h3>
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

        <div className="card">
          <h3>Edit roster</h3>
          <p>One player name per line. Saving replaces the full roster.</p>
          <textarea
            className={styles.textarea}
            value={namesText}
            onChange={(e) => setNamesText(e.target.value)}
          />
          <div className={styles.hint}>
            <button className="btn btn-primary btn-sm" onClick={handleSaveManual} disabled={isSaving}>
              {isSaving ? 'Saving…' : 'Save roster'}
            </button>{' '}
            <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
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
