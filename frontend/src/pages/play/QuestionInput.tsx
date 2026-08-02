import { useState } from 'react';
import { resolveMediaUrl } from '../../api/client';
import type { Question } from '../../api/types';
import { AnnotationViewer } from '../../components/annotation/AnnotationViewer';
import { ImageLightbox } from '../../components/ImageLightbox';
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
}: {
  question: Question;
  index: number;
  answer: PlayerAnswer | undefined;
  onChange: (answer: PlayerAnswer) => void;
}) {
  const [isZoomed, setIsZoomed] = useState(false);
  const image = question.image;
  const hasAnnotations = (image?.annotations.length ?? 0) > 0;

  return (
    <div className={`card ${styles.questionCard}`}>
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
      <strong>
        {index + 1}. {question.question_text}
      </strong>

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
              <input
                type="radio"
                name={`question-${question.id}`}
                checked={answer?.selected_option_id === option.id}
                onChange={() => onChange({ selected_option_id: option.id })}
              />
              {option.option_text}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
