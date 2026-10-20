import { useState } from 'react';
import type { Question } from '../../api/types';
import { ReviewMissed } from './FootballDecision';
import type { StoredReview } from './workProgress';

/**
 * REVIEW MISSED, FROM PLAYER HOME: his last run's misses, on the exact
 * pictures, without starting a new run - what he chose, the right answer when
 * it was a Rep, the coach's point. Then Run it again (a fresh run, as the Rep
 * itself offers) or back to his work.
 */
export function HomeReview({
  questions,
  review,
  isRep,
  onDone,
  onRunAgain,
}: {
  /** The quiz's questions as the code delivers them now. */
  questions: Question[];
  review: StoredReview;
  isRep: boolean;
  onDone: () => void;
  onRunAgain: () => void;
}) {
  const missed = review.missedIds
    .map((id) => questions.find((q) => q.id === id))
    .filter((q): q is Question => !!q);
  const [at, setAt] = useState(0);
  const feedback = Object.fromEntries(review.feedback.map((f) => [f.question_id, f]));
  return (
    <ReviewMissed
      decisions={missed}
      feedback={feedback}
      chosen={review.chosen}
      at={at}
      onAt={setAt}
      onDone={onDone}
      onRunAgain={onRunAgain}
      runAgainLabel={isRep ? 'Run it again' : 'Try again'}
    />
  );
}
