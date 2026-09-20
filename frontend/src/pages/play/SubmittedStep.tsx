import { useCallback, useEffect, useState } from 'react';
import { getPlayerResults, type PlayerResultsWithAuth } from '../../api/play';
import { getErrorMessage } from '../../api/client';
import type { PlayerResultsResponse } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/ui/Icon';
import { LoadingState } from '../../components/ui/LoadingState';
import { clearAttemptToken, readAttemptToken, saveAttemptToken } from './attemptToken';
import { PinStep } from './PinStep';
import { isAuthRefusal, pinNoticeFor } from './playerEntry';
import { rememberPlayer, type RememberedPlayer } from './playerSession';
import { ResultsView } from './ResultsView';
import styles from './PlayPage.module.css';

// How long the "Quiz Complete" celebration stays up before fading away to
// reveal the real results underneath.
const CELEBRATION_MS = 1800;

export function SubmittedStep({
  code,
  playerName,
  playerId,
  player,
}: {
  code: string;
  playerName: string;
  /** Set when this player is a canonical master-roster entry - threaded
   * into the results lookup and bookmark link so two players sharing a
   * display name never see each other's results. */
  playerId: number | undefined;
  /** Who is shown on the PIN screen, if the results ask for one. */
  player?: RememberedPlayer;
}) {
  const [results, setResults] = useState<PlayerResultsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinNotice, setPinNotice] = useState<string | null | undefined>(undefined);
  // This step only ever mounts after a real, already-successful submission
  // (PlayPage only switches to it once submitQuiz() has resolved) - so
  // showing the celebration here, tied to a real mount rather than a
  // simulated click, is what "ties it to actual completion, not a timer"
  // means in practice. The timer that follows only controls how long the
  // celebration itself stays visible before fading.
  const [showCelebration, setShowCelebration] = useState(true);

  const keep = useCallback(
    (found: PlayerResultsWithAuth) => {
      if (found.player_auth && playerId !== undefined) {
        saveAttemptToken(code, playerId, found.player_auth.attempt_token);
      }
      // The results payload itself, without the credential riding beside it.
      const { player_auth: _auth, ...shown } = found;
      setResults(shown);
    },
    [code, playerId],
  );

  useEffect(() => {
    // The device that just submitted holds the attempt's token, which is what
    // opens these results with PINs switched on - no second PIN.
    const token = playerId !== undefined ? readAttemptToken(code, playerId) : null;
    getPlayerResults(code, playerName, playerId, ...(token ? [{ token }] : []))
      .then(keep)
      .catch((err) => {
        if (playerId !== undefined && isAuthRefusal(err)) {
          if (token) clearAttemptToken(code, playerId);
          setPinNotice(pinNoticeFor(err.reason, token !== null));
          return;
        }
        setError(getErrorMessage(err));
      });
  }, [code, playerName, playerId, keep]);

  useEffect(() => {
    const timer = setTimeout(() => setShowCelebration(false), CELEBRATION_MS);
    return () => clearTimeout(timer);
  }, []);

  if (error) return <ErrorBanner message={error} />;

  if (!results && pinNotice !== undefined && playerId !== undefined) {
    const who = player ?? { playerId, name: playerName, jerseyNumber: null, position: null };
    return (
      <PinStep
        title="See your results"
        player={who}
        notice={pinNotice ?? 'Enter your PIN to see your results.'}
        notYouLabel="Back"
        onNotYou={() => window.location.assign(`/play/${encodeURIComponent(code)}`)}
        onSubmitPin={async (pin) => {
          const found = await getPlayerResults(code, playerName, playerId, { pin });
          rememberPlayer(code, { ...who, playerId });
          keep(found);
        }}
      />
    );
  }

  const resultsUrl = `/results/${encodeURIComponent(code)}/${encodeURIComponent(playerName)}${
    playerId !== undefined ? `?player_id=${playerId}` : ''
  }`;

  return (
    <div className={styles.submittedWrapper}>
      {showCelebration && (
        <div className={styles.celebrationOverlay}>
          <div className={styles.celebrationBadge}>
            <Icon name="check" size={30} strokeWidth={3} />
          </div>
          <span className={styles.celebrationText}>Quiz Complete</span>
        </div>
      )}
      {!results ? (
        <LoadingState label="Loading your results…" />
      ) : (
        <div>
          <ResultsView results={results} />
          <p className={styles.bookmarkNote}>
            Written answers may still be waiting on your coach's review. Bookmark{' '}
            <a href={resultsUrl}>this link</a> to check back later once they're graded.
          </p>
        </div>
      )}
    </div>
  );
}
