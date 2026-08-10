import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TourProvider } from '../help/tour/TourProvider';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';
import { FolderPage } from './FolderPage';
import * as quizzesApi from '../api/quizzes';
import * as foldersApi from '../api/folders';
import * as authContext from '../auth/AuthContext';
import { acceptConfirm, cancelConfirm } from '../test/confirmDialog';
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
  require_all_answers: false,
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
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

/** TourProvider wraps these renders because the shared header contains the
 *  Help menu, which can launch the Dashboard Tour. useTour throws without a
 *  provider rather than silently producing a Help entry that does nothing. */
function renderDashboard() {
  render(
    <MemoryRouter>
      <TourProvider>
        <DashboardPage />
      </TourProvider>
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

    expect(await screen.findByText('No Quizzes yet. Create your first one above.')).toBeInTheDocument();
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

  it('disables New Quiz until a title is entered, then creates and refreshes the list', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    const createSpy = vi.spyOn(quizzesApi, 'createQuiz').mockResolvedValue(sampleQuiz);
    renderDashboard();
    await screen.findByText('No Quizzes yet. Create your first one above.');

    const newQuizButton = screen.getByRole('button', { name: 'New Quiz' });
    expect(newQuizButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText('New Quiz title, e.g. Week 3 Prep'), '  Week 3 Prep  ');
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
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Delete Quiz?');
    await cancelConfirm(user);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('deletes the quiz once the confirmation is accepted', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    const deleteSpy = vi.spyOn(quizzesApi, 'deleteQuiz').mockResolvedValue(undefined);
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await acceptConfirm(user, 'Delete Quiz');

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
    await screen.findByText('No Quizzes yet. Create your first one above.');

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
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    await user.click(screen.getByRole('button', { name: 'Delete folder' }));
    await acceptConfirm(user, 'Delete Folder');

    await waitFor(() => expect(deleteFolderSpy).toHaveBeenCalledWith(10));
  });

  // --- simple two-level nesting -------------------------------------------

  const sampleSubfolder: Folder = {
    id: 20,
    organization_id: 1,
    coach_id: 1,
    name: 'Week 1',
    parent_folder_id: 10,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  function renderDashboardWithFolderRoute(entry = '/') {
    render(
      <MemoryRouter initialEntries={[entry]}>
        <TourProvider>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/folders/:folderId" element={<FolderPage />} />
          </Routes>
        </TourProvider>
      </MemoryRouter>,
    );
  }

  it('renders a subfolder inline inside its parent, not as a link away', async () => {
    // Subfolders used to be links out to their own page, which only worked
    // while nesting was capped at two levels. Now that a season can be five
    // deep, they expand in place - otherwise the coach walks five pages.
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder, sampleSubfolder]);
    renderDashboard();

    await screen.findByRole('button', { name: /Fall Camp/ });
    // Its own expandable section, with its own controls, exactly like a root.
    expect(screen.getByRole('button', { name: /Week 1 \(/ })).toBeInTheDocument();
    expect(screen.getByLabelText('New subfolder inside "Week 1"')).toBeInTheDocument();
  });

  it('nests folders five levels deep, each expandable in place', async () => {
    const chain = ['2026 Season', 'Week 3', 'Defense', 'Redzone', 'Install Quizzes'].map(
      (name, index) => ({
        ...sampleFolder,
        id: 100 + index,
        name,
        parent_folder_id: index === 0 ? null : 100 + index - 1,
      }),
    );
    const deepQuiz: Quiz = { ...sampleQuiz, id: 99, title: 'Deep Install', folder_id: 104 };
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([deepQuiz]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue(chain);
    renderDashboard();

    // Expanded by default in Coach View, so the whole chain is present and the
    // quiz at the bottom is reachable without navigating anywhere.
    for (const name of ['2026 Season', 'Week 3', 'Defense', 'Redzone', 'Install Quizzes']) {
      expect(await screen.findByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(await screen.findByText('Deep Install')).toBeInTheDocument();
  });

  it('collapsing a folder hides everything nested below it', async () => {
    const user = userEvent.setup();
    const chain = ['Season', 'Week', 'Defense'].map((name, index) => ({
      ...sampleFolder,
      id: 200 + index,
      name,
      parent_folder_id: index === 0 ? null : 200 + index - 1,
    }));
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue(chain);
    renderDashboard();

    await user.click(await screen.findByRole('button', { name: /Season/ }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Defense/ })).not.toBeInTheDocument(),
    );
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
    // FolderPage is still reachable by URL - a bookmark, a shared link - so
    // its breadcrumb still has to work. It is just no longer how a coach
    // reaches a subfolder from the dashboard, which now nests inline.
    renderDashboardWithFolderRoute('/folders/20');

    expect(await screen.findByRole('heading', { name: 'Week 1' })).toBeInTheDocument();
    expect(await screen.findByText('Install Quiz')).toBeInTheDocument();

    // The breadcrumb goes to the parent folder's own page, not the
    // dashboard - "Back to Fall Camp" should actually land on Fall Camp.
    await user.click(screen.getByRole('link', { name: /Back to Fall Camp/ }));
    expect(await screen.findByRole('heading', { name: 'Fall Camp' })).toBeInTheDocument();
  });

  it('lists a subfolder as an option in the move-quiz select', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder, sampleSubfolder]);
    const updateSpy = vi.spyOn(quizzesApi, 'updateQuiz').mockResolvedValue(sampleQuiz);
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    // Selected by value, not by visible text: options are indented by depth,
    // and a test that matches the indentation breaks every time the tree's
    // presentation changes without the behaviour changing.
    const select = screen.getByLabelText('Move "Week 1 Prep" to folder');
    await user.selectOptions(select, '20');

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(1, { folder_id: 20 }));
  });

  it('offers a deeply nested folder as a move destination', async () => {
    // Before the nesting cap was lifted the picker listed roots and their
    // direct children only, so anything three or more levels down could not
    // be chosen at all.
    const user = userEvent.setup();
    const deep = { ...sampleSubfolder, id: 30, name: 'Install 1', parent_folder_id: 20 };
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder, sampleSubfolder, deep]);
    const updateSpy = vi.spyOn(quizzesApi, 'updateQuiz').mockResolvedValue(sampleQuiz);
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    await user.selectOptions(screen.getByLabelText('Move "Week 1 Prep" to folder'), '30');

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(1, { folder_id: 30 }));
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
