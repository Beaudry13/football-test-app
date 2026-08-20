import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { requestAccess } from '../api/auth';
import { getErrorMessage } from '../api/client';
import { ErrorBanner } from '../components/ErrorBanner';
import { NotebookPage } from '../components/notebook/NotebookPage';
import { NotebookHeader } from '../components/notebook/NotebookHeader';
import nb from '../styles/notebook.module.css';
import styles from './AuthPages.module.css';

/**
 * Putting your hand up for the beta.
 *
 * THE OTHER SIDE OF AN INVITE. `BetaInvitePage` is somebody who was invited;
 * this is somebody asking to be. It grants nothing - the reply is a person
 * deciding, not a screen.
 *
 * THREE FIELDS, AND THE THIRD IS OPTIONAL. Name, email, and the team if they
 * have one. No message box, no "how did you hear about us", no phone number.
 * Everything asked here is asked before this coach has any reason to trust
 * Peira, and the owner can ask anything else in the reply.
 *
 * THE CONFIRMATION IS THE SAME EVERY TIME, which is a security property and
 * not just a tone. A screen that said "you have already asked" would answer
 * "is this address known to Peira" for anybody who typed one in. The page
 * cannot tell the difference either, because the server does not say.
 *
 * NOT LINKED FROM ANYWHERE YET, on purpose: public registration is still
 * open, and a "Request access" link next to a working "Sign up" button is two
 * front doors and a confused coach. The link belongs with the decision to
 * close signup, not with building this.
 */
export function RequestAccessPage() {
  const [form, setForm] = useState({ name: '', email: '', team: '' });
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await requestAccess(form);
      setSent(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (sent) {
    return (
      <NotebookPage>
        <NotebookHeader />
        <div className={nb.contentNarrow}>
          <div className={`${nb.card} ${styles.form}`}>
            <h2 className={nb.subheading}>Thanks for asking</h2>
            <p className={styles.introText}>{sent}</p>
            <p className={styles.footer}>
              Already have an account? <Link to="/login">Log in</Link>
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
          <h2 className={nb.subheading}>Ask for early access</h2>
          <p className={styles.introText}>
            Peira is in early access and coaches join by invitation. Tell us who you are and we
            will be in touch.
          </p>
          <ErrorBanner message={error} />
          <div className={nb.field}>
            <label className={nb.fieldLabel} htmlFor="name">
              Your name
            </label>
            <input
              id="name"
              className={nb.input}
              type="text"
              required
              autoComplete="name"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
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
            <label className={nb.fieldLabel} htmlFor="team">
              Team or program <span className={styles.optional}>(optional)</span>
            </label>
            <input
              id="team"
              className={nb.input}
              type="text"
              value={form.team}
              onChange={(e) => update('team', e.target.value)}
            />
          </div>
          <button
            type="submit"
            className={nb.btnPrimary}
            disabled={isSubmitting}
            style={{ width: '100%' }}
          >
            {isSubmitting ? 'Sending…' : 'Request access'}
          </button>
          <p className={styles.footer}>
            Already have an account? <Link to="/login">Log in</Link>
          </p>
        </form>
      </div>
    </NotebookPage>
  );
}
