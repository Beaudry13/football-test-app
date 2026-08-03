import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { PeiraLogo } from '../brand/PeiraLogo';
import styles from '../../styles/notebook.module.css';

const NAV_LINKS = [
  // isActive checks a prefix rather than exact match, so e.g. viewing a
  // specific quiz (/quizzes/5) or its annotation tool still highlights
  // "Quizzes" instead of showing no active tab at all.
  { to: '/', label: 'Quizzes', isActive: (path: string) => path === '/' || path.startsWith('/quizzes') },
  { to: '/groups', label: 'Groups', isActive: (path: string) => path.startsWith('/groups') },
  { to: '/team', label: 'Team', isActive: (path: string) => path.startsWith('/team') },
];

/** Shared header for every notebook-themed page. Reads auth state itself
 * (no props needed) so it can be dropped into any page: shows the full
 * nav + coach name + logout when signed in, or just the brand when not
 * (Login/Register/Join). Active nav link is derived from the current
 * route rather than passed in, so it never drifts out of sync. */
export function NotebookHeader() {
  const { coach, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className={styles.header}>
      <Link to="/" className={styles.brand} aria-label="Peira">
        <PeiraLogo variant="dark" size={30} />
      </Link>
      {/* Logged-out pages (Login/Register/Join) are themselves the way to
          get signed in, so there's nothing useful to put in the nav - just
          the brand, for visual consistency with the rest of the app. */}
      {coach && (
        <div className={styles.nav}>
          {NAV_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={`${styles.navLink} ${link.isActive(location.pathname) ? styles.navLinkActive : ''}`}
            >
              {link.label}
            </Link>
          ))}
          <span className={styles.navDivider} />
          <span className={styles.coachName}>{coach.username}</span>
          <button className={styles.logoutButton} onClick={handleLogout}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
