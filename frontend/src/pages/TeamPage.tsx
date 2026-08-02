import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  createInvite,
  getOrganization,
  listInvites,
  removeMember,
  renameOrganization,
  revokeInvite,
  updateMemberRole,
} from '../api/organizations';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { Organization, OrganizationInvite } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import styles from './TeamPage.module.css';

function joinLink(code: string): string {
  return `${window.location.origin}/join/${code}`;
}

export function TeamPage() {
  const { coach } = useAuth();
  const isAdmin = coach?.role === 'admin';

  const [org, setOrg] = useState<Organization | null>(null);
  const [invites, setInvites] = useState<OrganizationInvite[]>([]);
  const [orgName, setOrgName] = useState('');
  const [newInviteCode, setNewInviteCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function handleCreateInvite() {
    setError(null);
    setIsBusy(true);
    try {
      const invite = await createInvite();
      setNewInviteCode(invite.code ?? null);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCopy(code: string) {
    await navigator.clipboard.writeText(joinLink(code));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleRevoke(inviteId: number) {
    setError(null);
    try {
      await revokeInvite(inviteId);
      await refresh();
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
    if (
      !window.confirm(
        `Remove ${username} from this organization? Quizzes they created stay with the team.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await removeMember(coachId);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  if (!org) {
    return (
      <div>
        <ErrorBanner message={error} />
        {!error && <p>Loading…</p>}
      </div>
    );
  }

  const pendingInvites = invites.filter((i) => i.is_usable);

  return (
    <div>
      <div className={styles.header}>
        <h1>{org.name}</h1>
      </div>

      <ErrorBanner message={error} />

      {isAdmin && (
        <form className={styles.renameForm} onSubmit={handleRename}>
          <input
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            aria-label="Organization name"
          />
          <button
            type="submit"
            className="btn btn-secondary btn-sm"
            disabled={isBusy || !orgName.trim() || orgName.trim() === org.name}
          >
            Rename
          </button>
        </form>
      )}

      <div className="card">
        <h3>Coaches ({org.members.length})</h3>
        <table className={styles.table}>
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
                  <span className={member.role === 'admin' ? 'badge badge-success' : 'badge badge-neutral'}>
                    {member.role}
                  </span>
                </td>
                {isAdmin && (
                  <td>
                    <div className={styles.memberActions}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() =>
                          handleRoleChange(member.id, member.role === 'admin' ? 'member' : 'admin')
                        }
                      >
                        {member.role === 'admin' ? 'Make member' : 'Make admin'}
                      </button>
                      {member.id !== coach?.id && (
                        <button
                          className="btn btn-danger btn-sm"
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

      {isAdmin && (
        <div className="card">
          <h3>Invite a coach</h3>
          <p>
            Generate a link and send it however you like. It works once, and expires after 14 days.
          </p>
          <button className="btn btn-primary" onClick={handleCreateInvite} disabled={isBusy}>
            {isBusy ? 'Generating…' : 'Create invite link'}
          </button>

          {newInviteCode && (
            <>
              <div className={styles.inviteLinkRow}>
                <input readOnly value={joinLink(newInviteCode)} onFocus={(e) => e.target.select()} />
                <button className="btn btn-secondary btn-sm" onClick={() => handleCopy(newInviteCode)}>
                  {copied ? 'Copied!' : 'Copy link'}
                </button>
              </div>
              <p className={styles.inviteNote}>
                Copy this now — for security it isn’t shown again after you leave this page.
              </p>
            </>
          )}

          {pendingInvites.length > 0 && (
            <>
              <h4>Pending invites ({pendingInvites.length})</h4>
              <table className={styles.table}>
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
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleRevoke(invite.id)}
                          >
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
