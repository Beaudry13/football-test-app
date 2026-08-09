import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DASHBOARD_TOUR, selectorsOf, type TourStep } from './tourSteps';
import styles from './Tour.module.css';

/** How long a target gets to appear before the step is treated as absent.
 *
 *  Not zero, because the tour can start while the dashboard is still
 *  mounting - resolving instantly would skip every step before the page
 *  existed. Not long, because a genuinely missing target (Admin View for a
 *  member) should not leave a coach staring at a dimmed screen. */
const RESOLVE_TIMEOUT_MS = 400;

/** Breathing room around the spotlight so the target does not sit flush
 *  against the dimming. */
const SPOTLIGHT_PADDING = 8;

const PANEL_WIDTH = 320;
const PANEL_GAP = 14;
/** Only used to decide above-or-below before the panel has been measured. */
const PANEL_ESTIMATED_HEIGHT = 180;

interface SpotRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function findElements(step: TourStep): HTMLElement[] {
  return selectorsOf(step).flatMap((selector) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)),
  );
}

/** One spotlight covering every element the step names.
 *
 *  Viewport coordinates, because the overlay is position:fixed - which is
 *  also why this has to be recomputed on scroll rather than measured once. */
function unionRect(elements: HTMLElement[]): SpotRect | null {
  if (elements.length === 0) return null;
  const rects = elements.map((el) => el.getBoundingClientRect());
  const top = Math.min(...rects.map((r) => r.top));
  const left = Math.min(...rects.map((r) => r.left));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  const right = Math.max(...rects.map((r) => r.right));
  return {
    top: top - SPOTLIGHT_PADDING,
    left: left - SPOTLIGHT_PADDING,
    width: right - left + SPOTLIGHT_PADDING * 2,
    height: bottom - top + SPOTLIGHT_PADDING * 2,
  };
}

function panelPosition(rect: SpotRect) {
  const viewportHeight = window.innerHeight || 800;
  const viewportWidth = window.innerWidth || 1200;

  const below = rect.top + rect.height + PANEL_GAP;
  const fitsBelow = below + PANEL_ESTIMATED_HEIGHT <= viewportHeight;
  const top = fitsBelow
    ? below
    : Math.max(PANEL_GAP, rect.top - PANEL_GAP - PANEL_ESTIMATED_HEIGHT);

  // Clamped so the panel is never pushed off-screen by a target near an edge.
  const left = Math.min(
    Math.max(PANEL_GAP, rect.left),
    Math.max(PANEL_GAP, viewportWidth - PANEL_WIDTH - PANEL_GAP),
  );

  return { top, left };
}

interface DashboardTourProps {
  onFinish: () => void;
}

/** The Dashboard Tour: dim everything, light one area at a time, explain it
 *  in a sentence.
 *
 *  Deliberately NOT a product tour. Six steps, none of which teaches a
 *  button - they orient a coach in the parts of the app and get out.
 *
 *  Three rules hold it together:
 *
 *  1. Targets are found by `data-tour` selector at runtime, and a step whose
 *     target is absent is SKIPPED rather than fatal. That is the whole of
 *     "Admin View, admins only" - no role check exists anywhere - and it is
 *     what stops a dashboard change from breaking the tour.
 *  2. The spotlight is re-measured continuously - every frame AND on scroll
 *     and resize. Both, because neither covers the other: only the frame
 *     loop sees a reflow (which fires no event), and only the listeners keep
 *     working when the frame loop is suspended (a background tab gets no rAF
 *     callbacks at all).
 *  3. Body scroll is NOT locked. The overlay blocks clicks, but a coach can
 *     still scroll, and the spotlight follows - which is better than pinning
 *     them to one screenful and is why the tracking in (2) has to be right.
 *
 *  Nothing is persisted. This is replayable help, not onboarding progress.
 */
export function DashboardTour({ onFinish }: DashboardTourProps) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<SpotRect | null>(null);
  // Whether anything AFTER this step actually exists on the page.
  //
  // Not the same as "is the last entry in the array": a member has no Admin
  // View, so their last real step is Help, and labelling its button "Next"
  // promises a step that will never come - the click just ends the tour.
  const [lastReachable, setLastReachable] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Which way we were travelling, so a skipped step continues past itself
  // instead of bouncing back at whoever pressed Back.
  const directionRef = useRef(1);

  const step: TourStep | undefined = DASHBOARD_TOUR[index];

  const finish = useCallback(() => {
    onFinish();
  }, [onFinish]);

  const goTo = useCallback(
    (next: number) => {
      directionRef.current = next >= index ? 1 : -1;
      if (next < 0) return;
      if (next >= DASHBOARD_TOUR.length) {
        finish();
        return;
      }
      setRect(null);
      setIndex(next);
    },
    [index, finish],
  );

  // Focus goes to the panel on every step, and back where it came from when
  // the tour ends - a coach who launched from Help lands back on Help.
  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    return () => returnFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    panelRef.current?.focus();
  }, [index]);

  // Resolve the current step's target, waiting briefly for it to appear.
  useEffect(() => {
    if (!step) return;
    let cancelled = false;
    let frame = 0;
    const deadline = Date.now() + RESOLVE_TIMEOUT_MS;

    const attempt = () => {
      if (cancelled) return;

      const elements = findElements(step);
      if (elements.length > 0) {
        setLastReachable(
          !DASHBOARD_TOUR.slice(index + 1).some((later) => findElements(later).length > 0),
        );
        const first = elements[0].getBoundingClientRect();
        if (first.top < 0 || first.bottom > (window.innerHeight || 800)) {
          // Optional-called: jsdom has no scrollIntoView, and a help overlay
          // is not worth throwing over.
          elements[0].scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        }
        setRect(unionRect(elements));
        return;
      }

      if (Date.now() < deadline) {
        frame = requestAnimationFrame(attempt);
        return;
      }

      const next = index + directionRef.current;
      if (next < 0 || next >= DASHBOARD_TOUR.length) {
        finish();
        return;
      }
      setIndex(next);
    };

    attempt();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [step, index, finish]);

  // Keep the spotlight on the target while the page moves under it.
  //
  // Measured every frame rather than on scroll+resize events, because those
  // two do not cover the case that actually broke it: the dashboard reflowed
  // under a settled spotlight - a card above the target finished loading and
  // pushed it 17px down - and no event fires for a reflow. Polling the rect
  // catches scrolling, resizing, reflow and animation with one mechanism.
  //
  // Cheap despite the loop: one getBoundingClientRect per frame, only while a
  // short-lived overlay is open, and state is set ONLY when the numbers
  // actually change, so a still page re-renders nothing.
  const hasRect = rect !== null;
  useEffect(() => {
    if (!hasRect || !step) return;
    let frame = 0;
    let previous = '';

    const measure = () => {
      const elements = findElements(step);
      if (elements.length === 0) return;
      const next = unionRect(elements);
      const key = next ? `${next.top}|${next.left}|${next.width}|${next.height}` : '';
      // Only on a real change, so a still page re-renders nothing and this
      // cannot feed itself.
      if (key === previous) return;
      previous = key;
      setRect(next);
    };

    const tick = () => {
      measure();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    // Both, deliberately, because neither alone is enough:
    //
    //  - The frame loop is the only thing that catches a REFLOW, which fires
    //    no event at all (a card above the target finishes loading and pushes
    //    it down).
    //  - The listeners are the only thing that works when the frame loop is
    //    suspended - a background or non-compositing tab gets zero rAF
    //    callbacks, and a coach returning to it would find a stale spotlight.
    //
    // Capture phase: a scrolling container inside the page does not bubble
    // its scroll to window.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [hasRect, step]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goTo(index + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goTo(index - 1);
      } else if (event.key === 'Tab') {
        // Tab stays inside the panel: everything behind the overlay is
        // dimmed and unclickable, so reaching it with a keyboard would put
        // focus somewhere invisible.
        const focusable = Array.from(
          panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [finish, goTo, index]);

  if (!step) return null;

  const isLast = lastReachable || index === DASHBOARD_TOUR.length - 1;
  const position = rect ? panelPosition(rect) : { top: PANEL_GAP, left: PANEL_GAP };

  return createPortal(
    <div className={styles.overlay} data-testid="dashboard-tour">
      {/* The dimming IS this element's outer box-shadow, so the target stays
          fully lit with no second layer to keep in sync. */}
      {rect && (
        <div
          className={styles.spotlight}
          data-testid="tour-spotlight"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
        />
      )}

      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step-title"
        className={styles.panel}
        style={{ top: position.top, left: position.left }}
      >
        <h2 id="tour-step-title" className={styles.title}>
          {step.title}
        </h2>
        <p className={styles.body}>{step.body}</p>

        <div className={styles.actions}>
          <button type="button" className={styles.skip} onClick={finish}>
            Skip
          </button>
          <div className={styles.nav}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => goTo(index - 1)}
              disabled={index === 0}
            >
              Back
            </button>
            <button type="button" className={styles.primary} onClick={() => goTo(index + 1)}>
              {isLast ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
