import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { listQuizzes, duplicateQuiz, deleteQuiz, updateQuiz } from '../api/quizzes';
import { deleteFolder, listFolders, renameFolder } from '../api/folders';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { Folder, Quiz } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { QuizCard } from '../components/QuizCard';
import { NotebookPage } from '../components/notebook/NotebookPage';
import { NotebookHeader } from '../components/notebook/NotebookHeader';
import nb from '../styles/notebook.module.css';
import dashboardStyles from './DashboardPage.module.css';
import styles from './FolderPage.module.css';
import { LoadingState } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';

/** A single subfolder's own page: breadcrumb back to its parent, rename,
 * delete, and the quizzes assigned directly to it. Folders are at most one
 * level deep (see Folder.parent_folder_id), so this page never needs to
 * show a further level of nesting - just its own quizzes. */
export function FolderPage() {
  const { folderId } = useParams<{ folderId: string }>();
  const { coach } = useAuth();
  const navigate = useNavigate();

  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [quizzes, setQuizzes] = useState<Quiz[] | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();

  const load = useCallback(async () => {
    try {
      const [folderList, quizList] = await Promise.all([listFolders(), listQuizzes()]);
      setFolders(folderList);
      setQuizzes(quizList);
      // Set once, directly from the fetch that just resolved - not a
      // separate effect reacting to derived state, which would re-run (and
      // clobber whatever the coach is mid-typing) on every unrelated render.
      const loaded = folderList.find((f) => f.id === Number(folderId));
      if (loaded) setRenameValue(loaded.name);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [folderId]);

  useEffect(() => {
    load();
  }, [load]);

  const folder = folders?.find((f) => f.id === Number(folderId)) ?? null;
  const parent = folder?.parent_folder_id
    ? (folders?.find((f) => f.id === folder.parent_folder_id) ?? null)
    : null;

  async function handleRename(event: FormEvent) {
    event.preventDefault();
    if (!folder || !renameValue.trim() || renameValue.trim() === folder.name) return;
    setIsRenaming(true);
    setError(null);
    try {
      await renameFolder(folder.id, { name: renameValue.trim() });
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsRenaming(false);
    }
  }

  async function handleDelete() {
    if (!folder) return;
    setError(null);
    try {
      await confirm({
        title: 'Delete Folder?',
        body: `"${folder.name}" will be removed. Its Quizzes are not deleted - they move to Uncategorized.`,
        confirmLabel: 'Delete Folder',
        action: async () => {
          await deleteFolder(folder.id);
          navigate('/dashboard');
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleMoveToFolder(quizId: number, newFolderId: number | null) {
    setError(null);
    try {
      await updateQuiz(quizId, { folder_id: newFolderId });
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleDuplicate(quizId: number) {
    setError(null);
    try {
      await duplicateQuiz(quizId);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleDeleteQuiz(quizId: number, title: string) {
    setError(null);
    try {
      await confirm({
        title: 'Delete Quiz?',
        body: `"${title}" and its questions, roster, and results will be removed. This action cannot be undone.`,
        confirmLabel: 'Delete Quiz',
        action: async () => {
          await deleteQuiz(quizId);
          await load();
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  if (folders && !folder) {
    // Covers both "bad id typed by hand" and "this folder was deleted by a
    // teammate since this tab last loaded" - same friendly outcome either way.
    return (
      <NotebookPage>
        <NotebookHeader />
        <div className={nb.content}>
          <ErrorBanner message="This folder no longer exists." />
          <Link to="/dashboard" className={styles.backLink}>
            ← Back to Dashboard
          </Link>
        </div>
      </NotebookPage>
    );
  }

  if (!folders || !quizzes || !folder) {
    return (
      <NotebookPage>
        <NotebookHeader />
        <div className={nb.content}>
          <ErrorBanner message={error} />
          {!error && <LoadingState />}
        </div>
      </NotebookPage>
    );
  }

  const folderQuizzes = quizzes.filter((q) => q.folder_id === folder.id);

  return (
    <NotebookPage>
      {dialog}
      <NotebookHeader />
      <div className={nb.content}>
        <div className={styles.header}>
          <Link to={parent ? `/folders/${parent.id}` : '/dashboard'} className={styles.backLink}>
            ← Back to {parent ? parent.name : 'Dashboard'}
          </Link>
          <button className={`${nb.btnSm} ${nb.btnDanger}`} onClick={handleDelete}>
            Delete folder
          </button>
        </div>

        <form className={styles.renameForm} onSubmit={handleRename}>
          <input
            className={nb.input}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            aria-label="Folder name"
          />
          <button
            type="submit"
            className={nb.btnSm}
            disabled={isRenaming || !renameValue.trim() || renameValue.trim() === folder.name}
          >
            {isRenaming ? 'Saving…' : 'Rename'}
          </button>
        </form>

        <ErrorBanner message={error} />

        <div className={dashboardStyles.contentHeader}>
          <h1 className={nb.heading}>{folder.name}</h1>
          <span className={nb.countBadge}>
            {folderQuizzes.length} Quiz{folderQuizzes.length === 1 ? '' : 'zes'}
          </span>
        </div>

        {folderQuizzes.length === 0 ? (
          <EmptyState message="No Quizzes in this folder yet." />
        ) : (
          <div className={dashboardStyles.list}>
            {folderQuizzes.map((quiz) => (
              <QuizCard
                key={quiz.id}
                quiz={quiz}
                coach={coach}
                folders={folders}
                onMoveToFolder={handleMoveToFolder}
                onDuplicate={handleDuplicate}
                onDelete={handleDeleteQuiz}
              />
            ))}
          </div>
        )}
      </div>
    </NotebookPage>
  );
}
