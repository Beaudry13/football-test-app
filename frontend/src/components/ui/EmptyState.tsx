import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import nb from '../../styles/notebook.module.css';
import styles from './EmptyState.module.css';

interface EmptyStateProps {
  message: ReactNode;
  icon?: IconName;
  /** Optional call-to-action button/link rendered under the message. */
  action?: ReactNode;
  /** Wraps in the shared card surface (matches most existing empty states,
   * e.g. "No Quizzes yet"). Set false for an empty state that already sits
   * inside its own card/section (e.g. a folder's empty quiz list). */
  card?: boolean;
}

/** One consistent empty-state shape, replacing the 3 conventions the
 * design-system audit found in place before this (`${nb.card} ${nb.empty}`,
 * bare `nb.empty`, and assorted page-local one-offs). */
export function EmptyState({ message, icon, action, card = true }: EmptyStateProps) {
  const content = (
    <div className={styles.empty}>
      {icon && (
        <div className={styles.icon}>
          <Icon name={icon} size={28} />
        </div>
      )}
      <p className={styles.message}>{message}</p>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );

  return card ? <div className={nb.card}>{content}</div> : content;
}
