import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getErrorMessage } from '../../api/client';
import { createRetest } from '../../api/retests';
import type { ConceptBreakdown, Question, QuestionBreakdown, RetestSummary } from '../../api/types';
import type { TeachSlide } from '../../components/teach/TeachView';
import { FootballProblem } from '../../components/football/FootballProblem';
import { MissActions } from './MissActions';
import { RetestStatus } from './RetestStatus';
import { quizTeachSlides } from './quizTeach';
import { RetestAction } from './RetestAction';
import { playerLabels } from '../../utils/playerDisplayLabel';
import styles from './WeakestConcepts.module.css';

/** "What should I teach next?", above everything else on Results.
 *
 * Results has always opened with a team average and a table of scores - which
 * answers "how did they do", a question the coach can already feel by
 * Wednesday. What they cannot get anywhere is which IDEA the team is weakest
 * on, who specifically missed it, and what those players thought instead.
 *
 * EVERY NUMBER HERE IS HEDGED BY THE DATA THAT PRODUCED IT. A concept two
 * players answered is labelled as thin rather than announced as a weakness,
 * and a wrong-answer pattern is only named when enough players chose the same
 * wrong thing. The thresholds are the server's (see services/concept_results);
 * this file owns only the wording, so a coach reading "60% missed this" is
 * never being told something the sample cannot support.
 */
/** TEACH: a concept's questions as the meeting-room view (quizTeach) - the
 *  football picture, the coach's right answer, the reason, and what the misses
 *  chose: per question from the counts when Results has them, else the
 *  concept's own distractor when the concept is one question (so it cannot be
 *  pinned on the wrong one). Empty when the quiz's questions are not to hand. */
function conceptQuestions(concept: ConceptBreakdown, questions: Question[]): Question[] {
  return questions.filter((q) => q.concept?.id === concept.concept_id && !q.is_retired);
}
function teachSlides(concept: ConceptBreakdown, questions: Question[], breakdown: QuestionBreakdown[] = []): TeachSlide[] {
  const inConcept = conceptQuestions(concept, questions);
  return quizTeachSlides(inConcept, breakdown).map((slide) => ({
    ...slide,
    wrong:
      slide.wrong ??
      (inConcept.length === 1 && concept.top_distractor
        ? { text: concept.top_distractor.option_text, count: concept.top_distractor.count }
        : null),
  }));
}

/** TEACH -> RETEST without leaving the teaching screen: the same draft
 *  "Retest these N" builds, for the same players. */
function TeachRetest({ quizId, concept }: { quizId: number; concept: ConceptBreakdown }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const n = concept.players_missed.length;
  if (n === 0 || concept.retestable_question_count === 0 || concept.concept_id === null) return null;
  return (
    <button
      type="button"
      disabled={busy}
      title={failed ?? undefined}
      onClick={async () => {
        setBusy(true);
        setFailed(null);
        try {
          const draft = await createRetest(quizId, {
            concept_id: concept.concept_id as number,
            player_ids: concept.players_missed.map((p) => p.player_id).filter((id): id is number => id !== null),
            player_names: concept.players_missed.filter((p) => p.player_id === null).map((p) => p.player_name),
          });
          navigate(`/quizzes/${draft.id}?tab=questions`);
        } catch (err) {
          setFailed(getErrorMessage(err));
          setBusy(false);
        }
      }}
    >
      {busy ? 'Building…' : failed ? 'Retest failed - try again' : n === 1 ? 'Retest this player' : `Retest these ${n}`}
    </button>
  );
}

export function WeakestConcepts({
  concepts,
  quizId,
  questions = [],
  breakdown = [],
  retests = [],
  teachConceptId = null,
}: {
  concepts: ConceptBreakdown[];
  quizId: number;
  /** The quiz's own questions (coach payload), so Teach can show them. */
  questions?: Question[];
  /** Results' per-question breakdown: what the room chose on each question. */
  breakdown?: QuestionBreakdown[];
  /** How retests built from this quiz went - did it stick, per concept. */
  retests?: RetestSummary[];
  /** ?teach=<concept> (Home's Next up): that concept's Teach opens on arrival. */
  teachConceptId?: number | null;
}) {
  const retestOf = (concept: ConceptBreakdown) => retests.find((t) => t.concept_ids.includes(concept.concept_id));
  const [showAllPlayers, setShowAllPlayers] = useState(false);
  /** Teach it / Make a rep for the ones who missed it - the loop a Rep has. */
  const missActions = (concept: ConceptBreakdown, label: string, show: 'all' | 'teach' | 'more' = 'all') => {
    const slides = teachSlides(concept, questions, breakdown);
    if (slides.length === 0) return null;
    return (
      <MissActions
        quizId={quizId}
        questions={conceptQuestions(concept, questions)}
        breakdown={breakdown}
        slides={slides}
        teachLabel={label}
        title={concept.concept_name ?? 'General'}
        repTitle={`${concept.concept_name ?? 'General'} - Rep`}
        playerIds={concept.players_missed.map((p) => p.player_id).filter((id): id is number => id !== null)}
        conceptId={concept.concept_id}
        extraAction={<TeachRetest quizId={quizId} concept={concept} />}
        show={show}
        startTeaching={show !== 'more' && teachConceptId !== null && concept.concept_id === teachConceptId}
      />
    );
  };
  /* Nothing tagged, or nothing graded yet: render nothing at all and let
     Results be what it was. An empty "Weakest concept" panel would be a
     permanent reminder of a feature rather than an answer - and every quiz
     that predates tagging is in exactly this state. */
  const ranked = concepts.filter((c) => c.player_miss_rate !== null);
  if (ranked.length === 0) return null;

  const [weakest, ...rest] = ranked;

  /* A WHOLE UNIT MISSING SOMETHING IS THE CASE THIS PANEL EXISTS FOR, and it
     was the case that broke it: measured at 375px, fourteen name chips take
     287px and pushed "Retest these 14" to y=827 - past the fold, and past the
     fixed bottom nav at 764. The coach was told what to teach and then had to
     go looking for the button.

     THIS IS A DISPLAY CAP AND NOTHING ELSE. The retest is built from
     weakest.players_missed in full, never from what is on screen, so a
     collapsed list still targets everyone who missed it. Tests assert the
     count in the button and the players in the request against the FULL list
     while the display is truncated - because a truncation that quietly became
     a selection would send a smaller retest than the coach asked for. */
  const PLAYERS_BEFORE_FOLD = 8;
  const shownPlayers = showAllPlayers
    ? weakest.players_missed
    : weakest.players_missed.slice(0, PLAYERS_BEFORE_FOLD);
  const hiddenCount = weakest.players_missed.length - shownPlayers.length;
  /* Guarded on the FULL list, not on hiddenCount: once expanded nothing is
     hidden, and keying the toggle off that made it disappear at exactly the
     moment the coach needed it to collapse again. */
  const canToggle = weakest.players_missed.length > PLAYERS_BEFORE_FOLD;
  /* Worked out over the FULL list, like the retest, so expanding "and N more"
     can never change how a name already on screen reads. `shownPlayers` is a
     prefix of it, so indexes line up. Attempt mode: jersey only - the position
     beside each name is `position_at_attempt`, and live roster position must
     not be mixed into it. */
  const missedLabels = playerLabels(
    weakest.players_missed,
    (p) => ({
      name: p.display_name,
      jerseyNumber: p.jersey_number,
      identity: p.player_id ?? `name:${p.player_name}`,
    }),
    'attempt',
  );

  return (
    <section className={styles.wrap} aria-labelledby="teach-next">
      <h2 className={styles.eyebrow} id="teach-next">
        Teach next
      </h2>

      {/* THE FOOTBALL PROBLEM, then the next step - the same card a Rep
          uses (FootballProblem). Who missed it and every further action are
          one tap down; the coach is not asked to read them to know what to do.

          PLAYERS, AND IT SAYS SO: the count is people, in the same unit as
          the names under "View details"; the answer-level figures stay in the
          question-by-question evidence where the unit cannot be mistaken.
          "Most chose" names the wrong answer the misses picked most, with the
          count beside it - what they picked, never why. */}
      <FootballProblem
        headingLevel={3}
        name={weakest.concept_name}
        label={weakest.concept_name ?? 'General'}
        missed={weakest.players_missed_count}
        responded={weakest.players_responded_count}
        who={weakest.players_responded_count === 1 ? 'player' : 'players'}
        thin={!weakest.has_enough_responses}
        chose={
          weakest.top_distractor
            ? {
                text: weakest.top_distractor.option_text,
                detail:
                  weakest.top_distractor.count === weakest.top_distractor.of_misses
                    ? `all ${weakest.top_distractor.of_misses} wrong answers`
                    : `${weakest.top_distractor.count} of ${weakest.top_distractor.of_misses} wrong answers`,
              }
            : null
        }
        note={
          <>
            {weakest.ungraded_count > 0 && (
              <p className={styles.ungradedNote}>
                {weakest.ungraded_count} answer{weakest.ungraded_count === 1 ? '' : 's'} here still need
                {weakest.ungraded_count === 1 ? 's' : ''} grading, and {weakest.ungraded_count === 1 ? 'is' : 'are'} not
                counted above.
              </p>
            )}
            {/* OFFERED ONLY WHEN IT CAN SUCCEED: every question they missed
                may since have been stopped - saying why beats a dead button. */}
            {weakest.retestable_question_count === 0 && (
              <p className={styles.ungradedNote}>
                Every question they missed here has been stopped, so there is nothing to retest.
              </p>
            )}
          </>
        }
        status={retestOf(weakest) && <RetestStatus retest={retestOf(weakest)!} />}
        actions={
          <>
            {/* TEACH, beside Retest: the questions they missed, big, with the
                right answer and the reason - for the meeting room. */}
            {missActions(weakest, 'Teach it', 'teach')}
            {/* Peira assembles a draft; it does not send anything. */}
            {weakest.retestable_question_count > 0 && (
              <RetestAction
                quizId={quizId}
                conceptId={weakest.concept_id}
                conceptName={weakest.concept_name}
                targets={weakest.players_missed}
                retiredCount={weakest.retired_missed_question_count}
              />
            )}
          </>
        }
        detailsLabel="View details"
        details={
          <>
            {weakest.players_missed.length > 0 && (
              <div className={styles.players}>
                <div className={styles.playersLabel}>Who missed it</div>
                <ul className={styles.playerList}>
                  {shownPlayers.map((player, index) => (
                    <li
                      // THE PERSON, not the name: two same-named players shared a key.
                      key={player.player_id != null ? `player:${player.player_id}` : `name:${player.player_name}`}
                      className={styles.player}
                    >
                      {player.player_id != null ? (
                        <Link to={`/roster/${player.player_id}`} className={styles.playerLink}>
                          {missedLabels[index].text}
                        </Link>
                      ) : (
                        missedLabels[index].text
                      )}
                      {/* Their position WHEN THEY ANSWERED. Absent rather than
                          guessed when it was never recorded. */}
                      {player.position_at_attempt && (
                        <span className={styles.position}>{player.position_at_attempt}</span>
                      )}
                    </li>
                  ))}
                  {canToggle && (
                    <li className={styles.moreItem}>
                      <button
                        type="button"
                        className={styles.moreToggle}
                        onClick={() => setShowAllPlayers((open) => !open)}
                      >
                        {showAllPlayers ? 'Show fewer' : `and ${hiddenCount} more`}
                      </button>
                    </li>
                  )}
                </ul>
              </div>
            )}
            {/* Make a rep of it, pick more questions on it, open its play. */}
            {missActions(weakest, 'Teach it', 'more')}
          </>
        }
      />

      {rest.length > 0 && (
        <ul className={styles.others}>
          {rest.map((concept) => (
            <li key={concept.concept_id} className={styles.otherRow}>
              <span className={styles.otherName}>{concept.concept_name}</span>
              <span className={styles.otherCount}>
                {/* Same unit as the headline above. A list where the first row
                    counts players and the rest count answers would be the
                    original confusion, merely spread out. */}
                {concept.players_missed_count} of {concept.players_responded_count} players
                {!concept.has_enough_responses && <span className={styles.thin}> (thin)</span>}
              </span>
              {/* THE PROBLEM IN ONE LINE, as a Rep says it: what they chose
                  instead and the next step - or that nobody needs it. */}
              {retestOf(concept) && <RetestStatus retest={retestOf(concept)!} />}
              {concept.players_missed_count === 0 ? (
                <span className={styles.looksGood}>✓ Looks good</span>
              ) : (
                <>
                  {concept.top_distractor && (
                    <span className={styles.otherChose}>
                      most chose <strong>{concept.top_distractor.option_text}</strong>
                    </span>
                  )}
                  {missActions(concept, 'Teach')}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
