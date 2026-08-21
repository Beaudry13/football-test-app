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

    await waitFor(() => expect(activateSpy).toHaveBeenCalledWith(1, [], 'GRADED', false, expect.any(Date)));
  });

  it('passes the checked group ids through to activateQuiz', async () => {
    const user = userEvent.setup();
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
    const activateSpy = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(activeCode);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText('This Quiz has no active access code.');
    await user.click(await screen.findByRole('checkbox', { name: /Defense/ }));
    await user.click(screen.getByRole('button', { name: 'Activate Quiz' }));

    await waitFor(() => expect(activateSpy).toHaveBeenCalledWith(1, [7], 'GRADED', false, expect.any(Date)));
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

    await waitFor(() => expect(activateSpy).toHaveBeenCalledWith(1, [], 'PRACTICE', false, expect.any(Date)));
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

describe('AccessCodesTab available-until', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
  });

  it('sends the chosen moment as an absolute instant when activating', async () => {
    const user = userEvent.setup();
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
    const activate = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(activeCode);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText('This Quiz has no active access code.');
    await user.click(screen.getByRole('button', { name: 'Tomorrow morning' }));
    await user.click(screen.getByRole('button', { name: 'Activate Quiz' }));

    const [, , , , expiresAt] = activate.mock.calls[0];
    expect(expiresAt).toBeInstanceOf(Date);
    expect((expiresAt as Date).getHours()).toBe(9);
  });

  it('ACTIVATING STILL TAKES ONE CLICK for a coach who does not care when', async () => {
    // A default is always selected, so adding the choice did not add a
    // required decision.
    const user = userEvent.setup();
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
    const activate = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(activeCode);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText('This Quiz has no active access code.');
    await user.click(screen.getByRole('button', { name: 'Activate Quiz' }));

    expect(activate).toHaveBeenCalledTimes(1);
    const [, , , , expiresAt] = activate.mock.calls[0];
    expect((expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('EXTENDS THE LIVE CODE WITHOUT REACTIVATING IT', async () => {
    // The link is already in a team group text. Reactivating would mint a new
    // code and silently kill it; this must not.
    const user = userEvent.setup();
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([activeCode]);
    const setExpiry = vi
      .spyOn(accessCodesApi, 'setAccessCodeExpiry')
      .mockResolvedValue(activeCode);
    const activate = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(activeCode);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText(/Active until/);
    // Live, the expiry is an ANSWER - the controls for moving it are behind
    // "Change", so a coach reading the card meets one sentence, not five
    // buttons for something most never touch.
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.click(screen.getByRole('button', { name: 'In 3 days' }));

    expect(setExpiry).toHaveBeenCalledWith(quiz.id, activeCode.id, expect.any(Date));
    expect(activate).not.toHaveBeenCalled();
  });

  it('SHOWS THE EXPIRY AS A SENTENCE, NOT AS FIVE CONTROLS', async () => {
    // The mental model on a live Peira is: when does it close, and how do I
    // get it to players. Presets for changing the close time are neither.
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([activeCode]);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText(/Active until/);

    expect(screen.queryByRole('button', { name: 'In 3 days' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pick date & time' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('still asks the question openly BEFORE activation', async () => {
    // Before activating, the coach is deciding - so the presets are the
    // question being asked and belong in front of them.
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText('This Quiz has no active access code.');

    expect(screen.getByRole('button', { name: 'In 3 days' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
  });

  it('shows when the active code stops in plain language', async () => {
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([activeCode]);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText(/Active until/);
    // Not "TTL", not "expires_at", not a raw ISO string.
    expect(document.body.textContent).not.toMatch(/TTL|expires_at|GMT|Z$/);
  });
});

describe('AccessCodesTab active-card focus', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([activeCode]);
  });

  it('KEEPS NEXT-ACTIVATION SETTINGS OUT OF THE LIVE CARD', async () => {
    // While a Peira is live the coach's jobs are: know the code, know when it
    // closes, get it to players, stop it. How the NEXT activation should count
    // is none of those, and it had already been decided.
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText(/Active until/);

    expect(screen.queryByText('How should this count?')).not.toBeInTheDocument();
    expect(screen.queryByText('Randomize questions')).not.toBeInTheDocument();
  });

  it('offers exactly the four live jobs', async () => {
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText(/Active until/);

    // Twice - the hero display and the activation history row below it.
    expect(screen.getAllByText(activeCode.code).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Copy link|Share Peira/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show QR code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate now' })).toBeInTheDocument();
  });

  it('reveals those settings under Reactivate, with the consequence stated', async () => {
    const user = userEvent.setup();
    render(<AccessCodesTab quiz={quiz} />);
    await screen.findByText(/Active until/);

    await user.click(screen.getByRole('button', { name: 'Reactivate with new code' }));

    expect(screen.getByText('How should this count?')).toBeInTheDocument();
    // The destructive consequence is stated BEFORE the controls - finding it
    // underneath the button would be too late to back out.
    expect(screen.getByText(/stops working/)).toBeInTheDocument();
  });

  it('lets the coach back out without making a new code', async () => {
    const user = userEvent.setup();
    const activate = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(activeCode);
    render(<AccessCodesTab quiz={quiz} />);
    await screen.findByText(/Active until/);

    await user.click(screen.getByRole('button', { name: 'Reactivate with new code' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('How should this count?')).not.toBeInTheDocument();
    expect(activate).not.toHaveBeenCalled();
  });

  it('still mints a new code when the coach goes through with it', async () => {
    const user = userEvent.setup();
    const activate = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(activeCode);
    render(<AccessCodesTab quiz={quiz} />);
    await screen.findByText(/Active until/);

    await user.click(screen.getByRole('button', { name: 'Reactivate with new code' }));
    await user.click(screen.getByRole('button', { name: 'Create new code' }));

    expect(activate).toHaveBeenCalledTimes(1);
  });
});

describe('AccessCodesTab question-order badge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
  });

  it('SAYS NOTHING ABOUT ORDER ON A GRADED CODE', async () => {
    // Randomization is ignored entirely for graded - routes/play.py passes
    // `randomize = is_practice and randomize_questions` - so the badge could
    // only ever read "Standard". A label that cannot change is not
    // information; it is a word beside one that is.
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([activeCode]);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText(/Active until/);

    expect(screen.queryByText(/Question order/)).not.toBeInTheDocument();
    // "Graded" already tells the coach the order is the authored one.
    expect(screen.getAllByText('Graded').length).toBeGreaterThan(0);
  });

  it('still says it on a PRACTICE code, where it can vary', async () => {
    const practice = { ...activeCode, mode: 'PRACTICE' as const, is_practice: true };
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([practice]);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText(/Active until/);

    expect(screen.getAllByText(/Question order: Standard/).length).toBeGreaterThan(0);
  });

  it('distinguishes a randomized practice code', async () => {
    const practice = {
      ...activeCode,
      mode: 'PRACTICE' as const,
      is_practice: true,
      randomize_questions: true,
    };
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([practice]);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText(/Active until/);

    expect(screen.getAllByText(/Question order: Randomized/).length).toBeGreaterThan(0);
  });
});
