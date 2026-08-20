import { Link } from 'react-router-dom';
import type { Folder, Quiz } from '../api/types';
import { MenuButton, MenuItem } from '../components/ui/MenuButton';
import { Icon } from '../components/ui/Icon';
import { countQuizzesInFolderTree } from './folderTotals';
import nb from '../styles/notebook.module.css';
import styles from './DashboardPage.module.css';

/**
 * One folder, as a place to GO rather than a thing to unfold.
 *
 * WHAT THIS REPLACED, AND WHY. Folders used to expand inline and render every
 * quiz inside them - recursively, to any depth, expanded by default. A coach
 * with eight folders and a hundred quizzes met all hundred at once on the
 * dashboard, and the answer to "where is the quiz I want" was to scroll past
 * every quiz they did not want. Opening a folder made the page BIGGER, which
 * is the opposite of what opening something should do.
 *
 * A folder is now a row that takes you into it. The dashboard is the library;
 * the folder is the shelf. `FolderPage` already existed, already had
 * breadcrumbs, rename, delete and a subfolder form - it was simply never
 * linked to, so the destination was built and unreachable.
 *
 * ONE ROW, ONE MENU. Rename and Delete were two permanent buttons on every
 * folder at every depth; they are now inside the same "..." menu a quiz card
 * uses, so a screen of folders is a list of names rather than a grid of
 * controls. Same pattern, same component - a coach learns it once.
 *
 * THE COUNT IS THE WHOLE TREE. A folder holding four quizzes one level down
 * read "(0)" while plainly containing them, so the number counts descendants
 * too. It is the only thing on the row besides the name, because it is the
 * only thing that helps you decide whether to go in.
 */
export function FolderRow({
  folder,
  allFolders,
  quizzes,
  renamingId,
  renameValue,
  onRenameValueChange,
  onStartRename,
  onCancelRename,
  onRename,
  onDelete,
}: {
  folder: Folder;
  allFolders: Folder[];
  quizzes: Quiz[];
  renamingId: number | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onStartRename: (folder: Folder) => void;
  onCancelRename: () => void;
  onRename: (id: number) => void;
  onDelete: (id: number, name: string) => void;
}) {
  const totalInTree = countQuizzesInFolderTree(folder.id, allFolders, quizzes);
  const subfolders = allFolders.filter((f) => f.parent_folder_id === folder.id);

  if (renamingId === folder.id) {
    return (
      <div className={styles.folderRow}>
        <input
          autoFocus
          className={nb.input}
          value={renameValue}
          onChange={(e) => onRenameValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRename(folder.id);
            if (e.key === 'Escape') onCancelRename();
          }}
          aria-label={`Rename folder "${folder.name}"`}
        />
        <button
          className={nb.btnSm}
          onClick={() => onRename(folder.id)}
          // Without this the handler silently returns on an empty name and the
          // coach sees a Save button that does nothing.
          disabled={!renameValue.trim()}
        >
          Save
        </button>
        <button className={nb.btnSm} onClick={onCancelRename}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className={styles.folderRow}>
      {/* The whole row is the target, not just the words - a folder name is a
          small thing to hit on a phone. Stretched by CSS rather than wrapping
          the menu in the link, because a link containing a button is neither
          valid nor operable by keyboard. */}
      <Link to={`/folders/${folder.id}`} className={styles.folderLink}>
        <span className={styles.folderIcon} aria-hidden="true">
          <Icon name="chevronRight" size={16} />
        </span>
        <span className={styles.folderName}>{folder.name}</span>
        <span className={styles.folderCount}>{totalInTree}</span>
      </Link>

      <MenuButton label={`Folder options for ${folder.name}`}>
        <MenuItem onSelect={() => onStartRename(folder)}>Rename</MenuItem>
        {/* The API refuses to delete a folder that still has subfolders (422,
            see routes/folders.delete_folder). Offering it anyway meant a
            confirmation promising the quizzes would move to Uncategorized,
            followed by an error - so it says why instead. */}
        <MenuItem onSelect={() => onDelete(folder.id, folder.name)} disabled={subfolders.length > 0}>
          {subfolders.length > 0 ? 'Delete (empty its folders first)' : 'Delete folder'}
        </MenuItem>
      </MenuButton>
    </div>
  );
}
