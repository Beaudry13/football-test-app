import { Icon } from './Icon';
import styles from './LoadingState.module.css';

interface LoadingStateProps {
  /** "inline" sits next to other content at normal text size; "section"
   * (default) centers itself in a padded block, for a page/tab that's
   * entirely waiting on its first fetch. */
  variant?: 'inline' | 'section';
  label?: string;
}

/** Replaces the raw `<p>Loading…</p>` that used to be duplicated across
 * ~16 pages with no shared spinner - a single small spinning icon plus
 * label, token-driven so it always matches whichever theme (coach dark or
 * player light) it's rendered inside. */
export function LoadingState({ variant = 'section', label = 'Loading…' }: LoadingStateProps) {
  return (
    <div className={variant === 'inline' ? styles.inline : styles.section} role="status">
      <Icon name="spinner" size={variant === 'inline' ? 14 : 18} className={styles.spinner} />
      <span>{label}</span>
    </div>
  );
}
