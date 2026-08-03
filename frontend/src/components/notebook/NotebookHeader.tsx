import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { PeiraLogo } from '../brand/PeiraLogo';
import { OnboardingModal } from '../OnboardingModal';
import styles from '../../styles/notebook.module.css';

const ONBOARDING_SEEN_KEY = 'peira_onboarding_seen';

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
  // Auto-shows once per browser (not per session) the first time a coach
  // lands on any notebook-themed page, then stays dismissed - the "What is
  // Peira?" link is what makes it reachable again after that.
  const [onboardingOpen, setOnboardingOpen] = useState(
    () => localStorage.getItem(ONBOARDING_SEEN_KEY) !== 'true',
  );

  function handleLogout() {
    logout();
    navigate('/login');
  }

  function dismissOnboarding() {
    localStorage.setItem(ONBOARDING_SEEN_KEY, 'true');
    setOnboardingOpen(false);
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
          <span className={styles.whatIsPeira} onClick={() => setOnboardingOpen(true)}>
            What is Peira?
          </span>
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
      {coach && onboardingOpen && <OnboardingModal onDismiss={dismissOnboarding} />}
    </div>
  );
}
