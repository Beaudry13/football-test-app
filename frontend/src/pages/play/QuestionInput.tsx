import { resolveMediaUrl } from '../../api/client';
import type { Question } from '../../api/types';
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
  return (
    <div className={`card ${styles.questionCard}`}>
      {question.image && (
        <img
          src={resolveMediaUrl(question.image.image_url)}
          alt="Film still"
          style={{ maxWidth: '100%', borderRadius: 'var(--radius-sm)', marginBottom: '0.75em' }}
        />
      )}
      <strong>
        {index + 1}. {question.question_text}
      </strong>

      {question.question_type === 'written' ? (
        <textarea
          className={styles.optionList}
          style={{ width: '100%', marginTop: '0.75em', padding: '0.6em' }}
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
