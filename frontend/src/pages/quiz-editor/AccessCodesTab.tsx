import { useCallback, useEffect, useState } from 'react';
import { activateQuiz, deactivateAccessCode, listAccessCodes } from '../../api/accessCodes';
import { getErrorMessage } from '../../api/client';
import type { AccessCode, Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import styles from './AccessCodesTab.module.css';

function playLink(code: string): string {
  return `${window.location.origin}/play/${code}`;
}

export function AccessCodesTab({ quiz }: { quiz: Quiz }) {
  const [codes, setCodes] = useState<AccessCode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  async function handleActivate() {
    setError(null);
    setIsActivating(true);
    try {
      await activateQuiz(quiz.id);
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
      await deactivateAccessCode(quiz.id, accessCodeId);
      await load();
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
      <ErrorBanner message={error} />

      <div className={`card ${styles.activeCard}`}>
        {activeCode ? (
          <>
            <p>Share this code and link with players</p>
            <div className={styles.codeDisplay}>{activeCode.code}</div>
            <div className={styles.linkRow}>
              <input readOnly value={playLink(activeCode.code)} onFocus={(e) => e.target.select()} />
              <button className="btn btn-secondary btn-sm" onClick={() => handleCopyLink(activeCode.code)}>
                {copied ? 'Copied!' : 'Copy link'}
              </button>
            </div>
            <div className={styles.expiry}>
              Expires {new Date(activeCode.expires_at).toLocaleString()}
            </div>
            <div style={{ marginTop: '1em', display: 'flex', gap: '0.5em', justifyContent: 'center' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => handleDeactivate(activeCode.id)}>
                Deactivate now
              </button>
              <button className="btn btn-primary btn-sm" onClick={handleActivate} disabled={isActivating}>
                {isActivating ? 'Generating…' : 'Reactivate with new code'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>This quiz has no active access code.</p>
            <button className="btn btn-primary" onClick={handleActivate} disabled={isActivating}>
              {isActivating ? 'Activating…' : 'Activate quiz'}
            </button>
            <p style={{ fontSize: '0.85em', marginTop: '0.75em' }}>
              Requires at least one question and a non-empty roster. The code is valid for 24 hours.
            </p>
          </>
        )}
      </div>

      {codes && codes.length > 0 && (
        <div className="card">
          <h3>Activation history</h3>
          <table className={styles.historyTable}>
            <thead>
              <tr>
                <th>Code</th>
                <th>Activated</th>
                <th>Expires</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((code) => (
                <tr key={code.id}>
                  <td>{code.code}</td>
                  <td>{new Date(code.activated_at).toLocaleString()}</td>
                  <td>{new Date(code.expires_at).toLocaleString()}</td>
                  <td>
                    {code.is_active && code.is_valid ? (
                      <span className="badge badge-success">Active</span>
                    ) : (
                      <span className="badge badge-neutral">Inactive</span>
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
