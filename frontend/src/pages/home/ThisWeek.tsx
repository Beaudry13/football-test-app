import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { listInstalls, type InstallSummary } from '../../api/installs';
import { contents } from '../installs/installDetail';
import styles from './ThisWeek.module.css';

/**
 * CURRENT INSTALL: the one quiet continuation line on Home - the install he
 * chose as current (never just the one he last edited), one tap from opening
 * it or teaching it. Without one, Home keeps its "pick up where you left off"
 * line (`fallback`), so there is never more than one.
 */
export function ThisWeek({ fallback }: { fallback: ReactNode }) {
  // undefined while asking: nothing shows, so the line never swaps under him.
  const [current, setCurrent] = useState<InstallSummary | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    listInstalls()
      .then((list) => live && setCurrent(list.find((i) => i.current) ?? null))
      .catch(() => live && setCurrent(null));
    return () => {
      live = false;
    };
  }, []);

  if (current === undefined) return null;
  if (current === null) return <>{fallback}</>;
  return (
    <p className={styles.thisWeek}>
      Current install:{' '}
      <Link to={`/installs/${current.id}`} className={styles.title}>
        {current.title}
      </Link>
      <span className={styles.contents}> · {contents(current)}</span>
      {current.item_count > 0 && (
        <>
          {' · '}
          <Link to={`/installs/${current.id}?teach=1`} className={styles.teach}>
            Teach
          </Link>
        </>
      )}
    </p>
  );
}
