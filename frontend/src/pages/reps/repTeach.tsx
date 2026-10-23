import { resolveMediaUrl } from '../../api/client';
import type { RepConcept, RepDecision } from '../../api/reps';
import { PlayPicture } from '../../components/football/PlayPicture';
import { usableTargets } from '../../components/football/tapTargets';
import type { TeachSlide } from '../../components/teach/TeachView';

// TEACH A REP'S FOOTBALL PROBLEM - its decisions as the meeting-room slides,
// shared by the Rep page and an install's meeting.

const targetsOf = (d: RepDecision) => usableTargets(d.tap_targets, d.choices.length, !!(d.image || d.presnap));
const choicesOf = (d: RepDecision) => d.choices.map((c) => ({ id: c.option_id, option_text: c.text }));

/** One slide per decision: the play exactly as the players saw it, the right
 *  answer, the coach's reason, what most chose - and, for Ask first, the same
 *  picture without the right spot lit. */
export function repDecisionSlides(decisions: RepDecision[], fallbackPlayId: number | null = null): TeachSlide[] {
  return decisions.map((d) => {
    const wrong = d.choices.filter((c) => !c.is_correct && c.count > 0).sort((a, b) => b.count - a.count)[0];
    return {
      key: d.question_id,
      imageUrl: d.image ? resolveMediaUrl(d.image.image_url) : null,
      role: d.subject_role,
      prompt: d.question_text,
      right: d.correct_text,
      why: d.answer_explanation,
      wrong: wrong ? { text: wrong.text, count: wrong.count } : null,
      motionPlayId: d.motion_play_id ?? fallbackPlayId,
      // Ask first: the play without the right spot lit.
      pictureAsk: targetsOf(d) ? <PlayPicture image={d.image} presnap={d.presnap} marker={d.subject_marker} motionKey={d.question_id} /> : undefined,
      // The play moving to the decision moment, exactly as the players saw it
      // - and, when they tapped, the right spot lit.
      picture:
        d.presnap || targetsOf(d) || d.subject_marker ? (
          <PlayPicture
            image={d.image}
            presnap={d.presnap}
            // HIS JOB: the coach's ring on a photo (a moving play rings him itself).
            marker={d.subject_marker}
            targets={targetsOf(d)}
            options={choicesOf(d)}
            chosen={d.choices.filter((c) => c.is_correct).map((c) => c.option_id)}
            tone="right"
            disabled
            motionKey={d.question_id}
          />
        ) : undefined,
    };
  });
}

/** A problem's decisions, and where Teach starts: the worst of them. */
export function problemSlides(problem: RepConcept, decisions: RepDecision[]): { slides: TeachSlide[]; start: number } {
  const inProblem = decisions.filter((d) => problem.question_ids.includes(d.question_id));
  const worst = [...inProblem].sort((a, b) => b.missed - a.missed)[0];
  return { slides: repDecisionSlides(inProblem, problem.motion_play_id), start: Math.max(0, inProblem.indexOf(worst)) };
}
