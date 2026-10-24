import { Alert } from './ui/Alert';
import styles from './ErrorBanner.module.css';

/**
 * WHAT WENT WRONG - and, when the page can simply ask again, a way to: a
 * "Try again" beside the message, so a failed load is never a dead end.
 */
export function ErrorBanner({ message, onRetry }: { message: string | null; onRetry?: () => void }) {
  if (!message) return null;
  return (
    <Alert variant="error">
      {message}
      {onRetry && (
        <>
          {' '}
          <button type="button" className={styles.retry} onClick={onRetry}>
            Try again
          </button>
        </>
      )}
    </Alert>
  );
}
