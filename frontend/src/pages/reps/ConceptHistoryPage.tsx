import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { activateQuiz } from '../../api/accessCodes';
import { getErrorMessage } from '../../api/client';
import { createRepRetest, getConceptHistory, type ConceptHistory } from '../../api/reps';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import nb from '../../styles/notebook.module.css';
import { taughtLine } from './taught';
import rep from './RepPage.module.css';
import styles from './ConceptHistoryPage.module.css';

/** How many points the trend line shows - the arc, not the archive. */
const TREND_POINTS = 6;

const day = (at: string | null) =>
  at ? new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';

/**
 * ONE FOOTBALL PROBLEM, OVER TIME - not a dashboard. Is it getting better
 * (64% -> 67% -> 82%, first tries), who is still missing it, and the one next
 * step: Teach it, or Retest the players who missed it on the latest Rep.
 */
export function ConceptHistoryPage() {
  const { conceptId } = useParams<{ conceptId: string }>();
  const id = Number(conceptId);
  const navigate = useNavigate();
  const [history, setHistory] = useState<ConceptHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useDocumentTitle(history ? `${history.concept.name} - Football problem` : 'Football problem');

  const load = useCallback(() => {
    getConceptHistory(id)
      .then(setHistory)
      .catch((err) => setError(getErrorMessage(err)));
  }, [id]);

  useEffect(() => {
    setHistory(null);
    load();
  }, [load]);

  const latest = history?.latest ?? null;
  const points = history?.points ?? [];
  const shown = points.slice(-TREND_POINTS);

  /** Retest = a new Rep of this problem for exactly the players who missed it on the latest Rep, sent, opened. */
  const retest = async () => {
    if (!latest) return;
    setBusy(true);
    setError(null);
    try {
      const made = await createRepRetest(latest.rep_id, id);
      await activateQuiz(made.id, [], 'PRACTICE');
      navigate(`/reps/${made.id}`);
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div>
      <Link to="/reps" className={rep.back}>
        ← Reps
      </Link>
      <ErrorBanner message={error} />
      {!history && !error && <LoadingState />}
      {history && (
        <>
          <header className={rep.head}>
            <span className={rep.kicker}>Football problem</span>
            <h1 className={nb.heading}>{history.concept.name}</h1>
          </header>

          {points.length === 0 ? (
            <p className={rep.waiting}>None of your reps has tested this yet.</p>
          ) : (
            <>
              <p className={styles.trend} aria-label="First-try trend">
                {points.length > shown.length && <span className={styles.trendMore}>… </span>}
                {shown.map((p, i) => (
                  <span key={p.rep_id}>
                    {i > 0 && <span className={styles.arrow}> → </span>}
                    <span className={i === shown.length - 1 ? styles.now : undefined}>{p.pct}%</span>
                  </span>
                ))}
              </p>
              <p className={styles.trendNote}>
                First tries, across {points.length} {points.length === 1 ? 'rep' : 'reps'}.
              </p>

              {latest && (
                <section className={styles.next} aria-label="Next step">
                  {latest.missed === 0 ? (
                    <p className={rep.nextLine}>Nobody missed it on the latest rep.</p>
                  ) : latest.retest ? (
                    <>
                      <p className={rep.nextLine}>
                        {latest.retest.ran === 0
                          ? `Retest is out to ${latest.retest.invited} - nobody has run it yet.`
                          : `Retest: ${latest.retest.missed} of ${latest.retest.responded} still missing.`}
                      </p>
                      <div className={rep.actions}>
                        <Link to={`/reps/${latest.retest.id}`} className={`${nb.btnPrimary} ${rep.linkButton}`}>
                          Open retest
                        </Link>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className={rep.nextLine}>
                        {latest.missed} of {latest.responded} missed it on <Link to={`/reps/${latest.rep_id}`}>{latest.title}</Link>.
                        {latest.taught && <> {taughtLine(latest.taught)} Now see if it stuck.</>}
                      </p>
                      <div className={rep.actions}>
                        <Link
                          to={`/reps/${latest.rep_id}?teach=${id}`}
                          className={`${latest.taught ? nb.btnSecondary : nb.btnPrimary} ${rep.linkButton}`}
                        >
                          Teach
                        </Link>
                        <button
                          type="button"
                          className={latest.taught ? nb.btnPrimary : nb.btnSecondary}
                          onClick={() => setConfirming(true)}
                          disabled={busy}
                        >
                          Retest
                        </button>
                      </div>
                      {confirming && (
                        <div className={rep.confirm} role="group" aria-label="Retest">
                          <span>
                            Send {history.concept.name} back to the {latest.missed}{' '}
                            {latest.missed === 1 ? 'player' : 'players'} who missed it?
                          </span>
                          <button type="button" className={nb.btnPrimary} disabled={busy} onClick={() => void retest()}>
                            {busy ? 'Sending…' : 'Send it'}
                          </button>
                          <button type="button" className={nb.btnSm} disabled={busy} onClick={() => setConfirming(false)}>
                            Not now
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>
              )}

              <section className={styles.block} aria-label="Still missing it">
                <h2 className={styles.blockTitle}>Still missing it</h2>
                {history.still_missing.length === 0 ? (
                  <p className={styles.none}>Nobody - everyone got it on their latest try.</p>
                ) : (
                  <div className={rep.chips}>
                    {history.still_missing.map((p) =>
                      p.player_id !== null ? (
                        <Link key={p.key} to={`/roster/${p.player_id}`} className={rep.chip}>
                          {p.display_name}
                        </Link>
                      ) : (
                        <span key={p.key} className={rep.chip}>
                          {p.display_name}
                        </span>
                      ),
                    )}
                  </div>
                )}
              </section>

              <section className={styles.block} aria-label="Recent reps">
                <h2 className={styles.blockTitle}>Recent reps</h2>
                <ul className={styles.recent}>
                  {history.recent.map((p) => (
                    <li key={p.rep_id}>
                      <Link to={`/reps/${p.rep_id}`} className={styles.recentRow}>
                        <span className={styles.recentTitle}>
                          {p.title}
                          {p.is_retest && <span className={styles.retestTag}>retest</span>}
                        </span>
                        <span className={styles.recentMeta}>{day(p.at)}</span>
                        <span className={styles.recentPct}>{p.pct}%</span>
                        <span className={styles.recentMeta}>
                          {p.missed} of {p.responded} missed
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
