import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderPage } from './FolderPage';
import { DashboardPage } from './DashboardPage';
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

const root: Folder = {
  id: 10,
  organization_id: 1,
  coach_id: 1,
  name: '2026 Season',
  parent_folder_id: null,
  quiz_count: 0,
  subfolder_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const subfolder: Folder = {
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

const quizInSubfolder: Quiz = {
  id: 1,
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Install Quiz',
  description: null,
  one_question_at_a_time: true,
  require_all_answers: false,
  folder_id: 20,
  question_count: 3,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

function renderAtFolder(folderId: number) {
  render(
    <MemoryRouter initialEntries={[`/folders/${folderId}`]}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/folders/:folderId" element={<FolderPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('FolderPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(quizzesApi, 'getActiveStatus').mockResolvedValue([]);
    mockAuth();
  });

  it('shows a loading state, then the subfolder name and its quizzes - direct navigation, no accordion required first', async () => {
    vi.spyOn(foldersApi, 'listFolders').mockResolvedValue([root, subfolder]);
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([quizInSubfolder]);
    renderAtFolder(20);

    expect(await screen.findByRole('heading', { name: 'Week 1' })).toBeInTheDocument();
    expect(await screen.findByText('Install Quiz')).toBeInTheDocument();
  });

  it('shows the breadcrumb back to the parent root folder', async () => {
    vi.spyOn(foldersApi, 'listFolders').mockResolvedValue([root, subfolder]);
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([quizInSubfolder]);
    renderAtFolder(20);

    const back = await screen.findByRole('link', { name: '← Back to 2026 Season' });
    expect(back).toHaveAttribute('href', '/');
  });

  it('shows an empty-subfolder state distinct from an empty-roster message', async () => {
    vi.spyOn(foldersApi, 'listFolders').mockResolvedValue([root, subfolder]);
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    renderAtFolder(20);

    expect(await screen.findByText('No Peiras in this folder yet.')).toBeInTheDocument();
  });

  it('renames a subfolder', async () => {
    const user = userEvent.setup();
    vi.spyOn(foldersApi, 'listFolders').mockResolvedValue([root, subfolder]);
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([quizInSubfolder]);
    const renameSpy = vi
      .spyOn(foldersApi, 'renameFolder')
      .mockResolvedValue({ ...subfolder, name: 'Week 1 - Install' });
    renderAtFolder(20);

    const input = await screen.findByLabelText('Folder name');
    await user.clear(input);
    await user.type(input, 'Week 1 - Install');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(renameSpy).toHaveBeenCalledWith(20, { name: 'Week 1 - Install' }));
  });

  it('deletes a subfolder and returns to the dashboard once confirmed', async () => {
    const user = userEvent.setup();
    vi.spyOn(foldersApi, 'listFolders').mockResolvedValue([root, subfolder]);
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([quizInSubfolder]);
    const deleteSpy = vi.spyOn(foldersApi, 'deleteFolder').mockResolvedValue(undefined);
    renderAtFolder(20);

    await screen.findByRole('heading', { name: 'Week 1' });
    await user.click(screen.getByRole('button', { name: 'Delete folder' }));
    await acceptConfirm(user, 'Delete Folder');

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith(20));
    expect(await screen.findByRole('heading', { name: 'Your Trials' })).toBeInTheDocument();
  });

  it('does nothing if the delete confirmation is declined', async () => {
    const user = userEvent.setup();
    vi.spyOn(foldersApi, 'listFolders').mockResolvedValue([root, subfolder]);
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([quizInSubfolder]);
    const deleteSpy = vi.spyOn(foldersApi, 'deleteFolder').mockResolvedValue(undefined);
    renderAtFolder(20);

    await screen.findByRole('heading', { name: 'Week 1' });
    await user.click(screen.getByRole('button', { name: 'Delete folder' }));
    await cancelConfirm(user);

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Week 1' })).toBeInTheDocument();
  });

  it('shows a friendly message, not a raw error, for a folder that no longer exists (stale/deleted-folder URL)', async () => {
    vi.spyOn(foldersApi, 'listFolders').mockResolvedValue([root]); // 20 already deleted by a teammate
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    renderAtFolder(20);

    expect(await screen.findByText('This folder no longer exists.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to Dashboard' })).toHaveAttribute('href', '/');
  });

  it('shows a friendly message, not a raw error, when the folder list fails to load', async () => {
    vi.spyOn(foldersApi, 'listFolders').mockRejectedValue(new Error('Could not reach the server.'));
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    renderAtFolder(20);

    expect(await screen.findByText('Could not reach the server.')).toBeInTheDocument();
  });

  it('moves a quiz out of the subfolder back to root via the per-card select', async () => {
    const user = userEvent.setup();
    vi.spyOn(foldersApi, 'listFolders').mockResolvedValue([root, subfolder]);
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([quizInSubfolder]);
    const updateSpy = vi.spyOn(quizzesApi, 'updateQuiz').mockResolvedValue(quizInSubfolder);
    renderAtFolder(20);

    await screen.findByText('Install Quiz');
    const select = screen.getByLabelText('Move "Install Quiz" to folder');
    await user.selectOptions(select, '2026 Season');

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(1, { folder_id: 10 }));
  });
});
