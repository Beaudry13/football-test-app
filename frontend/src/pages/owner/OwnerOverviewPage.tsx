import { useEffect, useState } from 'react';
import { getPlatformOverview } from '../../api/owner';
import { getErrorMessage } from '../../api/client';
import type { PlatformOverview } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { count } from './ownerFormat';
import styles from './Owner.module.css';

const TOTALS: { key: keyof PlatformOverview['totals']; label: string }[] = [
  { key: 'organizations', label: 'Organizations' },
  { key: 'coaches', label: 'Coaches' },
  { key: 'active_players', label: 'Active players' },
  { key: 'quizzes', label: 'Quizzes' },
  { key: 'graded_attempts', label: 'Graded attempts' },
  { key: 'practice_attempts', label: 'Practice attempts' },
  { key: 'documents', label: 'Playbooks' },
];

const WINDOW_ROWS: { key: keyof PlatformOverview['windows'][string]; label: string }[] = [
  { key: 'new_organizations', label: 'New organizations' },
  { key: 'new_coaches', label: 'New coaches' },
  { key: 'new_quizzes', label: 'New quizzes' },
  { key: 'documents_uploaded', label: 'Playbooks uploaded' },
  { key: 'graded_attempts', label: 'Graded attempts submitted' },
  { key: 'practice_attempts', label: 'Practice attempts submitted' },
  { key: 'active_organizations', label: 'Organizations with activity' },
];

/** Platform command centre.
 *
 * Every figure here is derived from timestamps the product already wrote for
 * its own reasons. There is deliberately NO daily/monthly active user metric:
 * Peira records no logins or sessions, so any such number would be invented.
 * The definitions are stated on the page rather than hidden in a doc, because
 * an operator reading "8 organizations with activity" needs to know what
 * counted. */
export function OwnerOverviewPage() {
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPlatformOverview()
      .then(setOverview)
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  if (error) return <ErrorBanner message={error} />;
  if (!overview) return <LoadingState />;

  return (
    <div>
      <div className={styles.metricGrid}>
        {TOTALS.map((item) => (
          <div key={item.key} className={styles.metric}>
            <div className={styles.metricValue}>{count(overview.totals[item.key])}</div>
            <div className={styles.metricLabel}>{item.label}</div>
          </div>
        ))}
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Recent activity</h2>
        <p className={styles.sectionNote}>
          Rolling windows ending now. &ldquo;Organizations with activity&rdquo; means the
          organization built or edited a quiz, sent one to players, had a player start or submit an
          attempt, had an answer graded, uploaded a playbook, or changed a roster, group or folder.
          Signing in is not counted &mdash; Peira does not record logins.
        </p>
        <div className={styles.windowGrid}>
          {Object.keys(overview.windows)
            .sort((a, b) => Number(a) - Number(b))
            .map((days) => (
              <div key={days} className={styles.windowCard}>
                <div className={styles.windowTitle}>Last {days} days</div>
                {WINDOW_ROWS.map((row) => (
                  <div key={row.key} className={styles.windowRow}>
                    <span>{row.label}</span>
                    <strong>{count(overview.windows[days][row.key])}</strong>
                  </div>
                ))}
              </div>
            ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Feature adoption</h2>
        <p className={styles.sectionNote}>
          Organizations that have <strong>ever</strong> used each feature, derived from records the
          product already writes. This is adoption, not frequency &mdash; an organization that tried
          a feature once and stopped still counts here.
        </p>
        <div className={styles.adoptionList}>
          {overview.feature_adoption.map((feature) => (
            <div key={feature.key} className={styles.adoptionRow}>
              <div className={styles.adoptionCount}>{count(feature.organizations)}</div>
              <div className={styles.adoptionLabel}>{feature.label}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
