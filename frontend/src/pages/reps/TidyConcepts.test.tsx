import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/concepts', () => ({ getConceptDuplicates: vi.fn(), mergeConcepts: vi.fn() }));
import * as conceptsApi from '../../api/concepts';
import * as authModule from '../../auth/AuthContext';
import { TidyConcepts } from './TidyConcepts';

/** ONE "Motion adjustment", NOT FIVE: spot the spellings, merge into the one kept. Admins only. */

const GROUP = {
  concepts: [
    { id: 2, name: 'Motion adjustment', question_count: 5 },
    { id: 7, name: 'Motion-Adjust', question_count: 1 },
  ],
  suggested_keep: 2,
};

function open(role: 'admin' | 'member') {
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, role } } as never);
  const onMerged = vi.fn();
  render(<TidyConcepts onMerged={onMerged} />);
  return onMerged;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(conceptsApi.getConceptDuplicates).mockReset().mockResolvedValue([GROUP]);
  vi.mocked(conceptsApi.mergeConcepts).mockReset().mockResolvedValue({ kept: { id: 2, name: 'Motion adjustment', is_archived: false }, retagged: 1 });
});

describe('Tidy concepts', () => {
  it('merges the spellings into the one kept - the most used, unless the coach picks another', async () => {
    const onMerged = open('admin');
    fireEvent.click(await screen.findByRole('button', { name: /look like the same idea/ }));
    const group = within(screen.getByRole('group', { name: 'Keep which one?' }));
    expect(group.getByRole('radio', { name: /Motion adjustment/ })).toBeChecked();
    expect(group.getByText('5 questions')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Merge into “Motion adjustment”' }));
    await waitFor(() => expect(conceptsApi.mergeConcepts).toHaveBeenCalledWith(2, [7]));
    expect(onMerged).toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Tidy concepts' })).toBeNull();
  });

  it('keeps whichever the coach picks', async () => {
    open('admin');
    fireEvent.click(await screen.findByRole('button', { name: /look like the same idea/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Motion-Adjust/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge into “Motion-Adjust”' }));
    await waitFor(() => expect(conceptsApi.mergeConcepts).toHaveBeenCalledWith(7, [2]));
  });

  it('is not offered to a coach who is not an admin', async () => {
    open('member');
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('region', { name: 'Tidy concepts' })).toBeNull();
    expect(conceptsApi.getConceptDuplicates).not.toHaveBeenCalled();
  });
});
