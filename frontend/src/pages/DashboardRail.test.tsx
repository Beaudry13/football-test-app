import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DashboardQuietNote, DashboardRail } from './DashboardRail';
import { outstandingPlayers, recentActivity } from './dashboardRailData';
import type { ActiveQuizStatus, Quiz } from '../api/types';

const liveEntry = (over: Partial<ActiveQuizStatus> = {}): ActiveQuizStatus =>
  ({
    quiz_id: 1,
    quiz_title: 'Install Week 2',
    access_code_id: 10,
    code: '7KQ4M2',
    expires_at: '2026-08-22T21:00:00Z',
    group_names: [],
    roster_size: 24,
    mode: 'GRADED',
    is_practice: false,
    randomize_questions: false,
    submitted: [],
    in_progress: [],
    not_started: [],
    ...over,
  }) as ActiveQuizStatus;

const quiz = (over: Partial<Quiz> = {}): Quiz =>
  ({
    id: 1,
    organization_id: 1,
    coach_id: 1,
    created_by_username: 'coach',
    title: 'Install Week 2',
    description: null,
    one_question_at_a_time: true,
    require_all_answers: false,
    folder_id: null,
    question_count: 12,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-20T00:00:00Z',
    ...over,
  }) as Quiz;

const draw = (entries: ActiveQuizStatus[] | null, quizzes: Quiz[] | null) =>
  render(
    <MemoryRouter>
      <DashboardRail entries={entries} quizzes={quizzes} />
    </MemoryRouter>,
  );

describe('the rail exists only when something is true', () => {
  it('renders nothing on a quiet day, even when there are results to show', () => {
    // THE QUIET-DAY RULE. Results alone would keep a second column on screen
    // on the day the dashboard is meant to get simpler, and the quiz list
    // would lose the width for it.
    const { container } = draw([], [quiz({ average_score_percent: 76, completed_count: 18, roster_size: 24 })]);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before the first poll has answered', () => {
    // null is "we have not been told", not "nothing is live".
    const { container } = draw(null, [quiz({ average_score_percent: 76 })]);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows no Needs attention panel when every player has submitted', () => {
    draw([liveEntry({ submitted: [{ player_name: 'A', submitted_at: '2026-08-22T17:00:00Z' }] })], []);
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('shows no Closing soon panel for a single live quiz, whose card already says it', () => {
    draw([liveEntry({ submitted: [{ player_name: 'A', submitted_at: '2026-08-22T17:00:00Z' }] })], []);
    expect(screen.queryByText('Closing soon')).not.toBeInTheDocument();
  });

  it('shows Closing soon once two quizzes are live, where the order is the point', () => {
    draw(
      [
        liveEntry({ access_code_id: 10, quiz_title: 'Later', expires_at: '2026-08-23T21:00:00Z' }),
        liveEntry({ access_code_id: 11, quiz_id: 2, quiz_title: 'Sooner', expires_at: '2026-08-22T09:00:00Z' }),
      ],
      [],
    );
    const panel = screen.getByText('Closing soon').closest('section') as HTMLElement;
    const names = within(panel).getAllByRole('link').map((a) => a.textContent);
    expect(names).toEqual(['Sooner', 'Later']);
  });
});

describe('what the panels are allowed to say', () => {
  it('counts only players who owe a GRADED submission', () => {
    // Nobody owes a practice rep. Counting one would invent an obligation the
    // product does not have.
    const entries = [
      liveEntry({ not_started: ['A', 'B'] }),
      liveEntry({ access_code_id: 11, is_practice: true, mode: 'PRACTICE', not_started: ['C', 'D', 'E'] }),
    ];
    expect(outstandingPlayers(entries)).toBe(2);
  });

  it('builds activity from submitted_at, newest first, and never invents a row', () => {
    const rows = recentActivity([
      liveEntry({
        submitted: [
          { player_name: 'Early', submitted_at: '2026-08-22T17:00:00Z' },
          { player_name: 'Late', submitted_at: '2026-08-22T17:30:00Z' },
          // An in-progress attempt has no submitted_at and must not appear.
          { player_name: 'Started only' },
        ],
      }),
    ]);
    expect(rows.map((r) => r.who)).toEqual(['Late', 'Early']);
  });

  it('caps the feed rather than becoming an event log', () => {
    const submitted = Array.from({ length: 20 }, (_, i) => ({
      player_name: `P${i}`,
      submitted_at: new Date(Date.UTC(2026, 7, 22, 17, i)).toISOString(),
    }));
    expect(recentActivity([liveEntry({ submitted })])).toHaveLength(6);
  });

  it('shows a score only for a quiz that HAS one, never a fabricated 0%', () => {
    // average_score_percent is omitted (not 0) until something gradeable has
    // been answered - the rail must not turn that absence into a number.
    draw(
      [liveEntry({ not_started: ['A'] })],
      [quiz({ id: 7, title: 'Ungraded quiz' }), quiz({ id: 8, title: 'Graded quiz', average_score_percent: 76 })],
    );
    expect(screen.getByText('Graded quiz')).toBeInTheDocument();
    expect(screen.queryByText('Ungraded quiz')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});

describe('the quiet note', () => {
  it('says nothing at all until the first poll has answered', () => {
    const { container } = render(
      <MemoryRouter>
        <DashboardQuietNote entries={null} quizzes={[quiz({ average_score_percent: 76 })]} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('is silent while something is live, because the rail is speaking', () => {
    const { container } = render(
      <MemoryRouter>
        <DashboardQuietNote entries={[liveEntry()]} quizzes={[]} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('carries the last score in one sentence when the day is quiet', () => {
    render(
      <MemoryRouter>
        <DashboardQuietNote
          entries={[]}
          quizzes={[quiz({ title: 'Protection IDs', average_score_percent: 76, completed_count: 18, roster_size: 24 })]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Nothing is out with players right now/)).toBeInTheDocument();
    expect(screen.getByText(/scored 76% from 18 of 24/)).toBeInTheDocument();
  });

  it('still says the quiet part when no quiz has a score yet', () => {
    render(
      <MemoryRouter>
        <DashboardQuietNote entries={[]} quizzes={[quiz()]} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Nothing is out with players right now/)).toBeInTheDocument();
    expect(screen.queryByText(/scored/)).not.toBeInTheDocument();
  });
});
