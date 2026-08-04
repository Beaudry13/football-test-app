import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  deactivatePlayer,
  getPlayerHistory,
  reactivatePlayer,
  updatePlayer,
  uploadPlayerPhoto,
} from '../api/players';
import { getErrorMessage } from '../api/client';
import type { PlayerHistory } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { PlayerAvatar } from '../components/PlayerAvatar';
import nb from '../styles/notebook.module.css';
import styles from './PlayerProfilePage.module.css';

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

            {history.current_groups.length > 0 && (
              <p className={styles.groupsLine}>
                Groups: {history.current_groups.map((g) => g.name).join(', ')}
              </p>
            )}

            <div className={styles.statsGrid}>
              <div className={nb.card}>
                <div className={styles.statValue}>{history.assigned_count}</div>
                <div className={styles.statLabel}>Assigned</div>
              </div>
              <div className={nb.card}>
                <div className={styles.statValue}>{history.completed_count}</div>
                <div className={styles.statLabel}>Completed</div>
              </div>
              <div className={nb.card}>
                <div className={styles.statValue}>
                  {history.completion_percent !== null ? `${history.completion_percent}%` : '—'}
                </div>
                <div className={styles.statLabel}>Completion rate</div>
              </div>
              <div className={nb.card}>
                <div className={styles.statValue}>
                  {history.average_score_percent !== null ? `${history.average_score_percent}%` : '—'}
                </div>
                <div className={styles.statLabel}>Average score</div>
              </div>
            </div>

            <h2 className={nb.subheading}>Recent Results</h2>
            {history.recent_results.length === 0 ? (
              <div className={`${nb.card} ${nb.empty}`}>No completed Quizzes yet.</div>
            ) : (
              <table className={nb.table}>
                <thead>
                  <tr>
                    <th>Quiz</th>
                    <th>Date</th>
                    <th>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {history.recent_results.map((result) => (
                    <tr key={result.attempt_id}>
                      <td>
                        <Link to={`/quizzes/${result.quiz_id}?tab=results`}>{result.quiz_title}</Link>
                      </td>
                      <td>{result.submitted_at ? new Date(result.submitted_at).toLocaleDateString() : '—'}</td>
                      <td>
                        {result.score_percent !== null ? `${result.score_percent}%` : '—'}
                        {result.pending_grading_count > 0 && (
                          <span className={`${nb.badge} ${nb.badgeWarning}`} style={{ marginLeft: '0.5em' }}>
                            {result.pending_grading_count} to grade
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
    </div>
  );
}
