import { useEffect, useState, type ReactNode } from 'react';
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
}

/**
 * TEACH: the meeting-room view. Full screen - PEIRA's own header included,
 * hence the portal - with the picture as big as it goes, the coach's right
 * answer and reason beside it, what the room chose instead, and the Motion
 * Lab play one tap away when the question came from one. Several slides step
 * with 1, 2, 3; Escape closes.
 *
 * Shared by a Situational Rep's football problems and a quiz's Results.
 */
export function TeachView({
  title,
  slides,
  start = 0,
  onClose,
  action,
}: {
  title: string;
  slides: TeachSlide[];
  start?: number;
  onClose: () => void;
  /** The next step, right where the teaching happens (e.g. "Retest the 4 who missed"). */
  action?: ReactNode;
}) {
  const [at, setAt] = useState(Math.min(Math.max(0, start), Math.max(0, slides.length - 1)));
  // The play link only for coaches who can open Motion Lab.
  const motionLab = useMayUseMotionLab();
  const slide = slides[at];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!slide) return null;
  return createPortal(
    <div className={styles.teach} role="dialog" aria-modal="true" aria-label={`Teach ${title}`}>
      <div className={styles.bar}>
        <span className={styles.title}>{title}</span>
        {slides.length > 1 && (
          <span className={styles.steps}>
            {slides.map((s, i) => (
              <button key={s.key} type="button" className={i === at ? styles.stepOn : ''} onClick={() => setAt(i)}>
                {i + 1}
              </button>
            ))}
          </span>
        )}
        {motionLab && slide.motionPlayId !== null && (
          <Link to={`/motion-lab/plays/${slide.motionPlayId}`} className={styles.play}>
            Open the play in Motion Lab
          </Link>
        )}
        {action && <span className={styles.action}>{action}</span>}
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className={styles.body}>
        {slide.imageUrl && <img className={styles.picture} src={slide.imageUrl} alt="The play" />}
        <div className={styles.side}>
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
        </div>
      </div>
    </div>,
    document.body,
  );
}
