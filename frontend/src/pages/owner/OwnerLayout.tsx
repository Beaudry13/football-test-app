import { Navigate, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import styles from './Owner.module.css';

const TABS = [
  { to: '/owner', label: 'Overview', end: true },
  { to: '/owner/organizations', label: 'Organizations', end: false },
  { to: '/owner/coaches', label: 'Coaches', end: false },
];

/** Shell for the Peira Owner Dashboard.
 *
 * A LEVEL ABOVE ORGANIZATIONS, and it says so. The heading names the product
 * rather than the coach's team, and the sub-navigation is its own strip -
 * both so that it is never mistaken for another section of Coach View or for
 * the organization's Admin View.
 *
 * Rendering this shell is not a permission. Every screen underneath fetches
 * from /api/owner, which enforces platform ownership server-side; a non-owner
 * who typed the URL gets 404s from the API and no data.
 *
 * The redirect below is COSMETIC DEFENCE IN DEPTH, not the boundary. Without
 * it a non-owner who guessed the URL still saw this heading and sub-navigation
 * before the empty state arrived - no data, but the chrome itself confirmed
 * that an owner dashboard exists and what it is called, which is exactly what
 * the API's 404-instead-of-403 is chosen to avoid. Bouncing them to their own
 * dashboard makes the two layers tell the same story. */
export function OwnerLayout() {
  const { coach } = useAuth();
  if (coach && !coach.is_platform_owner) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>Peira — Owner Dashboard</h1>
      </div>
      <p className={styles.subtitle}>
        Platform adoption and usage across every organization. Read-only, and deliberately free of
        customer football content.
      </p>

      <nav className={styles.subnav}>
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              `${styles.subnavLink} ${isActive ? styles.subnavLinkActive : ''}`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
