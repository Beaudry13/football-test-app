import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminQuizzesPage } from './AdminQuizzesPage';
import * as organizationsApi from '../../api/organizations';
import type { OrganizationQuiz } from '../../api/organizations';

const mockCoach = { role: 'admin', username: 'theadmin', organization: 'Wildcats' };
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ coach: mockCoach }),
}));

function quiz(overrides: Partial<OrganizationQuiz> = {}): OrganizationQuiz {
  return {
    id: 1,
    organization_id: 1,
    coach_id: 2,
    created_by_username: 'coacha',
    title: 'A Quiz',
    description: null,
    one_question_at_a_time: true,
    require_all_answers: false,
    folder_id: null,
    question_count: 3,
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
    owner: { id: 2, username: 'coacha' },
    is_unassigned: false,
    ...overrides,
  } as OrganizationQuiz;
}

function renderPage() {
  render(
    <MemoryRouter>
      <AdminQuizzesPage />
    </MemoryRouter>,
  );
}

describe('AdminQuizzesPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCoach.role = 'admin';
    vi.spyOn(organizationsApi, 'getOrganization').mockResolvedValue({
      id: 1,
      name: 'Wildcats',
      members: [
        { id: 2, username: 'coacha', email: 'a@x.com', role: 'member' },
        { id: 3, username: 'coachb', email: 'b@x.com', role: 'member' },
      ],
    } as never);
  });

  it('lists every quiz with its owner', async () => {
    vi.spyOn(organizationsApi, 'listOrganizationQuizzes').mockResolvedValue([
      quiz(),
      quiz({ id: 2, title: 'B Quiz', owner: { id: 3, username: 'coachb' } }),
    ]);
    renderPage();

    expect(await screen.findByText('A Quiz')).toBeInTheDocument();
    expect(screen.getByText('B Quiz')).toBeInTheDocument();
    // Scoped to each row. A coach's name also appears in the filter dropdown
    // and in every OTHER row's reassign options, so an unscoped query matches
    // several times and proves nothing about whether the row shows an owner.
    const rowFor = (title: string) =>
      within(screen.getByText(title).closest('li') as HTMLElement);
    expect(rowFor('A Quiz').getByText('coacha')).toBeInTheDocument();
    expect(rowFor('B Quiz').getByText('coachb')).toBeInTheDocument();
  });

  it('filters by coach', async () => {
    const user = userEvent.setup();
    const list = vi
      .spyOn(organizationsApi, 'listOrganizationQuizzes')
      .mockResolvedValue([quiz()]);
    renderPage();
    await screen.findByText('A Quiz');

    await user.selectOptions(screen.getByLabelText('Filter by coach'), '3');

    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ coachId: 3 })),
    );
  });

  it('searches across all quizzes', async () => {
    const user = userEvent.setup();
    const list = vi
      .spyOn(organizationsApi, 'listOrganizationQuizzes')
      .mockResolvedValue([quiz()]);
    renderPage();
    await screen.findByText('A Quiz');

    await user.type(screen.getByLabelText('Search all quizzes'), 'blitz');

    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ search: 'blitz' })),
    );
  });

  it('flags an unassigned quiz and explains why it matters', async () => {
    vi.spyOn(organizationsApi, 'listOrganizationQuizzes').mockResolvedValue([
      quiz({ owner: null, coach_id: null, is_unassigned: true, created_by_username: null }),
    ]);
    renderPage();

    expect(await screen.findByText('Unassigned')).toBeInTheDocument();
    // A coach reading "Unassigned" needs to know the consequence, not just
    // the label: nobody can see it until it has an owner. Matched by text
    // rather than role="status", which the loading spinner also carries.
    expect(await screen.findByText(/no owner/i)).toBeInTheDocument();
  });

  it('can filter to just the unassigned quizzes', async () => {
    const user = userEvent.setup();
    const list = vi
      .spyOn(organizationsApi, 'listOrganizationQuizzes')
      .mockResolvedValue([quiz()]);
    renderPage();
    await screen.findByText('A Quiz');

    await user.selectOptions(screen.getByLabelText('Filter by coach'), 'unassigned');

    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ coachId: 'unassigned' })),
    );
  });

  it('transfers ownership explicitly', async () => {
    const user = userEvent.setup();
    vi.spyOn(organizationsApi, 'listOrganizationQuizzes').mockResolvedValue([quiz()]);
    const transfer = vi
      .spyOn(organizationsApi, 'transferQuizOwner')
      .mockResolvedValue(quiz({ owner: { id: 3, username: 'coachb' } }));
    renderPage();
    await screen.findByText('A Quiz');

    await user.selectOptions(screen.getByLabelText('Assign owner for A Quiz'), '3');

    await waitFor(() => expect(transfer).toHaveBeenCalledWith(1, 3));
  });

  it('does not offer to reassign a quiz to the coach who already owns it', async () => {
    vi.spyOn(organizationsApi, 'listOrganizationQuizzes').mockResolvedValue([quiz()]);
    renderPage();
    await screen.findByText('A Quiz');

    const select = screen.getByLabelText('Assign owner for A Quiz');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).not.toContain('coacha');
    expect(options).toContain('coachb');
  });

  it('is not a second copy of the dashboard', async () => {
    // No creation, no folder tree - this screen answers "whose is this",
    // and mixing in the authoring workflow would make it a bigger quiz list.
    vi.spyOn(organizationsApi, 'listOrganizationQuizzes').mockResolvedValue([quiz()]);
    renderPage();
    await screen.findByText('A Quiz');

    expect(screen.queryByPlaceholderText(/New Quiz title/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/New folder/i)).not.toBeInTheDocument();
  });

  it('sends a non-admin back to their own quizzes', async () => {
    // Belt and braces - the server 403s every request from this page anyway.
    mockCoach.role = 'member';
    vi.spyOn(organizationsApi, 'listOrganizationQuizzes').mockResolvedValue([]);
    renderPage();

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Admin View' })).not.toBeInTheDocument(),
    );
  });

  it('surfaces a load failure', async () => {
    vi.spyOn(organizationsApi, 'listOrganizationQuizzes').mockRejectedValue(new Error('nope'));
    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
