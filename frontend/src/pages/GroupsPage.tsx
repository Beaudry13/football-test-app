import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createGroup, deleteGroup, listGroups } from '../api/groups';
import { getErrorMessage } from '../api/client';
import type { Group } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { useConfirmDialog } from '../components/ConfirmDialog';
import nb from '../styles/notebook.module.css';
import styles from './GroupsPage.module.css';
import { LoadingState } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';

export function GroupsPage() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [newName, setNewName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    try {
      setGroups(await listGroups());
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!newName.trim()) return;
    setIsCreating(true);
    setError(null);
    try {
      const created = await createGroup({ name: newName.trim() });
      // Straight into the group that was just created - adding its first
      // players is the very next thing a coach does, so don't make them
      // find and click the new card in the list to get there.
      navigate(`/groups/${created.id}`);
    } catch (err) {
      setError(getErrorMessage(err));
      setIsCreating(false);
    }
  }

  async function handleDelete(groupId: number, name: string) {
    setError(null);
    try {
      await confirm({
        title: 'Delete Group?',
        body: `"${name}" will be removed. Quizzes it was already used on are not affected.`,
        confirmLabel: 'Delete Group',
        action: async () => {
          await deleteGroup(groupId);
          await refresh();
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  return (
    <div>
      {dialog}
      <div className={styles.header}>
        <h1 className={nb.heading}>Player groups</h1>
      </div>

      <p className={styles.description}>
        Build reusable groups like "Varsity" or "Defense" once, then pick which group(s) can access a
        Quiz when you activate it.
      </p>

      <ErrorBanner message={error} />

      <form className={styles.newGroupForm} onSubmit={handleCreate}>
        <input
          className={nb.input}
          type="text"
          placeholder="New group name, e.g. Defense"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit" className={nb.btnPrimary} disabled={isCreating || !newName.trim()}>
          {isCreating ? 'Creating…' : 'New group'}
        </button>
      </form>

      {groups === null ? (
        <LoadingState />
      ) : groups.length === 0 ? (
        <EmptyState message="No groups yet. Create your first one above." />
      ) : (
        <div className={styles.list}>
          {groups.map((group) => (
            <div key={group.id} className={`${nb.card} ${nb.cardHoverable} ${styles.groupCard}`}>
              <div className={nb.accentStripe} />
              <Link to={`/groups/${group.id}`} className={styles.groupInfo} style={{ flex: 1 }}>
                <h2>{group.name}</h2>
                <div className={styles.groupMeta}>
                  {group.players.length} player{group.players.length === 1 ? '' : 's'}
                </div>
              </Link>
              <div className={styles.actions}>
                <button
                  className={`${nb.btnSm} ${nb.btnDanger}`}
                  onClick={() => handleDelete(group.id, group.name)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
