import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { validateCode } from '../../api/play';
import { itemFor, progressOf, rememberedCodes, sortWork, type WorkItem } from './workProgress';
import styles from './MyWork.module.css';

function actionLabel(item: WorkItem): string {
  if (item.action === 'review' || item.action === 'results') return `Review missed (${item.missed})`;
  if (item.action === 'continue') return 'Continue';
  return item.kind === 'REP' ? 'Start your rep' : 'Start';
}

function kindLabel(item: WorkItem): string {
  if (item.retest) return 'Second look';
  if (item.retry) return 'Your misses, again';
  if (item.kind === 'REP') return 'Rep';
  return item.graded ? 'Quiz' : 'Practice';
}

function closes(iso: string): string {
  const when = new Date(iso);
  return `Open until ${when.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

function linkFor(item: WorkItem): string {
  // A graded quiz's misses are on his results page - the one the finish screen bookmarks.
  if (item.action === 'results' && item.name) {
    return `/results/${encodeURIComponent(item.code)}/${encodeURIComponent(item.name)}${
      item.playerId !== null ? `?player_id=${item.playerId}` : ''
    }`;
  }
  return `/play/${encodeURIComponent(item.code)}${item.action === 'review' ? '?review=1' : ''}`;
}

/**
 * PLAYER HOME: "what do I need to do next?" - one thing leads, big; anything
 * else he has open sits quietly below; a new code is always one box away.
 *
 * Built from the codes this device has played (myWork), each re-checked with
 * the server so nothing closed or unknown is ever offered. With nothing on
 * this device it is exactly the code screen it always was.
 */
export function MyWork({ joinSlot }: { joinSlot: (secondary: boolean) => ReactNode }) {
  const [codes] = useState(rememberedCodes);
  const [items, setItems] = useState<WorkItem[] | null>(codes.length ? null : []);
  /** Checks that never reached the server (offline) - not codes that closed. */
  const [unreachable, setUnreachable] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (codes.length === 0) return;
    let cancelled = false;
    setItems(null);
    Promise.allSettled(codes.map((code) => validateCode(code).then((joined) => ({ code, joined })))).then((results) => {
      if (cancelled) return;
      const open = results.flatMap((r) =>
        r.status === 'fulfilled' ? [itemFor(r.value.code, r.value.joined, progressOf(r.value.code))] : [],
      );
      // A closed or unknown code answers (4xx) - that work is simply over. No
      // answer at all is different: "all caught up" would be a guess.
      setUnreachable(results.filter((r) => r.status === 'rejected' && !(r.reason instanceof ApiError && r.reason.status >= 400 && r.reason.status < 500)).length);
      setItems(sortWork(open.filter((i): i is WorkItem => i !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [codes, attempt]);

  const [next, ...rest] = items ?? [];
  const names = [...new Set((items ?? []).map((i) => i.name).filter((n): n is string => !!n))];
  const first = names.length === 1 ? names[0].split(' ')[0] : null;

  /* ONE SHAPE IN EVERY STATE, so the code box keeps its place in the tree:
     a player who starts typing a new code while his work is being found
     never has the box reset under him. It never waits on the check. */
  return (
    <div className={styles.home}>
      {items === null && <p className={styles.checking}>Finding your work…</p>}
      {/* NOTHING TO DO IS AN ANSWER TOO - said, not left as an empty screen. */}
      {items !== null && items.length === 0 && codes.length > 0 && unreachable === 0 && (
        <p className={styles.caughtUp}>You&rsquo;re all caught up.</p>
      )}
      {items !== null && items.length === 0 && unreachable > 0 && (
        <div className={styles.caughtUp} role="alert">
          <p>Couldn&rsquo;t check your work.</p>
          <button type="button" className="btn btn-secondary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      {first && <p className={styles.hello}>Hi, {first}</p>}
      {next && (
      <section className={styles.next} aria-label="Up next">
        <span className={styles.kicker}>Up next</span>
        <h1 className={styles.title}>{next.title}</h1>
        <span className={styles.meta}>
          {kindLabel(next)} ·{' '}
          {next.action === 'review' ? 'Your last run' : next.action === 'results' ? 'Your results' : closes(next.expiresAt)}
          {names.length > 1 && next.name ? ` · ${next.name}` : ''}
        </span>
        {/* WHAT TO LEARN, in the coach's own words for it. */}
        {(next.action === 'review' || next.action === 'results') && next.workOn.length > 0 && (
          <span className={styles.workOn}>Work on: {next.workOn.join(', ')}</span>
        )}
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
      {/* Secondary whenever this device has played before - known at once,
          before the check, so the box never autofocuses over work that is
          about to appear. */}
      <section className={next ? styles.newCode : undefined} aria-label="Got a new code?">
        {joinSlot(codes.length > 0)}
      </section>
    </div>
  );
}
