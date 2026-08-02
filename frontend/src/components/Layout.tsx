import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import styles from './Layout.module.css';

export function Layout() {
  const { coach, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          🏈 Football Quiz Platform
        </Link>
        <nav className={styles.nav}>
          <Link to="/">Quizzes</Link>
          <Link to="/groups">Groups</Link>
          <Link to="/team">Team</Link>
          {coach ? (
            <div className={styles.coachInfo}>
              <span>{coach.username}</span>
              <button className="btn btn-secondary btn-sm" onClick={handleLogout}>
                Log out
              </button>
            </div>
          ) : (
            <Link to="/login">Log in</Link>
          )}
        </nav>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
