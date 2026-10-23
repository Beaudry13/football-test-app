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
  /** ASK FIRST: the picture without the answer in it (no lit spot, no drawn
   *  assignment) - shown until the coach reveals it. Absent when the picture
   *  gives nothing away. */
  pictureAsk?: ReactNode;
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
 *   A  ask first / show the answer       F  full screen (a projector)
 *   Esc  close
 *
 * ASK FIRST is the room check: the play and the question, the answer held
 * back - no right answer, no reason, no lit spot or drawn assignment - until
 * the coach shows it. Each slide starts held back while it is on. Nothing is
 * recorded: the room answers out loud; Retest is the formal check.
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
  prev,
  place,
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
  /** The thing taught before this one: ← before the first slide goes back to it. */
  prev?: { label: string; onGo: () => void } | null;
  /** Where this is in a meeting ("Week 7 - West Virginia · 2 of 6"). */
  place?: string;
}) {
  const clamp = (i: number) => Math.min(Math.max(0, i), Math.max(0, slides.length - 1));
  const [at, setAt] = useState(clamp(start));
  /** Bumped to watch the play again: the picture restarts. */
  const [replay, setReplay] = useState(0);
  const [notes, setNotes] = useState(true);
  /** Ask first: the answer held back on each slide until it is shown. */
  const [asking, setAsking] = useState(false);
  const [shownKey, setShownKey] = useState<string | number | null>(null);
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
  const holding = asking && shownKey !== slide.key;
  const hasAnswer = slide.right.length > 0 || !!slide.why || !!slide.pictureAsk;
  const picture = holding && slide.pictureAsk ? slide.pictureAsk : slide.picture;
  const askOrShow = () => {
    if (!asking) {
      setAsking(true);
      setShownKey(null);
    } else if (holding) setShownKey(slide.key);
    else setAsking(false);
  };
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
        else if (e.key === 'ArrowLeft') {
          if (at > 0) setAt(at - 1);
          else prev?.onGo();
        }
        else if (e.key === ' ' && target.tagName !== 'BUTTON') setReplay((n) => n + 1);
        else if (e.key === 'n' || e.key === 'N') setNotes((on) => !on);
        else if (e.key === 'f' || e.key === 'F') fullScreen();
        else if (e.key === 'a' || e.key === 'A') askOrShow();
        else if (/^[1-9]$/.test(e.key) && Number(e.key) <= slides.length) setAt(Number(e.key) - 1);
        else return;
        e.preventDefault();
      }}
    >
      <div className={styles.bar}>
        {/* Back an item - the ← key's twin, for a finger. */}
        {prev && (
          <button type="button" className={styles.prev} onClick={prev.onGo} aria-label={`Back: ${prev.label}`} title={`Back: ${prev.label} (← before the first slide)`}>
            <span aria-hidden="true">‹</span>
          </button>
        )}
        <span className={styles.title}>{title}</span>
        {place && <span className={styles.place}>{place}</span>}
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
          aria-pressed={asking}
          onClick={() => {
            setAsking((on) => !on);
            setShownKey(null);
          }}
          title="Ask the room first - the answer held back until you show it (A)"
        >
          Ask first
        </button>
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
        {picture ? (
          <div className={styles.pictureSlot} key={`${slide.key}-${replay}-${holding ? 'ask' : 'shown'}`}>
            {picture}
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
            {holding && hasAnswer && (
              <button type="button" className={styles.reveal} onClick={() => setShownKey(slide.key)}>
                Show the answer <span className={styles.revealKey}>A</span>
              </button>
            )}
            {!holding && slide.right.length > 0 && (
              <p className={styles.right}>
                <span>Right answer</span> {slide.right.join(', ')}
              </p>
            )}
            {!holding && slide.why && <p className={styles.why}>{slide.why}</p>}
            {!holding && slide.wrong && (
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
