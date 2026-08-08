import { useEffect, useState, type FormEvent } from 'react';
import { createQuiz, deleteQuiz, duplicateQuiz, listQuizzes, updateQuiz } from '../api/quizzes';
import { createFolder, deleteFolder, listFolders, renameFolder } from '../api/folders';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { Folder, Quiz } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { QuizCard } from '../components/QuizCard';
import { NotebookPage } from '../components/notebook/NotebookPage';
import { NotebookHeader } from '../components/notebook/NotebookHeader';
import { Icon } from '../components/ui/Icon';
import { CoachFolderSection } from './CoachFolderSection';
import { LoadingState } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';
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
  const { confirm, dialog } = useConfirmDialog();

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
    setError(null);
    try {
      await confirm({
        title: 'Delete Quiz?',
        body: `"${title}" and its questions, roster, and results will be removed. This action cannot be undone.`,
        confirmLabel: 'Delete Quiz',
        action: async () => {
          await deleteQuiz(quizId);
          await refresh();
        },
      });
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
    setError(null);
    try {
      await confirm({
        title: 'Delete Folder?',
        body: `"${name}" will be removed. Its Quizzes are not deleted - they move to Uncategorized.`,
        confirmLabel: 'Delete Folder',
        action: async () => {
          await deleteFolder(folderId);
          await refresh();
        },
      });
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

  // Only root folders start the recursion; CoachFolderSection renders each
  // folder's own subfolders inline, to any depth. Subfolders used to be links
  // out to FolderPage, which only worked while nesting was capped at two
  // levels - a five-deep season would otherwise be five pages to walk.
  const rootFolders = folders?.filter((f) => f.parent_folder_id === null) ?? [];
  const hasFolders = rootFolders.length > 0;
  const uncategorized = quizzes?.filter((q) => q.folder_id === null) ?? [];

  return (
    <NotebookPage>
      {dialog}
      <NotebookHeader />

      <div className={nb.content}>
        <ActiveQuizStatusSection />

        <div className={styles.contentHeader}>
          <h1 className={nb.heading}>Your Quizzes</h1>
          {quizzes && (
            <span className={nb.countBadge}>
              {quizzes.length} Quiz{quizzes.length === 1 ? '' : 'zes'}
            </span>
          )}
        </div>

        <ErrorBanner message={error} />

        <form className={styles.newQuizForm} onSubmit={handleCreate}>
          <input
            className={nb.input}
            type="text"
            placeholder="New Quiz title, e.g. Week 3 Prep"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <button type="submit" className={nb.btnPrimary} disabled={isCreating || !newTitle.trim()}>
            {isCreating ? 'Creating…' : 'New Quiz'}
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
                <Icon name="add" size={14} /> New folder
              </>
            )}
          </button>
        </form>

        {quizzes === null ? (
          <LoadingState />
        ) : quizzes.length === 0 && !hasFolders ? (
          <EmptyState message="No Quizzes yet. Create your first one above." />
        ) : !hasFolders ? (
          <div className={styles.list}>{quizzes.map(renderQuizCard)}</div>
        ) : (
          <div className={styles.folderSections}>
            {rootFolders.map((folder) => (
              <CoachFolderSection
                key={folder.id}
                folder={folder}
                depth={0}
                allFolders={folders ?? []}
                quizzes={quizzes}
                collapsedIds={collapsedFolderIds}
                onToggle={toggleFolder}
                renamingId={renamingFolderId}
                renameValue={renameValue}
                onRenameValueChange={setRenameValue}
                onStartRename={(f) => {
                  setRenamingFolderId(f.id);
                  setRenameValue(f.name);
                }}
                onCancelRename={() => setRenamingFolderId(null)}
                onRename={handleRenameFolder}
                onDelete={handleDeleteFolder}
                subfolderNames={newSubfolderNames}
                onSubfolderNameChange={(parentId, value) =>
                  setNewSubfolderNames((prev) => ({ ...prev, [parentId]: value }))
                }
                creatingSubfolderFor={isCreatingSubfolderFor}
                onCreateSubfolder={handleCreateSubfolder}
                renderQuizCard={renderQuizCard}
              />
            ))}

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
