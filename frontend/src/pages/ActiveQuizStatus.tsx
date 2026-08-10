import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getActiveStatus } from '../api/quizzes';
import { getQuizDashboard } from '../api/grading';
import { usePolling } from '../hooks/usePolling';
import type { ActiveQuizStatus as ActiveQuizStatusEntry, QuestionBreakdown } from '../api/types';
import { Icon } from '../components/ui/Icon';
import { LoadingState } from '../components/ui/LoadingState';
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

function QuestionBreakdownTable({ breakdown }: { breakdown: QuestionBreakdown[] }) {
  return (
    <table className={nb.table}>
      <thead>
        <tr>
          <th>Question</th>
          <th>Correct</th>
          <th>Incorrect</th>
          <th>Ungraded</th>
        </tr>
      </thead>
      <tbody>
        {breakdown.map((q) => (
          <tr key={q.question_id}>
            <td>{q.question_text}</td>
            <td>{q.correct_count}</td>
            <td>{q.incorrect_count}</td>
            <td>{q.ungraded_count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ActiveQuizCard({ entry }: { entry: ActiveQuizStatusEntry }) {
  const pendingCount = entry.in_progress.length + entry.not_started.length;
  // Practice has unlimited retakes, so "pending against the roster" is not a
  // meaningful completion state - a player who has practised three times and
  // one who never will both sit outside "submitted". The counts are relabelled
  // rather than removed: a coach still wants to see who is getting reps.
  const submittedLabel = entry.is_practice ? 'practised' : 'submitted';
  const [isOpen, setIsOpen] = useState(false);
  const [breakdown, setBreakdown] = useState<QuestionBreakdown[] | null>(null);

  const fetchBreakdown = useCallback(async () => {
    try {
      const dashboard = await getQuizDashboard(entry.quiz_id);
      setBreakdown(dashboard.question_breakdown);
    } catch {
      // Same "leave last known state, let the next tick retry" reasoning
      // as the outer section's own poll - this is a nice-to-have snapshot,
      // not the only way to reach this data (the Results tab still works).
    }
  }, [entry.quiz_id]);

  useEffect(() => {
    if (isOpen) fetchBreakdown();
  }, [isOpen, fetchBreakdown]);

  usePolling(fetchBreakdown, POLL_INTERVAL_MS, isOpen);

  return (
    <div className={`${nb.card} ${nb.cardHoverable} ${styles.card}`}>
      <div className={nb.accentStripe} />
      {/* role=button rather than a real <button>: this header contains a
          <Link> to the quiz, and nesting an <a> inside a <button> is invalid
          HTML. Keyboard support (Enter/Space) and aria-expanded are wired up
          by hand to keep the accordion reachable without a mouse. */}
      <div
        className={styles.cardHeader}
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        aria-label={`${isOpen ? 'Collapse' : 'Expand'} live status for ${entry.quiz_title}`}
        onClick={() => setIsOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsOpen((v) => !v);
          }
        }}
      >
        <div>
          <Link
            to={`/quizzes/${entry.quiz_id}?tab=results`}
            className={styles.title}
            onClick={(e) => e.stopPropagation()}
          >
            {entry.quiz_title}
          </Link>
          <div className={styles.meta}>
            Sent to {sentToLabel(entry)} · {formatRelativeExpiry(entry.expires_at)}
          </div>
        </div>
        <div className={styles.counts}>
          {/* First, and unconditionally: a card reading "12 submitted" that
              silently meant practice reps would be read as twelve results. */}
          {entry.is_practice && (
            <span className={`${nb.badge} ${nb.badgeWarning}`}>Practice</span>
          )}
          <span className={`${nb.badge} ${nb.badgeSuccess}`}>
            {entry.submitted.length} {submittedLabel}
          </span>
          {!entry.is_practice && (
            <span className={`${nb.badge} ${nb.badgeWarning}`}>{pendingCount} pending</span>
          )}
          <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={16} />
        </div>
      </div>

      {isOpen && (
        <>
          <div className={styles.statusLists}>
            <div className={styles.statusColumn}>
              <h3 className={styles.columnHeading}>
                {entry.is_practice ? 'Practised' : 'Submitted'} ({entry.submitted.length})
              </h3>
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
              <h3 className={styles.columnHeading}>Pending ({pendingCount})</h3>
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

          <div className={styles.breakdownSection}>
            <h3 className={styles.columnHeading}>Answer breakdown</h3>
            {entry.is_practice && (
              // The breakdown comes from the quiz dashboard, which is official
              // -only by design. Saying so beats showing an empty table that
              // looks like nobody has answered anything.
              <p className={styles.emptyNote}>
                Practice answers are not included &mdash; this shows graded results only.
              </p>
            )}
            {breakdown == null ? (
              <LoadingState variant="inline" />
            ) : breakdown.length === 0 ? (
              <p className={styles.emptyNote}>No questions on this Quiz.</p>
            ) : (
              <QuestionBreakdownTable breakdown={breakdown} />
            )}
          </div>
        </>
      )}
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
      <h2 className={nb.headingSm}>Live now</h2>
      <div className={styles.cardList}>
        {entries.map((entry) => (
          <ActiveQuizCard key={entry.access_code_id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
