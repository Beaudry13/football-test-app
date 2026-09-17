import { useState } from 'react';
import { getErrorMessage } from '../../api/client';
import type { RosterPlayerOption } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { PlayerAvatar } from '../../components/PlayerAvatar';
import { playerTag, type RememberedPlayer } from './playerSession';
import styles from './PlayPage.module.css';

/** Jersey and position, or nothing when neither was recorded. */
function optionTag(option: RosterPlayerOption): string {
  return playerTag({ jerseyNumber: option.jersey_number, position: option.position });
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

function toRememberedPlayer(option: RosterPlayerOption): RememberedPlayer {
  return {
    playerId: option.player_id,
    name: option.name,
    jerseyNumber: option.jersey_number,
    position: option.position,
  };
}

/** "Choose your name". What happens next - the quiz, a PIN, results - is the
 *  caller's decision (PlayPage, through playerEntry.ts); this screen only
 *  collects who the player says they are, and shows what went wrong. */
export function NameStep({
  quizTitle,
  rosterPlayers,
  remembered,
  onChoose,
  onForgetRemembered,
}: {
  quizTitle: string;
  rosterPlayers: RosterPlayerOption[];
  /** The player this device last played this code as - offered as one tap. */
  remembered?: RememberedPlayer | null;
  /** `continuing` is true only for the "Continue as" tap: the one path that may
   *  use a token this device already holds. */
  onChoose: (player: RememberedPlayer, continuing: boolean) => Promise<void>;
  onForgetRemembered?: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = selectedIndex !== null ? rosterPlayers[selectedIndex] : null;

  async function choose(player: RememberedPlayer, continuing: boolean) {
    setError(null);
    setIsSubmitting(true);
    try {
      await onChoose(player, continuing);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  const rememberedTag = remembered ? playerTag(remembered) : '';

  return (
    <div className={`card ${styles.panel}`}>
      <h1>{quizTitle}</h1>
      <ErrorBanner message={error} />
      {remembered && (
        <div className={styles.continueCard}>
          <button
            className="btn btn-primary"
            disabled={isSubmitting}
            onClick={() => void choose(remembered, true)}
          >
            {isSubmitting
              ? 'Loading…'
              : `Continue as ${remembered.name}${rememberedTag ? ` · ${rememberedTag}` : ''}`}
          </button>
          <button
            type="button"
            className={styles.quietLink}
            disabled={isSubmitting}
            onClick={onForgetRemembered}
          >
            Not you? Choose your name
          </button>
        </div>
      )}
      {!remembered && (
        <>
          <p>Choose your name.</p>
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
            onClick={() => selected && void choose(toRememberedPlayer(selected), false)}
          >
            {isSubmitting ? 'Loading…' : 'Continue'}
          </button>
        </>
      )}
    </div>
  );
}
