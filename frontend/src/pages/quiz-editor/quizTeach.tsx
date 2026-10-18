import { resolveMediaUrl } from '../../api/client';
import type { Question, QuestionBreakdown } from '../../api/types';
import { PlayPicture } from '../../components/football/PlayPicture';
import { usableTargets } from '../../components/football/tapTargets';
import type { TeachSlide } from '../../components/teach/TeachView';

// TEACH FROM A QUIZ MISS - the same meeting-room view a Rep teaches with, made
// from quiz questions: the football picture (the play moving to the decision
// moment, the right spot lit when it was tapped), the coach's right answer and
// reason, and what the room chose instead when the counts say so.

type Taught = Question & { subject_role?: string | null; motion_play_id?: number | null };

/** The wrong answer most of the room chose on this question, from its counts. */
function mostChosenWrong(row: QuestionBreakdown | undefined): { text: string; count: number } | null {
  const wrong = (row?.option_counts ?? []).filter((c) => !c.is_correct && c.count > 0).sort((a, b) => b.count - a.count)[0];
  return wrong ? { text: wrong.option_text, count: wrong.count } : null;
}

/** One slide per question, in quiz order. */
export function quizTeachSlides(questions: Question[], breakdown: QuestionBreakdown[] = []): TeachSlide[] {
  return (questions as Taught[]).map((q) => {
    const row = breakdown.find((r) => r.question_id === q.id);
    const targets = usableTargets(q.tap_targets, q.options.length, !!(q.image || q.presnap));
    const right = q.options.filter((o) => o.is_correct_answer);
    return {
      key: q.id,
      imageUrl: q.image ? resolveMediaUrl(q.image.image_url) : null,
      role: q.subject_role ?? null,
      prompt: q.question_text,
      right: q.question_type === 'fill_blank' ? (q.expected_answers ?? []) : right.map((o) => o.option_text),
      why: q.answer_explanation ?? null,
      wrong: mostChosenWrong(row),
      motionPlayId: q.motion_play_id ?? null,
      picture:
        q.presnap || targets || q.subject_marker ? (
          <PlayPicture
            image={q.image}
            presnap={q.presnap}
            marker={q.subject_marker}
            targets={targets}
            options={q.options.map((o) => ({ id: o.id, option_text: o.option_text }))}
            chosen={right.map((o) => o.id)}
            tone="right"
            disabled
            motionKey={q.id}
          />
        ) : undefined,
    };
  });
}

/** Whether a question has football to put on the meeting-room screen. */
export const teachable = (q: Question) => !!(q.image || q.presnap || q.answer_explanation);
