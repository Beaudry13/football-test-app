import { useState } from 'react';
import { submitQuiz } from '../../api/play';
import { getErrorMessage } from '../../api/client';
import type { Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { QuestionInput, type PlayerAnswer } from './QuestionInput';
import styles from './PlayPage.module.css';

export function QuizStep({
  quiz,
  accessCodeId,
  playerName,
  onSubmitted,
}: {
  quiz: Quiz;
  accessCodeId: number;
  playerName: string;
  onSubmitted: () => void;
}) {
  const questions = quiz.questions ?? [];
  const [answers, setAnswers] = useState<Record<number, PlayerAnswer>>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function updateAnswer(questionId: number, answer: PlayerAnswer) {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }));
  }

  async function handleSubmit() {
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

  if (quiz.one_question_at_a_time) {
    const question = questions[currentIndex];
    const isLast = currentIndex === questions.length - 1;

    return (
      <div className={styles.quizPanel}>
        <div className={styles.progress}>
          Question {currentIndex + 1} of {questions.length}
        </div>
        <ErrorBanner message={error} />
        <QuestionInput
          question={question}
          index={currentIndex}
          answer={answers[question.id]}
          onChange={(a) => updateAnswer(question.id, a)}
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
              {isSubmitting ? 'Submitting…' : 'Submit quiz'}
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
      <ErrorBanner message={error} />
      {questions.map((question, index) => (
        <QuestionInput
          key={question.id}
          question={question}
          index={index}
          answer={answers[question.id]}
          onChange={(a) => updateAnswer(question.id, a)}
        />
      ))}
      <button className="btn btn-primary" onClick={handleSubmit} disabled={isSubmitting} style={{ width: '100%' }}>
        {isSubmitting ? 'Submitting…' : 'Submit quiz'}
      </button>
    </div>
  );
}
