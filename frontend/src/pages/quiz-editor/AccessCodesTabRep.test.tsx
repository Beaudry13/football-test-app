import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessCodesTab } from './AccessCodesTab';
import * as accessCodesApi from '../../api/accessCodes';
import * as groupsApi from '../../api/groups';
import type { AccessCode, Quiz } from '../../api/types';

/** A SITUATIONAL REP in the Activate tab: no Graded/Practice choice - it is always immediate feedback. */

const rep = {
  id: 1,
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Trips Jet - Boundary safety',
  description: null,
  kind: 'REP',
  one_question_at_a_time: true,
  require_all_answers: false,
  folder_id: null,
  question_count: 2,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
} as Quiz;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
  vi.spyOn(accessCodesApi, 'listAccessCodes').mockResolvedValue([]);
});

describe('Activating a Rep', () => {
  it('says it goes out for immediate feedback, offers no choice, and sends it as practice', async () => {
    const user = userEvent.setup();
    const activate = vi.spyOn(accessCodesApi, 'activateQuiz').mockResolvedValue({ id: 3, code: 'ABC234' } as AccessCode);
    render(<AccessCodesTab quiz={rep} />);
    expect(await screen.findByText(/A Rep always goes out for immediate feedback/)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Activate/ }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith(1, [], 'PRACTICE', false, expect.any(Date)));
  });
});
