import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { createQuiz, deleteQuiz, duplicateQuiz, listQuizzes, updateQuiz } from '../api/quizzes';
import { createFolder, deleteFolder, listFolders, renameFolder } from '../api/folders';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { Folder, Quiz } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { NotebookPage } from '../components/notebook/NotebookPage';
import { NotebookHeader } from '../components/notebook/NotebookHeader';
import nb from '../styles/notebook.module.css';
import styles from './DashboardPage.module.css';

export function DashboardPage() {
  const { coach } = useAuth();
  const [quizzes, setQuizzes] = useState<Quiz[] | null>(null);
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [renamingFolderId, setRenamingFolderId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    try {
      const [quizList, folderList] = await Promise.all([listQuizzes(), listFolders()]);
      setQuizzes(quizList);
      setFolders(folderList);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!newTitle.trim()) return;
    setIsCreating(true);
    setError(null);
    try {
      await createQuiz({ title: newTitle.trim() });
      setNewTitle('');
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleDuplicate(quizId: number) {
    setError(null);
    try {
      await duplicateQuiz(quizId);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleDelete(quizId: number, title: string) {
    if (!window.confirm(`Delete "${title}"? This removes its questions, roster, and results.`)) return;
    setError(null);
    try {
      await deleteQuiz(quizId);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleMoveToFolder(quizId: number, folderId: number | null) {
    setError(null);
    try {
      await updateQuiz(quizId, { folder_id: folderId });
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleCreateFolder(event: FormEvent) {
    event.preventDefault();
    if (!newFolderName.trim()) return;
    setIsCreatingFolder(true);
    setError(null);
    try {
      await createFolder({ name: newFolderName.trim() });
      setNewFolderName('');
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsCreatingFolder(false);
    }
  }

  async function handleRenameFolder(folderId: number) {
    if (!renameValue.trim()) return;
    setError(null);
    try {
      await renameFolder(folderId, { name: renameValue.trim() });
      setRenamingFolderId(null);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleDeleteFolder(folderId: number, name: string) {
    if (!window.confirm(`Delete folder "${name}"? Its quizzes move to Uncategorized, they are not deleted.`)) {
      return;
    }
    setError(null);
    try {
      await deleteFolder(folderId);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  function toggleFolder(folderId: number) {
    setCollapsedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function renderQuizCard(quiz: Quiz) {
    // Mirrors the backend's get_editable_quiz rule so the UI doesn't offer
    // actions the API will refuse. The server is still the enforcement
    // point - this only keeps the buttons honest.
    const canEdit = coach != null && (quiz.coach_id === coach.id || coach.role === 'admin');
    const isTeammates = coach != null && quiz.coach_id !== coach.id;

    return (
      <div key={quiz.id} className={`${nb.card} ${nb.cardHoverable} ${styles.quizCard}`}>
        <div className={nb.accentStripe} />
        <Link to={`/quizzes/${quiz.id}`} className={styles.quizInfo} style={{ flex: 1 }}>
          <h3>{quiz.title}</h3>
          <div className={styles.quizMeta}>
            {quiz.question_count} question{quiz.question_count === 1 ? '' : 's'} · updated{' '}
            {new Date(quiz.updated_at).toLocaleDateString()}
            {isTeammates && <> · by {quiz.created_by_username ?? 'a former coach'}</>}
          </div>
        </Link>
        <div className={styles.actions}>
          {canEdit && folders && folders.length > 0 && (
            <select
              className={styles.folderSelect}
              value={quiz.folder_id ?? ''}
              onChange={(e) => handleMoveToFolder(quiz.id, e.target.value ? Number(e.target.value) : null)}
              aria-label={`Move "${quiz.title}" to folder`}
            >
              <option value="">Uncategorized</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
          {/* Duplicate stays available to everyone: the copy belongs to
              whoever made it, so starting from a teammate's quiz is safe. */}
          <button className={nb.btnSm} onClick={() => handleDuplicate(quiz.id)}>
            Duplicate
          </button>
          {canEdit && (
            <button className={`${nb.btnSm} ${nb.btnDanger}`} onClick={() => handleDelete(quiz.id, quiz.title)}>
              Delete
            </button>
          )}
        </div>
      </div>
    );
  }

  const hasFolders = (folders?.length ?? 0) > 0;
  const uncategorized = quizzes?.filter((q) => q.folder_id === null) ?? [];

  return (
    <NotebookPage>
      <NotebookHeader />

      <div className={nb.content}>
        <div className={styles.contentHeader}>
          <h1 className={nb.heading}>Your quizzes</h1>
          {quizzes && (
            <span className={nb.countBadge}>
              {quizzes.length} quiz{quizzes.length === 1 ? '' : 'zes'}
            </span>
          )}
        </div>

        <ErrorBanner message={error} />

        <form className={styles.newQuizForm} onSubmit={handleCreate}>
          <input
            className={nb.input}
            type="text"
            placeholder="New quiz title, e.g. Week 3 Prep"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <button type="submit" className={nb.btnPrimary} disabled={isCreating || !newTitle.trim()}>
            {isCreating ? 'Creating…' : 'New quiz'}
          </button>
        </form>

        <form className={styles.newFolderForm} onSubmit={handleCreateFolder}>
          <input
            className={nb.input}
            type="text"
            placeholder="New folder, e.g. Fall Camp"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
          />
          <button type="submit" className={nb.btnSecondary} disabled={isCreatingFolder || !newFolderName.trim()}>
            {isCreatingFolder ? 'Creating…' : 'New folder'}
          </button>
        </form>

        {quizzes === null ? (
          <p>Loading…</p>
        ) : quizzes.length === 0 ? (
          <div className={`${nb.card} ${nb.empty}`}>No quizzes yet. Create your first one above.</div>
        ) : !hasFolders ? (
          <div className={styles.list}>{quizzes.map(renderQuizCard)}</div>
        ) : (
          <div className={styles.folderSections}>
            {folders!.map((folder) => {
              const folderQuizzes = quizzes.filter((q) => q.folder_id === folder.id);
              const isCollapsed = collapsedFolderIds.has(folder.id);
              return (
                <div key={folder.id} className={styles.folderSection}>
                  <div className={styles.folderHeader}>
                    <button className={styles.folderToggle} onClick={() => toggleFolder(folder.id)}>
                      <span className={styles.folderCollapseIcon}>{isCollapsed ? '▸' : '▾'}</span>
                      {folder.name} <span className={styles.folderCount}>({folderQuizzes.length})</span>
                    </button>
                    <div className={styles.folderActions}>
                      {renamingFolderId === folder.id ? (
                        <>
                          <input
                            autoFocus
                            className={nb.input}
                            style={{ width: 200 }}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleRenameFolder(folder.id)}
                            aria-label={`Rename folder "${folder.name}"`}
                          />
                          <button className={nb.btnSm} onClick={() => handleRenameFolder(folder.id)}>
                            Save
                          </button>
                          <button className={nb.btnSm} onClick={() => setRenamingFolderId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className={nb.btnSm}
                          onClick={() => {
                            setRenamingFolderId(folder.id);
                            setRenameValue(folder.name);
                          }}
                        >
                          Rename
                        </button>
                      )}
                      <button
                        className={`${nb.btnSm} ${nb.btnDanger}`}
                        onClick={() => handleDeleteFolder(folder.id, folder.name)}
                      >
                        Delete folder
                      </button>
                    </div>
                  </div>
                  {!isCollapsed && (
                    <div className={styles.list}>
                      {folderQuizzes.length === 0 ? (
                        <div className={styles.emptyFolder}>No quizzes in this folder yet.</div>
                      ) : (
                        folderQuizzes.map(renderQuizCard)
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {uncategorized.length > 0 && (
              <div className={styles.folderSection}>
                <div className={styles.folderHeader}>
                  <span className={styles.folderTitle}>
                    Uncategorized <span className={styles.folderCount}>({uncategorized.length})</span>
                  </span>
                </div>
                <div className={styles.list}>{uncategorized.map(renderQuizCard)}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </NotebookPage>
  );
}
