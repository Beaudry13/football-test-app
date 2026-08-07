import { useEffect, useRef, useState } from 'react';
import { saveAnswer, saveDrawing, submitQuiz } from '../../api/play';
import { getErrorMessage } from '../../api/client';
import type { Question, Quiz, ResumedAnswer } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { hasDrawnAnswer } from '../../components/drawing/drawingDocument';
import { QuestionInput, type PlayerAnswer } from './QuestionInput';
import { QuizProgress } from './QuizProgress';
import styles from './PlayPage.module.css';

const AUTOSAVE_DEBOUNCE_MS = 800;
/** Longer than the text debounce. A drawing payload is orders of magnitude
 * larger, and a player mid-stroke produces changes continuously rather than in
 * the bursts typing produces. */
const DRAWING_AUTOSAVE_DEBOUNCE_MS = 1500;

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
  playerId,
  initialAnswers,
  onSubmitted,
}: {
  quiz: Quiz;
  accessCodeId: number;
  playerName: string;
  /** Set when the player picked a canonical master-roster entry - see
   * NameStep. Threaded through every /play call so two Players sharing a
   * display name never collide onto the same attempt. */
  playerId: number | undefined;
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
  /** The revision the server last confirmed, per question.
   *
   * A ref rather than state, and read at SEND time rather than at schedule
   * time. The save is debounced, so the `answer` captured when the timer was
   * set is already stale by the time it fires - the previous save's response
   * has landed in between. Reading a captured revision sent `null` on the
   * second save of every session, which the server correctly refused as a
   * conflict, and the player saw "Couldn't save" on their first real stroke. */
  const drawingRevisions = useRef<Record<number, number>>({});

  /** Namespaces drawing drafts in localStorage. Keyed by access code and
   * player, so two team-mates handing one phone back and forth never see each
   * other's drawings, and the same player on a different code starts clean. */
  const drawingScope = `${accessCodeId}:${playerId ?? playerName}`;

  /** The one place the player flow decides whether a question has been
   * answered, mirroring services/attempts.py::is_answered on the server. The
   * two must agree, or a player is told they may submit and is then refused.
   *
   * Asks what the question's TYPE requires rather than scanning for whatever
   * content happens to be present. That distinction is what keeps the planned
   * combined-response work possible: a Draw Response question may later also
   * require a written explanation, and a "has any content" rule would call it
   * answered the moment either half arrived. */
  function isAnswered(question: Question, answer: PlayerAnswer | undefined): boolean {
    if (question.question_type === 'draw_response') return hasDrawnAnswer(answer?.drawing);
    if (question.question_type === 'written') return Boolean(answer?.answer_text?.trim());
    return answer?.selected_option_id !== undefined;
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
      player_id: playerId,
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

  /** Sends a drawing to its own endpoint.
   *
   * QuestionInput has already written the local draft before this runs, so a
   * failure here costs the player nothing - the draft is the resilience layer
   * and the server is the authority, in that order. */
  function performDrawingSave(questionId: number, answer: PlayerAnswer) {
    if (!answer.drawing) return;

    const knownRevision = drawingRevisions.current[questionId];
    // Nothing drawn and nothing ever saved: opening the board creates an empty
    // document, and persisting that would write a row purely so the next save
    // could conflict with it. An empty document with a revision IS saved -
    // that is a player deliberately erasing their answer.
    if (!hasDrawnAnswer(answer.drawing) && knownRevision === undefined) return;

    setSaveStatus('saving');
    saveDrawing({
      access_code_id: accessCodeId,
      player_name: playerName,
      player_id: playerId,
      question_id: questionId,
      document: answer.drawing,
      // Read now, not from the captured `answer` - see drawingRevisions.
      base_revision: knownRevision ?? null,
    })
      .then((result) => {
        setSaveStatus('saved');
        drawingRevisions.current[questionId] = result.revision;
      })
      .catch((err) => {
        setSaveStatus('error');
        // 409 means this drawing was changed elsewhere - another device, or a
        // tab left open. The local copy is kept and submit still carries it
        // (submit is authoritative), so the player is never stranded; they
        // are just told rather than left with a silent "Saved" that was not.
        if (getErrorMessage(err).toLowerCase().includes('another device')) {
          setError('This drawing was changed on another device. Yours will be used when you submit.');
        }
      });
  }

  function updateAnswer(questionId: number, answer: PlayerAnswer) {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }));
    const changedQuestion = questions.find((q) => q.id === questionId);
    // Clears a stale highlight the instant the player fixes it, rather than
    // only re-checking on the next submit attempt.
    if (changedQuestion && isAnswered(changedQuestion, answer)) {
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

    // A drawing goes to its own endpoint: a much larger payload, a longer
    // debounce, and a revision the text path has no concept of.
    if (answer.drawing !== undefined) {
      debounceTimers.current[questionId] = setTimeout(() => {
        delete debounceTimers.current[questionId];
        performDrawingSave(questionId, answer);
      }, DRAWING_AUTOSAVE_DEBOUNCE_MS);
      return;
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

    // The Phase 2 guard that used to sit here is gone: it existed only because
    // a drawing could not reach the server, so a drawing-only answer passed
    // the client check and was then refused by one. Both sides now agree, via
    // isAnswered above and services/attempts.py::is_answered below it.
    if (quiz.require_all_answers) {
      const missing = questions.filter((q) => !isAnswered(q, answers[q.id]));
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
        player_id: playerId,
        answers: questions.map((q) => ({
          question_id: q.id,
          selected_option_id: answers[q.id]?.selected_option_id ?? null,
          answer_text: answers[q.id]?.answer_text ?? null,
          // Re-sent as the same safety net the text answers already get: an
          // autosave may have failed on a flaky connection, and submit is the
          // player's last chance to be heard. The server treats submit as
          // authoritative, so this never 409s against their own autosave.
          drawing: answers[q.id]?.drawing ?? null,
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
        {/* A bar, not just a count. "Question 7 of 20" tells a player where
            they are only after they do the arithmetic; a filled track tells
            them how much is left at a glance, which is what actually keeps
            someone going on a phone. Shared with QuizPreviewPage so the two
            cannot drift - see QuizProgress. */}
        <QuizProgress
          currentIndex={currentIndex}
          total={questions.length}
          saveIndicator={saveIndicator}
        />
        <ErrorBanner message={error} />
        <QuestionInput
          question={question}
          index={currentIndex}
          answer={answers[question.id]}
          onChange={(a) => updateAnswer(question.id, a)}
          isUnanswered={unansweredIds.has(question.id)}
          drawingScope={drawingScope}
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
              {isSubmitting ? 'Submitting…' : 'Submit Quiz'}
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
          drawingScope={drawingScope}
        />
      ))}
      <button className="btn btn-primary" onClick={handleSubmit} disabled={isSubmitting} style={{ width: '100%' }}>
        {isSubmitting ? 'Submitting…' : 'Submit Quiz'}
      </button>
    </div>
  );
}
