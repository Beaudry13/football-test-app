import { useState } from 'react';
import { startAttempt } from '../../api/play';
import { ApiError, getErrorMessage } from '../../api/client';
import type { AttemptState, RosterPlayerOption } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { PlayerAvatar } from '../../components/PlayerAvatar';
import styles from './PlayPage.module.css';

/** Jersey and position, or nothing when neither was recorded. */
function optionTag(option: RosterPlayerOption): string {
  return [option.jersey_number ? `#${option.jersey_number}` : null, option.position]
    .filter(Boolean)
    .join(' · ');
}

/** THE ACCESSIBLE NAME, which is deliberately NOT what is drawn on screen.
 *
 * Visually the name and the jersey/position now sit on separate lines - one
 * concatenated string wrapped to three centred lines in a two-column grid and
 * was the hardest thing in the flow to read, which matters most in exactly
 * the case it was built for: two players who share a surname. Splitting the
 * lines would have changed each button's accessible name, so it is pinned
 * here with aria-label instead. A screen reader still hears
 * "Jordan Smith (#7 · QB)" as one phrase. */
function optionLabel(option: RosterPlayerOption): string {
  const tag = optionTag(option);
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
      <h1>{quizTitle}</h1>
      <p>Select your name from the roster.</p>
      <ErrorBanner message={error} />
      <div className={styles.nameGrid}>
        {rosterPlayers.map((option, index) => (
          <button
            key={option.player_id ?? `legacy:${option.name}`}
            className={`${styles.nameButton} ${selectedIndex === index ? styles.nameButtonActive : ''}`}
            onClick={() => setSelectedIndex(index)}
            disabled={isSubmitting}
            aria-label={optionLabel(option)}
            aria-pressed={selectedIndex === index}
          >
            {/* Neutral, not the default gold. A dozen of these are on screen
                at once here - the roster is the whole page - and at that
                count a gold disc per row stops being an accent and becomes
                the background. A real photo is unaffected. */}
            <PlayerAvatar
              name={option.name}
              photoUrl={option.photo_url}
              size="sm"
              tone="neutral"
            />
            <span className={styles.nameButtonText}>
              <span className={styles.nameButtonName}>{option.name}</span>
              {optionTag(option) && (
                <span className={styles.nameButtonTag}>{optionTag(option)}</span>
              )}
            </span>
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
