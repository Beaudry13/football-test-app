import { useState, type FormEvent } from 'react';
import type { QuestionType } from '../../api/types';
import type { QuestionInput, QuestionOptionInput } from '../../api/questions';
import { getErrorMessage } from '../../api/client';
import { ErrorBanner } from '../../components/ErrorBanner';
import nb from '../../styles/notebook.module.css';
import styles from './QuestionEditor.module.css';

const TRUE_FALSE_OPTIONS: QuestionOptionInput[] = [
  { option_text: 'True', is_correct_answer: true },
  { option_text: 'False', is_correct_answer: false },
];

interface QuestionEditorProps {
  initialText?: string;
  initialType?: QuestionType;
  initialOptions?: QuestionOptionInput[];
  submitLabel: string;
  onSave: (input: QuestionInput) => Promise<void>;
  onCancel: () => void;
}

export function QuestionEditor({
  initialText = '',
  initialType = 'true_false',
  initialOptions,
  submitLabel,
  onSave,
  onCancel,
}: QuestionEditorProps) {
  const [questionText, setQuestionText] = useState(initialText);
  const [questionType, setQuestionType] = useState<QuestionType>(initialType);
  const [options, setOptions] = useState<QuestionOptionInput[]>(
    initialOptions ?? (initialType === 'true_false' ? TRUE_FALSE_OPTIONS : []),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  function handleTypeChange(type: QuestionType) {
    setQuestionType(type);
    if (type === 'true_false') {
      setOptions(TRUE_FALSE_OPTIONS);
    } else if (type === 'written') {
      setOptions([]);
    } else {
      setOptions([
        { option_text: '', is_correct_answer: true },
        { option_text: '', is_correct_answer: false },
      ]);
    }
  }

  function updateOptionText(index: number, text: string) {
    setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, option_text: text } : o)));
  }

  function setCorrectOption(index: number) {
    setOptions((prev) => prev.map((o, i) => ({ ...o, is_correct_answer: i === index })));
  }

  function addOption() {
    setOptions((prev) => [...prev, { option_text: '', is_correct_answer: false }]);
  }

  function removeOption(index: number) {
    setOptions((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (questionType === 'multiple_choice' && options.some((o) => !o.option_text.trim())) {
      setError('Every option needs text.');
      return;
    }

    setIsSaving(true);
    try {
      await onSave({ question_text: questionText.trim(), question_type: questionType, options });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form className={`${nb.card} ${styles.form}`} onSubmit={handleSubmit}>
      <ErrorBanner message={error} />

      <div className={nb.field}>
        <label className={nb.fieldLabel} htmlFor="question_text">
          Question
        </label>
        <textarea
          id="question_text"
          className={nb.input}
          required
          value={questionText}
          onChange={(e) => setQuestionText(e.target.value)}
        />
      </div>

      <div className={nb.field}>
        <label className={nb.fieldLabel} htmlFor="question_type">
          Type
        </label>
        <select
          id="question_type"
          className={nb.input}
          value={questionType}
          onChange={(e) => handleTypeChange(e.target.value as QuestionType)}
        >
          <option value="true_false">True / False</option>
          <option value="multiple_choice">Multiple choice</option>
          <option value="written">Written response</option>
        </select>
      </div>

      {questionType === 'true_false' && (
        <div className={nb.field}>
          <span className={nb.fieldLabel}>Correct answer</span>
          {options.map((option, index) => (
            <label key={option.option_text} style={{ display: 'block', fontWeight: 400 }}>
              <input
                type="radio"
                name="correct-option"
                checked={option.is_correct_answer}
                onChange={() => setCorrectOption(index)}
              />{' '}
              {option.option_text}
            </label>
          ))}
        </div>
      )}

      {questionType === 'multiple_choice' && (
        <div className={nb.field}>
          <span className={nb.fieldLabel}>Options (mark the correct one)</span>
          {options.map((option, index) => (
            <div className={styles.optionRow} key={index}>
              <input
                type="radio"
                name="correct-option"
                checked={option.is_correct_answer}
                onChange={() => setCorrectOption(index)}
              />
              <input
                type="text"
                className={nb.input}
                placeholder={`Option ${index + 1}`}
                value={option.option_text}
                onChange={(e) => updateOptionText(index, e.target.value)}
              />
              {options.length > 2 && (
                <button
                  type="button"
                  className={styles.removeOption}
                  onClick={() => removeOption(index)}
                  aria-label="Remove option"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button type="button" className={`${nb.btnSm} ${styles.addOption}`} onClick={addOption}>
            + Add option
          </button>
        </div>
      )}

      <div className={styles.formActions}>
        <button type="submit" className={nb.btnPrimary} disabled={isSaving}>
          {isSaving ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className={nb.btnSecondary} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
