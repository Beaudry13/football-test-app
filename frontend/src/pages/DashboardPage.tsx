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
import { FolderRow } from './FolderRow';
import { ActiveCompetitionBanner } from './compete/ActiveCompetitionBanner';
import { LoadingState } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';
import { ActiveQuizStatusSection } from './ActiveQuizStatus';
import { FirstSuccessChecklist } from '../components/onboarding/FirstSuccessChecklist';
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
  const [error, setError] = useState<string | null>(null);
  // Bumped when this page changes something the setup checklist derives from,
  // so it re-checks instead of sitting stale. Only quiz create/duplicate/
  // delete qualify - folders are not a setup step, and bumping on every
  // refresh would re-fetch onboarding twice on each dashboard load for
  // nothing. The checklist owns no rules of its own; see
  // components/onboarding/FirstSuccessChecklist.
  const [onboardingSignal, setOnboardingSignal] = useState(0);
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
      setOnboardingSignal((n) => n + 1);
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
      setOnboardingSignal((n) => n + 1);
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
          setOnboardingSignal((n) => n + 1);
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

  // Subfolders are created on the folder's OWN page now - FolderPage already
  // had that form. Creating one from here meant a per-folder input on the
  // dashboard for every folder a coach owned.

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

  // Only ROOT folders appear here. A subfolder is reached by opening its
  // parent, which is what keeps this screen the same size whether a coach has
  // three folders or a five-deep season structure.
  const rootFolders = folders?.filter((f) => f.parent_folder_id === null) ?? [];
  const hasFolders = rootFolders.length > 0;
  const uncategorized = quizzes?.filter((q) => q.folder_id === null) ?? [];

  return (
    <NotebookPage>
      {dialog}
      <NotebookHeader />

      <div className={nb.content}>
        {/* Recovery for a live competition. Renders nothing when there is
            none, so the ordinary dashboard is unchanged. */}
        <ActiveCompetitionBanner />
        <FirstSuccessChecklist reloadSignal={onboardingSignal} />

        <ActiveQuizStatusSection />

        {/* Tour target. An attribute rather than a class, so restyling this
            header can never silently unhook the Dashboard Tour - see
            help/tour/tourSteps. */}
        <div className={styles.contentHeader} data-tour="quizzes">
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

        <form className={styles.newFolderForm} onSubmit={handleCreateFolder} data-tour="folders">
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
            {/* FOLDERS ARE PLACES TO GO, NOT THINGS TO UNFOLD. They used to
                expand here and render every quiz inside them, recursively and
                expanded by default - so a coach with a hundred quizzes met all
                hundred at once and found the one they wanted by scrolling past
                the rest. Opening a folder made the page bigger.

                They now navigate into FolderPage, which already had the
                breadcrumbs, the rename, the delete and the subfolder form and
                was simply never linked to. See FolderRow.tsx. */}
            <div className={styles.folderList}>
              {rootFolders.map((folder) => (
                <FolderRow
                  key={folder.id}
                  folder={folder}
                  allFolders={folders ?? []}
                  quizzes={quizzes}
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
                />
              ))}
            </div>

            {/* Loose work stays inline. It is not a folder anybody filed
                something into, so hiding it behind a click would bury the
                quizzes a coach is most likely still working on. */}
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
