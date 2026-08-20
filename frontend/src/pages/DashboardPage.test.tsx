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
import { openRowMenu } from '../test/rowMenu';
import { acceptConfirm, cancelConfirm } from '../test/confirmDialog';
import type { Coach, Folder, Quiz } from '../api/types';

const currentCoach: Coach = {
  id: 1,
  username: 'coach1',
  email: 'coach1@example.com',
  organization: 'Wildcats',
  organization_id: 1,
  role: 'member',
  is_platform_owner: false,
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
    registerWithBetaInvite: vi.fn(),
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

    await openRowMenu(user, 'Week 1 Prep');
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

    await waitFor(() => expect(duplicateSpy).toHaveBeenCalledWith(1));
  });

  it('asks for confirmation before deleting, and does nothing if declined', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    const deleteSpy = vi.spyOn(quizzesApi, 'deleteQuiz').mockResolvedValue(undefined);
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    await openRowMenu(user, 'Week 1 Prep');
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

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

    await openRowMenu(user, 'Week 1 Prep');
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await acceptConfirm(user, 'Delete Quiz');

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith(1));
  });

  it('renders a flat list with no folder sections when the coach has no folders', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    renderDashboard();

    await screen.findByText('Week 1 Prep');
    expect(screen.queryByText('Uncategorized')).not.toBeInTheDocument();
    // Opened first: an assertion that a control is absent proves nothing if
    // it is merely behind a closed menu.
    await openRowMenu(userEvent.setup(), 'Week 1 Prep');
    expect(screen.queryByLabelText(/Move ".*" to folder/)).not.toBeInTheDocument();
  });

  it('KEEPS A FOLDER’S QUIZZES OFF THE DASHBOARD', async () => {
    // THE WHOLE POINT OF THIS SCREEN. Folders used to unfold here and render
    // every quiz inside them, so a coach with a hundred quizzes met all
    // hundred at once. A folder is now a row you go into.
    const foldered: Quiz = { ...sampleQuiz, id: 2, title: 'Defense Install', folder_id: 10 };
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz, foldered]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder]);
    renderDashboard();

    // The loose quiz is here; the filed one is not.
    await screen.findByText('Week 1 Prep');
    expect(screen.queryByText('Defense Install')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Uncategorized/).length).toBeGreaterThan(0);
  });

  it('makes the folder a link into itself, counting the whole tree', async () => {
    const foldered: Quiz = { ...sampleQuiz, id: 2, title: 'Defense Install', folder_id: 10 };
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz, foldered]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder]);
    renderDashboard();

    const link = await screen.findByRole('link', { name: /Fall Camp/ });
    expect(link).toHaveAttribute('href', '/folders/10');
    // The count is why a coach can decide whether to go in without going in.
    expect(link).toHaveTextContent('1');
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

    await openRowMenu(user, 'Week 1 Prep');
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
    // The quiz is inside the folder now, so it is NOT on this screen - wait
    // for the folder row instead.
    await screen.findByRole('link', { name: /Fall Camp/ });

    // Rename and Delete were two permanent buttons on every folder row; they
    // are now in the same "..." menu a quiz card uses.
    await user.click(screen.getByRole('button', { name: 'Folder options for Fall Camp' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete folder' }));
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

  it('SHOWS ONLY ROOT FOLDERS, WHATEVER THE DEPTH', async () => {
    // The dashboard is the library, not the whole shelf. A subfolder is
    // reached by opening its parent, which is what keeps this screen the same
    // size for a coach with three folders and one with a five-deep season.
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder, sampleSubfolder]);
    renderDashboard();

    await screen.findByRole('link', { name: /Fall Camp/ });
    // No quizzes in this case on purpose: a QuizCard is itself a link, so a
    // loose "Week 1 Prep" would match a folder-name pattern and prove nothing.
    expect(screen.queryByRole('link', { name: /Week 1/ })).not.toBeInTheDocument();
  });

  it('STAYS THE SAME HEIGHT AS A SEASON GETS DEEPER', async () => {
    // Five levels and a quiz at the bottom used to render as five nested
    // sections plus the quiz. It is now one row.
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

    const root = await screen.findByRole('link', { name: /2026 Season/ });
    // The count still tells the truth about what is down there.
    expect(root).toHaveTextContent('1');
    for (const buried of ['Week 3', 'Defense', 'Redzone', 'Install Quizzes']) {
      expect(screen.queryByRole('link', { name: new RegExp(buried) })).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Deep Install')).not.toBeInTheDocument();
  });

  it('renames a folder in place from its menu', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder]);
    const renameSpy = vi.spyOn(foldersApi, 'renameFolder').mockResolvedValue(sampleFolder);
    renderDashboard();
    await screen.findByRole('link', { name: /Fall Camp/ });

    await user.click(screen.getByRole('button', { name: 'Folder options for Fall Camp' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByLabelText('Rename folder "Fall Camp"');
    await user.clear(input);
    await user.type(input, 'Spring Camp');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(renameSpy).toHaveBeenCalledWith(10, { name: 'Spring Camp' }),
    );
  });

  it('REFUSES TO DELETE A FOLDER THAT STILL HAS FOLDERS, AND SAYS WHY', async () => {
    // The API returns 422 for this. Offering it anyway meant a confirmation
    // promising the quizzes would move to Uncategorized, then an error.
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    vi.mocked(foldersApi.listFolders).mockResolvedValue([sampleFolder, sampleSubfolder]);
    renderDashboard();
    await screen.findByRole('link', { name: /Fall Camp/ });

    await user.click(screen.getByRole('button', { name: 'Folder options for Fall Camp' }));

    expect(screen.getByRole('menuitem', { name: /empty its folders first/ })).toBeDisabled();
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
    await openRowMenu(user, 'Week 1 Prep');
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

    await openRowMenu(user, 'Week 1 Prep');
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

    // The permissions are unchanged; only where the actions live has moved.
    await openRowMenu(userEvent.setup(), "Jones's quiz");
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/to folder/)).not.toBeInTheDocument();
    // Duplicating a teammate's quiz is always allowed - the copy is yours.
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
  });

  it('lets an admin edit a teammate\'s quiz', async () => {
    const teammates: Quiz = { ...sampleQuiz, id: 2, coach_id: 99, created_by_username: 'coach_jones' };
    mockAuth({ role: 'admin' });
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([teammates]);
    renderDashboard();

    await screen.findByText('Week 1 Prep');
    await openRowMenu(userEvent.setup(), 'Week 1 Prep');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('does not label or restrict the coach\'s own quiz', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    renderDashboard();

    await screen.findByText('Week 1 Prep');
    expect(screen.queryByText(/by coach1/)).not.toBeInTheDocument();
    await openRowMenu(userEvent.setup(), 'Week 1 Prep');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('falls back gracefully when the creator has left the organization', async () => {
    const orphaned: Quiz = { ...sampleQuiz, id: 3, coach_id: null, created_by_username: null };
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([orphaned]);
    renderDashboard();

    await screen.findByText('Week 1 Prep');
    expect(screen.getByText(/by a former coach/)).toBeInTheDocument();
  });
});
