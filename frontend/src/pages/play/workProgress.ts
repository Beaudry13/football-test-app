// PLAYER HOME, ON THIS DEVICE: what a player has been sent here, how far he
// got, and what he missed - so /play can say "here is what to do next".
//
// DEVICE-SCOPED BY DESIGN. A player has no account that spans codes (his PIN
// proves him one attempt at a time - see docs/PLAYER-HOME.md), so this is
// built from what the device already holds: the codes he has played here
// (playerSession), and a small progress record per code written as he plays.
// It never says anything the server would not: a code's title, kind and
// whether it is still open are re-read from /validate-code every time.

import type { PracticeFeedback, ValidateCodeResponse } from '../../api/types';
import { rememberedPlayer } from './playerSession';

const PROGRESS_PREFIX = 'peira.play.progress.v1';
const SESSION_PREFIX = 'peira.play.session.v1';

/** What he missed on his last run, to review on the exact pictures. */
export interface StoredReview {
  /** The missed questions, in the order he met them. */
  missedIds: number[];
  /** What he picked on each (option ids). */
  chosen: Record<number, number[]>;
  /** The verdicts he was shown (a Rep's carry the right answer). */
  feedback: PracticeFeedback[];
}

export interface WorkProgress {
  state: 'started' | 'done';
  /** How many he missed on the last finished run (0 when not finished). */
  missed: number;
  at: string;
  review?: StoredReview;
  /** A graded quiz he submitted: its misses are reviewed on his results page. */
  graded?: boolean;
}

function key(prefix: string, code: string): string {
  return `${prefix}:${code.trim().toUpperCase()}`;
}

/** The codes this device has played, newest progress first. */
export function rememberedCodes(): string[] {
  const codes: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(`${SESSION_PREFIX}:`)) codes.push(k.slice(SESSION_PREFIX.length + 1));
    }
  } catch {
    return [];
  }
  return codes.sort((a, b) => (progressOf(b)?.at ?? '').localeCompare(progressOf(a)?.at ?? ''));
}

export function progressOf(code: string): WorkProgress | null {
  try {
    const raw = window.localStorage.getItem(key(PROGRESS_PREFIX, code));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<WorkProgress>;
    if (value.state !== 'started' && value.state !== 'done') return null;
    return {
      state: value.state,
      missed: typeof value.missed === 'number' ? value.missed : 0,
      at: typeof value.at === 'string' ? value.at : '',
      review: value.review && Array.isArray(value.review.missedIds) ? value.review : undefined,
      graded: value.graded === true ? true : undefined,
    };
  } catch {
    return null;
  }
}

function write(code: string, progress: WorkProgress): void {
  try {
    window.localStorage.setItem(key(PROGRESS_PREFIX, code), JSON.stringify(progress));
  } catch {
    // A private window: the home simply knows less. Nothing is lost.
  }
}

/** He opened it: it is in progress (a finished run stays finished until a new one starts). */
export function recordStarted(code: string): void {
  write(code, { state: 'started', missed: 0, at: new Date().toISOString() });
}

/** He finished a run: how many he missed, and what to review. A graded quiz
 *  says so: its misses are reviewed on his results page, not from a record here. */
export function recordDone(code: string, missed: number, review?: StoredReview, { graded = false } = {}): void {
  write(code, {
    state: 'done',
    missed,
    at: new Date().toISOString(),
    review: review && review.missedIds.length > 0 ? review : undefined,
    ...(graded ? { graded: true } : {}),
  });
}

export function forgetProgress(code: string): void {
  try {
    window.localStorage.removeItem(key(PROGRESS_PREFIX, code));
  } catch {
    /* already unreachable */
  }
}

/** The review record from a run's verdicts: the misses, what he chose. */
export function reviewFrom(
  order: number[],
  feedback: PracticeFeedback[],
  chosen: Record<number, number[]>,
): StoredReview {
  const wrong = new Set(feedback.filter((f) => f.is_correct === false).map((f) => f.question_id));
  return {
    missedIds: order.filter((id) => wrong.has(id)),
    chosen: Object.fromEntries(Object.entries(chosen).filter(([id]) => wrong.has(Number(id)))),
    feedback: feedback.filter((f) => wrong.has(f.question_id)),
  };
}

/** One thing he has been sent, still open, and what to do about it. */
export interface WorkItem {
  code: string;
  title: string;
  kind: 'REP' | 'QUIZ';
  retest: boolean;
  graded: boolean;
  expiresAt: string;
  /** review: his last practice run's misses here; results: a graded quiz's, on his results page. */
  action: 'start' | 'continue' | 'review' | 'results';
  missed: number;
  name: string | null;
  playerId: number | null;
}

/** A retest first - Rep or quiz, a second look at something he missed - then
 *  Reps, then quizzes (graded and closing soonest first), then review. */
function rank(item: WorkItem): number {
  if (item.action === 'review' || item.action === 'results') return 5;
  if (item.retest) return 0;
  if (item.kind === 'REP') return 1;
  return item.graded ? 2 : 3;
}

export function itemFor(code: string, joined: ValidateCodeResponse, progress: WorkProgress | null): WorkItem | null {
  const base = {
    code,
    title: joined.quiz.title,
    kind: joined.quiz.kind === 'REP' ? ('REP' as const) : ('QUIZ' as const),
    retest: !!joined.quiz.retest_of,
    graded: joined.mode !== 'PRACTICE',
    expiresAt: joined.expires_at,
    missed: progress?.missed ?? 0,
    name: rememberedPlayer(code)?.name ?? null,
    playerId: rememberedPlayer(code)?.playerId ?? null,
  };
  if (!progress) return { ...base, action: 'start' };
  if (progress.state === 'started') return { ...base, action: 'continue' };
  // Finished: worth coming back to only when there is something to review -
  // a graded quiz's misses on his results page (it needs his name to open).
  if (progress.graded) return progress.missed > 0 && base.name ? { ...base, action: 'results' } : null;
  return progress.review && progress.missed > 0 ? { ...base, action: 'review' } : null;
}

export function sortWork(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => rank(a) - rank(b) || a.expiresAt.localeCompare(b.expiresAt));
}
