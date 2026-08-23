import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DashboardQuietNote, DashboardRail } from './DashboardRail';
import { outstandingPlayers, readyToSend, recentActivity } from './dashboardRailData';
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

describe('the rail speaks whenever it has something true to say', () => {
  it('CHANGES SUBJECT on a quiet day instead of disappearing', () => {
    // THE REVERSED QUIET-DAY RULE. The rail used to return null the moment
    // nothing was live, which made the ordinary day the day the dashboard had
    // the least to say. It now keeps the panels that are still true - and
    // drops only the ones that could only show zeros.
    draw([], [quiz({ average_score_percent: 76, completed_count: 18, roster_size: 24 })]);
    expect(screen.getByText('Results')).toBeInTheDocument();
    expect(screen.queryByText('Activity')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
    expect(screen.queryByText('Closing soon')).not.toBeInTheDocument();
  });

  it('renders nothing at all when it has nothing true to say', () => {
    // The empty-handed case still returns null. A rail of empty panels is
    // worse than no rail, and the page widens to one column behind it.
    const { container } = draw([], [quiz({ is_active: true, completed_count: 4 })]);
    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing LIVE before the first poll has answered', () => {
    // null is "we have not been told", not "nothing is live" - so no panel
    // that describes live state may appear. Results comes from the quiz list,
    // which we HAVE been told, so it is honest either way.
    draw(null, [quiz({ average_score_percent: 76 })]);
    expect(screen.queryByText('Activity')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
    expect(screen.queryByText('Closing soon')).not.toBeInTheDocument();
    expect(screen.getByText('Results')).toBeInTheDocument();
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

describe('what counts as ready to send', () => {
  it('offers a built quiz that has never gone out', () => {
    const ready = readyToSend([quiz({ is_active: false, completed_count: 0, question_count: 9 })]);
    expect(ready).toHaveLength(1);
  });

  it('NEVER guesses from a field the list endpoint did not send', () => {
    // is_active and completed_count are OPTIONAL - omitted, not false/0, on
    // every response but list_quizzes. A falsy check would read "we were not
    // told" as "not active" and offer a quiz that may well be live.
    expect(readyToSend([quiz({ question_count: 9 })])).toHaveLength(0);
    expect(readyToSend([quiz({ is_active: false, question_count: 9 })])).toHaveLength(0);
  });

  it('excludes a quiz that is live, and one that has already been answered', () => {
    expect(readyToSend([quiz({ is_active: true, completed_count: 0 })])).toHaveLength(0);
    expect(readyToSend([quiz({ is_active: false, completed_count: 3 })])).toHaveLength(0);
  });

  it('excludes an empty quiz, which could not be activated anyway', () => {
    const empty = quiz({ is_active: false, completed_count: 0, question_count: 0 });
    expect(readyToSend([empty])).toHaveLength(0);
  });

  it('stays a glance rather than a second quiz list', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      quiz({ id: i + 1, is_active: false, completed_count: 0, question_count: 4 }),
    );
    expect(readyToSend(many).length).toBeLessThanOrEqual(3);
  });
});

describe('the quiet note', () => {
  it('says nothing at all until the first poll has answered', () => {
    const { container } = render(
      <MemoryRouter>
        <DashboardQuietNote entries={null} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('is silent while something is live, because the rail is speaking', () => {
    const { container } = render(
      <MemoryRouter>
        <DashboardQuietNote entries={[liveEntry()]} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('states the live fact and NOTHING about history', () => {
    // It used to append "scored 76% from 18 of 24". Results carries that now,
    // beside this line and with a link per quiz - and this was the loudest
    // place the "of 0" bug surfaced, because it printed the raw counts.
    render(
      <MemoryRouter>
        <DashboardQuietNote entries={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Nothing is out with players right now.')).toBeInTheDocument();
    expect(screen.queryByText(/scored/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ of /)).not.toBeInTheDocument();
  });
});
