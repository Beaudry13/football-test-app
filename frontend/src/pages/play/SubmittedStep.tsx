import { useEffect, useState } from 'react';
import { getPlayerResults } from '../../api/play';
import { getErrorMessage } from '../../api/client';
import type { PlayerResultsResponse } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { ResultsView } from './ResultsView';
import styles from './PlayPage.module.css';

export function SubmittedStep({ code, playerName }: { code: string; playerName: string }) {
  const [results, setResults] = useState<PlayerResultsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPlayerResults(code, playerName)
      .then(setResults)
      .catch((err) => setError(getErrorMessage(err)));
  }, [code, playerName]);

  if (error) return <ErrorBanner message={error} />;
  if (!results) return <p>Loading your results…</p>;

  const resultsUrl = `/results/${encodeURIComponent(code)}/${encodeURIComponent(playerName)}`;

  return (
    <div>
      <ResultsView results={results} />
      <p className={styles.bookmarkNote}>
        Written answers may still be waiting on your coach's review. Bookmark{' '}
        <a href={resultsUrl}>this link</a> to check back later once they're graded.
      </p>
    </div>
  );
}
