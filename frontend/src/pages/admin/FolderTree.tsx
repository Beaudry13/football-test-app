import { Link } from 'react-router-dom';
import type { FolderNode } from './adminTree';
import type { OrganizationQuiz } from '../../api/organizations';
import type { OrganizationMember } from '../../api/types';
import { Icon } from '../../components/ui/Icon';
import nb from '../../styles/notebook.module.css';
import styles from './FolderTree.module.css';

/** One level of the tree, rendering itself for each child.
 *
 * Recursive with no depth cap. Indentation comes from a CSS custom property
 * rather than nested padding so that a deep branch stays readable instead of
 * marching off the right edge, and so the row's hover/focus target still
 * spans the full width at every level.
 */
export function FolderTree({
  nodes,
  depth = 0,
  expanded,
  onToggle,
  members,
  onAssign,
  assigningId,
}: {
  nodes: FolderNode[];
  depth?: number;
  expanded: Set<number | null>;
  onToggle: (id: number | null) => void;
  members: OrganizationMember[];
  onAssign: (quiz: OrganizationQuiz, coachId: number) => void;
  assigningId: number | null;
}) {
  return (
    <ul className={styles.level}>
      {nodes.map((node) => {
        const isOpen = expanded.has(node.id);
        const isEmpty = node.totalQuizzes === 0 && node.children.length === 0;

        return (
          <li key={node.id ?? 'uncategorised'}>
            <button
              type="button"
              className={styles.folderRow}
              style={{ '--depth': depth } as React.CSSProperties}
              aria-expanded={isOpen}
              onClick={() => onToggle(node.id)}
            >
              <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}>
                <Icon name="chevronRight" size={14} />
              </span>
              <span className={styles.folderIcon}>
                <Icon name={isOpen ? 'folderOpen' : 'folder'} size={16} />
              </span>
              <span className={styles.folderName}>{node.name}</span>

              {/* What is inside, before opening it - otherwise every expand is
                  a guess and the admin opens branches to find them empty. */}
              <span className={styles.summary}>
                {isEmpty ? (
                  <span className={styles.emptyTag}>Empty</span>
                ) : (
                  <>
                    <span>
                      {node.totalQuizzes} {node.totalQuizzes === 1 ? 'quiz' : 'quizzes'}
                    </span>
                    {node.totalSubfolders > 0 && (
                      <span>
                        {node.totalSubfolders}{' '}
                        {node.totalSubfolders === 1 ? 'subfolder' : 'subfolders'}
                      </span>
                    )}
                    {node.coachCount > 0 && (
                      <span>
                        {node.coachCount} {node.coachCount === 1 ? 'coach' : 'coaches'}
                      </span>
                    )}
                  </>
                )}
              </span>
            </button>

            {isOpen && (
              <>
                <FolderTree
                  nodes={node.children}
                  depth={depth + 1}
                  expanded={expanded}
                  onToggle={onToggle}
                  members={members}
                  onAssign={onAssign}
                  assigningId={assigningId}
                />
                {node.quizzes.map((quiz) => (
                  <QuizRow
                    key={quiz.id}
                    quiz={quiz}
                    depth={depth + 1}
                    members={members}
                    onAssign={onAssign}
                    isAssigning={assigningId === quiz.id}
                  />
                ))}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function QuizRow({
  quiz,
  depth,
  members,
  onAssign,
  isAssigning,
}: {
  quiz: OrganizationQuiz;
  depth: number;
  members: OrganizationMember[];
  onAssign: (quiz: OrganizationQuiz, coachId: number) => void;
  isAssigning: boolean;
}) {
  return (
    <div
      className={`${styles.quizRow} ${quiz.is_unassigned ? styles.quizRowUnassigned : ''}`}
      style={{ '--depth': depth } as React.CSSProperties}
    >
      <span className={styles.quizIcon}>
        <Icon name="quiz" size={15} />
      </span>
      <Link to={`/quizzes/${quiz.id}`} className={styles.quizTitle}>
        {quiz.title}
      </Link>

      {/* Ownership and folder are separate concepts: an unassigned quiz stays
          exactly where it is filed and is marked, rather than being moved to
          some "needs attention" bucket away from its context. */}
      {quiz.is_unassigned ? (
        <span className={styles.unassignedTag}>Unassigned</span>
      ) : (
        <span className={styles.ownerTag}>{quiz.owner?.username}</span>
      )}

      <span className={styles.quizMeta}>
        {quiz.question_count} {quiz.question_count === 1 ? 'question' : 'questions'}
      </span>

      <label className={nb.srOnly} htmlFor={`assign-${quiz.id}`}>
        Assign owner for {quiz.title}
      </label>
      <select
        id={`assign-${quiz.id}`}
        className={`${nb.input} ${styles.assign}`}
        disabled={isAssigning}
        value=""
        onChange={(event) => event.target.value && onAssign(quiz, Number(event.target.value))}
      >
        <option value="">{quiz.is_unassigned ? 'Assign owner…' : 'Reassign…'}</option>
        {members
          .filter((member) => member.id !== quiz.owner?.id)
          .map((member) => (
            <option key={member.id} value={member.id}>
              {member.username}
            </option>
          ))}
      </select>
    </div>
  );
}
