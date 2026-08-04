import { useEffect, useState } from 'react';
import { getPlayerResults } from '../../api/play';
import { getErrorMessage } from '../../api/client';
import type { PlayerResultsResponse } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { ResultsView } from './ResultsView';
import styles from './PlayPage.module.css';

// How long the "Quiz Complete" celebration stays up before fading away to
// reveal the real results underneath.
const CELEBRATION_MS = 1800;

export function SubmittedStep({
  code,
  playerName,
  playerId,
}: {
  code: string;
  playerName: string;
  /** Set when this player is a canonical master-roster entry - threaded
   * into the results lookup and bookmark link so two players sharing a
   * display name never see each other's results. */
  playerId: number | undefined;
}) {
  const [results, setResults] = useState<PlayerResultsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // This step only ever mounts after a real, already-successful submission
  // (PlayPage only switches to it once submitQuiz() has resolved) - so
  // showing the celebration here, tied to a real mount rather than a
  // simulated click, is what "ties it to actual completion, not a timer"
  // means in practice. The timer that follows only controls how long the
  // celebration itself stays visible before fading.
  const [showCelebration, setShowCelebration] = useState(true);

  useEffect(() => {
    getPlayerResults(code, playerName, playerId)
      .then(setResults)
      .catch((err) => setError(getErrorMessage(err)));
  }, [code, playerName, playerId]);

  useEffect(() => {
    const timer = setTimeout(() => setShowCelebration(false), CELEBRATION_MS);
    return () => clearTimeout(timer);
  }, []);

  if (error) return <ErrorBanner message={error} />;

  const resultsUrl = `/results/${encodeURIComponent(code)}/${encodeURIComponent(playerName)}${
    playerId !== undefined ? `?player_id=${playerId}` : ''
  }`;

  return (
    <div className={styles.submittedWrapper}>
      {showCelebration && (
        <div className={styles.celebrationOverlay}>
          <div className={styles.celebrationBadge}>
            <span aria-hidden="true">✓</span>
          </div>
          <span className={styles.celebrationText}>Quiz Complete</span>
        </div>
      )}
      {!results ? (
        <p>Loading your results…</p>
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
