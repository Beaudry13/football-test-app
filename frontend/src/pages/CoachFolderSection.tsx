import type { FormEvent, ReactNode } from 'react';
import type { Folder, Quiz } from '../api/types';
import { Icon } from '../components/ui/Icon';
import nb from '../styles/notebook.module.css';
import styles from './DashboardPage.module.css';

/** One folder on the coach's dashboard, rendering its subfolders inline.
 *
 * Recursive, with no depth limit. Subfolders used to be links out to a
 * separate page, which worked only because folders could not nest more than
 * two levels; now that they can, a link-per-level would make a five-deep
 * season structure five pages to walk instead of one tree to open.
 *
 * Everything a coach can do to a root folder - rename, delete, add a
 * subfolder, expand - they can do at every level, because there is nothing
 * special about depth 0.
 *
 * This renders only what the caller passed it: the dashboard supplies folders
 * and quizzes already scoped to this coach, so nesting can never surface a
 * teammate's work.
 */
export function CoachFolderSection({
  folder,
  depth,
  allFolders,
  quizzes,
  collapsedIds,
  onToggle,
  renamingId,
  renameValue,
  onRenameValueChange,
  onStartRename,
  onCancelRename,
  onRename,
  onDelete,
  subfolderNames,
  onSubfolderNameChange,
  creatingSubfolderFor,
  onCreateSubfolder,
  renderQuizCard,
}: {
  folder: Folder;
  depth: number;
  allFolders: Folder[];
  quizzes: Quiz[];
  collapsedIds: Set<number>;
  onToggle: (id: number) => void;
  renamingId: number | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onStartRename: (folder: Folder) => void;
  onCancelRename: () => void;
  onRename: (id: number) => void;
  onDelete: (id: number, name: string) => void;
  subfolderNames: Record<number, string>;
  onSubfolderNameChange: (parentId: number, value: string) => void;
  creatingSubfolderFor: number | null;
  onCreateSubfolder: (event: FormEvent, parentId: number) => void;
  renderQuizCard: (quiz: Quiz) => ReactNode;
}) {
  const folderQuizzes = quizzes.filter((q) => q.folder_id === folder.id);
  const subfolders = allFolders.filter((f) => f.parent_folder_id === folder.id);
  const isCollapsed = collapsedIds.has(folder.id);

  return (
    <div
      className={styles.folderSection}
      // Indentation by custom property rather than nested padding, so depth 5
      // stays readable instead of each level compounding the last.
      style={{ '--folder-depth': depth } as React.CSSProperties}
    >
      <div className={styles.folderHeader}>
        <button className={styles.folderToggle} onClick={() => onToggle(folder.id)}>
          <span className={styles.folderCollapseIcon}>
            <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={16} />
          </span>
          {folder.name} <span className={styles.folderCount}>({folderQuizzes.length})</span>
        </button>
        <div className={styles.folderActions}>
          {renamingId === folder.id ? (
            <>
              <input
                autoFocus
                className={nb.input}
                style={{ width: 200 }}
                value={renameValue}
                onChange={(e) => onRenameValueChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onRename(folder.id)}
                aria-label={`Rename folder "${folder.name}"`}
              />
              <button className={nb.btnSm} onClick={() => onRename(folder.id)}>
                Save
              </button>
              <button className={nb.btnSm} onClick={onCancelRename}>
                Cancel
              </button>
            </>
          ) : (
            <button className={nb.btnSm} onClick={() => onStartRename(folder)}>
              Rename
            </button>
          )}
          <button
            className={`${nb.btnSm} ${nb.btnDanger}`}
            onClick={() => onDelete(folder.id, folder.name)}
          >
            Delete folder
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <>
          {subfolders.map((sub) => (
            <CoachFolderSection
              key={sub.id}
              folder={sub}
              depth={depth + 1}
              allFolders={allFolders}
              quizzes={quizzes}
              collapsedIds={collapsedIds}
              onToggle={onToggle}
              renamingId={renamingId}
              renameValue={renameValue}
              onRenameValueChange={onRenameValueChange}
              onStartRename={onStartRename}
              onCancelRename={onCancelRename}
              onRename={onRename}
              onDelete={onDelete}
              subfolderNames={subfolderNames}
              onSubfolderNameChange={onSubfolderNameChange}
              creatingSubfolderFor={creatingSubfolderFor}
              onCreateSubfolder={onCreateSubfolder}
              renderQuizCard={renderQuizCard}
            />
          ))}

          <form
            className={styles.newSubfolderForm}
            onSubmit={(e) => onCreateSubfolder(e, folder.id)}
          >
            <input
              className={nb.input}
              style={{ width: 200 }}
              type="text"
              placeholder="New subfolder, e.g. Week 1"
              value={subfolderNames[folder.id] ?? ''}
              onChange={(e) => onSubfolderNameChange(folder.id, e.target.value)}
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

          <div className={styles.list}>
            {folderQuizzes.length === 0 ? (
              <div className={styles.emptyFolder}>No Quizzes directly in this folder yet.</div>
            ) : (
              folderQuizzes.map(renderQuizCard)
            )}
          </div>
        </>
      )}
    </div>
  );
}
