import { Outlet } from 'react-router-dom';
import { Tabs, type Tab } from '../components/ui/Tabs';
import nb from '../styles/notebook.module.css';
import styles from './TeamLayout.module.css';

const TABS: Tab[] = [
  { to: '/team', label: 'Players', end: true },
  { to: '/team/groups', label: 'Groups' },
  { to: '/team/coaches', label: 'Coaches' },
];

/**
 * One place for everything about the people in a program.
 *
 * WHAT THIS REPLACED. Roster, Groups and Team were three top-level
 * destinations, all describing people in the same organization. A coach
 * wanting to find a player, make a position group, or add another coach had to
 * remember which of the three it lived behind - and the names gave no help:
 * "Roster" and "Team" are the same word to most people.
 *
 * The question is now always answered the same way: Team, then which kind of
 * person. Players, Groups, Coaches.
 *
 * A SHELL, NOT A MERGE. The three screens underneath are the SAME components,
 * unchanged, rendered through an Outlet - the same nested-route pattern
 * OwnerLayout already uses. Nothing was combined: three APIs, three
 * permissions, three sets of behaviour, all exactly as they were. Stacking
 * them into one long page would have moved the clutter rather than removed it,
 * and would have recreated on this screen the wall the dashboard just stopped
 * being.
 *
 * ONLY THE SELECTED AREA IS ON SCREEN. That is the whole difference between
 * consolidating navigation and consolidating pages.
 *
 * The old /roster and /groups URLs still work - they redirect here, so a
 * bookmark or a link in somebody's notes keeps its meaning.
 */
export function TeamLayout() {
  return (
    <div>
      <div className={styles.header}>
        <h1 className={nb.heading}>Team</h1>
      </div>

      <Tabs tabs={TABS} label="Team sections" />

      <Outlet />
    </div>
  );
}
