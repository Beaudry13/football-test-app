import { NavLink } from 'react-router-dom';
import styles from './Tabs.module.css';

export interface Tab {
  to: string;
  label: string;
  /** True for the index route, so "/team" does not stay lit on "/team/groups". */
  end?: boolean;
}

/**
 * The areas inside one section of Peira.
 *
 * ONE PRODUCT CONCEPT, NOT ONE SHAPE. Team and the Owner Dashboard are both a
 * section with a few areas inside it - Players/Groups/Coaches,
 * Overview/Organizations/Coaches - reached by nested routes, one at a time.
 * They had two implementations that agreed on everything except which token
 * alias they spelled and whether they scrolled on a phone. That is duplication
 * of a concept, not a coincidence of styling, which is why this is worth
 * sharing and a "looks similar" card would not be.
 *
 * NAVLINKS, NOT BUTTONS, and deliberately so: each area is a real address a
 * coach can bookmark, open in a new tab, or land on from a redirect. That also
 * means the browser gives us keyboard behaviour, focus and aria-current for
 * free - none of which a div-with-onClick would.
 *
 * STRUCTURAL ONLY. This is the two existing treatments merged, not a redesign;
 * the visual pass comes later and will change it once, here, rather than twice.
 */
export function Tabs({ tabs, label }: { tabs: Tab[]; label: string }) {
  return (
    <nav className={styles.tabs} aria-label={label}>
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end ?? false}
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
