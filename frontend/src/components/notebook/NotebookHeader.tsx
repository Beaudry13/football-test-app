import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { PeiraLogo } from '../brand/PeiraLogo';
import { HelpMenu } from '../../help/HelpMenu';
import styles from '../../styles/notebook.module.css';

const NAV_LINKS = [
  // isActive checks a prefix rather than exact match, so e.g. viewing a
  // specific quiz (/quizzes/5) or its annotation tool still highlights
  // "Quizzes" instead of showing no active tab at all.
  {
    to: '/dashboard',
    label: 'Quizzes',
    isActive: (path: string) => path === '/dashboard' || path.startsWith('/quizzes'),
  },
  {
    to: '/documents',
    label: 'Playbooks',
    isActive: (path: string) => path.startsWith('/documents'),
    tour: 'playbooks',
  },
  {
    to: '/roster',
    label: 'Roster',
    isActive: (path: string) => path.startsWith('/roster'),
    tour: 'roster',
  },
  {
    to: '/groups',
    label: 'Groups',
    isActive: (path: string) => path.startsWith('/groups'),
    tour: 'groups',
  },
  { to: '/team', label: 'Team', isActive: (path: string) => path.startsWith('/team') },
];

// Shown only to admins, and kept out of NAV_LINKS so it renders visually
// apart from the normal tabs. Switching views is not the same kind of action
// as moving between sections: the tabs are all Coach View, and this leaves it.
const ADMIN_LINK = {
  to: '/admin/quizzes',
  label: 'Admin View',
  isActive: (path: string) => path.startsWith('/admin'),
};

// Shown only to Peira PLATFORM owners, and kept separate from ADMIN_LINK
// because it is a different level entirely: Admin View is one organization's
// view of itself, this is the product's view of every organization. An org
// admin never sees it, and hiding it is cosmetic anyway - /api/owner enforces
// the permission server-side.
const OWNER_LINK = {
  to: '/owner',
  label: 'Owner',
  isActive: (path: string) => path.startsWith('/owner'),
};

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
      {/* Signed in, this is the way back into the app; signed out (Login/
          Register/Join render this same header), "/" is the marketing
          homepage itself, so there's nowhere else for it to point. */}
      <Link to={coach ? '/dashboard' : '/'} className={styles.brand} aria-label="Peira">
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
              // Labels this link as tourable. An attribute, not a class, so
              // restyling the nav can never silently unhook the tour.
              data-tour={link.tour}
            >
              {link.label}
            </Link>
          ))}
          {/* Admins only. Coach View is everything to the left of this and
              is always where a page load lands; this is the one way out of
              it, and clicking any tab above comes straight back. */}
          {coach.role === 'admin' && (
            <>
              <span className={styles.navDivider} />
              <Link
                to={ADMIN_LINK.to}
                className={`${styles.navLink} ${
                  ADMIN_LINK.isActive(location.pathname) ? styles.navLinkActive : ''
                }`}
                // Absent for members, which is exactly how the tour's
                // "admins only" step works - no role check, just a target
                // that is not there.
                data-tour="admin-view"
              >
                {ADMIN_LINK.label}
              </Link>
            </>
          )}
          {/* Peira platform owners only - a level above the organization,
              rendered after Admin View so the escalation reads left to
              right: my work, my organization, the product. Hiding it is
              cosmetic; /api/owner enforces the permission server-side. */}
          {coach.is_platform_owner && (
            <>
              <span className={styles.navDivider} />
              <Link
                to={OWNER_LINK.to}
                className={`${styles.navLink} ${
                  OWNER_LINK.isActive(location.pathname) ? styles.navLinkActive : ''
                }`}
              >
                {OWNER_LINK.label}
              </Link>
            </>
          )}
          <span className={styles.navDivider} />
          {/* Everything a coach can be taught lives behind this one control,
              admins and members alike. It replaced a standalone "What is
              Peira?" link, whose content is now a Help article. */}
          <HelpMenu />
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
