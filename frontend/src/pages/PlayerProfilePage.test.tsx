import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerProfilePage } from './PlayerProfilePage';
import * as playersApi from '../api/players';
import * as groupsApi from '../api/groups';
import { acceptConfirm } from '../test/confirmDialog';
import type { Player, PlayerHistory } from '../api/types';

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 1,
    organization_id: 1,
    first_name: 'Jordan',
    last_name: 'Lee',
    full_name: 'Jordan Lee',
    jersey_number: '12',
    position: 'WR',
    photo_url: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeHistory(overrides: Partial<PlayerHistory> = {}): PlayerHistory {
  return {
    player: makePlayer(),
    current_groups: [],
    assigned_count: 3,
    completed_count: 2,
    completion_percent: 67,
    average_score_percent: 85,
    recent_results: [],
    ...overrides,
  };
}

function renderPage(initialPath = '/roster/1') {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/roster/:playerId" element={<PlayerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PlayerProfilePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and displays the player header, stats, and groups', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({ current_groups: [{ id: 1, name: 'Defense' }] }),
    );
    // The group list the editor offers. Membership itself still comes from
    // the profile payload above. Stubbed BEFORE render - the page loads it in
    // an effect on mount.
    vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([
      { id: 1, name: 'Defense' },
      { id: 2, name: 'Safeties' },
    ] as never);
    renderPage();

    expect(await screen.findByText('Jordan Lee')).toBeInTheDocument();
    expect(screen.getByText('#12 · WR')).toBeInTheDocument();
    // Same fact as before - this player is in Defense - now stated by the
    // control that can change it rather than by a sentence beside it.
    expect(
      await screen.findByRole('button', { name: /Defense/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Safeties/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('85%')).toBeInTheDocument();
  });

  it('shows the inactive badge and a Reactivate action for an inactive player', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({ player: makePlayer({ is_active: false }) }),
    );
    renderPage();

    expect(await screen.findByText('Inactive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('shows an empty-results message when nothing has been completed yet', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(makeHistory());
    renderPage();

    expect(await screen.findByText('No completed Quizzes yet.')).toBeInTheDocument();
  });

  it('lists recent results with score and a pending-grading badge', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
      makeHistory({
        recent_results: [
          {
            quiz_id: 5,
            quiz_title: 'Week 1 Prep',
            attempt_id: 900,
            submitted_at: '2026-01-05T00:00:00Z',
            score_percent: 80,
            graded_answer_count: 4,
            correct_answer_count: 3,
            pending_grading_count: 1,
          },
        ],
      }),
    );
    renderPage();

    expect(await screen.findByRole('link', { name: 'Week 1 Prep' })).toHaveAttribute(
      'href',
      '/quizzes/5?tab=results',
    );
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('1 to grade')).toBeInTheDocument();
  });

  it('edits and saves the player, pre-filled from the loaded profile', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(makeHistory());
    const updateSpy = vi.spyOn(playersApi, 'updatePlayer').mockResolvedValue(makePlayer({ position: 'QB' }));
    renderPage();

    await screen.findByText('Jordan Lee');
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByDisplayValue('Jordan')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Lee')).toBeInTheDocument();
    const positionInput = screen.getByPlaceholderText('Position');
    await user.clear(positionInput);
    await user.type(positionInput, 'QB');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(1, {
        first_name: 'Jordan',
        last_name: 'Lee',
        jersey_number: '12',
        position: 'QB',
      }),
    );
  });

  it('deactivates the player once the confirmation is accepted', async () => {
    const user = userEvent.setup();
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(makeHistory());
    const deactivateSpy = vi.spyOn(playersApi, 'deactivatePlayer').mockResolvedValue(
      makePlayer({ is_active: false }),
    );
    renderPage();

    await screen.findByText('Jordan Lee');
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await acceptConfirm(user, 'Deactivate');

    await waitFor(() => expect(deactivateSpy).toHaveBeenCalledWith(1));
  });

  describe('player photo', () => {
    it('uploads a photo and refreshes the profile with the new photo_url', async () => {
      const user = userEvent.setup();
      const getHistorySpy = vi
        .spyOn(playersApi, 'getPlayerHistory')
        .mockResolvedValueOnce(makeHistory())
        .mockResolvedValueOnce(makeHistory({ player: makePlayer({ photo_url: '/uploads/new.jpg' }) }));
      const uploadSpy = vi
        .spyOn(playersApi, 'uploadPlayerPhoto')
        .mockResolvedValue(makePlayer({ photo_url: '/uploads/new.jpg' }));
      renderPage();

      await screen.findByText('Jordan Lee');
      expect(screen.getByRole('button', { name: 'Add photo' })).toBeInTheDocument();
      const file = new File(['fake-image-bytes'], 'photo.jpg', { type: 'image/jpeg' });
      const input = screen.getByLabelText('Upload player photo', { selector: 'input' });
      await user.upload(input, file);

      await waitFor(() => expect(uploadSpy).toHaveBeenCalledWith(1, file));
      await waitFor(() => expect(getHistorySpy).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole('button', { name: 'Replace photo' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add photo' })).not.toBeInTheDocument();
    });

    it('shows "Replace photo" once the player already has one, and re-uploads through the same control', async () => {
      const user = userEvent.setup();
      vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(
        makeHistory({ player: makePlayer({ photo_url: '/uploads/existing.jpg' }) }),
      );
      const uploadSpy = vi
        .spyOn(playersApi, 'uploadPlayerPhoto')
        .mockResolvedValue(makePlayer({ photo_url: '/uploads/replaced.jpg' }));
      renderPage();

      await screen.findByText('Jordan Lee');
      expect(screen.getByRole('button', { name: 'Replace photo' })).toBeInTheDocument();

      const file = new File(['fake-image-bytes'], 'new-photo.jpg', { type: 'image/jpeg' });
      const input = screen.getByLabelText('Upload player photo', { selector: 'input' });
      await user.upload(input, file);

      await waitFor(() => expect(uploadSpy).toHaveBeenCalledWith(1, file));
    });

    it('shows an error if the photo upload fails, without disrupting the rest of the page', async () => {
      // The rejection here stands in for whatever the server refused it for
      // (bad content, oversized, etc.) - this test is only exercising the
      // error-handling path, not accept-attribute filtering (the browser's
      // own file picker already restricts extensions before a file ever
      // reaches this handler).
      const user = userEvent.setup();
      vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(makeHistory());
      vi.spyOn(playersApi, 'uploadPlayerPhoto').mockRejectedValue(new Error("The uploaded file isn't a valid image"));
      renderPage();

      await screen.findByText('Jordan Lee');
      const file = new File(['not-really-an-image'], 'payload.jpg', { type: 'image/jpeg' });
      const input = screen.getByLabelText('Upload player photo', { selector: 'input' });
      await user.upload(input, file);

      expect(await screen.findByText("The uploaded file isn't a valid image")).toBeInTheDocument();
      expect(screen.getByText('Jordan Lee')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add photo' })).toBeInTheDocument();
    });
  });
});
