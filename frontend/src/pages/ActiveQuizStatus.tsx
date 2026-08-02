import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getActiveStatus } from '../api/quizzes';
import { usePolling } from '../hooks/usePolling';
import type { ActiveQuizStatus as ActiveQuizStatusEntry } from '../api/types';
import nb from '../styles/notebook.module.css';
import styles from './ActiveQuizStatus.module.css';

const POLL_INTERVAL_MS = 15000;

function formatRelativeExpiry(expiresAt: string): string {
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (diffMs <= 0) return 'expiring now';
  const totalMinutes = Math.round(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `expires in ${minutes}m`;
  if (minutes === 0) return `expires in ${hours}h`;
  return `expires in ${hours}h ${minutes}m`;
}

function sentToLabel(entry: ActiveQuizStatusEntry): string {
  if (entry.group_names.length === 0) return `Whole roster (${entry.roster_size})`;
  return entry.group_names.join(', ');
}

function ActiveQuizCard({ entry }: { entry: ActiveQuizStatusEntry }) {
  const pendingCount = entry.in_progress.length + entry.not_started.length;

  return (
    <div className={`${nb.card} ${nb.cardHoverable} ${styles.card}`}>
      <div className={nb.accentStripe} />
      <div className={styles.cardHeader}>
        <div>
          <Link to={`/quizzes/${entry.quiz_id}?tab=results`} className={styles.title}>
            {entry.quiz_title}
          </Link>
          <div className={styles.meta}>
            Sent to {sentToLabel(entry)} · {formatRelativeExpiry(entry.expires_at)}
          </div>
        </div>
        <div className={styles.counts}>
          <span className={`${nb.badge} ${nb.badgeSuccess}`}>{entry.submitted.length} submitted</span>
          <span className={`${nb.badge} ${nb.badgeWarning}`}>{pendingCount} pending</span>
        </div>
      </div>

      <div className={styles.statusLists}>
        <div className={styles.statusColumn}>
          <h4 className={styles.columnHeading}>Submitted ({entry.submitted.length})</h4>
          {entry.submitted.length === 0 ? (
            <p className={styles.emptyNote}>No one yet.</p>
          ) : (
            <ul className={styles.nameList}>
              {entry.submitted.map((p) => (
                <li key={p.player_name}>{p.player_name}</li>
              ))}
            </ul>
          )}
        </div>

        <div className={styles.statusColumn}>
          <h4 className={styles.columnHeading}>Pending ({pendingCount})</h4>
          {pendingCount === 0 ? (
            <p className={styles.emptyNote}>Everyone has submitted.</p>
          ) : (
            <>
              {entry.in_progress.length > 0 && (
                <>
                  <div className={styles.subLabel}>Started, not submitted</div>
                  <ul className={styles.nameList}>
                    {entry.in_progress.map((p) => (
                      <li key={p.player_name}>{p.player_name}</li>
                    ))}
                  </ul>
                </>
              )}
              {entry.not_started.length > 0 && (
                <>
                  <div className={styles.subLabel}>Not started</div>
                  <ul className={styles.nameList}>
                    {entry.not_started.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Prominent, auto-refreshing "who's live right now" section for the main
 * Dashboard - shows every currently active quiz (there's no constraint
 * limiting an org to one at a time, so all of them get a card, not just
 * one) with a live submitted/pending breakdown. Renders nothing at all when
 * no quiz is active, rather than an empty-state card, so the common case
 * doesn't add clutter to the dashboard. */
export function ActiveQuizStatusSection() {
  const [entries, setEntries] = useState<ActiveQuizStatusEntry[] | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await getActiveStatus();
      setEntries(data);
    } catch {
      // A background poll failing shouldn't blank out or error-banner a
      // widget that was showing good data a moment ago - just leave the
      // last known state up and let the next tick try again. If we've
      // never loaded successfully, `entries` just stays null (renders
      // nothing), same as "no active quiz" - acceptable for a live-status
      // widget that isn't the only way to reach this data.
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  usePolling(fetchStatus, POLL_INTERVAL_MS);

  if (!entries || entries.length === 0) return null;

  return (
    <div className={styles.section}>
      <h2 className={nb.heading} style={{ fontSize: '1.5em' }}>
        Live now
      </h2>
      <div className={styles.cardList}>
        {entries.map((entry) => (
          <ActiveQuizCard key={entry.access_code_id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
