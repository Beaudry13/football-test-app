import type { ReactNode } from 'react';
import styles from './PlayPage.module.css';

/** The "Question 3 of 10" count, progress bar, and (optionally) the autosave
 * indicator.
 *
 * Shared rather than inlined because two places render it: the real player
 * flow (QuizStep) and the coach's read-only walkthrough (QuizPreviewPage),
 * whose entire value is being "exactly what a player sees". They had already
 * drifted once - the preview kept a bare count after the player flow gained
 * a bar - and a coach who previews something different from what ships is
 * worse off than one who cannot preview at all.
 *
 * The preview passes no `saveIndicator`, since nothing there is saved. */
export function QuizProgress({
  currentIndex,
  total,
  saveIndicator,
}: {
  /** Zero-based, so the display adds one. */
  currentIndex: number;
  total: number;
  saveIndicator?: ReactNode;
}) {
  const position = Math.min(currentIndex + 1, total);
  // Guards a quiz with no questions, which would otherwise divide by zero
  // and hand the bar a NaN width.
  const percent = total > 0 ? (position / total) * 100 : 0;

  return (
    <div className={styles.progressBlock}>
      <div className={styles.progressRow}>
        <span className={styles.progress}>
          Question {position} of {total}
        </span>
        {saveIndicator}
      </div>
      <div
        className={styles.progressTrack}
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={position}
        aria-label={`Question ${position} of ${total}`}
      >
        <div className={styles.progressFill} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
