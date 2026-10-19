import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/grading', () => ({ getQuizDashboard: vi.fn() }));
import * as gradingApi from '../../api/grading';
import type { RepSummary } from '../../api/reps';
import type { ConceptBreakdown, Quiz, QuizDashboard } from '../../api/types';
import { NextUp } from './NextUp';

/** NEXT UP on Home: the one football problem to deal with now - Rep or quiz. */

const rep = (over: Partial<RepSummary>): RepSummary => ({
  id: 1,
  title: 'Trips Jet - Boundary safety',
  decisions: 3,
  ran: 11,
  invited: 11,
  live: false,
  audience_label: 'Safeties',
  is_retest: false,
  worst: null,
  signal: null,
  ...over,
});

const quiz = (over: Partial<Quiz>): Quiz =>
  ({
    id: 7,
    title: 'Week 6 coverage',
    kind: 'QUIZ',
    updated_at: '2026-10-18T10:00:00Z',
    average_score_percent: 64,
    ...over,
  }) as Quiz;

const concept = (over: Partial<ConceptBreakdown> = {}): ConceptBreakdown =>
  ({
    concept_id: 3,
    concept_name: 'Coverage ID',
    players_missed_count: 4,
    players_responded_count: 11,
    player_miss_rate: 36,
    has_enough_responses: true,
    ...over,
  }) as ConceptBreakdown;

const dashboard = (over: Partial<QuizDashboard> = {}): QuizDashboard =>
  ({ concept_breakdown: [concept()], verification: null, retests: [], ...over }) as QuizDashboard;

function show(reps: RepSummary[] | null | undefined, quizzes: Quiz[] | null = null) {
  return render(
    <MemoryRouter>
      <NextUp reps={reps} quizzes={quizzes} />
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('Next up on Home', () => {
  it('leads with a Rep problem nobody has retested yet - one tap from Teach', () => {
    show([rep({ id: 7, open_problem: { name: 'Coverage ID', concept_id: 5, missed: 3, responded: 11 } })]);
    expect(screen.getByText(/3 of 11 safeties missed/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Teach it' })).toHaveAttribute('href', '/reps/7?teach=5');
  });

  it('after a retest that still misses: Teach, or Retest the ones still missing', () => {
    show([
      rep({
        id: 4,
        is_retest: true,
        signal: { kind: 'retest_missing', concept: 'Motion adjustment', concept_id: 3, missed: 1, responded: 3, before_pct: 64, now_pct: 67 },
      }),
    ]);
    expect(screen.getByText(/3 were retested, 1 still misses it/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Retest 1' })).toHaveAttribute('href', '/reps/4?retest=3');
  });

  it("with no Rep problem, the latest quiz's weakest concept leads - Teach opens on its Results", async () => {
    vi.mocked(gradingApi.getQuizDashboard).mockResolvedValue(dashboard());
    show([], [quiz({ id: 6, updated_at: '2026-10-01T00:00:00Z' }), quiz({ id: 7 })]);
    expect(await screen.findByText('Coverage ID')).toBeInTheDocument();
    expect(gradingApi.getQuizDashboard).toHaveBeenCalledWith(7);
    expect(screen.getByText(/4 of 11 missed it/)).toBeInTheDocument();
    expect(screen.getByText('in Week 6 coverage')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Teach it' })).toHaveAttribute('href', '/quizzes/7?tab=results&teach=3');
  });

  it('says nothing of a quiz concept already being retested, or too thin to trust', async () => {
    vi.mocked(gradingApi.getQuizDashboard).mockResolvedValue(
      dashboard({
        concept_breakdown: [concept(), concept({ concept_id: 4, concept_name: 'Leverage', has_enough_responses: false })],
        retests: [{ concept_ids: [3] } as never],
      }),
    );
    const { container } = show([], [quiz({})]);
    await waitFor(() => expect(gradingApi.getQuizDashboard).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('waits for the Reps summary before speaking for a quiz, and is silent with nothing to say', async () => {
    const { container, rerender } = show(undefined, [quiz({})]);
    expect(gradingApi.getQuizDashboard).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
    vi.mocked(gradingApi.getQuizDashboard).mockResolvedValue(dashboard({ concept_breakdown: [] }));
    rerender(
      <MemoryRouter>
        <NextUp reps={[]} quizzes={[quiz({})]} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(gradingApi.getQuizDashboard).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
