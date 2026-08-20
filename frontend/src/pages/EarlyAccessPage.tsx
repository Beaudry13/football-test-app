import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { NotebookPage } from '../components/notebook/NotebookPage';
import { NotebookHeader } from '../components/notebook/NotebookHeader';
import nb from '../styles/notebook.module.css';
import styles from './AuthPages.module.css';

/**
 * The public front door while Peira is invite-only.
 *
 * WHAT THIS REPLACED. `/register` was a generic signup form that created an
 * organization for anyone who filled it in, while the two real ways into Peira
 * - a beta invite and a request - were reachable only by typing their URLs. A
 * coach arriving at the site was told to Sign Up, and the product they signed
 * up to was not the one being run.
 *
 * TWO PATHS, AND A COACH IS ALWAYS ON EXACTLY ONE OF THEM. They either have an
 * invitation or they do not; there is no third case to explain. So the page is
 * two blocks and one sentence of context, rather than a paragraph about what
 * Early Access means.
 *
 * REQUESTING IS THE PRIMARY ACTION because of who actually lands here. An
 * invited coach arrives through their own unique link and never sees this page
 * at all - the code box exists only for somebody who was given a code by voice
 * or on paper, which is the rare case and is sized like one.
 *
 * THE URL IS STILL /register, ON PURPOSE. A bookmark or a "sign up at
 * peira/register" told to somebody last month still lands somewhere that makes
 * sense, rather than on a 404 - and it lands on the truth instead of on a form
 * that would quietly contradict it.
 *
 * THE TONE IS A FACT, NOT A VELVET ROPE. Peira is being built alongside a
 * small number of programs; that is the whole reason, and it is enough. No
 * countdown, no waitlist position, no "you have been selected".
 */
export function EarlyAccessPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');

  function handleCode(event: FormEvent) {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    // Straight to the invite page, which is where an invited coach would have
    // arrived from their link. It normalises and validates the code itself -
    // doing any of that twice is how two definitions of "valid" start to
    // disagree.
    navigate(`/invite/${encodeURIComponent(trimmed)}`);
  }

  return (
    <NotebookPage>
      <NotebookHeader />
      <div className={nb.contentNarrow}>
        <div className={`${nb.card} ${styles.form}`}>
          <h2 className={nb.subheading}>Peira is in early access</h2>
          <p className={styles.introText}>
            We’re building it alongside a small number of programs, so coaches join by invitation
            for now.
          </p>

          <div className={styles.earlyAccessPath}>
            <Link to="/request-access" className={nb.btnPrimary} style={{ width: '100%' }}>
              Request early access
            </Link>
          </div>

          {/* Sized as the rare path it is: an invited coach opens their own
              link and never reaches this page. This is for a code read out
              over the phone or written on a card. */}
          <form className={styles.inviteCodeRow} onSubmit={handleCode}>
            <label className={styles.inviteCodeLabel} htmlFor="invite-code">
              Have an invite code?
            </label>
            <div className={styles.inviteCodeControls}>
              <input
                id="invite-code"
                className={nb.input}
                type="text"
                placeholder="PEIRA-XXXX-XXXX-XXXX"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button type="submit" className={nb.btnSm} disabled={!code.trim()}>
                Continue
              </button>
            </div>
          </form>

          <p className={styles.footer}>
            Already have an account? <Link to="/login">Log in</Link>
          </p>
        </div>
      </div>
    </NotebookPage>
  );
}
