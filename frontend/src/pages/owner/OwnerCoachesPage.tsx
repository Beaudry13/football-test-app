import { useEffect, useState } from 'react';
import { listOwnerCoaches, type OwnerCoachQuery } from '../../api/owner';
import { getErrorMessage } from '../../api/client';
import type { OwnerCoachRow } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { AttributedActivityNote, OwnerCoachTable } from './OwnerCoachTable';
import { count } from './ownerFormat';
import styles from './Owner.module.css';

const FILTERS: { value: OwnerCoachQuery['filter']; label: string; title: string }[] = [
  {
    value: 'with_activity',
    label: 'Has attributed activity',
    title: 'Has created a quiz, uploaded a playbook, or graded an answer',
  },
  {
    value: 'no_activity',
    label: 'None attributable',
    title: 'Nothing Peira can attribute to this coach - not necessarily inactive',
  },
];

/** Every coach account on the platform.
 *
 * The filters are phrased around ATTRIBUTION rather than activity on purpose:
 * "None attributable" is an honest description of what the data supports,
 * where "Inactive" would be a claim the schema cannot back. */
export function OwnerCoachesPage() {
  const [coaches, setCoaches] = useState<OwnerCoachRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<OwnerCoachQuery['filter']>(undefined);

  useEffect(() => {
    let cancelled = false;
    listOwnerCoaches({ search: search || undefined, filter })
      .then((result) => {
        if (!cancelled) setCoaches(result.coaches);
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [search, filter]);

  return (
    <div>
      <ErrorBanner message={error} />

      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="search"
          placeholder="Search by coach, email or organization"
          aria-label="Search coaches"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`${styles.toggle} ${filter === option.value ? styles.toggleActive : ''}`}
            aria-pressed={filter === option.value}
            title={option.title}
            onClick={() => setFilter(filter === option.value ? undefined : option.value)}
          >
            {option.label}
          </button>
        ))}
        {coaches && <span className={styles.resultCount}>{count(coaches.length)} shown</span>}
      </div>

      {!coaches ? <LoadingState /> : <OwnerCoachTable coaches={coaches} />}

      <div style={{ marginTop: 12 }}>
        <AttributedActivityNote />
      </div>
    </div>
  );
}
