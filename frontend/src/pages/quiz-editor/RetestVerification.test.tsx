import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RetestVerification } from './RetestVerification';
import type { RetestVerification as Verification } from '../../api/types';

const verification = (over: Partial<Verification> = {}): Verification => ({
  parent_quiz_id: 1,
  parent_quiz_title: 'Install Week 2',
  concept_source: 'snapshot',
  concept_ids: [1],
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
    { player_id: 3, display_name: 'Jalen' },
    { player_id: 4, display_name: 'Marcus' },
  ],
  ...over,
});

describe('the verification card', () => {
  it('renders nothing on a quiz that is not a retest', () => {
    const { container } = render(<RetestVerification verification={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('KEEPS THE TWO POPULATIONS APART', () => {
    // "6 of 22 missed" and "4 of 6 correct" describe different groups. The
    // first is labelled as the first check and stated separately; the retest
    // outcome is never shown as a fraction of the team.
    render(<RetestVerification verification={verification()} />);

    expect(screen.getByText(/First check/)).toBeInTheDocument();
    expect(screen.getByText(/This retest went to the/)).toBeInTheDocument();
    expect(screen.getByText(/answered correctly this time/)).toBeInTheDocument();
    // No percentage anywhere - a percentage invites exactly the comparison
    // these two populations cannot support.
    expect(document.body.textContent).not.toMatch(/%/);
  });

  it('names who is still missing it', () => {
    render(<RetestVerification verification={verification()} />);

    expect(screen.getByText('Still missing')).toBeInTheDocument();
    expect(screen.getByText('Jalen')).toBeInTheDocument();
    expect(screen.getByText('Marcus')).toBeInTheDocument();
  });

  it('NEVER CLAIMS KNOWLEDGE', () => {
    // One correct answer on a copied question is a second observation, not
    // proof. No surface built on this data may say otherwise.
    render(<RetestVerification verification={verification()} />);

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
    render(
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

    expect(screen.getByText(/still need.*grading/i)).toBeInTheDocument();
    expect(screen.getByText(/ha(s|ve) not submitted yet/i)).toBeInTheDocument();
  });

  it('WITHHOLDS ANY VERDICT while the evidence is incomplete', () => {
    // A number that moves once grading finishes was never a finding.
    render(
      <RetestVerification
        verification={verification({ ungraded_count: 2, is_complete: false })}
      />,
    );

    expect(screen.getByText(/not the full picture yet/i)).toBeInTheDocument();
  });

  it('says nothing about incompleteness when everything is graded', () => {
    render(<RetestVerification verification={verification({ is_complete: true })} />);

    expect(screen.queryByText(/not the full picture/i)).not.toBeInTheDocument();
  });

  it('admits when the concept had to be matched on the CURRENT tag', () => {
    // Every attempt already in Peira predates concept tagging, so this caveat
    // is the normal case for a while - and it must not be passed off as
    // recorded history.
    render(
      <RetestVerification verification={verification({ concept_source: 'live_fallback' })} />,
    );

    expect(screen.getByText(/current concept/i)).toBeInTheDocument();
  });

  it('stays quiet about matching when the delivery recorded it', () => {
    render(<RetestVerification verification={verification({ concept_source: 'snapshot' })} />);

    expect(screen.queryByText(/current concept/i)).not.toBeInTheDocument();
  });

  it('offers another round only when players remain, and never sends one', () => {
    const onRetestRemaining = vi.fn();
    render(
      <RetestVerification verification={verification()} onRetestRemaining={onRetestRemaining} />,
    );

    expect(screen.getByRole('button', { name: 'Retest these 2' })).toBeInTheDocument();
    // The coach decides. Nothing happens until they say so.
    expect(onRetestRemaining).not.toHaveBeenCalled();
  });

  it('offers nothing when everyone answered correctly this time', () => {
    render(
      <RetestVerification
        verification={verification({ incorrect_count: 0, correct_count: 6, still_missing: [] })}
        onRetestRemaining={() => {}}
      />,
    );

    expect(screen.queryByRole('button', { name: /Retest these/ })).not.toBeInTheDocument();
  });

  it('does not show a zero for an outcome nobody is in', () => {
    render(
      <RetestVerification
        verification={verification({ incorrect_count: 0, still_missing: [] })}
      />,
    );

    expect(screen.queryByText(/still missed/)).not.toBeInTheDocument();
  });
});
