import { useEffect, useRef, useState, type FormEvent } from 'react';
import nb from '../../styles/notebook.module.css';
import styles from './RegionQuestionForm.module.css';

/** The inline panel that turns a drawn rectangle into a question.
 *
 * Inline, and NOT a modal, on purpose. The stated goal is 10-15 questions from
 * one page without repeatedly leaving it, and a modal per question would put a
 * mount, a focus trap and a dismissal between every one of them. This appears
 * beside the page, takes two fields, and hands focus straight back to the page
 * on save so the next drag can start immediately.
 *
 * The answer field is focused on mount rather than the prompt: the prompt is
 * often a phrase the coach reuses ("What is this coverage?"), while the answer
 * changes every time and is the thing they came to type.
 */
export function RegionQuestionForm({
  onSave,
  onCancel,
  saving,
  defaultPrompt,
  defaultAnswer = '',
}: {
  onSave: (input: { question_text: string; expected_answers: string[] }) => void;
  onCancel: () => void;
  saving: boolean;
  /** The last prompt used on this page, so a coach masking twelve coverage
   *  names does not retype the same question twelve times. */
  defaultPrompt: string;
  /** The text of the tapped run. THE speed win: the answer is already on the
   *  page, so asking the coach to retype what the system just read to them is
   *  pure ceremony. Empty for a dragged rectangle, where there is no text. */
  defaultAnswer?: string;
}) {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [answers, setAnswers] = useState(defaultAnswer);
  const answerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Selected, not just focused: a tapped answer is usually right, so Enter
    // saves it - but if the coach wants a different wording, typing replaces
    // it without a Ctrl+A first.
    answerRef.current?.focus();
    answerRef.current?.select();
  }, []);

  // Comma-separated, because that is how a coach naturally writes a list and
  // it avoids a repeater UI with add/remove buttons for what is usually one
  // value. Blank entries are dropped here and again on the server.
  const parsedAnswers = answers
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const canSave = prompt.trim().length > 0 && parsedAnswers.length > 0 && !saving;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    onSave({ question_text: prompt.trim(), expected_answers: parsedAnswers });
  }

  return (
    <form className={styles.panel} onSubmit={handleSubmit}>
      <div className={styles.title}>New question from this region</div>

      <label className={nb.fieldLabel} htmlFor="region-answers">
        Accepted answers
      </label>
      <input
        id="region-answers"
        ref={answerRef}
        className={nb.input}
        value={answers}
        placeholder="Cover 3, C3"
        onChange={(event) => setAnswers(event.target.value)}
      />
      <p className={styles.hint}>
        Separate alternatives with commas. Capitalisation and extra spaces are ignored.
      </p>

      <label className={nb.fieldLabel} htmlFor="region-prompt">
        Question
      </label>
      <input
        id="region-prompt"
        className={nb.input}
        value={prompt}
        placeholder="What is covered here?"
        onChange={(event) => setPrompt(event.target.value)}
      />

      <div className={styles.actions}>
        <button type="button" className={nb.btnSecondary} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className={nb.btnPrimary} disabled={!canSave}>
          {saving ? 'Saving…' : 'Save question'}
        </button>
      </div>
    </form>
  );
}
