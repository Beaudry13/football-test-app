import { useEffect, useState } from 'react';
import { excludeQuestion, listQuizAssignments } from '../../api/questionExclusions';
import { getErrorMessage } from '../../api/client';
import type { QuestionBreakdown, QuizAssignment } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import nb from '../../styles/notebook.module.css';
import { describeAssignment } from './assignmentLabel';
import styles from './ExcludeQuestionDialog.module.css';

const QUIZ_WIDE = 'quiz-wide';

export function ExcludeQuestionDialog({
  quizId,
  question,
  onCancel,
  onExcluded,
}: {
  quizId: number;
  question: QuestionBreakdown;
  onCancel: () => void;
  onExcluded: () => void;
}) {
  const [assignments, setAssignments] = useState<QuizAssignment[] | null>(null);
  const [scope, setScope] = useState<string>('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listQuizAssignments(quizId)
      .then((data) => {
        setAssignments(data);
        // Pre-select ONLY when there is exactly one assignment - then "this
        // assignment" is unambiguous and the coach should not have to fight
        // through a picker to say the only thing they could mean. With two or
        // more, nothing is chosen for them: guessing which delivery they meant
        // is how Monday's fix silently rewrites Tuesday.
        if (data.length === 1) setScope(String(data[0].access_code_id));
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, [quizId]);

  async function handleExclude() {
    setSaving(true);
    setError(null);
    try {
      await excludeQuestion(quizId, question.question_id, {
        access_code_id: scope === QUIZ_WIDE ? null : Number(scope),
        reason: reason.trim() || null,
      });
      onExcluded();
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  }

  const quizWide = scope === QUIZ_WIDE;
  const chosen = assignments?.find((a) => String(a.access_code_id) === scope);

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Don't count this question">
      <div className={`${nb.card} ${styles.dialog}`}>
        <h2 className={nb.subheading}>Don&rsquo;t count this question?</h2>

        <ErrorBanner message={error} />

        <p className={styles.questionText}>{question.question_text}</p>

        {assignments === null ? (
          <p className={styles.muted}>Loading assignments&hellip;</p>
        ) : assignments.length === 0 ? (
          <p className={styles.muted}>
            This quiz has never been sent out, so there are no results to change.
          </p>
        ) : (
          <>
            <label className={styles.label} htmlFor="exclusion-scope">
              Remove it from scoring for
            </label>
            <select
              id="exclusion-scope"
              className={nb.input}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="">Choose an assignment&hellip;</option>
              {assignments.map((a) => (
                <option key={a.access_code_id} value={String(a.access_code_id)}>
                  {describeAssignment(a)}
                </option>
              ))}
              <option value={QUIZ_WIDE}>All assignments using this quiz</option>
            </select>

            {/* The broader choice gets a stronger warning, and never arrives by
                default - a coach must pick it on purpose. */}
            {quizWide && (
              <div className={`${nb.badge} ${nb.badgeWarning} ${styles.warning}`}>
                This changes results for every past and future use of this quiz,
                not just one session.
              </div>
            )}
            {chosen && (
              <p className={styles.muted}>
                Affects {chosen.submitted_count} submitted{' '}
                {chosen.submitted_count === 1 ? 'response' : 'responses'}.
              </p>
            )}

            <label className={styles.label} htmlFor="exclusion-reason">
              Reason (optional)
            </label>
            <input
              id="exclusion-reason"
              className={nb.input}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              placeholder="e.g. wrong answer key"
            />
            <p className={styles.muted}>
              For your own records. Players never see this.
            </p>

            {/* Says plainly what is NOT happening. The whole action is
                reversible and destroys nothing, and a coach hesitating over
                this button is usually worried it deletes work. */}
            <p className={styles.reassurance}>
              Player answers are kept exactly as they are. You can undo this at
              any time.
            </p>
          </>
        )}

        <div className={styles.actions}>
          <button type="button" className={nb.btnSm} onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className={`${nb.btnSm} ${styles.confirm}`}
            onClick={handleExclude}
            disabled={saving || !scope || assignments === null || assignments.length === 0}
          >
            {saving ? 'Excluding…' : 'Exclude from scoring'}
          </button>
        </div>
      </div>
    </div>
  );
}
