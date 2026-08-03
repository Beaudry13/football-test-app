import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';
import { FolderPage } from './FolderPage';
import * as quizzesApi from '../api/quizzes';
import * as foldersApi from '../api/folders';
import * as authContext from '../auth/AuthContext';
import type { Coach, Folder, Quiz } from '../api/types';

const currentCoach: Coach = {
  id: 1,
  username: 'coach1',
  email: 'coach1@example.com',
  organization: 'Wildcats',
  organization_id: 1,
  role: 'member',
  created_at: '2026-01-01T00:00:00Z',
};

/** DashboardPage reads the signed-in coach to decide which quizzes it may
 * edit, so every test needs an auth context. */
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
  folder_id: null,
  question_count: 3,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

const sampleFolder: Folder = {
  id: 10,
  organization_id: 1,
  coach_id: 1,
  name: 'Fall Camp',
  parent_folder_id: null,
  quiz_count: 1,
  subfolder_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function renderDashboard() {
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(foldersApi, 'listFolders').mockResolvedValue([]);
    // Every render mounts ActiveQuizStatusSection alongside the quiz list -
    // default to "nothing live" so tests that don't care about it aren't
    // forced to mock it individually. See ActiveQuizStatus.test.tsx for
    // that section's own dedicated coverage.
    vi.spyOn(quizzesApi, 'getActiveStatus').mockResolvedValue([]);
    mockAuth();
  });

  it('shows the empty state when there are no quizzes', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    renderDashboard();

    expect(await screen.findByText('No Peiras yet. Create your first one above.')).toBeInTheDocument();
  });

  it('lists quizzes with their question count and update date', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    renderDashboard();

    expect(await screen.findByText('Week 1 Prep')).toBeInTheDocument();
    expect(screen.getByText(/3 questions/)).toBeInTheDocument();
  });

  it('shows the server error when the quiz list fails to load', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockRejectedValue(new Error('Could not reach the server.'));
    renderDashboard();

    expect(await screen.findByText('Could not reach the server.')).toBeInTheDocument();
  });

  it('shows the completed count and average score stats when the backend reports them', async () => {
    const withStats: Quiz = { ...sampleQuiz, completed_count: 4, roster_size: 4, average_score_percent: 82 };
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([withStats]);
    renderDashboard();

    expect(await screen.findByText('82%')).toBeInTheDocument();
    expect(screen.getByText('avg. score')).toBeInTheDocument();
    expect(screen.getByText('4/4')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('omits the average-score stat until at least one answer has been graded', async () => {
    const noScoreYet: Quiz = { ...sampleQuiz, completed_count: 0, roster_size: 4 };
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([noScoreYet]);
    renderDashboard();

    expect(await screen.findByText('0/4')).toBeInTheDocument();
    expect(screen.queryByText('avg. score')).not.toBeInTheDocument();
  });

  it('omits the stats line entirely for a single-quiz response that never computed it', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    renderDashboard();

    await screen.findByText('Week 1 Prep');
    expect(screen.queryByText('completed')).not.toBeInTheDocument();
  });

  it('badges a quiz with a live access code as Active', async () => {
    const active: Quiz = { ...sampleQuiz, is_active: true };
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([active]);
    renderDashboard();

    expect(await screen.findByText('Week 1 Prep')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('does not badge a quiz with no live access code', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([{ ...sampleQuiz, is_active: false }]);
    renderDashboard();

    expect(await screen.findByText('Week 1 Prep')).toBeInTheDocument();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('disables New Peira until a title is entered, then creates and refreshes the list', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    const createSpy = vi.spyOn(quizzesApi, 'createQuiz').mockResolvedValue(sampleQuiz);
    renderDashboard();
    await screen.findByText('No Peiras yet. Create your first one above.');

    const newQuizButton = screen.getByRole('button', { name: 'New Peira' });
    expect(newQuizButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText('New Peira title, e.g. Week 3 Prep'), '  Week 3 Prep  ');
    expect(newQuizButton).not.toBeDisabled();

    vi.mocked(quizzesApi.listQuizzes).mockResolvedValue([sampleQuiz]);
    await user.click(newQuizButton);

    await waitFor(() => expect(createSpy).toHaveBeenCalledWith({ title: 'Week 3 Prep' }));
    expect(quizzesApi.listQuizzes).toHaveBeenCalledTimes(2); // initial load + refresh after create
  });

  it('duplicates a quiz and refreshes the list', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    const duplicateSpy = vi.spyOn(quizzesApi, 'duplicateQuiz').mockResolvedValue(sampleQuiz);
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(duplicateSpy).toHaveBeenCalledWith(1));
  });

  it('asks for confirmation before deleting, and does nothing if declined', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    const deleteSpy = vi.spyOn(quizzesApi, 'deleteQuiz').mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('deletes the quiz once the confirmation is accepted', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    const deleteSpy = vi.spyOn(quizzesApi, 'deleteQuiz').mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith(1));
  });

  it('renders a flat list with no folder sections when the coach has no folders', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    renderDashboard();

    await screen.findByText('Week 1 Prep');
    expect(screen.queryByText('Uncategorized')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Move ".*" to folder/)).not.toBeInTheDocument();
  });

  it('groups quizzes into folder sections, with unfoldered quizzes under Uncategorized', async () => {
    const foldered: Quiz = { ...sampleQuiz, id: 2, title: 'Defense Install', folder_id: 10 };
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz, foldered]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder]);
    renderDashboard();

    await screen.findByText('Defense Install');
    expect(screen.getByRole('button', { name: /Fall Camp/ })).toBeInTheDocument();
    expect(screen.getAllByText(/Uncategorized/).length).toBeGreaterThan(0);
  });

  it('creates a folder from the inline form', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    const createFolderSpy = vi.spyOn(foldersApi, 'createFolder').mockResolvedValue(sampleFolder);
    renderDashboard();
    await screen.findByText('No Peiras yet. Create your first one above.');

    await user.type(screen.getByPlaceholderText('New folder, e.g. Fall Camp'), 'Fall Camp');
    await user.click(screen.getByRole('button', { name: 'New folder' }));

    await waitFor(() => expect(createFolderSpy).toHaveBeenCalledWith({ name: 'Fall Camp' }));
  });

  it('moves a quiz to a different folder via the per-card select', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder]);
    const updateSpy = vi.spyOn(quizzesApi, 'updateQuiz').mockResolvedValue(sampleQuiz);
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    const select = screen.getByLabelText('Move "Week 1 Prep" to folder');
    await user.selectOptions(select, 'Fall Camp');

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(1, { folder_id: 10 }));
  });

  it('deletes a folder without deleting its quizzes', async () => {
    const user = userEvent.setup();
    const foldered: Quiz = { ...sampleQuiz, folder_id: 10 };
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([foldered]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder]);
    const deleteFolderSpy = vi.spyOn(foldersApi, 'deleteFolder').mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    await user.click(screen.getByRole('button', { name: 'Delete folder' }));

    await waitFor(() => expect(deleteFolderSpy).toHaveBeenCalledWith(10));
  });

  // --- simple two-level nesting -------------------------------------------

  const sampleSubfolder: Folder = {
    id: 20,
    organization_id: 1,
    coach_id: 1,
    name: 'Week 1',
    parent_folder_id: 10,
    quiz_count: 1,
    subfolder_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  function renderDashboardWithFolderRoute() {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/folders/:folderId" element={<FolderPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('shows a subfolder inside its root folder, visually distinct from a quiz card', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder, sampleSubfolder]);
    renderDashboard();

    await screen.findByRole('button', { name: /Fall Camp/ });
    // A subfolder renders as a link (with a folder glyph), not a quiz card -
    // sampleQuiz is titled "Week 1 Prep", so scope by href to tell them apart.
    const subfolderLink = screen.getAllByRole('link').find((el) => el.getAttribute('href') === '/folders/20');
    expect(subfolderLink).toBeDefined();
    expect(subfolderLink).toHaveTextContent('Week 1');
  });

  it('creates a subfolder from the inline form inside its root folder', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder]);
    const createFolderSpy = vi.spyOn(foldersApi, 'createFolder').mockResolvedValue(sampleSubfolder);
    renderDashboard();
    await screen.findByRole('button', { name: /Fall Camp/ });

    await user.type(screen.getByLabelText('New subfolder inside "Fall Camp"'), 'Week 1');
    await user.click(screen.getByRole('button', { name: 'New subfolder' }));

    await waitFor(() =>
      expect(createFolderSpy).toHaveBeenCalledWith({ name: 'Week 1', parent_folder_id: 10 }),
    );
  });

  it('opens a subfolder and navigates back to its parent via the breadcrumb', async () => {
    const user = userEvent.setup();
    const subQuiz: Quiz = { ...sampleQuiz, id: 2, title: 'Install Quiz', folder_id: 20 };
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([subQuiz]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder, sampleSubfolder]);
    renderDashboardWithFolderRoute();

    await user.click(await screen.findByRole('link', { name: /Week 1/ }));

    expect(await screen.findByRole('heading', { name: 'Week 1' })).toBeInTheDocument();
    expect(await screen.findByText('Install Quiz')).toBeInTheDocument();

    await user.click(screen.getByText('← Back to Fall Camp'));
    expect(await screen.findByRole('heading', { name: 'Your Trials' })).toBeInTheDocument();
  });

  it('lists a subfolder as an option (grouped under its root) in the move-quiz select', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder, sampleSubfolder]);
    const updateSpy = vi.spyOn(quizzesApi, 'updateQuiz').mockResolvedValue(sampleQuiz);
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    const select = screen.getByLabelText('Move "Week 1 Prep" to folder');
    await user.selectOptions(select, '↳ Week 1');

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(1, { folder_id: 20 }));
  });

  // --- organization sharing: see all, edit own ---------------------------

  it("labels a teammate's quiz with its creator and hides the edit controls", async () => {
    const teammates: Quiz = {
      ...sampleQuiz,
      id: 2,
      coach_id: 99,
      created_by_username: 'coach_jones',
      title: "Jones's quiz",
    };
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([teammates]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder]);
    renderDashboard();

    await screen.findByText("Jones's quiz");
    expect(screen.getByText(/by coach_jones/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/to folder/)).not.toBeInTheDocument();
    // Duplicating a teammate's quiz is always allowed - the copy is yours.
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeInTheDocument();
  });

  it('lets an admin edit a teammate\'s quiz', async () => {
    const teammates: Quiz = { ...sampleQuiz, id: 2, coach_id: 99, created_by_username: 'coach_jones' };
    mockAuth({ role: 'admin' });
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([teammates]);
    renderDashboard();

    await screen.findByText('Week 1 Prep');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('does not label or restrict the coach\'s own quiz', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    renderDashboard();

    await screen.findByText('Week 1 Prep');
    expect(screen.queryByText(/by coach1/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('falls back gracefully when the creator has left the organization', async () => {
    const orphaned: Quiz = { ...sampleQuiz, id: 3, coach_id: null, created_by_username: null };
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([orphaned]);
    renderDashboard();

    await screen.findByText('Week 1 Prep');
    expect(screen.getByText(/by a former coach/)).toBeInTheDocument();
  });
});
