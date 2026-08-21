import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { PeiraLogo } from '../brand/PeiraLogo';
import { HelpMenu } from '../../help/HelpMenu';
import { MenuButton, MenuItem, MenuLink } from '../ui/MenuButton';
import { SectionBar } from './SectionBar';
import { SECTION_LINKS } from './sections';
import styles from '../../styles/notebook.module.css';


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
    <>
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
          {/* HIDDEN ON A PHONE, where SectionBar shows these same three along
              the bottom instead. Never both: showing a coach the same three
              destinations twice would spend the vertical space that
              arrangement exists to give back. */}
          <div className={styles.sectionLinks}>
          {SECTION_LINKS.map((link) => (
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
          </div>
          <span className={styles.navDivider} />
          {/* Everything a coach can be taught lives behind this one control,
              admins and members alike. It replaced a standalone "What is
              Peira?" link, whose content is now a Help article. */}
          <HelpMenu />
          {/* WHERE THE ACCOUNT CLUSTER WENT.
              Admin View, Owner, the coach's name and Log out used to sit in
              this row as four more items. They are not navigation between
              sections - they are who you are, which view you are in, and how
              to leave - and on a 375px phone they were the difference between
              a two-row header and a four-row one. Peira already puts
              maintenance behind one control on quiz cards and folder rows;
              this is the same decision applied to the header.

              Rendered AFTER Help so the row reads: where you can go, how to
              learn, who you are. */}
          {/* data-tour lives on a wrapper, and ONLY for admins, so the tour's
              "admins only" step keeps working exactly as it did: no role
              check anywhere, just a target that is not there for members.
              The step used to point at a visible Admin View link; it now
              points at the control that contains it. */}
          <span data-tour={coach.role === 'admin' ? 'admin-view' : undefined}>
          <MenuButton
            label={`Account: ${coach.username}`}
            triggerClassName={styles.accountTrigger}
            trigger={<span className={styles.accountName}>{coach.username}</span>}
          >
            {/* Admins only. Coach View is every destination to the left of
                this and is always where a page load lands; this is the one
                way out of it, and any tab comes straight back. */}
            {coach.role === 'admin' && <MenuLink to={ADMIN_LINK.to}>{ADMIN_LINK.label}</MenuLink>}
            {/* Peira platform owners only - a level above the organization.
                Hiding it is cosmetic; /api/owner enforces the permission
                server-side. */}
            {coach.is_platform_owner && <MenuLink to={OWNER_LINK.to}>{OWNER_LINK.label}</MenuLink>}
            <MenuItem onSelect={handleLogout}>Log out</MenuItem>
          </MenuButton>
          </span>
        </div>
      )}

    </div>

    {/* A SIBLING OF THE HEADER, NOT A CHILD OF IT. The header is sticky and
        carries z-index 10, and anything inside it joins that stacking
        context - which would have put this bar at the header's level rather
        than the level it asks for, and made whether a row menu opens above
        or below it depend on DOM order rather than on a decision. Rendered
        from this component because it is the one thing every coach-facing
        page already has, and it knows whether anybody is signed in. */}
    {coach && <SectionBar />}
    </>
  );
}
