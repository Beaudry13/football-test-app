import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminQuizzesPage } from './AdminQuizzesPage';
import * as organizationsApi from '../../api/organizations';
import type { OrganizationQuiz } from '../../api/organizations';
import type { Folder } from '../../api/types';

const mockCoach = { role: 'admin', username: 'theadmin', organization: 'Wildcats' };
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ coach: mockCoach }),
}));

function folder(id: number, name: string, parent: number | null = null): Folder {
  return {
    id,
    organization_id: 1,
    coach_id: 1,
    name,
    parent_folder_id: parent,
    quiz_count: 0,
    subfolder_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as Folder;
}

function quiz(
  id: number,
  title: string,
  folderId: number | null,
  owner: { id: number; username: string } | null = { id: 2, username: 'coacha' },
): OrganizationQuiz {
  return {
    id,
    organization_id: 1,
    coach_id: owner?.id ?? null,
    created_by_username: owner?.username ?? null,
    title,
    description: null,
    folder_id: folderId,
    question_count: 3,
    owner,
    is_unassigned: owner === null,
  } as OrganizationQuiz;
}

/** 2026 Season > {Week 3 (coacha's quiz), Week 1 (coachb's)}, plus a loose one. */
function sampleTree() {
  return {
    folders: [folder(1, '2026 Season'), folder(2, 'Week 3', 1), folder(3, 'Week 1', 1)],
    quizzes: [
      quiz(10, 'Redzone Install', 2),
      quiz(11, 'Base Install', 3, { id: 3, username: 'coachb' }),
      quiz(12, 'Loose Quiz', null),
    ],
  };
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
    sessionStorage.clear();
    mockCoach.role = 'admin';
    vi.spyOn(organizationsApi, 'getOrganization').mockResolvedValue({
      id: 1,
      name: 'Wildcats',
      members: [
        { id: 2, username: 'coacha', email: 'a@x.com', role: 'member' },
        { id: 3, username: 'coachb', email: 'b@x.com', role: 'member' },
      ],
    } as never);
    vi.spyOn(organizationsApi, 'listOrganizationQuizzes').mockResolvedValue(sampleTree());
  });

  it('shows top-level folders and nothing below them', async () => {
    renderPage();

    expect(await screen.findByText('2026 Season')).toBeInTheDocument();
    // Collapsed by default: the admin decides what to inspect, and a flat
    // dump of every quiz is what this redesign exists to stop.
    expect(screen.queryByText('Week 3')).not.toBeInTheDocument();
    expect(screen.queryByText('Redzone Install')).not.toBeInTheDocument();
  });

  it('summarises a collapsed folder so expanding is not a guess', async () => {
    renderPage();
    const row = (await screen.findByText('2026 Season')).closest('button')!;

    // Descendant counts, not just direct children.
    expect(within(row).getByText('2 quizzes')).toBeInTheDocument();
    expect(within(row).getByText('2 subfolders')).toBeInTheDocument();
    expect(within(row).getByText('2 coaches')).toBeInTheDocument();
  });

  it('expands one level at a time', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('2026 Season'));
    expect(await screen.findByText('Week 3')).toBeInTheDocument();
    // The grandchild's quizzes stay hidden until that folder is opened too.
    expect(screen.queryByText('Redzone Install')).not.toBeInTheDocument();

    await user.click(screen.getByText('Week 3'));
    expect(await screen.findByText('Redzone Install')).toBeInTheDocument();
  });

  it('collapses again', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('2026 Season'));
    await screen.findByText('Week 3');
    await user.click(screen.getByText('2026 Season'));

    await waitFor(() => expect(screen.queryByText('Week 3')).not.toBeInTheDocument());
  });

  it('remembers what was open for the session', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <MemoryRouter>
        <AdminQuizzesPage />
      </MemoryRouter>,
    );
    await user.click(await screen.findByText('2026 Season'));
    await screen.findByText('Week 3');
    unmount();

    renderPage();
    // Re-opening the page mid-session lands where they left off.
    expect(await screen.findByText('Week 3')).toBeInTheDocument();
  });

  it('shows the owner and question count on each quiz row', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('2026 Season'));
    await user.click(await screen.findByText('Week 3'));

    const row = (await screen.findByText('Redzone Install')).closest('div')!;
    expect(within(row).getByText('coacha')).toBeInTheDocument();
    expect(within(row).getByText('3 questions')).toBeInTheDocument();
  });

  it('puts a quiz with no folder in Uncategorized rather than losing it', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Uncategorized'));
    expect(await screen.findByText('Loose Quiz')).toBeInTheDocument();
  });

  it('marks an unassigned quiz in place, without moving it out of its folder', async () => {
    // Folder organisation and ownership are separate concepts.
    vi.spyOn(organizationsApi, 'listOrganizationQuizzes').mockResolvedValue({
      folders: [folder(1, '2026 Season')],
      quizzes: [quiz(10, 'Ownerless', 1, null)],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('2026 Season'));
    const row = (await screen.findByText('Ownerless')).closest('div')!;
    expect(within(row).getByText('Unassigned')).toBeInTheDocument();
    expect(within(row).getByLabelText('Assign owner for Ownerless')).toBeInTheDocument();
  });

  it('warns that unassigned quizzes are invisible to every coach', async () => {
    vi.spyOn(organizationsApi, 'listOrganizationQuizzes').mockResolvedValue({
      folders: [folder(1, '2026 Season')],
      quizzes: [quiz(10, 'Ownerless', 1, null)],
    });
    renderPage();

    expect(await screen.findByText(/no owner/i)).toBeInTheDocument();
  });

  describe('coach filter', () => {
    it('keeps the ancestor path to the match', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('2026 Season');

      await user.selectOptions(screen.getByLabelText('Filter by coach'), '2');

      // coacha's only quiz is 2026 Season > Week 3 > Redzone Install, and the
      // whole path stays so the location still reads.
      expect(await screen.findByText('2026 Season')).toBeInTheDocument();
      expect(await screen.findByText('Week 3')).toBeInTheDocument();
      expect(await screen.findByText('Redzone Install')).toBeInTheDocument();
    });

    it('hides branches with none of that coach’s quizzes', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('2026 Season');

      await user.selectOptions(screen.getByLabelText('Filter by coach'), '2');

      await waitFor(() => expect(screen.queryByText('Week 1')).not.toBeInTheDocument());
      expect(screen.queryByText('Base Install')).not.toBeInTheDocument();
    });

    it('does not flatten the tree', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('2026 Season');
      await user.selectOptions(screen.getByLabelText('Filter by coach'), '2');

      // Still folders, still nested - not a flat result list.
      const season = (await screen.findByText('2026 Season')).closest('button')!;
      expect(season).toHaveAttribute('aria-expanded');
    });

    it('filters to unassigned quizzes', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('2026 Season');

      await user.selectOptions(screen.getByLabelText('Filter by coach'), 'unassigned');

      await waitFor(() => expect(screen.queryByText('2026 Season')).not.toBeInTheDocument());
    });

    it('restores the full tree when cleared, with no refetch', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('2026 Season');
      await user.selectOptions(screen.getByLabelText('Filter by coach'), '2');
      await waitFor(() => expect(screen.queryByText('Week 1')).not.toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Clear' }));

      expect(await screen.findByText('2026 Season')).toBeInTheDocument();
      expect(organizationsApi.listOrganizationQuizzes).toHaveBeenCalledTimes(1);
    });
  });

  describe('search', () => {
    it('reveals the path to a match instead of flattening', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('2026 Season');

      await user.type(screen.getByLabelText('Search all quizzes'), 'redzone');

      // Auto-expanded, so the admin sees WHERE it lives without re-orienting
      // to a different layout.
      expect(await screen.findByText('Week 3')).toBeInTheDocument();
      expect(await screen.findByText('Redzone Install')).toBeInTheDocument();
      expect(screen.queryByText('Base Install')).not.toBeInTheDocument();
    });

    it('finds quizzes by owner name', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('2026 Season');

      await user.type(screen.getByLabelText('Search all quizzes'), 'coachb');

      expect(await screen.findByText('Base Install')).toBeInTheDocument();
    });

    it('never hits the network while typing', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('2026 Season');

      await user.type(screen.getByLabelText('Search all quizzes'), 'redzone install');

      // One fetch on mount, then everything local - a request per keystroke is
      // what the single-payload design exists to avoid.
      expect(organizationsApi.listOrganizationQuizzes).toHaveBeenCalledTimes(1);
    });
  });

  it('transfers ownership explicitly', async () => {
    const user = userEvent.setup();
    const transfer = vi
      .spyOn(organizationsApi, 'transferQuizOwner')
      .mockResolvedValue(quiz(10, 'Redzone Install', 2, { id: 3, username: 'coachb' }));
    renderPage();

    await user.click(await screen.findByText('2026 Season'));
    await user.click(await screen.findByText('Week 3'));
    await user.selectOptions(screen.getByLabelText('Assign owner for Redzone Install'), '3');

    await waitFor(() => expect(transfer).toHaveBeenCalledWith(10, 3));
  });

  it('marks an empty folder rather than leaving it ambiguous', async () => {
    vi.spyOn(organizationsApi, 'listOrganizationQuizzes').mockResolvedValue({
      folders: [folder(1, 'Nothing Here')],
      quizzes: [],
    });
    renderPage();

    const row = (await screen.findByText('Nothing Here')).closest('button')!;
    expect(within(row).getByText('Empty')).toBeInTheDocument();
  });

  it('is not a second copy of the dashboard', async () => {
    renderPage();
    await screen.findByText('2026 Season');

    expect(screen.queryByPlaceholderText(/New Quiz title/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/New folder/i)).not.toBeInTheDocument();
  });

  it('sends a non-admin back to their own quizzes', async () => {
    mockCoach.role = 'member';
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
