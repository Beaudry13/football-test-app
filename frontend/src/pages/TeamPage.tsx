import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  getOrganization,
  listInvites,
  removeMember,
  renameOrganization,
  requestStaffInvite,
  revokeInvite,
  updateMemberRole,
} from '../api/organizations';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { Organization, OrganizationInvite } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { useConfirmDialog } from '../components/ConfirmDialog';
import nb from '../styles/notebook.module.css';
import styles from './TeamPage.module.css';
import { LoadingState } from '../components/ui/LoadingState';

export function TeamPage() {
  const { coach } = useAuth();
  const isAdmin = coach?.role === 'admin';

  const [org, setOrg] = useState<Organization | null>(null);
  const [invites, setInvites] = useState<OrganizationInvite[]>([]);
  const [orgName, setOrgName] = useState('');
  const [staffRequest, setStaffRequest] = useState({ name: '', email: '' });
  const [requestSent, setRequestSent] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();

  const refresh = useCallback(async () => {
    try {
      const organization = await getOrganization();
      setOrg(organization);
      setOrgName(organization.name);
      // Invite management is admin-only; members get a 403 we shouldn't
      // surface as an error on a page they're allowed to view.
      if (coach?.role === 'admin') {
        setInvites(await listInvites());
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [coach?.role]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleRename(event: FormEvent) {
    event.preventDefault();
    if (!org || !orgName.trim() || orgName.trim() === org.name) return;
    setError(null);
    setIsBusy(true);
    try {
      await renameOrganization({ name: orgName.trim() });
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRequestStaffInvite(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsBusy(true);
    try {
      await requestStaffInvite({
        name: staffRequest.name.trim(),
        email: staffRequest.email.trim(),
      });
      setStaffRequest({ name: '', email: '' });
      setRequestSent(true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRevoke(inviteId: number) {
    setError(null);
    try {
      await confirm({
        title: 'Revoke Invite?',
        body: 'The invite link will stop working immediately. Anyone who has not joined yet will need a new one.',
        confirmLabel: 'Revoke Invite',
        action: async () => {
          await revokeInvite(inviteId);
          await refresh();
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleRoleChange(coachId: number, role: 'admin' | 'member') {
    setError(null);
    try {
      await updateMemberRole(coachId, role);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleRemove(coachId: number, username: string) {
    setError(null);
    try {
      await confirm({
        title: 'Remove Coach?',
        body: `${username} will lose access to this organization. Quizzes they created stay with the team.`,
        confirmLabel: 'Remove Coach',
        action: async () => {
          await removeMember(coachId);
          await refresh();
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  if (!org) {
    return (
      <div>
        <ErrorBanner message={error} />
        {!error && <LoadingState />}
      </div>
    );
  }

  const pendingInvites = invites.filter((i) => i.is_usable);

  return (
    <div>
      {dialog}
      <div className={styles.header}>
        <h1 className={nb.heading}>{org.name}</h1>
      </div>

      <ErrorBanner message={error} />

      {isAdmin && (
        <form className={styles.renameForm} onSubmit={handleRename}>
          <input
            className={nb.input}
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            aria-label="Organization name"
          />
          <button
            type="submit"
            className={nb.btnSm}
            disabled={isBusy || !orgName.trim() || orgName.trim() === org.name}
          >
            Rename
          </button>
        </form>
      )}

      <div className={`${nb.card} ${styles.card}`}>
        <h2 className={nb.subheading}>Coaches ({org.members.length})</h2>
        <table className={nb.table}>
          <thead>
            <tr>
              <th>Coach</th>
              <th>Email</th>
              <th>Role</th>
              {isAdmin && <th />}
            </tr>
          </thead>
          <tbody>
            {org.members.map((member) => (
              <tr key={member.id}>
                <td>
                  {member.username}
                  {member.id === coach?.id && <span className={styles.you}> (you)</span>}
                </td>
                <td>{member.email}</td>
                <td>
                  <span
                    className={`${nb.badge} ${member.role === 'admin' ? nb.badgeSuccess : nb.badgeNeutral}`}
                  >
                    {member.role}
                  </span>
                </td>
                {isAdmin && (
                  <td>
                    <div className={styles.memberActions}>
                      <button
                        className={nb.btnSm}
                        onClick={() =>
                          handleRoleChange(member.id, member.role === 'admin' ? 'member' : 'admin')
                        }
                      >
                        {member.role === 'admin' ? 'Make member' : 'Make admin'}
                      </button>
                      {member.id !== coach?.id && (
                        <button
                          className={`${nb.btnSm} ${nb.btnDanger}`}
                          onClick={() => handleRemove(member.id, member.username)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* REPLACED "Create invite link", not added beside it. Two ways to get a
          colleague in - one instant, one reviewed - would be two answers to one
          question, and the instant one is exactly what Early Access is closing.
          The backend agrees: see invites.may_issue_invites_directly. */}
      {isAdmin && (
        <div className={`${nb.card} ${styles.card}`}>
          <h2 className={nb.subheading}>Request a staff invite</h2>
          <p>
            Tell us who to invite and we’ll send them a link to join {org.name}. They
            won’t have to type your program name.
          </p>

          {requestSent ? (
            /* THE WHOLE CONFIRMATION. No queue position, no reference number,
               no status to come back and check - approval is our job, and
               exposing its mechanics would invite the coach to manage it. */
            <p className={styles.requestSent}>
              Request sent. We’ll email them an invite once it’s approved.{' '}
              <button
                type="button"
                className={styles.requestAnother}
                onClick={() => setRequestSent(false)}
              >
                Request another
              </button>
            </p>
          ) : (
            <form className={styles.requestForm} onSubmit={handleRequestStaffInvite}>
              <div className={nb.field}>
                <label className={nb.fieldLabel} htmlFor="staff-name">
                  Name
                </label>
                <input
                  id="staff-name"
                  className={nb.input}
                  type="text"
                  required
                  value={staffRequest.name}
                  onChange={(e) => setStaffRequest((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className={nb.field}>
                <label className={nb.fieldLabel} htmlFor="staff-email">
                  Email
                </label>
                <input
                  id="staff-email"
                  className={nb.input}
                  type="email"
                  required
                  value={staffRequest.email}
                  onChange={(e) => setStaffRequest((f) => ({ ...f, email: e.target.value }))}
                />
              </div>
              <button type="submit" className={nb.btnPrimary} disabled={isBusy}>
                {isBusy ? 'Sending…' : 'Request invite'}
              </button>
            </form>
          )}

          {pendingInvites.length > 0 && (
            <>
              <h4 className={styles.subListHeading}>Pending invites ({pendingInvites.length})</h4>
              <table className={nb.table}>
                <thead>
                  <tr>
                    <th>Created by</th>
                    <th>Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pendingInvites.map((invite) => (
                    <tr key={invite.id}>
                      <td>{invite.created_by ?? '—'}</td>
                      <td>{new Date(invite.expires_at).toLocaleDateString()}</td>
                      <td>
                        <div className={styles.memberActions}>
                          <button className={nb.btnSm} onClick={() => handleRevoke(invite.id)}>
                            Revoke
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
