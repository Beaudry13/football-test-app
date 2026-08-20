import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessCodesTab } from './AccessCodesTab';
import * as accessCodesApi from '../../api/accessCodes';
import * as groupsApi from '../../api/groups';
import { acceptConfirm, cancelConfirm } from '../../test/confirmDialog';
import type { AccessCode, Group, Quiz } from '../../api/types';

const quiz: Quiz = {
  id: 1,
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Week 1 Prep',
  description: null,
  one_question_at_a_time: true,
  require_all_answers: false,
  folder_id: null,
  question_count: 2,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const defenseGroup: Group = {
  id: 7,
  organization_id: 1,
  coach_id: 1,
  name: 'Defense',
  players: [{ id: 1, player_name: 'Jordan Smith', position: 0 }],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const activeCode: AccessCode = {
  id: 3,
  quiz_id: 1,
  code: 'ABC234',
  mode: 'GRADED',
  is_practice: false,
  randomize_questions: false,
  activated_at: '2026-08-01T00:00:00Z',
  expires_at: '2026-08-02T00:00:00Z',
  is_active: true,
  is_valid: true,
  groups: [{ id: 7, name: 'Defense' }],
};

describe('AccessCodesTab group selection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([defenseGroup]);
  });

  it('activates with no groups selected by default', async () => {
    const user = userEvent.setup();
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
    const activateSpy = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(activeCode);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText('This Quiz has no active access code.');
    await user.click(screen.getByRole('button', { name: 'Activate Quiz' }));

    await waitFor(() => expect(activateSpy).toHaveBeenCalledWith(1, [], 'GRADED', false));
  });

  it('passes the checked group ids through to activateQuiz', async () => {
    const user = userEvent.setup();
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
    const activateSpy = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(activeCode);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText('This Quiz has no active access code.');
    await user.click(await screen.findByRole('checkbox', { name: /Defense/ }));
    await user.click(screen.getByRole('button', { name: 'Activate Quiz' }));

    await waitFor(() => expect(activateSpy).toHaveBeenCalledWith(1, [7], 'GRADED', false));
  });

  it('shows which groups the active code is restricted to', async () => {
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([activeCode]);
    render(<AccessCodesTab quiz={quiz} />);

    expect(await screen.findByText('Restricted to: Defense')).toBeInTheDocument();
  });

  it('does not render a group picker when the coach has no saved groups', async () => {
    vi.mocked(groupsApi.listGroups).mockResolvedValue([]);
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText('This Quiz has no active access code.');
    expect(screen.queryByText('Restrict to saved group(s) (optional)')).not.toBeInTheDocument();
  });
});

describe('AccessCodesTab deactivation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([defenseGroup]);
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([activeCode]);
  });

  it('confirms before deactivating a live code, and does nothing if cancelled', async () => {
    const user = userEvent.setup();
    const deactivateSpy = vi.spyOn(accessCodesApi, 'deactivateAccessCode').mockResolvedValue(activeCode);
    render(<AccessCodesTab quiz={quiz} />);

    await user.click(await screen.findByRole('button', { name: 'Deactivate now' }));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('locked out');
    await cancelConfirm(user);
    expect(deactivateSpy).not.toHaveBeenCalled();
  });

  it('deactivates once the confirmation is accepted', async () => {
    const user = userEvent.setup();
    const deactivateSpy = vi.spyOn(accessCodesApi, 'deactivateAccessCode').mockResolvedValue(activeCode);
    render(<AccessCodesTab quiz={quiz} />);

    await user.click(await screen.findByRole('button', { name: 'Deactivate now' }));
    await acceptConfirm(user, 'Deactivate Code');

    await waitFor(() => expect(deactivateSpy).toHaveBeenCalledWith(1, 3));
  });
});

describe('AccessCodesTab activation guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
  });

  it('will not offer to activate a quiz with no questions', async () => {
    // The API refuses this with a 422. Offering the button anyway sent the
    // coach into an error they could have been told about up front.
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
    render(<AccessCodesTab quiz={{ ...quiz, question_count: 0 }} />);

    expect(await screen.findByRole('button', { name: /Activate/ })).toBeDisabled();
  });

  it('offers activation as soon as there is a question', async () => {
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
    render(<AccessCodesTab quiz={{ ...quiz, question_count: 1 }} />);

    expect(await screen.findByRole('button', { name: /Activate/ })).toBeEnabled();
  });

  it('defaults to Graded, so an activation that says nothing still counts', async () => {
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText('This Quiz has no active access code.');

    expect(screen.getByRole('radio', { name: /Graded/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Practice/ })).not.toBeChecked();
  });

  it('sends PRACTICE when the coach picks it', async () => {
    const user = userEvent.setup();
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
    const activateSpy = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(activeCode);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText('This Quiz has no active access code.');
    await user.click(screen.getByRole('radio', { name: /Practice/ }));
    await user.click(screen.getByRole('button', { name: 'Activate Quiz' }));

    await waitFor(() => expect(activateSpy).toHaveBeenCalledWith(1, [], 'PRACTICE', false));
  });

  it('says on the active code whether it counts', async () => {
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([
      { ...activeCode, mode: 'PRACTICE', is_practice: true },
    ]);
    render(<AccessCodesTab quiz={quiz} />);

    // "Did this one count?" is the question a coach asks when a number looks
    // wrong, and it must be answerable without opening anything.
    expect(await screen.findAllByText('Practice')).not.toHaveLength(0);
  });
})

describe('AccessCodesTab sharing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('answers "how do I get this to my players" as one action on the active code', async () => {
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([activeCode]);
    render(<AccessCodesTab quiz={quiz} />);

    // The share action is wired to the ACTIVE code, not to some other one.
    await screen.findByRole('button', { name: 'Copy link' });
    await userEvent.click(screen.getByRole('button', { name: 'Show QR code' }));

    expect(screen.getByText(/Scan with your phone/)).toBeInTheDocument();
  });

  it('REPLACED the permanent read-only link box rather than adding to it', async () => {
    // The box was plumbing a coach had to understand before it helped them,
    // and on a phone it could not reach the apps they actually send with.
    // Keeping both would have been two answers to one question.
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([activeCode]);
    render(<AccessCodesTab quiz={quiz} />);
    await screen.findByRole('button', { name: 'Copy link' });

    const readOnlyLinkBoxes = screen
      .queryAllByRole('textbox')
      .filter((el) => (el as HTMLInputElement).value.includes('/play/'));

    expect(readOnlyLinkBoxes).toHaveLength(0);
  });

  it('shows no share action when there is nothing active to share', async () => {
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText('This Quiz has no active access code.');
    expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show QR code' })).not.toBeInTheDocument();
  });
});
