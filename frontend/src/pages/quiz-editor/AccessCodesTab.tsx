import { useCallback, useEffect, useState } from 'react';
import { activateQuiz, deactivateAccessCode, listAccessCodes } from '../../api/accessCodes';
import { listGroups } from '../../api/groups';
import { getErrorMessage } from '../../api/client';
import type { AccessCode, AssessmentMode, Group, Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import nb from '../../styles/notebook.module.css';
import styles from './AccessCodesTab.module.css';

function playLink(code: string): string {
  return `${window.location.origin}/play/${code}`;
}

/** Says plainly whether an activation counts. Deliberately shown on the
 *  active code and on every row of the history: "did this one count?" is the
 *  question a coach asks when a number looks wrong, and it should be
 *  answerable without opening anything. */
function ModeBadge({ mode }: { mode: AssessmentMode }) {
  const isPractice = mode === 'PRACTICE';
  return (
    <span className={`${nb.badge} ${isPractice ? nb.badgeWarning : nb.badgeSuccess}`}>
      {isPractice ? 'Practice' : 'Graded'}
    </span>
  );
}

const MODE_OPTIONS: { value: AssessmentMode; label: string; hint: string }[] = [
  {
    value: 'GRADED',
    label: 'Graded',
    hint: 'Counts toward results, averages and reports. One attempt each.',
  },
  {
    value: 'PRACTICE',
    label: 'Practice',
    hint: 'Instant feedback, unlimited retakes, and never affects a grade.',
  },
];

/** Radio buttons rather than a toggle or a dropdown: both options are named
 *  and their consequences stated, because picking the wrong one silently
 *  either loses a real assessment or pollutes the coach's averages. */
function ModePicker({
  mode,
  onChange,
}: {
  mode: AssessmentMode;
  onChange: (mode: AssessmentMode) => void;
}) {
  return (
    <fieldset className={styles.modePicker}>
      <legend>How should this count?</legend>
      {MODE_OPTIONS.map((option) => (
        <label key={option.value} className={styles.modeOption}>
          <input
            type="radio"
            name="assessment-mode"
            value={option.value}
            checked={mode === option.value}
            onChange={() => onChange(option.value)}
          />
          <span>
            <strong>{option.label}</strong>
            <span className={styles.modeHint}>{option.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function AccessCodesTab({ quiz }: { quiz: Quiz }) {
  const [codes, setCodes] = useState<AccessCode[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  // GRADED is the default, and reverting to it after each activation is
  // deliberate: sending a practice quiz is the deliberate act, and a sticky
  // PRACTICE would make the next real assessment silently not count.
  const [mode, setMode] = useState<AssessmentMode>('GRADED');
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();
  const [isActivating, setIsActivating] = useState(false);
  const [copied, setCopied] = useState(false);

  // The API refuses to activate a quiz with no questions (422). That one is
  // unambiguous from data this tab already has, so the button says so rather
  // than letting the coach click into an error.
  //
  // The other two refusals are deliberately NOT mirrored here: a missing
  // Draw Response image lives on the questions, which this tab does not
  // load, and the roster requirement depends on the quiz's own roster, which
  // the single-quiz response omits. Guessing either would risk disabling a
  // button on a quiz that could in fact be activated - worse than the error
  // it would prevent. The note under the button covers both.
  const hasNoQuestions = quiz.question_count === 0;

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
      await activateQuiz(quiz.id, selectedGroupIds, mode);
      await load();
      setMode('GRADED');
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
            <ModeBadge mode={activeCode.mode} />
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
            <ModePicker mode={mode} onChange={setMode} />
            <div className={styles.historyActions}>
              <button className={nb.btnSm} onClick={() => handleDeactivate(activeCode.id)}>
                Deactivate now
              </button>
              <button
                className={nb.btnSm}
                onClick={handleActivate}
                disabled={isActivating || hasNoQuestions}
                title={hasNoQuestions ? 'Add a question first' : undefined}
              >
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

            <ModePicker mode={mode} onChange={setMode} />

            <button
              className={nb.btnPrimary}
              onClick={handleActivate}
              disabled={isActivating || hasNoQuestions}
              title={hasNoQuestions ? 'Add a question first' : undefined}
            >
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
          <h2 className={nb.subheading}>Activation history</h2>
          <table className={nb.table}>
            <thead>
              <tr>
                <th>Code</th>
                <th>Activated</th>
                <th>Expires</th>
                <th>Groups</th>
                <th>Mode</th>
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
                    <ModeBadge mode={code.mode} />
                  </td>
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
