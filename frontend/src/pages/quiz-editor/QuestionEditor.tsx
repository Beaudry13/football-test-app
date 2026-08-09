import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  onSave: (input: QuestionInput, image?: File | null) => Promise<void>;
  onCancel: () => void;
  /** Offers an image picker whose file is held here until save.
   *
   *  Only the create flow passes this. Editing keeps its existing route to the
   *  annotation page, which does more than upload - it is where a coach draws
   *  on the image - and folding that in here would be a different change. */
  allowImage?: boolean;
}

export function QuestionEditor({
  initialText = '',
  initialType = 'true_false',
  initialOptions,
  submitLabel,
  onSave,
  onCancel,
  allowImage = false,
}: QuestionEditorProps) {
  const [questionText, setQuestionText] = useState(initialText);
  const [questionType, setQuestionType] = useState<QuestionType>(initialType);
  const [options, setOptions] = useState<QuestionOptionInput[]>(
    initialOptions ?? (initialType === 'true_false' ? TRUE_FALSE_OPTIONS : []),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // The file lives HERE, not on the server, until the coach saves. That is
  // what makes Cancel leave nothing behind: nothing was ever created.
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!image) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setPreview(url);
    // Revoked on replace and on unmount; an object URL pins the whole file in
    // memory until it is.
    return () => URL.revokeObjectURL(url);
  }, [image]);

  function clearImage() {
    setImage(null);
    // Without this, re-picking the SAME file after removing it fires no change
    // event at all and the picker appears broken.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleTypeChange(type: QuestionType) {
    setQuestionType(type);
    if (type === 'true_false') {
      setOptions(TRUE_FALSE_OPTIONS);
    } else if (type === 'written' || type === 'draw_response') {
      // Neither is answered by picking from a list. A Draw Response question
      // converted from multiple choice may still have option rows in the
      // database - they are kept, inert, for the planned combined-response
      // work - but authoring one never creates or edits them.
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
      await onSave(
        { question_text: questionText.trim(), question_type: questionType, options },
        image,
      );
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
          disabled={questionType === 'fill_blank'}
          onChange={(e) => handleTypeChange(e.target.value as QuestionType)}
        >
          <option value="true_false">True / False</option>
          <option value="multiple_choice">Multiple Choice</option>
          <option value="written">Short Answer</option>
          <option value="draw_response">Draw Response</option>
          {/* Present so an existing Fill in the Blank question shows its real
              type rather than falling back to the first option - but disabled,
              because one cannot be created here: it needs a rectangle on a
              playbook page, which is the Playbooks editor's job. */}
          <option value="fill_blank" disabled>
            Fill in the Blank
          </option>
        </select>
      </div>

      {questionType === 'fill_blank' && (
        <p className={styles.typeNote}>
          This question was built from a playbook page. Edit its region and accepted answers
          from Playbooks; the wording can still be changed here.
        </p>
      )}

      {questionType === 'draw_response' && (
        <p className={styles.typeNote}>
          Players answer by drawing on this question&rsquo;s image. Add an image after saving -
          the quiz cannot be activated until every Draw Response question has one.
        </p>
      )}

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

      {/* TODO (future UX, deliberately not built now): accept a drag-and-drop
          image onto this form as well as the click-to-upload below. The
          click path stays either way - drag-and-drop is an addition, not a
          replacement, and a coach on a trackpad or a tablet still needs the
          button. The plumbing already suits it: the file is held in state
          until save, so a dropped File would take exactly the same path as a
          picked one and need no server change. */}
      {allowImage && (
        <div className={nb.field}>
          <span className={nb.fieldLabel}>Image</span>
          {preview ? (
            <div className={styles.imagePreview}>
              {/* Previewed from the file itself, so the coach sees exactly what
                  they picked without a round-trip - and without anything having
                  been created yet. */}
              <img src={preview} alt="Selected question image" />
              <div className={styles.imageActions}>
                <button
                  type="button"
                  className={nb.btnSm}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Replace
                </button>
                <button
                  type="button"
                  className={`${nb.btnSm} ${nb.btnDanger}`}
                  onClick={clearImage}
                >
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <p className={styles.imageHint}>
              Optional. Added when you save this question &mdash; you can annotate it afterwards.
            </p>
          )}
          <input
            ref={fileInputRef}
            id="question_image"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className={preview ? nb.srOnly : undefined}
            aria-label="Question image"
            onChange={(event) => setImage(event.target.files?.[0] ?? null)}
          />
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
