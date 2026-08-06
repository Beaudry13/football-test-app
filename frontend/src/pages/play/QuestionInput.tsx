import { useState } from 'react';
import { resolveMediaUrl } from '../../api/client';
import type { Question } from '../../api/types';
import { AnnotationViewer } from '../../components/annotation/AnnotationViewer';
import { ImageLightbox } from '../../components/ImageLightbox';
import { renderArrows } from '../../utils/typography';
import styles from './PlayPage.module.css';

export interface PlayerAnswer {
  selected_option_id?: number;
  answer_text?: string;
}

export function QuestionInput({
  question,
  index,
  answer,
  onChange,
  isUnanswered = false,
}: {
  question: Question;
  index: number;
  answer: PlayerAnswer | undefined;
  onChange: (answer: PlayerAnswer) => void;
  /** True once a blocked submit attempt has flagged this question as
   * required and still blank - not a general "invalid" state. */
  isUnanswered?: boolean;
}) {
  const [isZoomed, setIsZoomed] = useState(false);
  const image = question.image;
  const hasAnnotations = (image?.annotations.length ?? 0) > 0;

  return (
    <div
      id={`question-${question.id}`}
      className={`card ${styles.questionCard} ${isUnanswered ? styles.questionCardUnanswered : ''}`}
    >
      {image && (
        <>
          {hasAnnotations ? (
            <AnnotationViewer
              imageUrl={resolveMediaUrl(image.image_url)}
              annotations={image.annotations}
              canvasWidth={image.canvas_width}
              alt="Film still with coach's annotations"
              onClick={() => setIsZoomed(true)}
              className={styles.questionImage}
            />
          ) : (
            <img
              src={resolveMediaUrl(image.image_url)}
              alt="Film still"
              onClick={() => setIsZoomed(true)}
              className={styles.questionImage}
            />
          )}
          {isZoomed && (
            <ImageLightbox
              src={resolveMediaUrl(image.image_url)}
              alt="Film still, enlarged"
              annotations={image.annotations}
              canvasWidth={image.canvas_width}
              onClose={() => setIsZoomed(false)}
            />
          )}
        </>
      )}
      {/* The number is a separate badge rather than "1." run into the text:
          at a glance a player should be able to find where they are without
          reading the question, and an inline number disappears into the
          sentence on a small screen. */}
      <div className={styles.questionHeader}>
        <span className={styles.questionNumber} aria-hidden="true">
          {index + 1}
        </span>
        {/* renderArrows is display-only - the coach's stored text keeps the
            literal "->" they typed. See utils/typography.ts. */}
        <strong className={styles.questionText}>{renderArrows(question.question_text)}</strong>
      </div>
      {isUnanswered && <div className={styles.questionRequiredNote}>Please answer this question.</div>}

      {question.question_type === 'written' ? (
        <textarea
          className={styles.writtenAnswer}
          value={answer?.answer_text ?? ''}
          onChange={(e) => onChange({ answer_text: e.target.value })}
        />
      ) : (
        <div className={styles.optionList}>
          {question.options.map((option) => (
            <label
              key={option.id}
              className={`${styles.optionRow} ${
                answer?.selected_option_id === option.id ? styles.optionRowActive : ''
              }`}
            >
              {/* Still a real <input type="radio"> - it is styled with
                  appearance:none rather than replaced by a div, so keyboard
                  navigation, screen readers and form semantics all keep
                  working exactly as before. */}
              <input
                type="radio"
                className={styles.optionRadio}
                name={`question-${question.id}`}
                checked={answer?.selected_option_id === option.id}
                onChange={() => onChange({ selected_option_id: option.id })}
              />
              <span className={styles.optionText}>{renderArrows(option.option_text)}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
