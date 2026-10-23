import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useMayUseMotionLab } from '../../motion-lab/motionLabAccess';
import styles from './TeachView.module.css';

/** One thing to put on the screen in the meeting room. */
export interface TeachSlide {
  key: string | number;
  imageUrl: string | null;
  /** "Boundary safety" - who the player is, when the question says. */
  role: string | null;
  prompt: string;
  /** The coach's right answer(s). */
  right: string[];
  why: string | null;
  /** What the room got wrong most: "3 chose 'Stay boundary'". */
  wrong: { text: string; count: number } | null;
  /** The Motion Lab play it came from, to open and run. */
  motionPlayId: number | null;
  /** Shown in place of the image - e.g. the play moving to the snap. */
  picture?: ReactNode;
  /** The concept this is, when the screen's title does not already say it. */
  concept?: string | null;
}

/** Who in the room this is about: "3 of 11 missed it" and their names. */
export interface TeachRoom {
  missed: number;
  /** How many answered - null when unknown. */
  of: number | null;
  names: string[];
  /** "missed it" (default) / "still working on it". */
  verb?: string;
}

/** How many names the room line shows before counting the rest. */
const NAMES_SHOWN = 6;

/**
 * TEACH: the meeting-room view. Full screen - PEIRA's own header included,
 * hence the portal - the FOOTBALL as big as the screen allows, the coach's
 * right answer and reason beside it, what the room chose instead, who this is
 * about ("3 of 11 missed it"), and the next step right there.
 *
 * Operated while talking to a room, so the keys do the work:
 *   ← →  previous / next (past the last slide: the next thing to teach)
 *   Space  watch the play again          N  notes on / off (the football alone)
 *   F  full screen (a projector)         Esc  close
 * and the controls that are on screen are few and large.
 *
 * Shared by a Situational Rep's football problems, a quiz's Results, the
 * quiz editor, a position group's needs and Motion Lab's Teach a moment.
 */
export function TeachView({
  title,
  slides,
  start = 0,
  onClose,
  action,
  room,
  next,
}: {
  title: string;
  slides: TeachSlide[];
  start?: number;
  onClose: () => void;
  /** The next step, right where the teaching happens (e.g. "Retest the 4 who missed"). */
  action?: ReactNode;
  /** Who this is about, when the screen knows: "3 of 11 missed it". */
  room?: TeachRoom | null;
  /** The next thing to teach ("Run fit · 3 missed") - without leaving Teach. */
  next?: { label: string; onGo: () => void } | null;
}) {
  const clamp = (i: number) => Math.min(Math.max(0, i), Math.max(0, slides.length - 1));
  const [at, setAt] = useState(clamp(start));
  /** Bumped to watch the play again: the picture restarts. */
  const [replay, setReplay] = useState(0);
  const [notes, setNotes] = useState(true);
  // The play link only for coaches who can open Motion Lab.
  const motionLab = useMayUseMotionLab();
  /* A NEW THING TO TEACH (Next, or new slides from the caller) starts at its
     own first slide. */
  const slideKeys = slides.map((s) => s.key).join('|');
  useEffect(() => {
    setAt(clamp(start));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideKeys, start]);
  const slide = slides[at];

  const screenRef = useRef<HTMLDivElement>(null);
  /* THE SCREEN HAS THE KEYS while it is up: focus moves to it, and a key
     pressed here stays here - Motion Lab's own shortcuts (Space plays, Delete
     clears a path) must not act on the play underneath the meeting room. */
  useEffect(() => screenRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fullScreen = () => {
    const el = screenRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el.requestFullscreen?.().catch(() => undefined);
  };
  const forward = () => {
    if (at < slides.length - 1) setAt(at + 1);
    else next?.onGo();
  };

  if (!slide) return null;
  const shownNames = room?.names.slice(0, NAMES_SHOWN) ?? [];
  const moreNames = (room?.names.length ?? 0) - shownNames.length;

  return createPortal(
    <div
      ref={screenRef}
      tabIndex={-1}
      className={styles.teach}
      role="dialog"
      aria-modal="true"
      aria-label={`Teach ${title}`}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const target = e.target as HTMLElement;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
        if (e.key === 'Escape') onClose();
        else if (e.key === 'ArrowRight') forward();
        else if (e.key === 'ArrowLeft') setAt(clamp(at - 1));
        else if (e.key === ' ' && target.tagName !== 'BUTTON') setReplay((n) => n + 1);
        else if (e.key === 'n' || e.key === 'N') setNotes((on) => !on);
        else if (e.key === 'f' || e.key === 'F') fullScreen();
        else if (/^[1-9]$/.test(e.key) && Number(e.key) <= slides.length) setAt(Number(e.key) - 1);
        else return;
        e.preventDefault();
      }}
    >
      <div className={styles.bar}>
        <span className={styles.title}>{title}</span>
        {slides.length > 1 && (
          <span className={styles.steps} aria-label="Slides">
            {slides.map((s, i) => (
              <button
                key={s.key}
                type="button"
                className={i === at ? styles.stepOn : ''}
                aria-current={i === at ? 'step' : undefined}
                onClick={() => setAt(i)}
              >
                {i + 1}
              </button>
            ))}
          </span>
        )}
        <span className={styles.spacer} />
        {action && <span className={styles.action}>{action}</span>}
        {next && (
          <button type="button" className={styles.next} onClick={next.onGo} title="Teach this next (→ after the last slide)">
            Next: {next.label} <span aria-hidden="true">›</span>
          </button>
        )}
        <button
          type="button"
          className={styles.tool}
          aria-pressed={!notes}
          onClick={() => setNotes((on) => !on)}
          title="Just the football - notes on or off (N)"
        >
          {notes ? 'Hide notes' : 'Notes'}
        </button>
        <button type="button" className={styles.tool} onClick={fullScreen} title="Full screen (F)" aria-label="Full screen">
          ⛶
        </button>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close" title="Close (Esc)">
          ×
        </button>
      </div>
      <div className={`${styles.body} ${notes ? '' : styles.footballOnly}`}>
        {slide.picture ? (
          <div className={styles.pictureSlot} key={`${slide.key}-${replay}`}>
            {slide.picture}
          </div>
        ) : (
          slide.imageUrl && (
            <div className={styles.pictureSlot}>
              <img className={styles.picture} src={slide.imageUrl} alt="The play" />
            </div>
          )
        )}
        {notes && (
          <div className={styles.side}>
            {room && room.missed > 0 && (
              <div className={styles.room}>
                <span className={styles.roomCount}>
                  {room.of !== null ? `${room.missed} of ${room.of}` : room.missed} {room.verb ?? 'missed it'}
                </span>
                {shownNames.length > 0 && (
                  <span className={styles.roomNames}>
                    {shownNames.join(', ')}
                    {moreNames > 0 ? ` and ${moreNames} more` : ''}
                  </span>
                )}
              </div>
            )}
            {slide.concept && slide.concept !== title && <span className={styles.concept}>{slide.concept}</span>}
            {slide.role && <span className={styles.role}>You&rsquo;re the {slide.role}</span>}
            <p className={styles.prompt}>{slide.prompt}</p>
            {slide.right.length > 0 && (
              <p className={styles.right}>
                <span>Right answer</span> {slide.right.join(', ')}
              </p>
            )}
            {slide.why && <p className={styles.why}>{slide.why}</p>}
            {slide.wrong && (
              <p className={styles.wrong}>
                {slide.wrong.count} chose “{slide.wrong.text}”
              </p>
            )}
            {motionLab && slide.motionPlayId !== null && (
              <Link to={`/motion-lab/plays/${slide.motionPlayId}`} className={styles.play}>
                Open the play in Motion Lab
              </Link>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
