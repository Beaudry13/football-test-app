import { useCallback, useEffect, useState } from 'react';
import {
  activateQuiz,
  deactivateAccessCode,
  listAccessCodes,
  setAccessCodeExpiry,
} from '../../api/accessCodes';
import { listGroups } from '../../api/groups';
import { ApiError, getErrorMessage } from '../../api/client';
import { generateMissingPins, type IssuedPin } from '../../api/players';
import { PinSheetDialog } from '../../components/pins/PinSheetDialog';
import type { AccessCode, AssessmentMode, Group, Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { AvailableUntil } from './AvailableUntil';
import { DEFAULT_PRESET } from './availableUntilTimes';
import { SharePeira } from './SharePeira';
import nb from '../../styles/notebook.module.css';
import styles from './AccessCodesTab.module.css';

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

/** How the questions were ordered for this activation. PRACTICE ONLY.
 *
 * A coach looking at a code weeks later should not have to remember how they
 * set it up - but on a GRADED code there is nothing to remember. Randomization
 * is ignored entirely for graded: `routes/play.py` passes
 * `randomize=access_code.is_practice and access_code.randomize_questions`, so
 * a graded attempt always receives the authored order and this badge could
 * only ever read "Standard".
 *
 * A label that cannot change is not information; it is a word taking up the
 * space beside one that IS. So it renders where it can vary and stays quiet
 * where it cannot - "Graded" already says the order is the authored one.
 *
 * This used to argue the opposite ("hiding it would make its absence
 * ambiguous"). The absence is not ambiguous once the badge only ever appears
 * on practice codes. */
function OrderBadge({ mode, randomized }: { mode: AssessmentMode; randomized: boolean }) {
  if (mode !== 'PRACTICE') return null;
  return (
    <span className={styles.orderBadge}>
      Question order: {randomized ? 'Randomized' : 'Standard'}
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

/** A player an activation was refused for: no PIN yet, with PINs enforced. */
interface PlayerNeedingPin {
  player_id: number;
  name: string;
  jersey_number: string | null;
}

export function AccessCodesTab({ quiz }: { quiz: Quiz }) {
  const [codes, setCodes] = useState<AccessCode[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  // GRADED is the default, and reverting to it after each activation is
  // deliberate: sending a practice quiz is the deliberate act, and a sticky
  // PRACTICE would make the next real assessment silently not count.
  const [mode, setMode] = useState<AssessmentMode>('GRADED');
  // Practice-only. Reset when the coach switches back to graded so a
  // toggle left on cannot travel silently into a graded activation.
  const [randomizeQuestions, setRandomizeQuestions] = useState(false);
  // Always a real moment, so activation never demands a decision. The default
  // is the window activation always used, so a coach who does not care about
  // timing behaves exactly as before.
  const [availableUntil, setAvailableUntil] = useState<Date>(() => DEFAULT_PRESET.at());
  const [isChangingExpiry, setIsChangingExpiry] = useState(false);
  // Folded away while a Peira is live - see the active card below.
  const [showReactivate, setShowReactivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();
  const [isActivating, setIsActivating] = useState(false);
  /** Who stopped the last activation for want of a PIN (Phase 3c). Only ever
   *  set by the server's refusal, which only happens with PINs enforced. */
  const [needPins, setNeedPins] = useState<PlayerNeedingPin[] | null>(null);
  const [isIssuingPins, setIsIssuingPins] = useState(false);
  const [pinSheet, setPinSheet] = useState<IssuedPin[] | null>(null);

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
    setNeedPins(null);
    setIsActivating(true);
    try {
      await activateQuiz(quiz.id, selectedGroupIds, mode, randomizeQuestions, availableUntil);
      await load();
      setMode('GRADED');
      // The new code is live; the panel that made it has nothing left to say.
      setShowReactivate(false);
    } catch (err) {
      if (err instanceof ApiError && err.reason === 'players_need_pins') {
        const listed = (err.details as unknown as { players_without_pins?: PlayerNeedingPin[] } | undefined)
          ?.players_without_pins;
        setNeedPins(listed ?? []);
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setIsActivating(false);
    }
  }

  /** The same batched "Generate missing PINs" the Team page runs. Whatever was
   *  issued is SHOWN, even if a later batch fails - a PIN nobody saw is a PIN
   *  nobody can use. Never replaces a PIN a player already has. */
  async function handleGeneratePins() {
    setIsIssuingPins(true);
    setError(null);
    const issuedSoFar: IssuedPin[] = [];
    try {
      for (let batch = 0; batch < 50; batch += 1) {
        const { issued, remaining } = await generateMissingPins();
        issuedSoFar.push(...issued);
        if (remaining === 0 || issued.length === 0) break;
      }
      setNeedPins(null);
    } catch (err) {
      setError(`${getErrorMessage(err)} Some players may still need a PIN - try again for the rest.`);
    } finally {
      if (issuedSoFar.length > 0) setPinSheet(issuedSoFar);
      setIsIssuingPins(false);
    }
  }

  /** Moves when the CURRENT code stops - same code, same link, same QR.
   *
   * Deliberately not "reactivate": that mints a new code and silently kills
   * the URL already sitting in a team group text. A session running late needs
   * the opposite. */
  async function handleChangeExpiry(accessCodeId: number, when: Date) {
    setError(null);
    setIsChangingExpiry(true);
    try {
      await setAccessCodeExpiry(quiz.id, accessCodeId, when);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsChangingExpiry(false);
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

  const activeCode = codes?.find((c) => c.is_active && c.is_valid);

  return (
    <div>
      {dialog}
      {pinSheet && <PinSheetDialog pins={pinSheet} onClosed={() => setPinSheet(null)} />}
      <ErrorBanner message={error} />
      {needPins && (
        <div className={`${nb.card} ${styles.pinBlocker}`} role="alert">
          <p className={styles.pinBlockerTitle}>
            {needPins.length === 1
              ? "1 player doesn't have a PIN yet, so they couldn't start this quiz."
              : `${needPins.length} players don't have a PIN yet, so they couldn't start this quiz.`}
          </p>
          {needPins.length > 0 && (
            <ul className={styles.pinBlockerList}>
              {needPins.map((p) => (
                <li key={p.player_id}>
                  {p.name}
                  {p.jersey_number ? ` · #${p.jersey_number}` : ''}
                </li>
              ))}
            </ul>
          )}
          <p className={styles.activateHint}>
            Give them PINs, hand out the sheet, then activate the quiz again.
          </p>
          <button className={nb.btnPrimary} onClick={() => void handleGeneratePins()} disabled={isIssuingPins}>
            {isIssuingPins ? 'Generating…' : 'Generate missing PINs'}
          </button>
        </div>
      )}

      <div className={`${nb.card} ${styles.activeCard}`}>
        {activeCode ? (
          <>
            {/* No "Share this code with players" line: the code is the hero
                and the Share button below says the action. A sentence telling
                a coach to do the thing the button does is explanation where
                structure already speaks. */}
            <div className={styles.codeDisplay}>{activeCode.code}</div>
            <ModeBadge mode={activeCode.mode} />
            <OrderBadge mode={activeCode.mode} randomized={activeCode.randomize_questions} />
            {activeCode.groups.length > 0 && (
              <p>Restricted to: {activeCode.groups.map((g) => g.name).join(', ')}</p>
            )}
            {/* THE LIVE ANSWER, in the same words the chooser used before
                activation. Changing it moves this one code's expiry - the
                shared link and the QR are untouched, which is the whole
                reason this is not "reactivate". */}
            <AvailableUntil
              label="Active until"
              value={new Date(activeCode.expires_at)}
              onChange={(when) => handleChangeExpiry(activeCode.id, when)}
              // Live: this is the ANSWER a coach came to check, not the
              // question they are being asked. Changing it is behind "Change".
              collapsible
            />
            {isChangingExpiry && <p className={styles.expiry}>Updating…</p>}
            {/* The whole answer to "how do I get this to my players", as one
                action. It replaced a permanent read-only link box and a Copy
                button: the box was plumbing the coach had to understand before
                it helped them, and on a phone it could not reach the apps they
                actually send with. See SharePeira.tsx. */}
            <SharePeira code={activeCode.code} quizTitle={quiz.title} />

            {/* WHILE A PEIRA IS LIVE, THE COACH HAS FOUR JOBS: know the code,
                know when it closes, get it to players, stop it if they must.
                How the NEXT activation should count is none of those, so the
                mode and randomize controls used to sit in the middle of this
                card asking about something that had already been decided.
                They now live under "Reactivate with new code", which is the
                only thing they affect. No new screen, no settings panel -
                the same controls, folded behind the action that uses them. */}
            <div className={styles.historyActions}>
              <button className={nb.btnSm} onClick={() => handleDeactivate(activeCode.id)}>
                Deactivate now
              </button>
              <button
                className={styles.reactivateToggle}
                onClick={() => setShowReactivate((open) => !open)}
                aria-expanded={showReactivate}
              >
                {showReactivate ? 'Cancel' : 'Reactivate with new code'}
              </button>
            </div>

            {showReactivate && (
              <div className={styles.reactivatePanel}>
                <p className={styles.reactivateWarning}>
                  This creates a NEW code. The link you already shared stops working.
                </p>
                <AvailableUntil value={availableUntil} onChange={setAvailableUntil} />
                <ModePicker
                  mode={mode}
                  onChange={(next) => {
                    setMode(next);
                    // Clearing on the way back to graded matters: a toggle left
                    // on would otherwise ride along invisibly into an activation
                    // whose form never showed it.
                    if (next !== 'PRACTICE') setRandomizeQuestions(false);
                  }}
                />
                {/* Practice only, and HIDDEN rather than disabled for graded -
                    a greyed control still asks the coach to think about
                    something that does not apply. */}
                {mode === 'PRACTICE' && (
                  <label className={styles.randomizeOption}>
                    <input
                      type="checkbox"
                      checked={randomizeQuestions}
                      onChange={(event) => setRandomizeQuestions(event.target.checked)}
                    />
                    <span>
                      <span className={styles.randomizeLabel}>Randomize questions</span>
                      <span className={styles.modeHint}>
                        Mix the question order for each new practice attempt.
                      </span>
                    </span>
                  </label>
                )}
                <button
                  className={nb.btnSm}
                  onClick={handleActivate}
                  disabled={isActivating || hasNoQuestions}
                  title={hasNoQuestions ? 'Add a question first' : undefined}
                >
                  {isActivating ? 'Generating…' : 'Create new code'}
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <p>This Quiz has no active access code.</p>

            {/* Chosen BEFORE activating, with a default already selected, so
                the coach who does not care about timing still just clicks
                Activate. */}
            <AvailableUntil value={availableUntil} onChange={setAvailableUntil} />

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

            <>
              <ModePicker
                mode={mode}
                onChange={(next) => {
                  setMode(next);
                  // Clearing on the way back to graded matters: a toggle left
                  // on would otherwise ride along invisibly into an activation
                  // whose form never showed it.
                  if (next !== 'PRACTICE') setRandomizeQuestions(false);
                }}
              />
              {/* Practice only, and HIDDEN rather than disabled for graded -
                  a greyed control still asks the coach to think about
                  something that does not apply. */}
              {mode === 'PRACTICE' && (
                <label className={styles.randomizeOption}>
                  <input
                    type="checkbox"
                    checked={randomizeQuestions}
                    onChange={(event) => setRandomizeQuestions(event.target.checked)}
                  />
                  <span>
                    <span className={styles.randomizeLabel}>Randomize questions</span>
                    <span className={styles.modeHint}>
                      Mix the question order for each new practice attempt.
                    </span>
                  </span>
                </label>
              )}
            </>

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
                    <OrderBadge mode={code.mode} randomized={code.randomize_questions} />
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
