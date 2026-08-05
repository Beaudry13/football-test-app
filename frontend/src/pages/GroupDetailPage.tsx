import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteGroup,
  getGroup,
  renameGroup,
  setGroupPlayers,
  uploadGroupPlayersCsv,
} from '../api/groups';
import { addGroupMembers, removeGroupMember } from '../api/players';
import { getErrorMessage } from '../api/client';
import type { Group } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { PlayerListEditor } from '../components/PlayerListEditor';
import { RosterSelectPanel } from '../components/RosterSelectPanel';
import nb from '../styles/notebook.module.css';
import styles from './GroupDetailPage.module.css';
import { LoadingState } from '../components/ui/LoadingState';

export function GroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const [group, setGroup] = useState<Group | null>(null);
  const [nameValue, setNameValue] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLegacy, setShowLegacy] = useState(false);
  const { confirm, dialog } = useConfirmDialog();

  const loadGroup = useCallback(async () => {
    if (!groupId) return;
    try {
      const loaded = await getGroup(Number(groupId));
      setGroup(loaded);
      setNameValue(loaded.name);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [groupId]);

  useEffect(() => {
    loadGroup();
  }, [loadGroup]);

  const load = useCallback(() => getGroup(Number(groupId)), [groupId]);
  const onSave = useCallback((names: string[]) => setGroupPlayers(Number(groupId), names), [groupId]);
  const onUploadCsv = useCallback(
    (file: File) => uploadGroupPlayersCsv(Number(groupId), file),
    [groupId],
  );
  const onAddMany = useCallback(
    async (playerIds: number[]) => {
      await addGroupMembers(Number(groupId), playerIds);
      await loadGroup();
    },
    [groupId, loadGroup],
  );
  const onRemoveMember = useCallback(
    async (playerId: number) => {
      await removeGroupMember(Number(groupId), playerId);
      await loadGroup();
    },
    [groupId, loadGroup],
  );

  const legacyCount = useMemo(
    () => (group ? group.players.filter((p) => !p.player).length : 0),
    [group],
  );

  async function handleRename(event: React.FormEvent) {
    event.preventDefault();
    if (!group || !nameValue.trim() || nameValue.trim() === group.name) return;
    setIsRenaming(true);
    setError(null);
    try {
      const updated = await renameGroup(group.id, { name: nameValue.trim() });
      setGroup(updated);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsRenaming(false);
    }
  }

  async function handleDelete() {
    if (!group) return;
    setError(null);
    try {
      await confirm({
        title: 'Delete Group?',
        body: `"${group.name}" will be removed. Quizzes it was already used on are not affected.`,
        confirmLabel: 'Delete Group',
        action: async () => {
          await deleteGroup(group.id);
          navigate('/groups');
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  if (!group) {
    return (
      <div>
        <ErrorBanner message={error} />
        {!error && <LoadingState />}
      </div>
    );
  }

  return (
    <div>
      {dialog}
      <div className={styles.header}>
        <Link to="/groups" className={styles.backLink}>
          ← Back to groups
        </Link>
        <button className={`${nb.btnSm} ${nb.btnDanger}`} onClick={handleDelete}>
          Delete group
        </button>
      </div>

      <form className={styles.renameForm} onSubmit={handleRename}>
        <input
          className={nb.input}
          value={nameValue}
          onChange={(e) => setNameValue(e.target.value)}
          aria-label="Group name"
        />
        <button
          type="submit"
          className={nb.btnSm}
          disabled={isRenaming || !nameValue.trim() || nameValue.trim() === group.name}
        >
          {isRenaming ? 'Saving…' : 'Rename'}
        </button>
      </form>

      <ErrorBanner message={error} />

      <RosterSelectPanel members={group.players} onAddMany={onAddMany} onRemove={onRemoveMember} />

      {legacyCount === 0 ? (
        <div className={styles.legacySection}>
          <button type="button" className={nb.btnSm} onClick={() => setShowLegacy((v) => !v)}>
            {showLegacy ? 'Hide Advanced / Legacy Members' : 'Advanced / Legacy Members'}
          </button>
          {showLegacy && (
            <PlayerListEditor
              load={load}
              onSave={onSave}
              onUploadCsv={onUploadCsv}
              currentListTitle="Legacy members (no master-roster link)"
              editTitle="Edit legacy members"
              saveButtonLabel="Save members"
            />
          )}
        </div>
      ) : (
        <div className={styles.legacySection}>
          <p className={styles.legacyNote}>
            Legacy members are plain names carried over from before the Master Roster - they aren't
            connected to a canonical Player, so photos, unified history, and roster-picker selection
            don't apply to them.
          </p>
          <PlayerListEditor
            load={load}
            onSave={onSave}
            onUploadCsv={onUploadCsv}
            currentListTitle="Legacy members (no master-roster link)"
            editTitle="Edit legacy members"
            saveButtonLabel="Save members"
          />
        </div>
      )}
    </div>
  );
}
