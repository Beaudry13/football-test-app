import { useEffect, useRef, useState } from 'react';
import { saveAnswer, submitQuiz } from '../../api/play';
import { getErrorMessage } from '../../api/client';
import type { Quiz, ResumedAnswer } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { QuestionInput, type PlayerAnswer } from './QuestionInput';
import styles from './PlayPage.module.css';

const AUTOSAVE_DEBOUNCE_MS = 800;

function seedAnswers(initialAnswers: ResumedAnswer[]): Record<number, PlayerAnswer> {
  const seeded: Record<number, PlayerAnswer> = {};
  for (const a of initialAnswers) {
    seeded[a.question_id] = {
      selected_option_id: a.selected_option_id ?? undefined,
      answer_text: a.answer_text ?? undefined,
    };
  }
  return seeded;
}

export function QuizStep({
  quiz,
  accessCodeId,
  playerName,
  initialAnswers,
  onSubmitted,
}: {
  quiz: Quiz;
  accessCodeId: number;
  playerName: string;
  initialAnswers: ResumedAnswer[];
  onSubmitted: () => void;
}) {
  const questions = quiz.questions ?? [];
  const [answers, setAnswers] = useState<Record<number, PlayerAnswer>>(() => seedAnswers(initialAnswers));
  const [currentIndex, setCurrentIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [unansweredIds, setUnansweredIds] = useState<Set<number>>(new Set());
  const debounceTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  function isAnswered(answer: PlayerAnswer | undefined): boolean {
    return answer?.selected_option_id !== undefined || Boolean(answer?.answer_text?.trim());
  }

  useEffect(() => {
    const timers = debounceTimers.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  function performSave(questionId: number, answer: PlayerAnswer) {
    setSaveStatus('saving');
    saveAnswer({
      access_code_id: accessCodeId,
      player_name: playerName,
      question_id: questionId,
      selected_option_id: answer.selected_option_id ?? null,
      answer_text: answer.answer_text ?? null,
    })
      .then(() => setSaveStatus('saved'))
      .catch(() => setSaveStatus('error'));
    // A non-409 failure here is caught, not surfaced as a blocking error -
    // submit's own final sync (see handleSubmit) re-sends every answer's
    // current value as a safety net, so a transient autosave failure isn't
    // the only chance this answer has to reach the server. A 409 (attempt
    // already locked, e.g. finished on another device) shows the same
    // "error" indicator; the player's local state stays visible but stops
    // saving, and hitting Submit will 409 too and can be routed from there.
  }

  function updateAnswer(questionId: number, answer: PlayerAnswer) {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }));
    // Clears a stale highlight the instant the player fixes it, rather than
    // only re-checking on the next submit attempt.
    if (isAnswered(answer)) {
      setUnansweredIds((prev) => {
        if (!prev.has(questionId)) return prev;
        const next = new Set(prev);
        next.delete(questionId);
        return next;
      });
    }

    if (debounceTimers.current[questionId]) {
      clearTimeout(debounceTimers.current[questionId]);
      delete debounceTimers.current[questionId];
    }

    if (answer.selected_option_id !== undefined) {
      // A radio/option pick is the final value until changed again -
      // nothing to protect against by delaying it, and delaying only
      // widens the window where a closed browser loses the just-picked answer.
      performSave(questionId, answer);
    } else {
      // Free text: debounce so this isn't firing a request per keystroke.
      debounceTimers.current[questionId] = setTimeout(() => {
        delete debounceTimers.current[questionId];
        performSave(questionId, answer);
      }, AUTOSAVE_DEBOUNCE_MS);
    }
  }

  async function handleSubmit() {
    // Cancel every pending debounce timer first - none of them should fire
    // after submit has locked the attempt. Submit's own payload is built
    // from this component's full local `answers` state below, which is
    // always at least as current as anything a cancelled timer would have
    // sent, so nothing is lost by cancelling rather than flushing.
    Object.values(debounceTimers.current).forEach(clearTimeout);
    debounceTimers.current = {};

    if (quiz.require_all_answers) {
      const missing = questions.filter((q) => !isAnswered(answers[q.id]));
      if (missing.length > 0) {
        setUnansweredIds(new Set(missing.map((q) => q.id)));
        setError('Please answer all questions before submitting.');
        const firstMissingIndex = questions.findIndex((q) => q.id === missing[0].id);
        if (quiz.one_question_at_a_time) {
          setCurrentIndex(firstMissingIndex);
        } else {
          document
            .getElementById(`question-${missing[0].id}`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return;
      }
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await submitQuiz({
        access_code_id: accessCodeId,
        player_name: playerName,
        answers: questions.map((q) => ({
          question_id: q.id,
          selected_option_id: answers[q.id]?.selected_option_id ?? null,
          answer_text: answers[q.id]?.answer_text ?? null,
        })),
      });
      onSubmitted();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  const saveStatusText: Record<typeof saveStatus, string> = {
    idle: '',
    saving: 'Saving…',
    saved: 'Saved',
    error: "Couldn't save - will retry",
  };

  const saveIndicator = saveStatusText[saveStatus] && (
    <div className={`${styles.saveStatus} ${saveStatus === 'error' ? styles.saveStatusError : ''}`}>
      {saveStatusText[saveStatus]}
    </div>
  );

  if (quiz.one_question_at_a_time) {
    const question = questions[currentIndex];
    const isLast = currentIndex === questions.length - 1;

    return (
      <div className={styles.quizPanel}>
        <div className={styles.progress}>
          Question {currentIndex + 1} of {questions.length}
        </div>
        {saveIndicator}
        <ErrorBanner message={error} />
        <QuestionInput
          question={question}
          index={currentIndex}
          answer={answers[question.id]}
          onChange={(a) => updateAnswer(question.id, a)}
          isUnanswered={unansweredIds.has(question.id)}
        />
        <div className={styles.navRow}>
          <button
            className="btn btn-secondary"
            disabled={currentIndex === 0}
            onClick={() => setCurrentIndex((i) => i - 1)}
          >
            Back
          </button>
          {isLast ? (
            <button className="btn btn-primary" onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? 'Submitting…' : 'Submit Peira'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setCurrentIndex((i) => i + 1)}>
              Next
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.quizPanel}>
      {saveIndicator}
      <ErrorBanner message={error} />
      {questions.map((question, index) => (
        <QuestionInput
          key={question.id}
          question={question}
          index={index}
          answer={answers[question.id]}
          onChange={(a) => updateAnswer(question.id, a)}
          isUnanswered={unansweredIds.has(question.id)}
        />
      ))}
      <button className="btn btn-primary" onClick={handleSubmit} disabled={isSubmitting} style={{ width: '100%' }}>
        {isSubmitting ? 'Submitting…' : 'Submit Peira'}
      </button>
    </div>
  );
}
