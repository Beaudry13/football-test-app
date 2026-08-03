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

    await waitFor(() => expect(activateSpy).toHaveBeenCalledWith(1, []));
  });

  it('passes the checked group ids through to activateQuiz', async () => {
    const user = userEvent.setup();
    vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
    const activateSpy = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue(activeCode);
    render(<AccessCodesTab quiz={quiz} />);

    await screen.findByText('This Quiz has no active access code.');
    await user.click(await screen.findByRole('checkbox', { name: /Defense/ }));
    await user.click(screen.getByRole('button', { name: 'Activate Quiz' }));

    await waitFor(() => expect(activateSpy).toHaveBeenCalledWith(1, [7]));
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
