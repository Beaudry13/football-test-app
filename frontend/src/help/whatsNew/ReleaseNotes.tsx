import { RELEASES } from './releases';
import styles from '../Help.module.css';

/** The What's New article body: every release, newest first.
 *
 *  History is never trimmed. A coach who joins in November should still be
 *  able to read what changed in August, so opening the notes marks them read
 *  but removes nothing.
 *
 *  Renders whatever is in the registry and knows nothing about what is in it
 *  - see help/whatsNew/releases.ts. Screenshots and video would be rendered
 *  here from an optional per-release field; that is deliberately not built. */
export function ReleaseNotes() {
  return (
    <>
      {RELEASES.map((release) => (
        <section key={release.id} className={styles.release}>
          <h3 className={styles.releaseTitle}>{release.title}</h3>
          <p className={styles.releaseDate}>{release.date}</p>
          <p className={styles.body}>{release.summary}</p>
          <ul className={styles.list}>
            {release.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
