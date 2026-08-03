import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResponseRow } from './ResponseRow';
import * as gradingApi from '../../api/grading';
import * as authContext from '../../auth/AuthContext';
import { acceptConfirm, cancelConfirm } from '../../test/confirmDialog';
import type { Coach, PlayerResponse, Quiz } from '../../api/types';

const currentCoach: Coach = {
  id: 1,
  username: 'coach1',
  email: 'coach1@example.com',
  organization: 'Wildcats',
  organization_id: 1,
  role: 'member',
  created_at: '2026-01-01T00:00:00Z',
};

function mockAuth(overrides: Partial<Coach> = {}) {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    coach: { ...currentCoach, ...overrides },
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    registerWithInvite: vi.fn(),
    logout: vi.fn(),
  });
}

const sampleQuiz: Quiz = {
  id: 1,
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Week 1 Prep',
  description: null,
  one_question_at_a_time: true,
  require_all_answers: false,
  folder_id: null,
  question_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const sampleResponse: PlayerResponse = {
  id: 7,
  quiz_id: 1,
  access_code_id: 9,
  player_name: 'Jordan Smith',
  submitted_at: '2026-01-01T00:05:00Z',
  answers: [],
};

function renderRow(overrides: Partial<PlayerResponse> = {}) {
  render(
    <MemoryRouter>
      <ResponseRow quiz={sampleQuiz} response={{ ...sampleResponse, ...overrides }} onChanged={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('ResponseRow reset attempt', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows Reset attempt to the quiz's creator", () => {
    mockAuth({ id: 1 });
    renderRow();
    expect(screen.getByRole('button', { name: 'Reset attempt' })).toBeInTheDocument();
  });

  it('shows Reset attempt to an org admin, even if not the creator', () => {
    mockAuth({ id: 99, role: 'admin' });
    renderRow();
    expect(screen.getByRole('button', { name: 'Reset attempt' })).toBeInTheDocument();
  });

  it('hides Reset attempt from a teammate who is neither creator nor admin', () => {
    mockAuth({ id: 99, role: 'member' });
    renderRow();
    expect(screen.queryByRole('button', { name: 'Reset attempt' })).not.toBeInTheDocument();
  });

  it('does nothing if the confirmation is declined', async () => {
    const user = userEvent.setup();
    mockAuth({ id: 1 });
    const resetSpy = vi.spyOn(gradingApi, 'resetAttempt');
    renderRow();

    await user.click(screen.getByRole('button', { name: 'Reset attempt' }));
    await cancelConfirm(user);

    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('resets the attempt once confirmed and refreshes the list', async () => {
    const user = userEvent.setup();
    mockAuth({ id: 1 });
    const resetSpy = vi.spyOn(gradingApi, 'resetAttempt').mockResolvedValue(undefined);
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <ResponseRow quiz={sampleQuiz} response={sampleResponse} onChanged={onChanged} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Reset attempt' }));
    await acceptConfirm(user, 'Reset Attempt');

    await waitFor(() => expect(resetSpy).toHaveBeenCalledWith(1, 7));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('shows an error and re-enables the button if the reset request fails', async () => {
    const user = userEvent.setup();
    mockAuth({ id: 1 });
    vi.spyOn(gradingApi, 'resetAttempt').mockRejectedValue(new Error('Request failed'));
    renderRow();

    await user.click(screen.getByRole('button', { name: 'Reset attempt' }));
    await acceptConfirm(user, 'Reset Attempt');

    expect(await screen.findByText('Request failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset attempt' })).not.toBeDisabled();
  });
});
