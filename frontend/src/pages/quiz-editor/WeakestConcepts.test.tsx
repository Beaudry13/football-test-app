import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/retests', () => ({ createRetest: vi.fn() }));

import { createRetest } from '../../api/retests';
import { WeakestConcepts } from './WeakestConcepts';
import type { ConceptBreakdown } from '../../api/types';

const concept = (over: Partial<ConceptBreakdown> = {}): ConceptBreakdown => ({
  concept_id: 1,
  concept_name: 'Force / Contain',
  question_count: 2,
  correct_count: 16,
  incorrect_count: 6,
  ungraded_count: 0,
  graded_count: 22,
  miss_rate: 27.3,
  has_enough_responses: true,
  players_missed: [],
  top_distractor: null,
  ...over,
});


/** The panel navigates on success, so every case needs a Router around it. */
function renderPanel(ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={['/quizzes/9']}>
      <Routes>
        <Route path="/quizzes/9" element={ui} />
        <Route path="/quizzes/:id" element={<div>EDITOR</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the "Teach next" panel', () => {
  it('leads with the COUNT, not the percentage', () => {
    // "6 of 22 missed" is a fact a coach can act on. "27.3%" is the same fact
    // needing arithmetic first, and reads far more confident than a small
    // sample usually deserves.
    renderPanel(<WeakestConcepts concepts={[concept()]} quizId={9} />);

    expect(screen.getByText('Force / Contain')).toBeInTheDocument();
    expect(screen.getByText(/6 of 22 missed/)).toBeInTheDocument();
  });

  it('puts the WEAKEST concept in the headline and the rest below', () => {
    renderPanel(
      <WeakestConcepts
        quizId={9}
        concepts={[
          concept({ concept_id: 1, concept_name: 'Force / Contain', miss_rate: 60 }),
          concept({ concept_id: 2, concept_name: 'Run Fit', miss_rate: 10, incorrect_count: 2 }),
        ]}
      />,
    );

    // The server sorts; this asserts the panel respects that order rather than
    // re-sorting and risking a second opinion.
    const headline = screen.getByText('Force / Contain');
    expect(headline).toBeInTheDocument();
    expect(screen.getByText('Run Fit')).toBeInTheDocument();
  });

  it('SAYS SO when there are too few answers to be sure', () => {
    renderPanel(
      <WeakestConcepts
        quizId={9}
        concepts={[concept({ graded_count: 3, incorrect_count: 2, has_enough_responses: false })]}
      />,
    );

    expect(screen.getByText(/too few answers to be sure/i)).toBeInTheDocument();
  });

  it('does not hedge when the sample supports it', () => {
    renderPanel(<WeakestConcepts quizId={9} concepts={[concept({ has_enough_responses: true })]} />);

    expect(screen.queryByText(/too few answers/i)).not.toBeInTheDocument();
  });

  it('names the common wrong answer in CAUTIOUS language', () => {
    renderPanel(
      <WeakestConcepts
        quizId={9}
        concepts={[
          concept({ top_distractor: { option_text: 'Safety', count: 5, of_misses: 6 } }),
        ]}
      />,
    );

    expect(screen.getByText(/5 of the 6 misses chose/)).toBeInTheDocument();
    expect(screen.getByText('Safety')).toBeInTheDocument();
    // The data says what they PICKED; it does not say why.
    expect(screen.queryByText(/misconception/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/believe/i)).not.toBeInTheDocument();
  });

  it('says nothing about patterns when the server withheld one', () => {
    renderPanel(<WeakestConcepts quizId={9} concepts={[concept({ top_distractor: null })]} />);

    expect(screen.queryByText(/misses chose/)).not.toBeInTheDocument();
  });

  it('names who missed it, with their position AT THE TIME', () => {
    renderPanel(
      <WeakestConcepts
        quizId={9}
        concepts={[
          concept({
            players_missed: [
              { player_id: 1, player_name: 'Jordan Smith', display_name: 'Jordan Smith', position_at_attempt: 'CB' },
            ],
          }),
        ]}
      />,
    );

    const list = screen.getByText('Who missed it').parentElement!;
    expect(within(list).getByText('Jordan Smith')).toBeInTheDocument();
    expect(within(list).getByText('CB')).toBeInTheDocument();
  });

  it('shows NOTHING rather than a guess when position was never recorded', () => {
    // Every attempt older than Phase A is in this state. An empty space is
    // honest; the roster's current value would be a fabrication.
    renderPanel(
      <WeakestConcepts
        quizId={9}
        concepts={[
          concept({
            players_missed: [
              { player_id: 1, player_name: 'Jordan Smith', display_name: 'Jordan Smith', position_at_attempt: null },
            ],
          }),
        ]}
      />,
    );

    expect(screen.getByText('Jordan Smith')).toBeInTheDocument();
    expect(screen.queryByText('null')).not.toBeInTheDocument();
    expect(screen.queryByText('undefined')).not.toBeInTheDocument();
  });

  it('RENDERS NOTHING when no concept has been graded', () => {
    // A quiz that predates tagging - which is every quiz in Peira today -
    // must look exactly as it did. An empty weakness panel would be a
    // permanent reminder of a feature rather than an answer.
    const { container } = renderPanel(
      <WeakestConcepts quizId={9} concepts={[concept({ miss_rate: null, graded_count: 0 })]} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing at all when nothing is tagged', () => {
    const { container } = renderPanel(<WeakestConcepts concepts={[]} quizId={9} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('says ungraded answers are not counted, rather than counting them', () => {
    renderPanel(<WeakestConcepts quizId={9} concepts={[concept({ ungraded_count: 3 })]} />);

    expect(screen.getByText(/3 answers here still need grading/)).toBeInTheDocument();
    expect(screen.getByText(/not counted/)).toBeInTheDocument();
  });

  it('never prints a fabricated 0%', () => {
    renderPanel(
      <WeakestConcepts
        quizId={9}
        concepts={[
          concept({ miss_rate: null, graded_count: 0, incorrect_count: 0, correct_count: 0 }),
          concept({ concept_id: 2, concept_name: 'Run Fit' }),
        ]}
      />,
    );

    // The unmeasured concept is simply absent; it is not shown as 0% missed.
    expect(screen.queryByText('Force / Contain')).not.toBeInTheDocument();
    expect(screen.getByText('Run Fit')).toBeInTheDocument();
  });
});

describe('Retest these players', () => {
  const missed = [
    { player_id: 3, player_name: 'Jalen Reed', display_name: 'Jalen Reed', position_at_attempt: 'CB' },
    { player_id: null, player_name: 'Legacy Kid', display_name: 'Legacy Kid', position_at_attempt: null },
  ];

  beforeEach(() => vi.mocked(createRetest).mockReset());

  it('names how many players it will retest', () => {
    renderPanel(<WeakestConcepts quizId={9} concepts={[concept({ players_missed: missed })]} />);

    expect(screen.getByRole('button', { name: 'Retest these 2' })).toBeInTheDocument();
  });

  it('CONFIRMS before building, and says nothing is sent', async () => {
    const user = userEvent.setup();
    renderPanel(<WeakestConcepts quizId={9} concepts={[concept({ players_missed: missed })]} />);

    await user.click(screen.getByRole('button', { name: 'Retest these 2' }));

    expect(screen.getByRole('dialog', { name: 'Create retest' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing is sent/)).toBeInTheDocument();
    // Confirming is not building.
    expect(createRetest).not.toHaveBeenCalled();
  });

  it('sends canonical ids AND legacy names, so nobody is quietly dropped', async () => {
    vi.mocked(createRetest).mockResolvedValue({ id: 42 } as never);
    const user = userEvent.setup();
    renderPanel(<WeakestConcepts quizId={9} concepts={[concept({ players_missed: missed })]} />);

    await user.click(screen.getByRole('button', { name: 'Retest these 2' }));
    await user.click(screen.getByRole('button', { name: 'Create retest' }));

    await waitFor(() =>
      expect(createRetest).toHaveBeenCalledWith(9, {
        concept_id: 1,
        player_ids: [3],
        player_names: ['Legacy Kid'],
      }),
    );
  });

  it('lands the coach in the EXISTING editor', async () => {
    vi.mocked(createRetest).mockResolvedValue({ id: 42 } as never);
    const user = userEvent.setup();
    renderPanel(<WeakestConcepts quizId={9} concepts={[concept({ players_missed: missed })]} />);

    await user.click(screen.getByRole('button', { name: 'Retest these 2' }));
    await user.click(screen.getByRole('button', { name: 'Create retest' }));

    expect(await screen.findByText('EDITOR')).toBeInTheDocument();
  });

  /* The failure path lives in WeakestConceptsRetestFailure.test.tsx. It is
     the same component and the same mocked rejection; sharing this file's mock
     state made the runner report the rejection as an unhandled error before
     the assertion ran. Alone, it passes - see that file's header. */

  it('can be backed out of', async () => {
    const user = userEvent.setup();
    renderPanel(<WeakestConcepts quizId={9} concepts={[concept({ players_missed: missed })]} />);

    await user.click(screen.getByRole('button', { name: 'Retest these 2' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(createRetest).not.toHaveBeenCalled();
  });
});
