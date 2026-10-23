import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getConceptFootball } from '../../api/concepts';
import { getQuizDashboard } from '../../api/grading';
import type { InstallItem } from '../../api/installs';
import { getMotionPlay } from '../../api/motionLab';
import type { GroupNeeds } from '../../api/players';
import { getMadeFromPlay, getRepResults } from '../../api/reps';
import type { Quiz } from '../../api/types';
import { PlayPicture, type DrawnStill } from '../../components/football/PlayPicture';
import { groupNeedSlides, groupRetestable, retestGroup } from '../../components/teach/groupTeach';
import { distinctFootball } from '../../components/teach/sameFootball';
import type { TeachRoom, TeachSlide } from '../../components/teach/TeachView';
import { CheckThem } from '../../motion-lab/CheckThem';
import type { Play } from '../../motion-lab/engine/play';
import { drawPlay, IMAGE_HEIGHT, IMAGE_WIDTH } from '../../motion-lab/playImage';
import { hasPresnapMotion, presnapOf } from '../../motion-lab/presnap';
import { playFromRow } from '../../motion-lab/storage/apiPlayRepository';
import { quizTeachSlides, teachable } from '../quiz-editor/quizTeach';
import { StepButton } from '../../components/ui/StepButton';
import { buildQuizRetest, buildRepRetest, retestLabel } from '../../components/teach/retest';
import { problemSlides, repDecisionSlides } from '../reps/repTeach';

/**
 * TEACH THE INSTALL: the install decides what football comes next; the Teach
 * screen is the one every other place uses (Ask first, notes, full screen, the
 * keys). Each item becomes:
 *   a play     - the play as Motion Lab holds it now: its motion to the snap,
 *                then the play with its authored routes (Ask first holds the
 *                routes back); the man and the point he gave it last; Check
 *                them (what is made from it, or make it in Motion Lab);
 *   a quiz     - its football, with what the room chose; Retest the weakest
 *                concept for exactly who missed it;
 *   a Rep      - its open football problem, who missed it, Retest them (or
 *                Open retest);
 *   a concept  - for a position group's install, the football the room
 *                missed and Retest them; otherwise his football on it.
 * Next walks the install in order (→ past the last slide too); ← before the
 * first slide goes back an item. An item with nothing to show is passed over.
 */

export interface TeachItem {
  title: string;
  slides: TeachSlide[];
  start?: number;
  room?: TeachRoom | null;
  action?: ReactNode;
}

export interface TeachContext {
  navigate: (to: string) => void;
  quizOf: (id: number) => Promise<Quiz>;
  /** A position group's needs, once - null for a whole-team install. */
  groupNeeds: () => Promise<GroupNeeds | null>;
  groupLabel: string | null;
}

/** The item's name, the way the coach knows it. */
export function itemTitle(item: InstallItem): string {
  if (item.kind === 'play') return item.ref.name;
  if (item.kind === 'quiz') return item.ref.title;
  return item.ref.name;
}

/** A play, as the meeting sees it: motion to the snap, then the routes. */
function playSlides(play: Play, serverId: number, highlight: string | null, role: string | null, point: string, concept: string | null): TeachSlide[] {
  const still = (routes: boolean): DrawnStill => ({
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    draw: (ctx) => drawPlay(ctx, play, { routes, motion: true, highlight }),
  });
  // "Open the play in Motion Lab" - the source, as it is now.
  const base = { imageUrl: null, role, prompt: point, right: [], why: null, wrong: null, motionPlayId: serverId, concept };
  const slides: TeachSlide[] = [];
  const clip = hasPresnapMotion(play) ? presnapOf(play, highlight, 'snap') : null;
  if (clip) slides.push({ ...base, key: `${play.id}-motion`, picture: <PlayPicture presnap={clip} motionKey={`${play.id}-motion`} alt={play.name} /> });
  slides.push({
    ...base,
    key: `${play.id}-routes`,
    picture: <PlayPicture drawn={still(true)} alt={play.name} />,
    // Ask first: the alignment and his job, then the authored routes.
    pictureAsk: <PlayPicture drawn={still(false)} alt={play.name} />,
  });
  return slides;
}

/** One install item, as Teach content - null when it has no football to show. */
export async function loadTeachItem(item: InstallItem, ctx: TeachContext): Promise<TeachItem | null> {
  const title = itemTitle(item);
  if (item.kind === 'play') {
    const [row, made] = await Promise.all([getMotionPlay(item.ref_id), getMadeFromPlay(item.ref_id).catch(() => null)]);
    const play = playFromRow(row);
    if (!play) return null;
    const last = made?.last ?? null;
    const man = last?.subject_man && play.players.some((p) => p.id === last.subject_man) ? last.subject_man : null;
    const role = man ? (last?.subject_role ?? null) : null;
    return {
      title,
      slides: playSlides(play, item.ref_id, man, role, last?.answer_explanation ?? '', last?.concept?.name ?? null),
      // CHECK THEM: what is made from it - or make the check in Motion Lab,
      // the man he tests already chosen.
      action: (
        <CheckThem
          made={made?.made ?? []}
          who={role}
          onMake={(kind) => ctx.navigate(`/motion-lab/plays/${item.ref_id}?make=${kind}${man ? `&man=${encodeURIComponent(man)}` : ''}`)}
        />
      ),
    };
  }

  if (item.kind === 'quiz' && item.ref.kind === 'REP') {
    const results = await getRepResults(item.ref_id);
    const problems = results.concepts.filter((c) => c.missed > 0);
    const problem = problems.find((c) => !c.retest) ?? problems[0] ?? null;
    if (!problem) {
      const slides = repDecisionSlides(results.decisions);
      return slides.length ? { title, slides } : null;
    }
    const { slides, start } = problemSlides(problem, results.decisions);
    return {
      title,
      slides,
      start,
      // The football problem in the room line - "3 of 9 missed Motion adjustment".
      room: { missed: problem.missed, of: problem.responded, names: problem.players_missed.map((p) => p.display_name), verb: `missed ${problem.name}` },
      action: problem.retest ? (
        <Link to={`/reps/${problem.retest.id}`}>Open retest</Link>
      ) : problem.players_missed.length > 0 ? (
        <StepButton
          label={retestLabel(problem.players_missed.map((p) => p.display_name))}
          run={async () => ctx.navigate(await buildRepRetest(item.ref_id, problem.concept?.id ?? null))}
        />
      ) : undefined,
    };
  }

  if (item.kind === 'quiz') {
    const [quiz, dashboard] = await Promise.all([ctx.quizOf(item.ref_id), getQuizDashboard(item.ref_id).catch(() => null)]);
    const questions = (quiz.questions ?? []).filter((q) => !q.is_retired && teachable(q));
    if (questions.length === 0) return null;
    const weakest = (dashboard?.concept_breakdown ?? []).find(
      (c) => c.player_miss_rate !== null && c.players_missed_count > 0 && c.retestable_question_count > 0,
    );
    return {
      title,
      slides: quizTeachSlides(questions, dashboard?.question_breakdown ?? []),
      room: weakest
        ? {
            missed: weakest.players_missed_count,
            of: weakest.players_responded_count,
            names: weakest.players_missed.map((p) => p.display_name),
            verb: `missed ${weakest.concept_name ?? 'it'}`,
          }
        : null,
      action: weakest ? (
        <StepButton
          label={retestLabel(weakest.players_missed.map((p) => p.display_name ?? p.player_name))}
          run={async () => ctx.navigate(await buildQuizRetest(item.ref_id, { concept_id: weakest.concept_id }, weakest.players_missed))}
        />
      ) : undefined,
    };
  }

  // A concept: the room's misses when the install is for a group...
  const needs = await ctx.groupNeeds();
  const need = needs?.concepts.find((c) => c.concept_id === item.ref_id) ?? null;
  if (need && needs) {
    const slides = await groupNeedSlides(need);
    if (slides.length > 0) {
      const label = ctx.groupLabel ?? 'group';
      return {
        title,
        slides,
        room: { missed: need.missing.length, of: needs.players, names: need.missing.map((m) => m.name), verb: 'still working on it' },
        action: groupRetestable(need) ? (
          <StepButton
            label={retestLabel(need.missing.map((m) => m.name))}
            run={async () => ctx.navigate(`/reps/${await retestGroup(need, label)}`)}
          />
        ) : undefined,
      };
    }
  }
  // ...otherwise his football on it, each piece once.
  // One read: his newest football on the concept, as his quizzes hold it.
  const football = await getConceptFootball(item.ref_id);
  const quizzes = new Map(football.quizzes.map((q) => [q.id, q]));
  const gathered = football.questions
    .filter((q) => teachable(q) && quizzes.has(q.quiz_id))
    .map((question) => ({ quiz: quizzes.get(question.quiz_id)!, question }));
  const slides = quizTeachSlides(distinctFootball(gathered).slice(0, 8));
  return slides.length ? { title, slides } : null;
}
