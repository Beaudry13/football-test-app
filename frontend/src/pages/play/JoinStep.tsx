import { useState, type FormEvent } from 'react';
import { validateCode } from '../../api/play';
import { ApiError, getErrorMessage } from '../../api/client';
import type { ValidateCodeResponse } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import styles from './PlayPage.module.css';

export function JoinStep({
  initialCode,
  onJoined,
}: {
  initialCode: string;
  onJoined: (code: string, result: ValidateCodeResponse) => void;
}) {
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim()) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const trimmedCode = code.trim();
      const result = await validateCode(trimmedCode);
      onJoined(trimmedCode, result);
    } catch (err) {
      // "expired" gets its own calmer, specific message - a code that used
      // to work but doesn't anymore isn't the player's mistake, and telling
      // them to just "try again" (the generic message's implicit framing)
      // would be actively unhelpful, since retrying can't fix it.
      if (err instanceof ApiError && err.reason === 'expired') {
        setError('This code has expired — ask your coach for a new one.');
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className={`card ${styles.panel}`} onSubmit={handleSubmit}>
      <h1>Join a Quiz</h1>
      <p>Enter the code your coach shared with you.</p>
      <ErrorBanner message={error} />
      <div className="field">
        <input
          className={styles.codeInput}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={16}
          placeholder="CODE"
          autoFocus
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={isSubmitting || !code.trim()} style={{ width: '100%' }}>
        {isSubmitting ? 'Checking…' : 'Continue'}
      </button>
    </form>
  );
}
