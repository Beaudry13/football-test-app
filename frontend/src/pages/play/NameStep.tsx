import { useState } from 'react';
import { startAttempt } from '../../api/play';
import { ApiError, getErrorMessage } from '../../api/client';
import type { AttemptState } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import styles from './PlayPage.module.css';

export function NameStep({
  quizTitle,
  rosterPlayers,
  accessCodeId,
  onStarted,
  onAlreadySubmitted,
}: {
  quizTitle: string;
  rosterPlayers: string[];
  accessCodeId: number;
  /** Called once the attempt is created (fresh) or resumed (already in
   * progress) - `attempt.answers` carries whatever was previously
   * autosaved, letting the quiz step seed itself instead of starting blank. */
  onStarted: (name: string, attempt: AttemptState) => void;
  /** The server found this name already SUBMITTED for this activation -
   * routes straight to results instead of a fresh/resumed quiz. */
  onAlreadySubmitted: (name: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue() {
    if (!selected) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const attempt = await startAttempt({ access_code_id: accessCodeId, player_name: selected });
      onStarted(selected, attempt);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onAlreadySubmitted(selected);
        return;
      }
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className={`card ${styles.panel}`}>
      <h2>{quizTitle}</h2>
      <p>Select your name from the roster.</p>
      <ErrorBanner message={error} />
      <div className={styles.nameGrid}>
        {rosterPlayers.map((name) => (
          <button
            key={name}
            className={`${styles.nameButton} ${selected === name ? styles.nameButtonActive : ''}`}
            onClick={() => setSelected(name)}
            disabled={isSubmitting}
          >
            {name}
          </button>
        ))}
      </div>
      <button
        className="btn btn-primary"
        disabled={!selected || isSubmitting}
        style={{ width: '100%' }}
        onClick={handleContinue}
      >
        {isSubmitting ? 'Loading…' : 'Continue'}
      </button>
    </div>
  );
}
