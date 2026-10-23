import { useState, type FormEvent } from 'react';
import { validateCode } from '../../api/play';
import { ApiError, getErrorMessage } from '../../api/client';
import type { ValidateCodeResponse } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import styles from './PlayPage.module.css';

export function JoinStep({
  initialCode,
  onJoined,
  secondary = false,
}: {
  initialCode: string;
  onJoined: (code: string, result: ValidateCodeResponse) => void;
  /** PLAYER HOME WITH WORK ON IT: the code box is the second thing, not the
   *  first - a smaller heading, and no autofocus, which on a phone would pop
   *  the keyboard up over what he came to do. */
  secondary?: boolean;
}) {
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const [expiredCode, setExpiredCode] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim()) return;
    setError(null);
    setExpiredCode(null);
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
        // Results outlive the code, so the way to them is right here.
        setExpiredCode(code.trim().toUpperCase());
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className={`card ${styles.panel}`} onSubmit={handleSubmit}>
      {/* "Code", not "Quiz": a code can be a Rep too. */}
      {secondary ? <h2>Got a new code?</h2> : <h1>Enter your code</h1>}
      {!secondary && <p>Enter the code your coach shared with you.</p>}
      <ErrorBanner message={error} />
      {expiredCode && (
        <p>
          Already played it? <a href={`/results?code=${encodeURIComponent(expiredCode)}`}>View your results</a>
        </p>
      )}
      <div className="field">
        <input
          className={styles.codeInput}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={16}
          placeholder="CODE"
          aria-label="Code"
          autoFocus={!secondary}
        />
      </div>
      <button
        type="submit"
        className={secondary ? 'btn btn-secondary' : 'btn btn-primary'}
        disabled={isSubmitting || !code.trim()}
        style={{ width: '100%' }}
      >
        {isSubmitting ? 'Checking…' : 'Continue'}
      </button>
    </form>
  );
}
