import { useEffect, useState } from 'react';
import { createCoachInvite, listCoachInvites, revokeCoachInvite } from '../../api/owner';
import { getErrorMessage } from '../../api/client';
import type { CoachInvite, CoachInviteCreated } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { shortDate } from './ownerFormat';
import styles from './Owner.module.css';

/** Inviting a coach into the beta, from the dashboard rather than a shell.
 *
 * A COACH INVITE IS NOT A QUIZ ACCESS CODE. A player's access code unlocks one
 * quiz for a day and is typed off a sideline card; this creates an ACCOUNT and
 * the organization behind it. The words are kept apart everywhere on purpose -
 * confusing them is how a stranger ends up inside somebody's program.
 *
 * THE CODE IS SHOWN ONCE, WHEN IT IS CREATED. Only its SHA-256 is stored, so
 * there is no later request that could show it again; the list can only show a
 * prefix, which distinguishes two invites and redeems neither. That is why the
 * created code gets its own panel with a copy button rather than a row in the
 * table, and why the panel says plainly that it will not be shown again.
 *
 * OPERATIONAL, NOT A CRM. Issue, see the state, copy, revoke. No notes, no
 * reminders, no approve/deny workflow - deciding who gets in is the owner
 * thinking, and sending it is the owner's own email.
 */
export function CoachInvites() {
  const [invites, setInvites] = useState<CoachInvite[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** The one and only sight of a token. Held until dismissed. */
  const [justCreated, setJustCreated] = useState<CoachInviteCreated | null>(null);
  const [copied, setCopied] = useState(false);

  function reload() {
    listCoachInvites()
      .then((body) => setInvites(body.coach_invites))
      .catch((err) => setError(getErrorMessage(err)));
  }

  useEffect(reload, []);

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>Coach invites</h2>
      <p className={styles.sectionNote}>
        An invite lets one coach create their account and their own program. Send it yourself
        &mdash; Peira does not email anyone.
      </p>

      {error ? (
        <ErrorBanner message={error} />
      ) : (
        <>
          {!creating && !justCreated && (
            <button type="button" className={styles.inviteCreate} onClick={() => setCreating(true)}>
              Create invite
            </button>
          )}

          {creating && (
            <form
              className={styles.inviteForm}
              onSubmit={async (event) => {
                event.preventDefault();
                setIsSubmitting(true);
                setFormError(null);
                try {
                  const created = await createCoachInvite({
                    label: label.trim() || null,
                    expires_in_days: expiresInDays,
                  });
                  setJustCreated(created);
                  setCopied(false);
                  setCreating(false);
                  setLabel('');
                  reload();
                } catch (err) {
                  setFormError(getErrorMessage(err));
                } finally {
                  setIsSubmitting(false);
                }
              }}
            >
              <label className={styles.inviteFieldLabel} htmlFor="invite-label">
                Who is this for?
              </label>
              {/* A NOTE, NOT AN EMAIL FIELD. It answers "who was this one for"
                  in the window before redemption, where nothing else can.
                  Binding the invite to an address would tell a coach who signs
                  up from a different one that their invitation is invalid. */}
              <input
                id="invite-label"
                className={styles.inviteInput}
                placeholder="Coach Smith - Madeira"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />

              <label className={styles.inviteFieldLabel} htmlFor="invite-expiry">
                Expires
              </label>
              <select
                id="invite-expiry"
                className={styles.inviteInput}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(Number(e.target.value))}
              >
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={30}>30 days</option>
              </select>

              {formError && <ErrorBanner message={formError} />}

              <div className={styles.inviteFormActions}>
                <button type="submit" className={styles.inviteCreate} disabled={isSubmitting}>
                  {isSubmitting ? 'Creating…' : 'Create invite'}
                </button>
                <button
                  type="button"
                  className={styles.inviteCancel}
                  disabled={isSubmitting}
                  onClick={() => {
                    setCreating(false);
                    setFormError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {justCreated && (
            /* SHOWN ONCE. Nothing stores the plaintext, so this panel is the
               only chance to copy it - said out loud rather than discovered
               when the code is needed and gone. */
            <div className={styles.inviteCreated} role="status">
              <div className={styles.inviteCreatedLabel}>
                Invite created{justCreated.label ? ` for ${justCreated.label}` : ''}
              </div>
              <code className={styles.inviteToken}>{justCreated.token}</code>
              <p className={styles.inviteCreatedNote}>
                Copy it now &mdash; this code cannot be shown again. If it is lost, revoke this
                invite and create another.
              </p>
              <div className={styles.inviteFormActions}>
                <button
                  type="button"
                  className={styles.inviteCreate}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(justCreated.token);
                      setCopied(true);
                    } catch {
                      // Clipboard can be refused; the code is on screen either
                      // way, so this must not look like the invite failed.
                      setCopied(false);
                    }
                  }}
                >
                  {copied ? 'Copied' : 'Copy code'}
                </button>
                <button
                  type="button"
                  className={styles.inviteCancel}
                  onClick={() => setJustCreated(null)}
                >
                  Done
                </button>
              </div>
            </div>
          )}

          {invites === null ? (
            <LoadingState />
          ) : invites.length === 0 ? (
            <p className={styles.sectionNote}>No coach invites yet.</p>
          ) : (
            <ul className={styles.inviteList}>
              {invites.map((invite) => (
                <li key={invite.id} className={styles.inviteRow}>
                  <div className={styles.inviteWho}>
                    <strong>{invite.label ?? 'Unlabelled invite'}</strong>
                    <span className={styles.invitePrefix}>
                      PEIRA-{invite.token_prefix}…
                    </span>
                  </div>
                  <div className={styles.inviteMeta}>
                    <span className={styles[`status_${invite.status}`]}>
                      {STATUS_LABEL[invite.status]}
                      {invite.status === 'redeemed' && invite.redeemed_at
                        ? ` ${shortDate(invite.redeemed_at)}`
                        : ''}
                    </span>
                    {/* A PENDING invite is about its deadline; a finished one
                        is about when it was issued. An invite from before
                        expiry existed has no deadline at all, and says so
                        rather than showing a dash that reads like missing
                        data. */}
                    <span className={styles.inviteDate}>
                      {invite.status !== 'pending'
                        ? shortDate(invite.created_at)
                        : invite.expires_at
                          ? `Expires ${shortDate(invite.expires_at)}`
                          : 'No expiry'}
                    </span>
                    {invite.is_usable && (
                      <button
                        type="button"
                        className={styles.inviteRevoke}
                        onClick={async () => {
                          try {
                            await revokeCoachInvite(invite.id);
                            reload();
                          } catch (err) {
                            setError(getErrorMessage(err));
                          }
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

const STATUS_LABEL: Record<CoachInvite['status'], string> = {
  pending: 'Pending',
  redeemed: 'Redeemed',
  expired: 'Expired',
  revoked: 'Revoked',
};
