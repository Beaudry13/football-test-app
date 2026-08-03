import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { createQuiz, deleteQuiz, duplicateQuiz, listQuizzes, updateQuiz } from '../api/quizzes';
import { createFolder, deleteFolder, listFolders, renameFolder } from '../api/folders';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { Folder, Quiz } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { QuizCard } from '../components/QuizCard';
import { NotebookPage } from '../components/notebook/NotebookPage';
import { NotebookHeader } from '../components/notebook/NotebookHeader';
import { ActiveQuizStatusSection } from './ActiveQuizStatus';
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
  // Keyed by root folder id - a separate "new subfolder" input per root,
  // only ever one shown at a time in practice but each root keeps its own
  // draft text independently.
  const [newSubfolderNames, setNewSubfolderNames] = useState<Record<number, string>>({});
  const [isCreatingSubfolderFor, setIsCreatingSubfolderFor] = useState<number | null>(null);
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

  async function handleCreateSubfolder(event: FormEvent, rootId: number) {
    event.preventDefault();
    const name = (newSubfolderNames[rootId] ?? '').trim();
    if (!name) return;
    setIsCreatingSubfolderFor(rootId);
    setError(null);
    try {
      await createFolder({ name, parent_folder_id: rootId });
      setNewSubfolderNames((prev) => ({ ...prev, [rootId]: '' }));
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsCreatingSubfolderFor(null);
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
    return (
      <QuizCard
        key={quiz.id}
        quiz={quiz}
        coach={coach}
        folders={folders}
        onMoveToFolder={handleMoveToFolder}
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
      />
    );
  }

  // Only root folders (no parent) render as their own accordion section
  // here - a subfolder is reached by clicking its link inside its parent's
  // section, which navigates to its own page (FolderPage) instead.
  const rootFolders = folders?.filter((f) => f.parent_folder_id === null) ?? [];
  const hasFolders = rootFolders.length > 0;
  const uncategorized = quizzes?.filter((q) => q.folder_id === null) ?? [];

  return (
    <NotebookPage>
      <NotebookHeader />

      <div className={nb.content}>
        <ActiveQuizStatusSection />

        <div className={styles.contentHeader}>
          <h1 className={nb.heading}>Your Trials</h1>
          {quizzes && (
            <span className={nb.countBadge}>
              {quizzes.length} Peira{quizzes.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        <ErrorBanner message={error} />

        <form className={styles.newQuizForm} onSubmit={handleCreate}>
          <input
            className={nb.input}
            type="text"
            placeholder="New Peira title, e.g. Week 3 Prep"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <button type="submit" className={nb.btnPrimary} disabled={isCreating || !newTitle.trim()}>
            {isCreating ? 'Creating…' : 'New Peira'}
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
            {isCreatingFolder ? (
              'Creating…'
            ) : (
              <>
                <span aria-hidden="true">＋</span> New folder
              </>
            )}
          </button>
        </form>

        {quizzes === null ? (
          <p>Loading…</p>
        ) : quizzes.length === 0 && !hasFolders ? (
          <div className={`${nb.card} ${nb.empty}`}>No Peiras yet. Create your first one above.</div>
        ) : !hasFolders ? (
          <div className={styles.list}>{quizzes.map(renderQuizCard)}</div>
        ) : (
          <div className={styles.folderSections}>
            {rootFolders.map((folder) => {
              const folderQuizzes = quizzes.filter((q) => q.folder_id === folder.id);
              const subfolders = folders?.filter((f) => f.parent_folder_id === folder.id) ?? [];
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
                    <>
                      <div className={styles.subfolderSection}>
                        <h4 className={styles.subListHeading}>Subfolders</h4>
                        {subfolders.length > 0 && (
                          <div className={styles.subfolderList}>
                            {subfolders.map((sub) => (
                              <Link
                                key={sub.id}
                                to={`/folders/${sub.id}`}
                                className={styles.subfolderLink}
                              >
                                📁 {sub.name} <span className={styles.folderCount}>({sub.quiz_count})</span>
                              </Link>
                            ))}
                          </div>
                        )}
                        <form
                          className={styles.newSubfolderForm}
                          onSubmit={(e) => handleCreateSubfolder(e, folder.id)}
                        >
                          <input
                            className={nb.input}
                            style={{ width: 200 }}
                            type="text"
                            placeholder="New subfolder, e.g. Week 1"
                            value={newSubfolderNames[folder.id] ?? ''}
                            onChange={(e) =>
                              setNewSubfolderNames((prev) => ({ ...prev, [folder.id]: e.target.value }))
                            }
                            aria-label={`New subfolder inside "${folder.name}"`}
                          />
                          <button
                            type="submit"
                            className={nb.btnSm}
                            disabled={
                              isCreatingSubfolderFor === folder.id || !(newSubfolderNames[folder.id] ?? '').trim()
                            }
                          >
                            {isCreatingSubfolderFor === folder.id ? 'Creating…' : 'New subfolder'}
                          </button>
                        </form>
                      </div>
                      <div className={styles.list}>
                        {folderQuizzes.length === 0 ? (
                          <div className={styles.emptyFolder}>No Peiras directly in this folder yet.</div>
                        ) : (
                          folderQuizzes.map(renderQuizCard)
                        )}
                      </div>
                    </>
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
