import { useState } from 'react';
import { DrawingViewer } from './DrawingViewer';
import type { DrawingDocument } from './types';
import styles from './CompareDrawing.module.css';

/**
 * A PLAYER'S DRAWING AGAINST THE ANSWER: his strokes as he drew them, the
 * coach's answer drawing over them in green, and one toggle to see either
 * alone. Coach review ("Your answer") and a Rep player's self-review
 * ("Coach's answer") use the same picture.
 */
export function CompareDrawing({
  imageUrl,
  document,
  answer,
  alt,
  answerLabel = 'Your answer',
  maxWidth,
}: {
  imageUrl: string;
  document: DrawingDocument;
  answer: DrawingDocument | null | undefined;
  alt: string;
  answerLabel?: string;
  maxWidth?: number;
}) {
  const [shown, setShown] = useState(true);
  return (
    <div className={styles.compare}>
      {answer && (
        <button type="button" className={styles.toggle} aria-pressed={shown} onClick={() => setShown((s) => !s)}>
          <span className={styles.swatch} aria-hidden="true" />
          {answerLabel}
          <span className={styles.state}>{shown ? 'on' : 'off'}</span>
        </button>
      )}
      <DrawingViewer imageUrl={imageUrl} document={document} overlay={answer && shown ? answer : null} alt={alt} maxWidth={maxWidth} />
    </div>
  );
}
