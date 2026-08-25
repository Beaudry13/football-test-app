import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/retests', () => ({ createRetest: vi.fn() }));

import { createRetest } from '../../api/retests';
import { RetestVerification } from './RetestVerification';
import type { RetestVerification as Verification } from '../../api/types';

/** The card offers another round, so the action needs a Router around it. */
function renderCard(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

const verification = (over: Partial<Verification> = {}): Verification => ({
  parent_quiz_id: 1,
  parent_quiz_title: 'Install Week 2',
  concept_source: 'snapshot',
  concept_ids: [1],
  concept_names: ['Force / Contain'],
  parent_missed_total: 6,
  parent_response_total: 22,
  targeted_total: 6,
  correct_count: 4,
  incorrect_count: 2,
  ungraded_count: 0,
  not_submitted_count: 0,
  is_complete: true,
  players: [],
  still_missing: [
    { player_id: 3, player_name: 'Jalen', display_name: 'Jalen' },
    { player_id: 4, player_name: 'Marcus', display_name: 'Marcus' },
  ],
  ...over,
});

describe('the verification card', () => {
  it('renders nothing on a quiz that is not a retest', () => {
    const { container } = renderCard(<RetestVerification verification={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('KEEPS THE TWO POPULATIONS APART', () => {
    // "6 of 22 missed" and "4 of 6 correct" describe different groups. The
    // first is labelled as the first check and stated separately; the retest
    // outcome is never shown as a fraction of the team.
    renderCard(<RetestVerification verification={verification()} />);

    expect(screen.getByText(/First check/)).toBeInTheDocument();
    expect(screen.getByText(/This retest went to the/)).toBeInTheDocument();
    expect(screen.getByText(/answered correctly this time/)).toBeInTheDocument();
    // No percentage anywhere - a percentage invites exactly the comparison
    // these two populations cannot support.
    expect(document.body.textContent).not.toMatch(/%/);
  });

  it('names who is still missing it', () => {
    renderCard(<RetestVerification verification={verification()} />);

    expect(screen.getByText('Still missing')).toBeInTheDocument();
    expect(screen.getByText('Jalen')).toBeInTheDocument();
    expect(screen.getByText('Marcus')).toBeInTheDocument();
  });

  it('NEVER CLAIMS KNOWLEDGE', () => {
    // One correct answer on a copied question is a second observation, not
    // proof. No surface built on this data may say otherwise.
    renderCard(<RetestVerification verification={verification()} />);

    const text = document.body.textContent ?? '';
    for (const banned of [
      /mastered/i,
      /\blearned\b/i,
      /\bknows\b/i,
      /\bfixed\b/i,
      /gap closed/i,
      /proficien/i,
      /mastery/i,
    ]) {
      expect(text).not.toMatch(banned);
    }
  });

  it('reports ungraded and not-submitted SEPARATELY, and as neither correct nor missed', () => {
    renderCard(
      <RetestVerification
        verification={verification({
          correct_count: 3,
          incorrect_count: 1,
          ungraded_count: 1,
          not_submitted_count: 1,
          is_complete: false,
        })}
      />,
    );

    // Both counted in PLAYERS, and both named separately: an ungraded round is
    // the coach's own backlog and an absent player has not failed anything.
    const text = () => document.body.textContent ?? '';
    expect(text()).toMatch(/1 player is waiting on grading/);
    expect(text()).toMatch(/1 player has not submitted yet/);
  });

  it('WITHHOLDS ANY VERDICT while the evidence is incomplete', () => {
    // A number that moves once grading finishes was never a finding.
    renderCard(
      <RetestVerification
        verification={verification({ ungraded_count: 2, is_complete: false })}
      />,
    );

    expect(screen.getByText(/not the full picture yet/i)).toBeInTheDocument();
  });

  it('says nothing about incompleteness when everything is graded', () => {
    renderCard(<RetestVerification verification={verification({ is_complete: true })} />);

    expect(screen.queryByText(/not the full picture/i)).not.toBeInTheDocument();
  });

  it('admits when the concept had to be matched on the CURRENT tag', () => {
    // Every attempt already in Peira predates concept tagging, so this caveat
    // is the normal case for a while - and it must not be passed off as
    // recorded history.
    renderCard(
      <RetestVerification verification={verification({ concept_source: 'live_fallback' })} />,
    );

    expect(screen.getByText(/current concept/i)).toBeInTheDocument();
  });

  it('stays quiet about matching when the delivery recorded it', () => {
    renderCard(<RetestVerification verification={verification({ concept_source: 'snapshot' })} />);

    expect(screen.queryByText(/current concept/i)).not.toBeInTheDocument();
  });

  it('OFFERS ANOTHER ROUND FROM THE CARD ITSELF, and never sends one', () => {
    /* REGRESSION. This button was guarded on a callback production never
       passed, so it rendered only in tests: the card said who was still
       missing and offered no way to act on it. */
    renderCard(<RetestVerification verification={verification()} quizId={9} />);

    expect(screen.getByRole('button', { name: 'Retest these 2' })).toBeInTheDocument();
    // The coach decides. Nothing is built until they confirm.
    expect(createRetest).not.toHaveBeenCalled();
  });

  it('offers nothing when everyone answered correctly this time', () => {
    renderCard(
      <RetestVerification
        verification={verification({ incorrect_count: 0, correct_count: 6, still_missing: [] })}
        quizId={9}
      />,
    );

    expect(screen.queryByRole('button', { name: /Retest th(is|ese)/ })).not.toBeInTheDocument();
  });

  it('does not offer a round it cannot aim, when this one tested several concepts', () => {
    /* "Retest this concept" has no single answer across two, and guessing one
       would build the wrong quiz. The counts still read normally. */
    renderCard(
      <RetestVerification verification={verification({ concept_ids: [1, 2] })} quizId={9} />,
    );

    expect(screen.queryByRole('button', { name: /Retest th(is|ese)/ })).not.toBeInTheDocument();
    expect(screen.getByText('Still missing')).toBeInTheDocument();
  });

  it('states its counts in PLAYERS, the same unit throughout', () => {
    /* The ungraded line used to say "N answers still need grading" while
       counting players - a unit error in the card whose entire purpose is
       keeping two populations apart. */
    renderCard(
      <RetestVerification
        verification={verification({ correct_count: 3, incorrect_count: 1, ungraded_count: 1 })}
        quizId={9}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/6 of 22 players missed this/);
    expect(text).toMatch(/3 players answered correctly this time/);
    expect(text).toMatch(/1 player still missed/);
    expect(text).toMatch(/1 player is waiting on grading/);
    expect(text).not.toMatch(/answers? still need/);
  });

  it('does not show a zero for an outcome nobody is in', () => {
    renderCard(
      <RetestVerification
        verification={verification({ incorrect_count: 0, still_missing: [] })}
      />,
    );

    expect(screen.queryByText(/still missed/)).not.toBeInTheDocument();
  });

  it('NAMES THE CONCEPT, not the quiz, when confirming another round', async () => {
    /* REGRESSION. The card passed parent_quiz_title, so the confirmation read
       "build a draft on Force / Contain - Retest" - the quiz it came from
       rather than the football idea the round is about. */
    const user = userEvent.setup();
    renderCard(
      <RetestVerification
        verification={verification({ parent_quiz_title: 'Install Week 2' })}
        quizId={9}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Retest these 2' }));

    expect(screen.getByText(/build a draft on/)).toHaveTextContent('Force / Contain');
    expect(screen.queryByText(/Install Week 2/)).not.toBeInTheDocument();
  });

  it('offers no round when the concept has no name to confirm with', () => {
    renderCard(<RetestVerification verification={verification({ concept_names: [] })} quizId={9} />);

    expect(screen.queryByRole('button', { name: /Retest th(is|ese)/ })).not.toBeInTheDocument();
  });
});
