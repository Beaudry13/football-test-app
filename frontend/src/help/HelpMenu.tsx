import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { restoreOnboarding } from '../api/onboarding';
import { useTour } from './tour/tourContext';
import { HelpArticleModal } from './HelpArticleModal';
import { HELP_ACTIONS, HELP_ENTRIES, type HelpEntry } from './registry';
import styles from './Help.module.css';

/** The Help / Learn menu, permanently in the header for every signed-in coach.
 *
 *  Renders whatever is in the registry and knows nothing about what is in it -
 *  adding a topic never touches this file (see help/registry.tsx). Available
 *  to admins and members alike; nothing here is role-gated, because the thing
 *  a coach most needs help with is the part they have not been given yet.
 */
export function HelpMenu() {
  const [open, setOpen] = useState(false);
  const [article, setArticle] = useState<HelpEntry | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const tour = useTour();

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  /** Bring the setup checklist back and take the coach to where it lives.
   *
   *  Server-side, not localStorage: a coach who hid the checklist on their
   *  laptop and restores it on their phone gets it back on both. That is the
   *  whole reason dismissal is a column on the coach and not a browser key. */
  async function restoreChecklist() {
    await restoreOnboarding();
    // Navigating with a fresh key remounts the dashboard even when the coach
    // is already standing on it, so the checklist reappears on the click
    // rather than on their next visit.
    navigate('/dashboard', { replace: false, state: { restoredAt: Date.now() } });
  }

  async function handleEntry(entry: HelpEntry) {
    if (entry.kind === 'pending') return;
    setOpen(false);

    if (entry.kind === 'article') {
      setArticle(entry);
      return;
    }
    try {
      await entry.run?.({ restoreChecklist, startTour: tour.start });
    } catch {
      // Nothing useful to say here, and a help menu is the wrong place to
      // start reporting API failures. The checklist is unchanged; trying
      // again costs one click.
    }
  }

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        data-tour="help"
      >
        Help
      </button>

      {open && (
        <div className={styles.menu} role="menu" aria-label="Help">
          <ul className={styles.group}>
            {HELP_ENTRIES.map((entry) => (
              <MenuItem key={entry.id} entry={entry} onSelect={handleEntry} />
            ))}
          </ul>
          <ul className={`${styles.group} ${styles.actionGroup}`}>
            {HELP_ACTIONS.map((entry) => (
              <MenuItem key={entry.id} entry={entry} onSelect={handleEntry} />
            ))}
          </ul>
        </div>
      )}

      {article && (
        <HelpArticleModal title={article.title} onDismiss={() => setArticle(null)}>
          {article.body?.()}
        </HelpArticleModal>
      )}
    </div>
  );
}

function MenuItem({
  entry,
  onSelect,
}: {
  entry: HelpEntry;
  onSelect: (entry: HelpEntry) => void;
}) {
  const pending = entry.kind === 'pending';

  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        onClick={() => onSelect(entry)}
        disabled={pending}
        // Named by the title alone. Without this a screen reader announces
        // the summary as part of the item's name, so every entry is read as
        // a paragraph before the next one can be reached.
        aria-label={entry.title}
      >
        <span className={styles.itemTitle}>
          {entry.title}
          {/* Listed, but honest about it. A menu entry that opens nothing
              teaches a coach the menu is broken; one that says so teaches
              them it is coming. */}
          {pending && <span className={styles.soon}>Coming soon</span>}
        </span>
        <span className={styles.itemSummary}>{entry.summary}</span>
      </button>
    </li>
  );
}
