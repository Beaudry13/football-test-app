import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getQuiz } from '../../api/quizzes';
import { getErrorMessage } from '../../api/client';
import type { Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { QuestionInput, type PlayerAnswer } from '../play/QuestionInput';
import playStyles from '../play/PlayPage.module.css';
import styles from './QuizPreviewPage.module.css';

/** Read-only walkthrough of the exact player-facing rendering (same
 * QuestionInput component, same PlayPage.module.css classes, same image
 * sizing) - so a coach can see what players will see without needing an
 * access code, a roster entry, or a real submission. Nothing here reaches
 * the play API; "submitting" just shows a local acknowledgement card. */
export function QuizPreviewPage() {
  const { quizId } = useParams<{ quizId: string }>();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<number, PlayerAnswer>>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFinished, setIsFinished] = useState(false);

  useEffect(() => {
    if (!quizId) return;
    getQuiz(Number(quizId))
      .then(setQuiz)
      .catch((err) => setError(getErrorMessage(err)));
  }, [quizId]);

  function updateAnswer(questionId: number, answer: PlayerAnswer) {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }));
  }

  function restart() {
    setAnswers({});
    setCurrentIndex(0);
    setIsFinished(false);
  }

  if (!quiz) {
    return (
      <div className={styles.page}>
        <ErrorBanner message={error} />
        {!error && <p>Loading…</p>}
      </div>
    );
  }

  const questions = quiz.questions ?? [];
  const backLink = (
    <Link to={`/quizzes/${quiz.id}`} className={styles.backLink}>
      ← Back to editor
    </Link>
  );

  if (questions.length === 0) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>{backLink}</div>
        <div className={`card ${styles.emptyState}`}>
          No questions yet — add at least one before previewing.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        {backLink}
        <strong>{quiz.title}</strong>
      </div>
      <div className={styles.banner}>
        Preview mode — this is exactly what a player sees. Nothing you do here is saved.
      </div>

      <div className={playStyles.wrapper}>
        {isFinished ? (
          <div className={playStyles.quizPanel}>
            <div className={`card ${playStyles.summaryStat}`}>
              <h2>End of preview</h2>
              <p>
                A real player would submit here and later see their per-question results once
                you've graded any written answers.
              </p>
              <button className="btn btn-primary" onClick={restart}>
                Restart preview
              </button>
            </div>
          </div>
        ) : quiz.one_question_at_a_time ? (
          (() => {
            const question = questions[currentIndex];
            const isLast = currentIndex === questions.length - 1;
            return (
              <div className={playStyles.quizPanel}>
                <div className={playStyles.progress}>
                  Question {currentIndex + 1} of {questions.length}
                </div>
                <QuestionInput
                  question={question}
                  index={currentIndex}
                  answer={answers[question.id]}
                  onChange={(a) => updateAnswer(question.id, a)}
                />
                <div className={playStyles.navRow}>
                  <button
                    className="btn btn-secondary"
                    disabled={currentIndex === 0}
                    onClick={() => setCurrentIndex((i) => i - 1)}
                  >
                    Back
                  </button>
                  {isLast ? (
                    <button className="btn btn-primary" onClick={() => setIsFinished(true)}>
                      Submit Peira
                    </button>
                  ) : (
                    <button className="btn btn-primary" onClick={() => setCurrentIndex((i) => i + 1)}>
                      Next
                    </button>
                  )}
                </div>
              </div>
            );
          })()
        ) : (
          <div className={playStyles.quizPanel}>
            {questions.map((question, index) => (
              <QuestionInput
                key={question.id}
                question={question}
                index={index}
                answer={answers[question.id]}
                onChange={(a) => updateAnswer(question.id, a)}
              />
            ))}
            <button
              className="btn btn-primary"
              onClick={() => setIsFinished(true)}
              style={{ width: '100%' }}
            >
              Submit Peira
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
