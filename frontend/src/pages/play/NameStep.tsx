import { useState } from 'react';
import { startAttempt } from '../../api/play';
import { ApiError, getErrorMessage } from '../../api/client';
import type { AttemptState, RosterPlayerOption } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import styles from './PlayPage.module.css';

function optionLabel(option: RosterPlayerOption): string {
  const tag = [option.jersey_number ? `#${option.jersey_number}` : null, option.position]
    .filter(Boolean)
    .join(' · ');
  return tag ? `${option.name} (${tag})` : option.name;
}

export function NameStep({
  quizTitle,
  rosterPlayers,
  accessCodeId,
  onStarted,
  onAlreadySubmitted,
}: {
  quizTitle: string;
  rosterPlayers: RosterPlayerOption[];
  accessCodeId: number;
  /** Called once the attempt is created (fresh) or resumed (already in
   * progress) - `attempt.answers` carries whatever was previously
   * autosaved, letting the quiz step seed itself instead of starting blank.
   * `playerId` is set when the selected entry is a canonical master-roster
   * Player (undefined for a legacy, name-only one) - carried forward so
   * every later /play call can submit it too, which is what lets two
   * Players who share a display name (e.g. two "Chris Smith"s) never
   * collide onto the same attempt. */
  onStarted: (name: string, playerId: number | undefined, attempt: AttemptState) => void;
  /** The server found this name already SUBMITTED for this activation -
   * routes straight to results instead of a fresh/resumed quiz. */
  onAlreadySubmitted: (name: string, playerId: number | undefined) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = selectedIndex !== null ? rosterPlayers[selectedIndex] : null;

  async function handleContinue() {
    if (!selected) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const attempt = await startAttempt({
        access_code_id: accessCodeId,
        player_name: selected.name,
        player_id: selected.player_id ?? undefined,
      });
      onStarted(selected.name, selected.player_id ?? undefined, attempt);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onAlreadySubmitted(selected.name, selected.player_id ?? undefined);
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
        {rosterPlayers.map((option, index) => (
          <button
            key={option.player_id ?? `legacy:${option.name}`}
            className={`${styles.nameButton} ${selectedIndex === index ? styles.nameButtonActive : ''}`}
            onClick={() => setSelectedIndex(index)}
            disabled={isSubmitting}
          >
            {optionLabel(option)}
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
