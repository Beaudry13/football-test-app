import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getErrorMessage } from '../api/client';
import { ErrorBanner } from '../components/ErrorBanner';
import { NotebookPage } from '../components/notebook/NotebookPage';
import { NotebookHeader } from '../components/notebook/NotebookHeader';
import nb from '../styles/notebook.module.css';
import styles from './AuthPages.module.css';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <NotebookPage>
      <NotebookHeader />
      <div className={nb.contentNarrow}>
        <div className={styles.intro}>
          <h1 className={nb.heading} style={{ fontSize: '2em' }}>
            Know it before you play it.
          </h1>
          <p className={styles.introText}>
            Peira comes from an Ancient Greek word meaning trial, test, and experience gained
            through testing. In football, preparation isn't complete until knowledge has been
            tested — Peira gives coaches a clearer picture of what their players understand,
            while giving athletes the mental reps they need to perform with confidence.
          </p>
        </div>
        <form className={`${nb.card} ${styles.form}`} onSubmit={handleSubmit}>
          <h2 className={nb.subheading}>Coach log in</h2>
          <ErrorBanner message={error} />
          <div className={nb.field}>
            <label className={nb.fieldLabel} htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className={nb.input}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className={nb.field}>
            <label className={nb.fieldLabel} htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className={nb.input}
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button type="submit" className={nb.btnPrimary} disabled={isSubmitting} style={{ width: '100%' }}>
            {isSubmitting ? 'Logging in…' : 'Log in'}
          </button>
          <p className={styles.footer}>
            New here? <Link to="/register">Create an account</Link>
          </p>
        </form>
      </div>
    </NotebookPage>
  );
}
