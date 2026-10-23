import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/reps', () => ({ makeRepFromQuiz: vi.fn(), addDecisions: vi.fn() }));
vi.mock('../../api/concepts', () => ({ listConceptQuestions: vi.fn() }));
import * as conceptsApi from '../../api/concepts';
vi.mock('../../api/roster', () => ({ addRosterMembers: vi.fn() }));
vi.mock('../../api/retests', () => ({ createRetest: vi.fn() }));
import * as retestsApi from '../../api/retests';
vi.mock('../../api/installs', () => ({ installsFor: vi.fn(), addToInstall: vi.fn(), createInstall: vi.fn() }));
import * as installsApi from '../../api/installs';
import { RetestVerification } from './RetestVerification';
import type { RetestVerification as Verification } from '../../api/types';
import * as repsApi from '../../api/reps';
import * as rosterApi from '../../api/roster';
import * as authModule from '../../auth/AuthContext';
import type { ConceptBreakdown, Question, QuestionBreakdown } from '../../api/types';
import { WeakestConcepts } from './WeakestConcepts';
import { MissActions } from './MissActions';

/**
 * A QUIZ MISS, THEN WHAT? Teach it on the football picture, or make it a Rep
 * for exactly the players who missed it - the football problem carried over,
 * nothing sent.
 */

const image = { id: 1, question_id: 7, image_url: '/uploads/toss.png', annotations: null, canvas_width: null, updated_at: '' };
const question = {
  id: 7,
  quiz_id: 9,
  question_text: 'Who has force on toss?',
  question_type: 'multiple_choice',
  position: 0,
  concept: { id: 1, name: 'Force / Contain', is_archived: false },
  image,
  options: [
    { id: 1, question_id: 7, option_text: 'The corner', position: 0, is_correct_answer: true },
    { id: 2, question_id: 7, option_text: 'Spill', position: 1, is_correct_answer: false },
    { id: 3, question_id: 7, option_text: 'The safety', position: 2, is_correct_answer: false },
  ],
  answer_explanation: 'Corner squeezes, keeps it inside.',
} as unknown as Question;

const row: QuestionBreakdown = {
  question_id: 7,
  question_number: 3,
  question_text: 'Who has force on toss?',
  question_type: 'multiple_choice',
  answered_count: 10,
  correct_count: 4,
  incorrect_count: 6,
  ungraded_count: 0,
  is_excluded: false,
  exclusions: [],
  option_counts: [
    { option_id: 1, option_text: 'The corner', is_correct: true, count: 4 },
    { option_id: 2, option_text: 'Spill', is_correct: false, count: 2 },
    { option_id: 3, option_text: 'The safety', is_correct: false, count: 4 },
  ],
} as unknown as QuestionBreakdown;

const concept = {
  concept_id: 1,
  concept_name: 'Force / Contain',
  question_count: 1,
  correct_count: 4,
  incorrect_count: 6,
  ungraded_count: 0,
  graded_count: 10,
  miss_rate: 60,
  players_missed_count: 2,
  players_responded_count: 10,
  player_miss_rate: 20,
  retestable_question_count: 1,
  retired_missed_question_count: 0,
  has_enough_responses: true,
  players_missed: [
    { player_id: 41, player_name: 'Ty Adams', display_name: 'Ty Adams', jersey_number: null, position_at_attempt: 'CB' },
    { player_id: 42, player_name: 'Bo Brown', display_name: 'Bo Brown', jersey_number: null, position_at_attempt: 'CB' },
  ],
  top_distractor: null,
} as unknown as ConceptBreakdown;

function at(ui: React.ReactNode) {
  render(
    <MemoryRouter initialEntries={['/quizzes/9']}>
      <Routes>
        <Route path="/quizzes/9" element={ui} />
        <Route path="/reps/:id" element={<p>the new rep</p>} />
        <Route path="/quizzes/:id" element={<p>the retest draft</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1 } } as never);
  vi.mocked(repsApi.makeRepFromQuiz).mockResolvedValue({ id: 55 } as never);
  vi.mocked(rosterApi.addRosterMembers).mockResolvedValue({} as never);
  vi.mocked(retestsApi.createRetest).mockResolvedValue({ id: 77 } as never);
});

describe('from a quiz miss', () => {
  it('a concept miss: Make a rep for the ones who missed it - the questions carried, those players on it', async () => {
    at(<WeakestConcepts concepts={[concept]} quizId={9} questions={[question]} breakdown={[row]} />);
    // The card leads with Teach and Retest; Make a rep is one tap down.
    expect(screen.queryByRole('button', { name: 'Make a rep for the 2' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make a rep for the 2' }));
    expect(await screen.findByText('the new rep')).toBeInTheDocument();
    expect(repsApi.makeRepFromQuiz).toHaveBeenCalledWith(9, [7], 'Force / Contain - Rep');
    expect(rosterApi.addRosterMembers).toHaveBeenCalledWith(55, [41, 42]);
  });

  it('Teach shows what the room chose most on that very question, from the counts', async () => {
    at(<MissActions quizId={9} questions={[question]} breakdown={[row]} title="Q3" repTitle="Week 3 - Q3" />);
    fireEvent.click(screen.getByRole('button', { name: 'Teach' }));
    const teach = within(screen.getByRole('dialog', { name: 'Teach Q3' }));
    expect(teach.getByText('The corner')).toBeInTheDocument();
    expect(teach.getByText('Corner squeezes, keeps it inside.')).toBeInTheDocument();
    expect(teach.getByText('4 chose “The safety”')).toBeInTheDocument();
    // Make rep right from the meeting room.
    fireEvent.click(teach.getByRole('button', { name: 'Make rep' }));
    await waitFor(() => expect(repsApi.makeRepFromQuiz).toHaveBeenCalledWith(9, [7], 'Week 3 - Q3'));
    expect(rosterApi.addRosterMembers).not.toHaveBeenCalled();
  });
});

describe('concept rows say the problem, or that it is fine', () => {
  it('a missed concept: what they chose instead and the next step; a clean one: Looks good', () => {
    const weakest = { ...concept, concept_id: 9, concept_name: 'Run fits', players_missed_count: 5, player_miss_rate: 50 };
    const missed = {
      ...concept,
      top_distractor: { option_text: 'Spill', count: 2, of_misses: 2 },
    };
    const clean = {
      ...concept,
      concept_id: 2,
      concept_name: 'Leverage',
      players_missed_count: 0,
      players_missed: [],
      player_miss_rate: 0,
    };
    at(
      <WeakestConcepts
        concepts={[weakest, missed, clean] as ConceptBreakdown[]}
        quizId={9}
        questions={[question, { ...question, id: 8, concept: { id: 2, name: 'Leverage', is_archived: false } } as Question]}
      />,
    );
    const force = screen.getByText('Force / Contain').closest('li')!;
    expect(within(force).getByText('Spill')).toBeInTheDocument();
    expect(within(force).getByRole('button', { name: 'Teach' })).toBeInTheDocument();
    const leverage = screen.getByText('Leverage').closest('li')!;
    expect(within(leverage).getByText('✓ Looks good')).toBeInTheDocument();
    expect(within(leverage).queryByRole('button', { name: 'Teach' })).toBeNull();
  });
});

describe('retest one question - no concept needed - and did it stick?', () => {
  it('sends this exact football problem back to exactly the players who missed it', async () => {
    const untagged = { ...question, concept: null } as Question;
    at(
      <MissActions
        quizId={9}
        questions={[untagged]}
        title="Q3"
        repTitle="Week 3 - Q3"
        retestTargets={[
          { player_id: 41, player_name: 'Ty Adams' },
          { player_id: null, player_name: 'Walk On' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retest the 2' }));
    expect(await screen.findByText('the retest draft')).toBeInTheDocument();
    expect(retestsApi.createRetest).toHaveBeenCalledWith(9, {
      question_ids: [7],
      player_ids: [41],
      player_names: ['Walk On'],
    });
  });

  it("the original's concept row says how its retest went - careful words, the retest a tap away", () => {
    at(
      <WeakestConcepts
        concepts={[concept]}
        quizId={9}
        questions={[question]}
        retests={[
          {
            quiz_id: 31,
            title: 'Force / Contain - Retest',
            concept_ids: [1],
            source_question_ids: [7],
            targeted_total: 4,
            correct_count: 3,
            incorrect_count: 1,
            ungraded_count: 0,
            not_submitted_count: 0,
            is_complete: true,
          },
        ]}
      />,
    );
    expect(screen.getByText(/answered correctly this time/)).toHaveTextContent('3 of 4 answered correctly this time');
    expect(screen.getByText('1 still missed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open retest' })).toHaveAttribute('href', '/quizzes/31?tab=results');
  });

  it('an untagged retest card offers Teach and Retest again for whoever still misses it', async () => {
    const v = {
      parent_quiz_id: 9,
      parent_quiz_title: 'Week 3',
      concept_source: 'question',
      concept_ids: [],
      concept_names: [],
      source_question_ids: [7],
      retest_question_ids: [70],
      parent_missed_total: 2,
      parent_response_total: 10,
      targeted_total: 2,
      correct_count: 1,
      incorrect_count: 1,
      ungraded_count: 0,
      not_submitted_count: 0,
      is_complete: true,
      players: [],
      still_missing: [{ player_id: 42, player_name: 'Bo Brown', display_name: 'Bo Brown' }],
    } as unknown as Verification;
    at(<RetestVerification verification={v} quizId={31} questions={[{ ...question, id: 70, concept: null } as Question]} />);
    expect(screen.getByRole('button', { name: 'Teach' })).toBeInTheDocument();
    // One player still missing: the button says his name.
    fireEvent.click(screen.getByRole('button', { name: 'Retest Bo' }));
    await waitFor(() =>
      expect(retestsApi.createRetest).toHaveBeenCalledWith(31, { question_ids: [70], player_ids: [42], player_names: [] }),
    );
    expect(await screen.findByText('the retest draft')).toBeInTheDocument();
  });
});

describe('a targeted rep from a concept - from what is already written', () => {
  it('Pick questions: this miss checked, your other quizzes and reps offered - one rep, those players on it', async () => {
    vi.mocked(conceptsApi.listConceptQuestions).mockResolvedValue([
      { question_id: 7, quiz_id: 9, quiz_title: 'Week 3', quiz_kind: 'QUIZ', question_text: 'Who has force on toss?', question_type: 'multiple_choice', has_picture: true },
      { question_id: 50, quiz_id: 12, quiz_title: 'Week 1', quiz_kind: 'QUIZ', question_text: 'Force on sweep?', question_type: 'multiple_choice', has_picture: true },
      { question_id: 60, quiz_id: 14, quiz_title: 'Toss - Rep', quiz_kind: 'REP', question_text: 'Your fit on toss?', question_type: 'multiple_choice', has_picture: false },
    ]);
    vi.mocked(repsApi.addDecisions).mockResolvedValue({} as never);
    at(<WeakestConcepts concepts={[concept]} quizId={9} questions={[question]} breakdown={[row]} />);
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick questions…' }));
    const picker = within(await screen.findByRole('group', { name: 'Questions for the rep' }));
    expect(picker.getByRole('checkbox', { name: /Who has force on toss\?/ })).toBeChecked();
    expect(picker.getByText(/Toss - Rep \(rep\)/)).toBeInTheDocument();
    fireEvent.click(picker.getByRole('checkbox', { name: /Force on sweep\?/ }));
    fireEvent.click(picker.getByRole('button', { name: 'Make a rep of 2' }));
    expect(await screen.findByText('the new rep')).toBeInTheDocument();
    expect(repsApi.makeRepFromQuiz).toHaveBeenCalledWith(9, [7], 'Force / Contain - Rep');
    expect(repsApi.addDecisions).toHaveBeenCalledWith(55, 12, [50]);
    expect(rosterApi.addRosterMembers).toHaveBeenCalledWith(55, [41, 42]);
  });

  it('several missed questions on one concept: one tap makes a rep of all of them', () => {
    const second = { ...question, id: 8, question_text: 'Who spills?' } as Question;
    at(<WeakestConcepts concepts={[concept]} quizId={9} questions={[question, second]} />);
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    expect(screen.getByRole('button', { name: 'Make a rep of all 2 for the 2' })).toBeInTheDocument();
  });

  it("a missed concept goes into this week's install from its details - by reference", async () => {
    vi.mocked(installsApi.installsFor).mockResolvedValue([{ id: 3, title: 'Week 7 - Central', has: false }]);
    vi.mocked(installsApi.addToInstall).mockResolvedValue({} as never);
    at(<WeakestConcepts concepts={[concept]} quizId={9} questions={[question]} />);
    expect(screen.queryByRole('button', { name: 'Add to install' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to install' }));
    const panel = within(screen.getByRole('dialog', { name: 'Add to install' }));
    fireEvent.click(await panel.findByRole('button', { name: 'Add' }));
    await waitFor(() => expect(installsApi.addToInstall).toHaveBeenCalledWith(3, 'concept', 1));
  });

  it('a miss from Motion Lab opens its play in one tap', () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: true } } as never);
    at(<MissActions quizId={9} questions={[{ ...question, motion_play_id: 14 } as Question]} title="Q3" repTitle="Q3 - Rep" />);
    // On a row: Teach shows; the rest waits behind More.
    expect(screen.queryByRole('link', { name: 'Open the play' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('link', { name: 'Open the play' })).toHaveAttribute('href', '/motion-lab/plays/14');
  });
});
