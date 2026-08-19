import { Link } from 'react-router-dom';
import type { Coach, Folder, Quiz } from '../api/types';
import { MenuButton, MenuItem } from './ui/MenuButton';
import { folderTreeOrder } from '../pages/folderTotals';
import nb from '../styles/notebook.module.css';
import styles from '../pages/DashboardPage.module.css';

interface QuizCardProps {
  quiz: Quiz;
  coach: Coach | null;
  /** All folders in the org, at any depth - used to build the move
   * dropdown, which lists the whole tree indented by level. */
  folders: Folder[] | null;
  onMoveToFolder: (quizId: number, folderId: number | null) => void;
  onDuplicate: (quizId: number) => void;
  onDelete: (quizId: number, title: string) => void;
}

/** One quiz row: title/meta link, and (if the caller may edit it) a
 * move-to-folder select plus duplicate/delete actions. Shared by
 * DashboardPage (root-level and Uncategorized lists) and FolderPage (a
 * subfolder's own quizzes) so "move/duplicate/delete a quiz" behaves
 * identically no matter which page it's shown from. */
export function QuizCard({ quiz, coach, folders, onMoveToFolder, onDuplicate, onDelete }: QuizCardProps) {
  // Mirrors the backend's get_editable_quiz rule so the UI doesn't offer
  // actions the API will refuse. The server is still the enforcement
  // point - this only keeps the buttons honest.
  const canEdit = coach != null && (quiz.coach_id === coach.id || coach.role === 'admin');
  const isTeammates = coach != null && quiz.coach_id !== coach.id;

  // The WHOLE tree, indented - not roots plus their direct children. A
  // folder five levels deep is a perfectly ordinary place to file a quiz.
  const folderOptions = folderTreeOrder(folders ?? []);

  return (
    <div className={`${nb.card} ${nb.cardHoverable} ${styles.quizCard}`}>
      {/* THE WHOLE CARD OPENS THE QUIZ. The link stretches over the card via
          CSS rather than by wrapping it, so there is still exactly ONE link
          and one tab stop - wrapping would have put a button inside an
          anchor, which is invalid and unusable by keyboard.

          Before this, the card hover-lifted as though it were clickable while
          only its left portion actually was; clicking the right third did
          nothing. */}
      <Link to={`/quizzes/${quiz.id}`} className={styles.quizInfo}>
        <h2>
          {quiz.title}
          {quiz.is_active && (
            <span className={`${nb.badge} ${nb.badgeSuccess} ${styles.activeBadge}`}>Active</span>
          )}
        </h2>
        {/* RESULTS FIRST, AUTHORING DETAIL SECOND. "How did my players do" is
            the reason a coach opens a quiz; the question count and the date
            are how they recognise which one it is. */}
        {quiz.completed_count !== undefined && (
          <div className={styles.quizStats}>
            {quiz.average_score_percent !== undefined && (
              <span className={styles.quizStat}>
                <b>{quiz.average_score_percent}%</b> avg. score
              </span>
            )}
            <span className={styles.quizStat}>
              <b>
                {quiz.completed_count}/{quiz.roster_size}
              </b>{' '}
              completed
            </span>
          </div>
        )}
        <div className={styles.quizMeta}>
          {quiz.question_count} question{quiz.question_count === 1 ? '' : 's'} · updated{' '}
          {new Date(quiz.updated_at).toLocaleDateString()}
          {isTeammates && <> · by {quiz.created_by_username ?? 'a former coach'}</>}
        </div>
      </Link>

      {/* Everything a coach does OCCASIONALLY. Three permanent controls per
          card - a folder dropdown, Duplicate and a red Delete - became one
          quiet affordance. Duplicate is the most frequent of the three and
          still moved: a permanent button on every card is a worse price than
          one extra click on an occasional action. */}
      <MenuButton label={`Actions for ${quiz.title}`}>
        <MenuItem onSelect={() => onDuplicate(quiz.id)}>Duplicate</MenuItem>

        {canEdit && folderOptions.length > 0 && (
          <div className={styles.moveField}>
            <label className={styles.moveLabel} htmlFor={`move-${quiz.id}`}>
              Move to
            </label>
            {/* Still a real <select>, and still carrying the same accessible
                name it always had. Relocating a control is not a reason to
                rebuild how it works. */}
            <select
              id={`move-${quiz.id}`}
              className={styles.folderSelect}
              value={quiz.folder_id ?? ''}
              onChange={(e) =>
                onMoveToFolder(quiz.id, e.target.value ? Number(e.target.value) : null)
              }
              aria-label={`Move "${quiz.title}" to folder`}
            >
              <option value="">Uncategorized</option>
              {folderOptions.map(({ folder, depth }) => (
                <option key={folder.id} value={folder.id}>
                  {'  '.repeat(depth)}
                  {depth > 0 ? '↳ ' : ''}
                  {folder.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {canEdit && (
          <MenuItem destructive onSelect={() => onDelete(quiz.id, quiz.title)}>
            Delete
          </MenuItem>
        )}
      </MenuButton>
    </div>
  );
}
