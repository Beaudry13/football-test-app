import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { previewInvite } from '../api/auth';
import { useAuth } from '../auth/AuthContext';
import { getErrorMessage } from '../api/client';
import { ErrorBanner } from '../components/ErrorBanner';
import { NotebookPage } from '../components/notebook/NotebookPage';
import { NotebookHeader } from '../components/notebook/NotebookHeader';
import nb from '../styles/notebook.module.css';
import styles from './AuthPages.module.css';

export function JoinOrgPage() {
  const { inviteCode } = useParams<{ inviteCode: string }>();
  const { registerWithInvite } = useAuth();
  const navigate = useNavigate();

  const [orgName, setOrgName] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!inviteCode) return;
    previewInvite(inviteCode)
      .then((result) => setOrgName(result.organization_name))
      .catch((err) => setInviteError(getErrorMessage(err)));
  }, [inviteCode]);

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!inviteCode) return;
    setError(null);
    setIsSubmitting(true);
    try {
      await registerWithInvite({ ...form, invite_code: inviteCode });
      navigate('/');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (inviteError) {
    return (
      <NotebookPage>
        <NotebookHeader />
        <div className={nb.contentNarrow}>
          <div className={`${nb.card} ${styles.form}`}>
            <h2 className={nb.subheading}>This invite can’t be used</h2>
            <ErrorBanner message={inviteError} />
            <p className={styles.footer}>
              Ask the coach who sent it for a new link, or <Link to="/login">log in</Link> if you
              already have an account.
            </p>
          </div>
        </div>
      </NotebookPage>
    );
  }

  return (
    <NotebookPage>
      <NotebookHeader />
      <div className={nb.contentNarrow}>
        <form className={`${nb.card} ${styles.form}`} onSubmit={handleSubmit}>
          <h2 className={nb.subheading}>{orgName ? `Join ${orgName}` : 'Join your team'}</h2>
          <ErrorBanner message={error} />
          <div className={nb.field}>
            <label className={nb.fieldLabel} htmlFor="username">
              Username
            </label>
            <input
              id="username"
              className={nb.input}
              type="text"
              required
              minLength={3}
              value={form.username}
              onChange={(e) => update('username', e.target.value)}
            />
          </div>
          <div className={nb.field}>
            <label className={nb.fieldLabel} htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className={nb.input}
              type="email"
              required
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
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
              minLength={8}
              value={form.password}
              onChange={(e) => update('password', e.target.value)}
            />
          </div>
          <button
            type="submit"
            className={nb.btnPrimary}
            disabled={isSubmitting || !orgName}
            style={{ width: '100%' }}
          >
            {isSubmitting ? 'Joining…' : 'Join team'}
          </button>
          <p className={styles.footer}>
            Already have an account? <Link to="/login">Log in</Link>
          </p>
        </form>
      </div>
    </NotebookPage>
  );
}
