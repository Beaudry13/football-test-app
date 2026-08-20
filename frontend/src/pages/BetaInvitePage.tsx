import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getErrorMessage } from '../api/client';
import { ErrorBanner } from '../components/ErrorBanner';
import { NotebookPage } from '../components/notebook/NotebookPage';
import { NotebookHeader } from '../components/notebook/NotebookHeader';
import nb from '../styles/notebook.module.css';
import styles from './AuthPages.module.css';

/**
 * Redeeming a Peira invite: four fields and a button.
 *
 * THIS IS NOT `JoinOrgPage`. That one adds a coach to a program that already
 * exists, so it previews the organization's name and never asks for one. This
 * one CREATES the program, so the name is the fourth field and there is
 * nothing to preview - which is why the route is `/invite/:token` rather than
 * `/join/:inviteCode`. The two must not be one page: telling them apart by the
 * shape of a token is the kind of cleverness that eventually puts a stranger
 * inside somebody else's program.
 *
 * NO PREVIEW, DELIBERATELY. There is no organization name to show before the
 * form, so a validity check would buy nothing except an endpoint that answers
 * "does this token exist" for anyone who asks. A coach with a dead link finds
 * out on submit, which is the rare path.
 *
 * NO ONBOARDING. Name, email, password, program. The next screen a coach sees
 * is their own dashboard, not a tour.
 */
export function BetaInvitePage() {
  const { token } = useParams<{ token: string }>();
  const { registerWithBetaInvite } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ username: '', email: '', password: '', organization: '' });
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setError(null);
    setIsSubmitting(true);
    try {
      await registerWithBetaInvite({ ...form, invite_code: token });
      // `replace`, not a push. The invite is a credential and it is spent -
      // leaving it in the address bar, and in the back-button history, keeps a
      // used-up secret on screen for no reason.
      navigate('/dashboard', { replace: true });
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
        <form className={`${nb.card} ${styles.form}`} onSubmit={handleSubmit}>
          <h2 className={nb.subheading}>Set up your Peira</h2>
          <p className={styles.introText}>
            Peira is in early access. This invite creates your account and your program.
          </p>
          <ErrorBanner message={error} />
          <div className={nb.field}>
            <label className={nb.fieldLabel} htmlFor="username">
              Your name
            </label>
            <input
              id="username"
              className={nb.input}
              type="text"
              required
              minLength={3}
              autoComplete="name"
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
              autoComplete="email"
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
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => update('password', e.target.value)}
            />
          </div>
          <div className={nb.field}>
            <label className={nb.fieldLabel} htmlFor="organization">
              Program name
            </label>
            <input
              id="organization"
              className={nb.input}
              type="text"
              required
              placeholder="Madeira Mustangs"
              value={form.organization}
              onChange={(e) => update('organization', e.target.value)}
            />
          </div>
          <button
            type="submit"
            className={nb.btnPrimary}
            disabled={isSubmitting}
            style={{ width: '100%' }}
          >
            {isSubmitting ? 'Setting up…' : 'Create my Peira'}
          </button>
          <p className={styles.footer}>
            Already have an account? <Link to="/login">Log in</Link>
          </p>
        </form>
      </div>
    </NotebookPage>
  );
}
