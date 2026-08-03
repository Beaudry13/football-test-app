import { useCallback, useEffect, useState } from 'react';
import { activateQuiz, deactivateAccessCode, listAccessCodes } from '../../api/accessCodes';
import { listGroups } from '../../api/groups';
import { getErrorMessage } from '../../api/client';
import type { AccessCode, Group, Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import nb from '../../styles/notebook.module.css';
import styles from './AccessCodesTab.module.css';

function playLink(code: string): string {
  return `${window.location.origin}/play/${code}`;
}

export function AccessCodesTab({ quiz }: { quiz: Quiz }) {
  const [codes, setCodes] = useState<AccessCode[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();
  const [isActivating, setIsActivating] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setCodes(await listAccessCodes(quiz.id));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [quiz.id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    listGroups()
      .then(setGroups)
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  function toggleGroup(groupId: number) {
    setSelectedGroupIds((prev) =>
      prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId],
    );
  }

  async function handleActivate() {
    setError(null);
    setIsActivating(true);
    try {
      await activateQuiz(quiz.id, selectedGroupIds);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsActivating(false);
    }
  }

  async function handleDeactivate(accessCodeId: number) {
    setError(null);
    try {
      await confirm({
        title: 'Deactivate Code?',
        body: 'Any player still taking the Quiz will be locked out immediately, even mid-attempt.',
        confirmLabel: 'Deactivate Code',
        action: async () => {
          await deactivateAccessCode(quiz.id, accessCodeId);
          await load();
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleCopyLink(code: string) {
    await navigator.clipboard.writeText(playLink(code));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const activeCode = codes?.find((c) => c.is_active && c.is_valid);

  return (
    <div>
      {dialog}
      <ErrorBanner message={error} />

      <div className={`${nb.card} ${styles.activeCard}`}>
        {activeCode ? (
          <>
            <p>Share this code and link with players</p>
            <div className={styles.codeDisplay}>{activeCode.code}</div>
            {activeCode.groups.length > 0 && (
              <p>Restricted to: {activeCode.groups.map((g) => g.name).join(', ')}</p>
            )}
            <div className={styles.linkRow}>
              <input
                className={nb.input}
                readOnly
                value={playLink(activeCode.code)}
                onFocus={(e) => e.target.select()}
              />
              <button className={nb.btnSm} onClick={() => handleCopyLink(activeCode.code)}>
                {copied ? 'Copied!' : 'Copy link'}
              </button>
            </div>
            <div className={styles.expiry}>
              Expires {new Date(activeCode.expires_at).toLocaleString()}
            </div>
            <div className={styles.historyActions}>
              <button className={nb.btnSm} onClick={() => handleDeactivate(activeCode.id)}>
                Deactivate now
              </button>
              <button className={nb.btnSm} onClick={handleActivate} disabled={isActivating}>
                {isActivating ? 'Generating…' : 'Reactivate with new code'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>This Quiz has no active access code.</p>

            {groups.length > 0 && (
              <div className={styles.groupPicker}>
                <strong>Restrict to saved group(s) (optional)</strong>
                <div className={styles.groupCheckboxList}>
                  {groups.map((group) => (
                    <label key={group.id} className={styles.groupCheckboxItem}>
                      <input
                        type="checkbox"
                        checked={selectedGroupIds.includes(group.id)}
                        onChange={() => toggleGroup(group.id)}
                      />
                      {group.name} ({group.players.length})
                    </label>
                  ))}
                </div>
              </div>
            )}

            <button className={nb.btnPrimary} onClick={handleActivate} disabled={isActivating}>
              {isActivating ? 'Activating…' : 'Activate Quiz'}
            </button>
            <p className={styles.activateHint}>
              Requires at least one question, and either a non-empty roster or a selected group. The
              code is valid for 24 hours.
            </p>
          </>
        )}
      </div>

      {codes && codes.length > 0 && (
        <div className={`${nb.card} ${styles.historyCard}`}>
          <h3 className={nb.subheading}>Activation history</h3>
          <table className={nb.table}>
            <thead>
              <tr>
                <th>Code</th>
                <th>Activated</th>
                <th>Expires</th>
                <th>Groups</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((code) => (
                <tr key={code.id}>
                  <td>{code.code}</td>
                  <td>{new Date(code.activated_at).toLocaleString()}</td>
                  <td>{new Date(code.expires_at).toLocaleString()}</td>
                  <td>{code.groups.length > 0 ? code.groups.map((g) => g.name).join(', ') : '—'}</td>
                  <td>
                    {code.is_active && code.is_valid ? (
                      <span className={`${nb.badge} ${nb.badgeSuccess}`}>Active</span>
                    ) : (
                      <span className={`${nb.badge} ${nb.badgeNeutral}`}>Inactive</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
