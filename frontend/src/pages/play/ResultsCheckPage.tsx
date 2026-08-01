import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { getPlayerResults } from '../../api/play';
import { getErrorMessage } from '../../api/client';
import type { PlayerResultsResponse } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { ResultsView } from './ResultsView';
import styles from './PlayPage.module.css';

/** A bookmarkable results page: /results/:code/:playerName auto-fetches (what
 * SubmittedStep's bookmark link points to), or /results shows a manual lookup form. */
export function ResultsCheckPage() {
  const params = useParams<{ code?: string; playerName?: string }>();
  const initialPlayerName = params.playerName ? decodeURIComponent(params.playerName) : '';
  const [code, setCode] = useState(params.code ?? '');
  const [playerName, setPlayerName] = useState(initialPlayerName);
  const [results, setResults] = useState<PlayerResultsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchResults = useCallback(async (codeValue: string, nameValue: string) => {
    setError(null);
    setIsLoading(true);
    try {
      setResults(await getPlayerResults(codeValue, nameValue));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (params.code && params.playerName) {
      fetchResults(params.code, decodeURIComponent(params.playerName));
    }
  }, [params.code, params.playerName, fetchResults]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim() || !playerName.trim()) return;
    fetchResults(code.trim(), playerName.trim());
  }

  if (results) {
    return (
      <div className={styles.wrapper}>
        <ResultsView results={results} />
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <form className={`card ${styles.panel}`} onSubmit={handleSubmit}>
        <h2>Check your results</h2>
        <p>Enter the access code and the name you played under.</p>
        <ErrorBanner message={error} />
        <div className="field">
          <input
            className={styles.codeInput}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={16}
            placeholder="CODE"
          />
        </div>
        <div className="field">
          <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="Your name" />
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={isLoading || !code.trim() || !playerName.trim()}
          style={{ width: '100%' }}
        >
          {isLoading ? 'Checking…' : 'View results'}
        </button>
      </form>
    </div>
  );
}
