import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getErrorMessage } from '../../api/client';
import { createInstall, listInstalls, updateInstall, type InstallSummary } from '../../api/installs';
import { listPlayers } from '../../api/players';
import type { Player } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import nb from '../../styles/notebook.module.css';
import { audiencesFrom } from '../reps/audiences';
import { contents } from './installDetail';
import styles from './Installs.module.css';

/**
 * INSTALLS: what he is installing - this week's first, in the order he last
 * worked on them; old weeks archived out of the way, never deleted with
 * their football. A new one is a name (and, for a position room, who it is
 * for); the football is added from the install, or from wherever it is.
 */
export function InstallsPage() {
  useDocumentTitle('Installs');
  const navigate = useNavigate();
  const [active, setActive] = useState<InstallSummary[] | null>(null);
  const [archived, setArchived] = useState<InstallSummary[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [title, setTitle] = useState('');
  const [group, setGroup] = useState('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audiences = useMemo(() => audiencesFrom(players), [players]);

  const load = () => {
    listInstalls()
      .then(setActive)
      .catch((err) => setError(getErrorMessage(err)));
    listInstalls(true)
      .then(setArchived)
      .catch(() => setArchived([]));
  };
  useEffect(() => {
    load();
    listPlayers({ active: 'true' })
      .then(setPlayers)
      .catch(() => setPlayers([]));
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const made = await createInstall({ title: title.trim(), position_group: group || null });
      navigate(`/installs/${made.id}`);
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };

  const restore = async (id: number) => {
    try {
      await updateInstall(id, { archived: false });
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const groupName = (key: string | null) => (key ? (audiences.find((a) => a.key === key)?.name ?? null) : null);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <h1 className={nb.heading}>Installs</h1>
          <p className={styles.meta}>This week&rsquo;s football, in the order you&rsquo;ll teach it.</p>
        </div>
      </header>
      <ErrorBanner message={error} />

      <form className={styles.newInstall} onSubmit={(e) => void create(e)}>
        <input
          className={nb.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Week 7 - Central"
          aria-label="New install name"
          maxLength={120}
        />
        {audiences.length > 0 && (
          <select className={nb.input} value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Who it is for">
            <option value="">The whole team</option>
            {audiences.map((a) => (
              <option key={a.key} value={a.key}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        <button type="submit" className={nb.btnPrimary} disabled={busy || !title.trim()}>
          {busy ? 'Starting…' : 'New install'}
        </button>
      </form>

      {active === null ? (
        <LoadingState label="Your installs" />
      ) : active.length === 0 ? (
        <p className={styles.quiet}>No install yet. Name this week&rsquo;s above, then add the football you&rsquo;re putting in.</p>
      ) : (
        <ul className={styles.installList}>
          {active.map((i, index) => (
            <li key={i.id} className={styles.installRow}>
              <div className={styles.itemMain}>
                <Link to={`/installs/${i.id}`} className={styles.installTitle}>
                  {i.title}
                </Link>
                <span className={styles.itemDetail}>
                  {index === 0 && <span className={styles.current}>This week · </span>}
                  {groupName(i.position_group) && `${groupName(i.position_group)} · `}
                  {contents(i)}
                </span>
              </div>
              {i.item_count > 0 && (
                <Link to={`/installs/${i.id}?teach=1`} className={styles.teachButton}>
                  Teach
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      {archived && archived.length > 0 && (
        <section className={styles.archived}>
          <button type="button" className={styles.linkButton} aria-expanded={showArchived} onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? 'Hide archived' : `Archived (${archived.length})`}
          </button>
          {showArchived && (
            <ul className={styles.installList}>
              {archived.map((i) => (
                <li key={i.id} className={styles.installRow}>
                  <div className={styles.itemMain}>
                    <Link to={`/installs/${i.id}`} className={styles.installTitle}>
                      {i.title}
                    </Link>
                    <span className={styles.itemDetail}>{contents(i)}</span>
                  </div>
                  <button type="button" className={styles.linkButton} onClick={() => void restore(i.id)}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
