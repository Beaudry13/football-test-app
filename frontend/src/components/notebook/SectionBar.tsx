import { Link, useLocation } from 'react-router-dom';
import { SECTION_LINKS } from './sections';
import styles from './SectionBar.module.css';

/** Peira's primary navigation on a phone, along the bottom of the screen.
 *
 * WHY IT IS NOT AT THE TOP. The header is a single-row pill that wraps, and
 * on a 375px phone it wrapped four times - 185px, 23% of the screen, on every
 * page, before any content. The measurement that decided this: the pill's
 * usable inner width at 375px is 270px, and Quizzes + Playbooks + Team alone
 * are 247px of it. Brand plus those three is 357px. They were never going to
 * share a row with anything, so they were moved off it.
 *
 * NOT A HAMBURGER. The three destinations stay visible and one tap away; a
 * menu would have traded a coach's vertical space for their ability to see
 * where they can go, which is the wrong trade on the surface they open first.
 *
 * NEVER BOTH. The header hides these same three links below 40rem, so a coach
 * sees them exactly once. Duplicating them would give back the vertical space
 * with one hand and take it with the other.
 *
 * Signed-out pages never render this, because NotebookHeader only renders it
 * when there is a coach - and Login, Early Access and the marketing homepage
 * have nowhere for it to point.
 */
export function SectionBar() {
  const location = useLocation();

  return (
    <nav className={styles.bar} aria-label="Sections" data-section-bar>
      {SECTION_LINKS.map((link) => {
        const active = link.isActive(location.pathname);
        return (
          <Link
            key={link.to}
            to={link.to}
            className={`${styles.item} ${active ? styles.itemActive : ''}`}
            // Announced, not just coloured. A coach using a screen reader gets
            // the same "you are here" the gold bar gives everybody else.
            aria-current={active ? 'page' : undefined}
            data-tour={link.tour}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
