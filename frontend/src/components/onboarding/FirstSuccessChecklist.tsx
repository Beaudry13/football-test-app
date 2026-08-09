import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  dismissOnboarding,
  getOnboarding,
  type OnboardingProgress,
  type OnboardingStep,
} from '../../api/onboarding';
import { useTour } from '../../help/tour/tourContext';
import { Icon } from '../ui/Icon';
import nb from '../../styles/notebook.module.css';
import styles from './FirstSuccessChecklist.module.css';

interface FirstSuccessChecklistProps {
  /** Bump to re-fetch. The dashboard changes onboarding state directly - a
   *  quiz created in the form above this card ticks step one - and without a
   *  nudge the checklist would sit stale until a reload.
   *
   *  A number rather than a callback registry: the dashboard already knows
   *  when it changed something, and this keeps the coupling to one prop
   *  instead of the card having to know what a quiz is. */
  reloadSignal?: number;
}

/** The First Success checklist.
 *
 *  Owns no rules. Which steps exist, whether each is done, and where its
 *  button goes are all decided by GET /api/onboarding (see backend
 *  app/services/onboarding.py) - this file only decides how that looks. That
 *  is what keeps onboarding from growing roots into the dashboard: moving
 *  this card to its own page is moving one line of JSX.
 */
export function FirstSuccessChecklist({ reloadSignal = 0 }: FirstSuccessChecklistProps) {
  const [progress, setProgress] = useState<OnboardingProgress | null>(null);
  // Set when the coach hides the card by hand. Separate from the server's
  // `dismissed` so the card goes away on the click rather than after the
  // round trip.
  const [hidden, setHidden] = useState(false);
  // Latches once the coach has earned the success state, and outranks the
  // server's `dismissed` from then on.
  //
  // Without it the card is unwinnable: finishing onboarding auto-dismisses,
  // and the dashboard's very next refresh re-fetches progress that now says
  // dismissed, so the success state disappears in the same breath as it
  // appears. The coach does all seven steps and is shown nothing.
  const [celebrating, setCelebrating] = useState(false);
  const location = useLocation();
  const tour = useTour();

  const load = useCallback(() => {
    getOnboarding()
      .then((next) => {
        setProgress(next);
        // Undoes an earlier "Hide" in this same session. Without it, Help's
        // "Show Getting Started Checklist" would clear the server flag and
        // still show nothing, because the local hide outlives it.
        if (!next.dismissed) setHidden(false);
      })
      // Deliberately silent. A guidance card that cannot load is a reason to
      // show nothing, not a reason to put a red banner across the dashboard
      // of a coach who was busy doing something else.
      .catch(() => setProgress(null));
  }, []);

  // `location.key` changes on any navigation, including one to the page the
  // coach is already standing on. That is what makes Help's restore land
  // immediately rather than on their next visit - a plain path check would
  // see /dashboard -> /dashboard and do nothing.
  useEffect(() => {
    load();
  }, [load, reloadSignal, location.key]);

  const isComplete = progress?.complete === true;
  const isDismissed = progress?.dismissed === true;

  useEffect(() => {
    if (!isComplete || isDismissed) return;
    // Auto-dismiss the moment onboarding is finished, so the success state is
    // something the coach sees once and never a permanent fixture of their
    // dashboard. The response is deliberately NOT written to state: doing so
    // would hide the card in the same tick that earned it.
    setCelebrating(true);
    dismissOnboarding().catch(() => {});
  }, [isComplete, isDismissed]);

  async function handleDismiss() {
    setHidden(true);
    try {
      await dismissOnboarding();
    } catch {
      // Hiding it locally is the part the coach asked for. If the server
      // never heard, the card returns on the next load, which is a far
      // better failure than an error they cannot act on.
    }
  }

  if (!progress || hidden) return null;
  // Checked BEFORE `dismissed`, because finishing onboarding sets both.
  if (celebrating) return <SuccessState progress={progress} onDone={handleDismiss} />;
  // Already put away on a previous visit. Restoring it is a Help menu job.
  if (isDismissed) return null;

  if (isComplete) return <SuccessState progress={progress} onDone={handleDismiss} />;

  return (
    <section className={`${nb.card} ${styles.card}`} aria-labelledby="onboarding-heading">
      <header className={styles.header}>
        <div>
          <h2 id="onboarding-heading" className={styles.title}>
            Get set up
          </h2>
          <p className={styles.subtitle}>
            {progress.completed_count} of {progress.total_count} done
          </p>
        </div>
        <button
          type="button"
          className={styles.dismiss}
          onClick={handleDismiss}
          title="Hide this checklist"
        >
          Hide
        </button>
      </header>

      <div
        className={styles.track}
        role="progressbar"
        aria-valuenow={progress.completed_count}
        aria-valuemin={0}
        aria-valuemax={progress.total_count}
        aria-label="Setup progress"
      >
        <div
          className={styles.fill}
          style={{ width: `${(progress.completed_count / progress.total_count) * 100}%` }}
        />
      </div>

      <ol className={styles.steps}>
        {progress.steps.map((step) => (
          <StepRow key={step.id} step={step} isNext={step.id === progress.next_step_id} />
        ))}
      </ol>

      <p className={styles.footnote}>
        {/* Optional, and deliberately below the steps. The checklist is the
            onboarding; the tour is supporting help for a coach who wants to
            know where things are before starting. */}
        <button type="button" className={styles.tourLink} onClick={tour.start}>
          New here? Take the dashboard tour
        </button>
        <span className={styles.footnoteDivider}>·</span>
        You can bring this back later from Help.
      </p>
    </section>
  );
}

function StepRow({ step, isNext }: { step: OnboardingStep; isNext: boolean }) {
  return (
    <li
      className={`${styles.step} ${step.complete ? styles.stepDone : ''} ${
        isNext ? styles.stepNext : ''
      }`}
    >
      <span className={styles.marker} aria-hidden="true">
        {step.complete ? <Icon name="check" size={13} /> : null}
      </span>

      <div className={styles.stepBody}>
        <div className={styles.stepTitle}>
          {step.title}
          {/* Completed steps say why they are ticked when the coach did not
              tick them - an invited coach whose team already had a roster
              would otherwise wonder what happened. */}
          {step.complete && step.scope === 'organization' && (
            <span className={styles.inherited}>already set up for your team</span>
          )}
          {isNext && <span className={styles.nextTag}>Next</span>}
        </div>

        {!step.complete && <p className={styles.stepDescription}>{step.description}</p>}
      </div>

      {!step.complete && (
        <div className={styles.stepActions}>
          <Link
            to={step.route}
            className={isNext ? nb.btnPrimary : nb.btnSm}
            data-testid={`onboarding-action-${step.id}`}
          >
            {step.action_label}
          </Link>
          {step.secondary_action && (
            <Link to={step.secondary_action.route} className={nb.btnSm}>
              {step.secondary_action.label}
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

function SuccessState({
  progress,
  onDone,
}: {
  progress: OnboardingProgress;
  onDone: () => void;
}) {
  const { milestone } = progress;

  return (
    <section className={`${nb.card} ${styles.card} ${styles.success}`}>
      <div className={styles.successHead}>
        <span className={styles.successMark} aria-hidden="true">
          <Icon name="check" size={16} />
        </span>
        <div>
          <h2 className={styles.title}>You&rsquo;re set up</h2>
          <p className={styles.subtitle}>All seven setup steps are done.</p>
        </div>
        <button type="button" className={styles.dismiss} onClick={onDone}>
          Done
        </button>
      </div>

      {/* A suggestion, not a step. It was kept out of the checklist because a
          coach cannot finish it alone, and it must never read as unfinished
          setup - hence "Next", past the success line, with no checkbox. */}
      {milestone && !milestone.complete && (
        <div className={styles.milestone}>
          <div>
            <p className={styles.milestoneTitle}>Next: {milestone.title}</p>
            <p className={styles.stepDescription}>{milestone.description}</p>
          </div>
          <Link to={milestone.route} className={nb.btnSm}>
            {milestone.action_label}
          </Link>
        </div>
      )}
    </section>
  );
}
