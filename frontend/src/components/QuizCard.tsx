import { Link } from 'react-router-dom';
import type { Coach, Folder, Quiz } from '../api/types';
import nb from '../styles/notebook.module.css';
import styles from '../pages/DashboardPage.module.css';

interface QuizCardProps {
  quiz: Quiz;
  coach: Coach | null;
  /** All folders in the org (root + subfolders) - used to build the move
   * dropdown's options, grouped under each root. */
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

  const rootFolders = folders?.filter((f) => f.parent_folder_id === null) ?? [];
  const subfoldersOf = (rootId: number) => folders?.filter((f) => f.parent_folder_id === rootId) ?? [];

  return (
    <div className={`${nb.card} ${nb.cardHoverable} ${styles.quizCard}`}>
      <div className={nb.accentStripe} />
      <Link to={`/quizzes/${quiz.id}`} className={styles.quizInfo} style={{ flex: 1 }}>
        <h3>
          {quiz.title}
          {quiz.is_active && (
            <span className={`${nb.badge} ${nb.badgeSuccess} ${styles.activeBadge}`}>Active</span>
          )}
        </h3>
        <div className={styles.quizMeta}>
          {quiz.question_count} question{quiz.question_count === 1 ? '' : 's'} · updated{' '}
          {new Date(quiz.updated_at).toLocaleDateString()}
          {isTeammates && <> · by {quiz.created_by_username ?? 'a former coach'}</>}
        </div>
        {/* Only present on list_quizzes, and only once there's something to
            report - a brand-new quiz has no completed attempts yet, and no
            average_score_percent until at least one answer's been graded. */}
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
      </Link>
      <div className={styles.actions}>
        {canEdit && rootFolders.length > 0 && (
          <select
            className={styles.folderSelect}
            value={quiz.folder_id ?? ''}
            onChange={(e) => onMoveToFolder(quiz.id, e.target.value ? Number(e.target.value) : null)}
            aria-label={`Move "${quiz.title}" to folder`}
          >
            <option value="">Uncategorized</option>
            {rootFolders.map((root) => (
              <optgroup key={root.id} label={root.name}>
                <option value={root.id}>{root.name}</option>
                {subfoldersOf(root.id).map((sub) => (
                  <option key={sub.id} value={sub.id}>
                    ↳ {sub.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
        {/* Duplicate stays available to everyone: the copy belongs to
            whoever made it, so starting from a teammate's quiz is safe. */}
        <button className={nb.btnSm} onClick={() => onDuplicate(quiz.id)}>
          <span aria-hidden="true">⧉</span> Duplicate
        </button>
        {canEdit && (
          <button className={`${nb.btnSm} ${nb.btnDanger}`} onClick={() => onDelete(quiz.id, quiz.title)}>
            <span aria-hidden="true">✕</span> Delete
          </button>
        )}
      </div>
    </div>
  );
}
