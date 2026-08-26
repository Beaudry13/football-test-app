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

    expect(screen.getByText(/Last check/)).toBeInTheDocument();
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

    // This fixture has nobody outstanding, only grading - so it names that.
    // Whole-body match: the numbers sit in <strong>, splitting the sentence.
    expect(document.body.textContent ?? '').toMatch(/2 are waiting on grading/i);
  });

  it('says nothing about incompleteness when everything is graded', () => {
    renderCard(<RetestVerification verification={verification({ is_complete: true })} />);

    expect(screen.queryByText(/haven.t answered yet|waiting on grading/i)).not.toBeInTheDocument();
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
    expect(text).toMatch(/Last check/);
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

    // Scoped to the CONFIRMATION. The parent quiz title legitimately appears
    // above, in the "Last check" line that names the round being compared -
    // what must not happen is the confirmation naming the quiz where it means
    // the concept.
    const confirmation = screen.getByRole('dialog', { name: 'Create retest' });
    expect(confirmation).toHaveTextContent('Force / Contain');
    expect(confirmation).not.toHaveTextContent('Install Week 2');
  });

  it('offers no round when the concept has no name to confirm with', () => {
    renderCard(<RetestVerification verification={verification({ concept_names: [] })} quizId={9} />);

    expect(screen.queryByRole('button', { name: /Retest th(is|ese)/ })).not.toBeInTheDocument();
  });

  it('NAMES THE ROUND IT IS COMPARED AGAINST', () => {
    /* REGRESSION. This said "First check". The backend has always compared
       against the IMMEDIATE PARENT, so on a retest of a retest the card
       reported round 2's figures under the original round's name. */
    renderCard(
      <RetestVerification
        verification={verification({ parent_quiz_title: 'Force / Contain - Retest' })}
        quizId={9}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Last check/);
    expect(text).toMatch(/Force \/ Contain - Retest/);
    expect(text).not.toMatch(/First check/);
  });

  it('reads naturally on a FIRST retest, where the parent IS the original', () => {
    renderCard(
      <RetestVerification
        verification={verification({ parent_quiz_title: 'Install Week 2' })}
        quizId={9}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Last check/);
    expect(text).toMatch(/Install Week 2/);
    expect(text).toMatch(/6 of 22 players missed this/);
  });

  it('never implies the parent is the original quiz on a LATER round', () => {
    // Round 3: the parent is itself a retest. Nothing may call it the first
    // check, and nothing may claim to reach past it to the original.
    renderCard(
      <RetestVerification
        verification={verification({
          parent_quiz_id: 77,
          parent_quiz_title: 'Force / Contain - Retest 2',
          parent_missed_total: 1,
          parent_response_total: 3,
        })}
        quizId={9}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Force \/ Contain - Retest 2/);
    expect(text).toMatch(/1 of 3 players missed this/);
    expect(text).not.toMatch(/First check|original|Install Week/i);
  });

  it('NAMES WHAT IS MISSING instead of saying the picture is incomplete', () => {
    /* "This is not the full picture yet" was true but vague - it never said
       what would complete it, or whose job that was. */
    renderCard(
      <RetestVerification
        verification={verification({
          targeted_total: 6,
          correct_count: 1,
          incorrect_count: 0,
          ungraded_count: 0,
          not_submitted_count: 5,
          is_complete: false,
        })}
        quizId={9}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/5 of 6 haven.t answered yet/);
    expect(text).not.toMatch(/not the full picture/);
    // Still no improvement claim while the round is unfinished.
    expect(text).not.toMatch(/improved|better|progress/i);
  });

  it('names BOTH kinds of outstanding work when both exist', () => {
    renderCard(
      <RetestVerification
        verification={verification({
          targeted_total: 6,
          correct_count: 2,
          incorrect_count: 1,
          ungraded_count: 1,
          not_submitted_count: 2,
          is_complete: false,
        })}
        quizId={9}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/2 of 6 haven.t answered yet/);
    expect(text).toMatch(/1 is waiting on grading/);
    // And neither has been folded into the missed count.
    expect(text).toMatch(/1 player still missed/);
  });

  it('says only the grading half when everyone has answered', () => {
    renderCard(
      <RetestVerification
        verification={verification({
          targeted_total: 6,
          correct_count: 4,
          incorrect_count: 0,
          ungraded_count: 2,
          not_submitted_count: 0,
          is_complete: false,
        })}
        quizId={9}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/2 are waiting on grading/);
    expect(text).not.toMatch(/haven.t answered yet/);
  });

  it('RECONCILES a retest sent to only some of the players who missed', () => {
    /* "14 of 14 players missed this" over "went to the 6 players who missed
       it" read like an arithmetic error. The coach chose six. */
    renderCard(
      <RetestVerification
        verification={verification({
          parent_missed_total: 14,
          parent_response_total: 14,
          targeted_total: 6,
        })}
        quizId={9}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/14 of 14 players missed this/);
    expect(text).toMatch(/went to 6 of those 14/);
  });

  it('keeps the plain wording when everyone who missed was retested', () => {
    renderCard(
      <RetestVerification
        verification={verification({ parent_missed_total: 6, targeted_total: 6 })}
        quizId={9}
      />,
    );

    expect(document.body.textContent ?? '').toMatch(/went to the 6 players who missed it/);
  });
});
