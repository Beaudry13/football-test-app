import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { validateCode } from '../../api/play';
import { itemFor, progressOf, rememberedCodes, sortWork, type WorkItem } from './workProgress';
import styles from './MyWork.module.css';

function actionLabel(item: WorkItem): string {
  if (item.action === 'review') return `Review missed (${item.missed})`;
  if (item.action === 'continue') return 'Continue';
  return item.kind === 'REP' ? 'Start your rep' : 'Start';
}

function kindLabel(item: WorkItem): string {
  if (item.retest) return 'Retest - your second look';
  if (item.kind === 'REP') return 'Rep';
  return item.graded ? 'Quiz' : 'Practice';
}

function closes(iso: string): string {
  const when = new Date(iso);
  return `Open until ${when.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

const linkFor = (item: WorkItem) => `/play/${encodeURIComponent(item.code)}${item.action === 'review' ? '?review=1' : ''}`;

/**
 * PLAYER HOME: "what do I need to do next?" - one thing leads, big; anything
 * else he has open sits quietly below; a new code is always one box away.
 *
 * Built from the codes this device has played (myWork), each re-checked with
 * the server so nothing closed or unknown is ever offered. With nothing on
 * this device it is exactly the code screen it always was.
 */
export function MyWork({ joinSlot }: { joinSlot: ReactNode }) {
  const [codes] = useState(rememberedCodes);
  const [items, setItems] = useState<WorkItem[] | null>(codes.length ? null : []);

  useEffect(() => {
    if (codes.length === 0) return;
    let cancelled = false;
    Promise.allSettled(codes.map((code) => validateCode(code).then((joined) => ({ code, joined })))).then((results) => {
      if (cancelled) return;
      const open = results.flatMap((r) =>
        r.status === 'fulfilled' ? [itemFor(r.value.code, r.value.joined, progressOf(r.value.code))] : [],
      );
      setItems(sortWork(open.filter((i): i is WorkItem => i !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [codes]);

  const [next, ...rest] = items ?? [];
  const names = [...new Set((items ?? []).map((i) => i.name).filter((n): n is string => !!n))];
  const first = names.length === 1 ? names[0].split(' ')[0] : null;

  /* ONE SHAPE IN EVERY STATE, so the code box keeps its place in the tree:
     a player who starts typing a new code while his work is being found
     never has the box reset under him. It never waits on the check. */
  return (
    <div className={styles.home}>
      {items === null && <p className={styles.checking}>Finding your work…</p>}
      {first && <p className={styles.hello}>Hi, {first}</p>}
      {next && (
      <section className={styles.next} aria-label="Up next">
        <span className={styles.kicker}>Up next</span>
        <h1 className={styles.title}>{next.title}</h1>
        <span className={styles.meta}>
          {kindLabel(next)} · {next.action === 'review' ? 'Your last run' : closes(next.expiresAt)}
          {names.length > 1 && next.name ? ` · ${next.name}` : ''}
        </span>
        <Link to={linkFor(next)} className={`btn btn-primary ${styles.go}`}>
          {actionLabel(next)}
        </Link>
      </section>
      )}
      {rest.length > 0 && (
        <section className={styles.also} aria-label="Also waiting">
          <h2 className={styles.alsoTitle}>Also waiting</h2>
          <ul className={styles.list}>
            {rest.map((item) => (
              <li key={item.code}>
                <Link to={linkFor(item)} className={styles.row}>
                  <span className={styles.rowTitle}>
                    {item.title}
                    <span className={styles.rowMeta}>
                      {' '}
                      · {kindLabel(item)}
                      {names.length > 1 && item.name ? ` · ${item.name}` : ''}
                    </span>
                  </span>
                  <span className={styles.rowAction}>{actionLabel(item)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className={next ? styles.newCode : undefined} aria-label="Got a new code?">
        {joinSlot}
      </section>
    </div>
  );
}
