import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getOwnerOrganization } from '../../api/owner';
import { getErrorMessage } from '../../api/client';
import type { OwnerOrganizationDetail } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { AttributedActivityNote, OwnerCoachTable } from './OwnerCoachTable';
import { count, exactTime, relativeDay, shortDate } from './ownerFormat';
import styles from './Owner.module.css';

const USAGE: { key: keyof OwnerOrganizationDetail['usage']; label: string }[] = [
  { key: 'coaches', label: 'Coaches' },
  { key: 'active_players', label: 'Active players' },
  { key: 'groups', label: 'Groups' },
  { key: 'folders', label: 'Folders' },
  { key: 'quizzes', label: 'Quizzes' },
  { key: 'documents', label: 'Playbooks' },
  { key: 'graded_attempts', label: 'Graded attempts' },
  { key: 'practice_attempts', label: 'Practice attempts' },
];

/** One organization's adoption picture.
 *
 * DELIBERATELY NOT A WINDOW INTO THEIR WORK. There is no quiz list, no player
 * roster, no playbook filenames - only how many of each exists, plus the
 * coach accounts needed to actually support the customer. If a support case
 * ever genuinely requires content, that should be a separate, explicit,
 * audited feature rather than something this page quietly grew. */
export function OwnerOrganizationDetailPage() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const [detail, setDetail] = useState<OwnerOrganizationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!organizationId) return;
    getOwnerOrganization(Number(organizationId))
      .then(setDetail)
      .catch((err) => setError(getErrorMessage(err)));
  }, [organizationId]);

  if (error) return <ErrorBanner message={error} />;
  if (!detail) return <LoadingState />;

  return (
    <div>
      <Link className={styles.backLink} to="/owner/organizations">
        ← All organizations
      </Link>

      <div className={styles.detailHead}>
        <h2 className={styles.detailName}>{detail.name}</h2>
        <div className={styles.detailMeta}>
          <span>
            Created <strong title={exactTime(detail.created_at)}>{shortDate(detail.created_at)}</strong>
          </span>
          <span>
            Last meaningful activity{' '}
            <strong
              className={detail.last_activity ? undefined : styles.unknown}
              title={exactTime(detail.last_activity)}
            >
              {relativeDay(detail.last_activity)}
            </strong>
          </span>
        </div>
      </div>

      <section className={styles.section}>
        <h3 className={styles.sectionHeading}>Usage</h3>
        <div className={styles.metricGrid}>
          {USAGE.map((item) => (
            <div key={item.key} className={styles.metric}>
              <div className={styles.metricValue}>{count(detail.usage[item.key])}</div>
              <div className={styles.metricLabel}>{item.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionHeading}>Features used</h3>
        <div className={styles.adoptionList}>
          {detail.features.map((feature) => (
            <div key={feature.key} className={styles.adoptionRow}>
              <div className={`${styles.adoptionCount} ${feature.used ? styles.adoptionUsed : ''}`}>
                {feature.used ? 'Yes' : 'No'}
              </div>
              <div className={styles.adoptionLabel}>{feature.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionHeading}>Coaches</h3>
        <OwnerCoachTable coaches={detail.coaches} showOrganization={false} />
        <div style={{ marginTop: 12 }}>
          <AttributedActivityNote />
        </div>
      </section>
    </div>
  );
}
