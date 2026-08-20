import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { listQuizzes, duplicateQuiz, deleteQuiz, updateQuiz } from '../api/quizzes';
import { createFolder, deleteFolder, listFolders, renameFolder } from '../api/folders';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { Folder, Quiz } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { QuizCard } from '../components/QuizCard';
import { countQuizzesInFolderTree } from './folderTotals';
import { NotebookPage } from '../components/notebook/NotebookPage';
import { NotebookHeader } from '../components/notebook/NotebookHeader';
import nb from '../styles/notebook.module.css';
import dashboardStyles from './DashboardPage.module.css';
import styles from './FolderPage.module.css';
import { LoadingState } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
import { FolderRow } from './FolderRow';

/** A single folder's own page: its place in the tree, its quizzes, and its
 * subfolders listed beneath it.
 *
 * Reachable by URL, so bookmarks and shared links keep working - it is just no
 * longer the only way to open a subfolder, since the dashboard now nests them
 * inline as well.
 *
 * The subfolders are rendered by the SAME FolderRow the dashboard uses, and
 * they are rows you go INTO rather than sections that unfold - a folder page
 * that expanded its children would recreate here exactly the wall the
 * dashboard just stopped being. The scoping that keeps a coach from seeing a
 * teammate's quizzes lives in what gets passed in.
 *
 * The breadcrumb walks the full ancestor chain rather than assuming a single
 * parent, which is what the old two-level nesting cap used to guarantee. */
export function FolderPage() {
  const { folderId } = useParams<{ folderId: string }>();
  const { coach } = useAuth();
  const navigate = useNavigate();

  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [quizzes, setQuizzes] = useState<Quiz[] | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  // Separate from the page's own rename form above: that one renames THIS
  // folder, these track a rename happening on a nested subfolder.
  const [nestedRenamingId, setNestedRenamingId] = useState<number | null>(null);
  const [nestedRenameValue, setNestedRenameValue] = useState('');
  const [subfolderNames, setSubfolderNames] = useState<Record<number, string>>({});
  const [creatingSubfolderFor, setCreatingSubfolderFor] = useState<number | null>(null);
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

  // The whole chain to the root, not just the immediate parent. With nesting
  // uncapped, "Back to <parent>" alone tells a coach nothing about where they
  // are five levels down.
  const ancestors: Folder[] = [];
  if (folders && folder) {
    const seen = new Set<number>();
    let current = folder.parent_folder_id
      ? folders.find((f) => f.id === folder.parent_folder_id)
      : undefined;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      ancestors.unshift(current);
      current = current.parent_folder_id
        ? folders.find((f) => f.id === current!.parent_folder_id)
        : undefined;
    }
  }


  async function handleNestedRename(id: number) {
    if (!nestedRenameValue.trim()) return;
    setError(null);
    try {
      await renameFolder(id, { name: nestedRenameValue.trim() });
      setNestedRenamingId(null);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleNestedDelete(id: number, name: string) {
    setError(null);
    try {
      await confirm({
        title: 'Delete Folder?',
        body: `"${name}" will be removed. Its Quizzes move to Uncategorized rather than being deleted.`,
        confirmLabel: 'Delete Folder',
        action: async () => {
          await deleteFolder(id);
          await load();
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleCreateSubfolder(event: FormEvent, parentId: number) {
    event.preventDefault();
    const name = (subfolderNames[parentId] ?? '').trim();
    if (!name) return;
    setCreatingSubfolderFor(parentId);
    setError(null);
    try {
      await createFolder({ name, parent_folder_id: parentId });
      setSubfolderNames((prev) => ({ ...prev, [parentId]: '' }));
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCreatingSubfolderFor(null);
    }
  }

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
            <Icon name="back" size={14} /> Back to Dashboard
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

  // Listed below: this folder's own quizzes, because its subfolders are
  // rendered underneath and list theirs.
  const folderQuizzes = quizzes.filter((q) => q.folder_id === folder.id);
  // The count in the header covers the whole tree, matching the dashboard and
  // Admin View - see pages/folderTotals.
  const totalInTree = countQuizzesInFolderTree(folder.id, folders ?? [], quizzes);
  const subfolders = folders.filter((f) => f.parent_folder_id === folder.id);

  function renderQuizCard(quiz: Quiz) {
    return (
      <QuizCard
        key={quiz.id}
        quiz={quiz}
        coach={coach}
        folders={folders!}
        onMoveToFolder={handleMoveToFolder}
        onDuplicate={handleDuplicate}
        onDelete={handleDeleteQuiz}
      />
    );
  }

  return (
    <NotebookPage>
      {dialog}
      <NotebookHeader />
      <div className={nb.content}>
        <div className={styles.header}>
          <nav className={styles.breadcrumb} aria-label="Folder path">
            <Link to={parent ? `/folders/${parent.id}` : '/dashboard'} className={styles.backLink}>
              <Icon name="back" size={14} /> Back to {parent ? parent.name : 'Dashboard'}
            </Link>
            {/* The full path, not just the parent. Five levels down, "Back to
                Redzone" on its own says nothing about where you are. */}
            {ancestors.length > 0 && (
              <span className={styles.crumbs}>
                <Link to="/dashboard" className={styles.crumb}>
                  Dashboard
                </Link>
                {ancestors.map((ancestor) => (
                  <span key={ancestor.id}>
                    <span className={styles.crumbSeparator}>/</span>
                    <Link to={`/folders/${ancestor.id}`} className={styles.crumb}>
                      {ancestor.name}
                    </Link>
                  </span>
                ))}
                <span className={styles.crumbSeparator}>/</span>
                <span className={styles.crumbCurrent}>{folder.name}</span>
              </span>
            )}
          </nav>
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
            {totalInTree} Quiz{totalInTree === 1 ? '' : 'zes'}
          </span>
        </div>

        {/* This folder's subfolders, as rows you go into - the SAME component
            the dashboard uses, rather than a second idea of what a folder
            looks like. They no longer unfold in place: a folder page that
            expanded its children would recreate on this screen exactly the
            wall the dashboard just stopped being.

            `quizzes` came from listQuizzes(), which is own-only, so a
            teammate's work can never surface here. */}
        {subfolders.length > 0 && (
          <div className={dashboardStyles.folderList}>
            {subfolders.map((sub) => (
              <FolderRow
                key={sub.id}
                folder={sub}
                allFolders={folders}
                quizzes={quizzes}
                renamingId={nestedRenamingId}
                renameValue={nestedRenameValue}
                onRenameValueChange={setNestedRenameValue}
                onStartRename={(f) => {
                  setNestedRenamingId(f.id);
                  setNestedRenameValue(f.name);
                }}
                onCancelRename={() => setNestedRenamingId(null)}
                onRename={handleNestedRename}
                onDelete={handleNestedDelete}
              />
            ))}
          </div>
        )}

        <form
          className={dashboardStyles.newSubfolderForm}
          onSubmit={(e) => handleCreateSubfolder(e, folder.id)}
        >
          <input
            className={nb.input}
            style={{ width: 200 }}
            type="text"
            placeholder="New subfolder, e.g. Week 1"
            value={subfolderNames[folder.id] ?? ''}
            onChange={(e) =>
              setSubfolderNames((prev) => ({ ...prev, [folder.id]: e.target.value }))
            }
            aria-label={`New subfolder inside "${folder.name}"`}
          />
          <button
            type="submit"
            className={nb.btnSm}
            disabled={
              creatingSubfolderFor === folder.id ||
              !(subfolderNames[folder.id] ?? '').trim()
            }
          >
            {creatingSubfolderFor === folder.id ? 'Creating…' : 'New subfolder'}
          </button>
        </form>

        {folderQuizzes.length === 0 ? (
          <EmptyState message="No Quizzes directly in this folder yet." />
        ) : (
          <div className={dashboardStyles.list}>{folderQuizzes.map(renderQuizCard)}</div>
        )}
      </div>
    </NotebookPage>
  );
}
