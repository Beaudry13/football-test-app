import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveQuizStatusSection } from './ActiveQuizStatus';
import * as quizzesApi from '../api/quizzes';
import type { ActiveQuizStatus } from '../api/types';

const baseEntry: ActiveQuizStatus = {
  quiz_id: 1,
  quiz_title: 'Week 1 Prep',
  access_code_id: 10,
  code: 'ABC123',
  expires_at: new Date(Date.now() + 90 * 60000).toISOString(), // 1h30m from now
  group_names: [],
  roster_size: 2,
  submitted: [{ player_name: 'Jordan Smith', submitted_at: '2026-01-01T00:00:00Z' }],
  in_progress: [{ player_name: 'Alex Lee', started_at: '2026-01-01T00:00:00Z' }],
  not_started: [],
};

function renderSection() {
  render(
    <MemoryRouter>
      <ActiveQuizStatusSection />
    </MemoryRouter>,
  );
}

describe('ActiveQuizStatusSection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when no quiz is active', async () => {
    vi.spyOn(quizzesApi, 'getActiveStatus').mockResolvedValue([]);
    const { container } = render(
      <MemoryRouter>
        <ActiveQuizStatusSection />
      </MemoryRouter>,
    );

    // Wait for the fetch to resolve without asserting on a specific element,
    // since the whole point is that nothing renders.
    await vi.waitFor(() => expect(quizzesApi.getActiveStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the quiz title, submitted count, and pending count', async () => {
    vi.spyOn(quizzesApi, 'getActiveStatus').mockResolvedValue([baseEntry]);
    renderSection();

    expect(await screen.findByText('Week 1 Prep')).toBeInTheDocument();
    expect(screen.getByText('1 submitted')).toBeInTheDocument();
    expect(screen.getByText('1 pending')).toBeInTheDocument();
  });

  it('splits pending into started-but-not-submitted vs never-started', async () => {
    vi.spyOn(quizzesApi, 'getActiveStatus').mockResolvedValue([
      { ...baseEntry, in_progress: [{ player_name: 'Alex Lee', started_at: '2026-01-01T00:00:00Z' }], not_started: ['Sam Rivera'] },
    ]);
    renderSection();

    await screen.findByText('Week 1 Prep');
    expect(screen.getByText('Started, not submitted')).toBeInTheDocument();
    expect(screen.getByText('Alex Lee')).toBeInTheDocument();
    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.getByText('Sam Rivera')).toBeInTheDocument();
  });

  it('shows "Whole roster (N)" when no group is linked', async () => {
    vi.spyOn(quizzesApi, 'getActiveStatus').mockResolvedValue([{ ...baseEntry, group_names: [] }]);
    renderSection();

    expect(await screen.findByText(/Whole roster \(2\)/)).toBeInTheDocument();
  });

  it('shows a single group name when one group is linked', async () => {
    vi.spyOn(quizzesApi, 'getActiveStatus').mockResolvedValue([
      { ...baseEntry, group_names: ['Defense'] },
    ]);
    renderSection();

    expect(await screen.findByText(/Sent to Defense/)).toBeInTheDocument();
  });

  it('comma-joins multiple linked group names', async () => {
    vi.spyOn(quizzesApi, 'getActiveStatus').mockResolvedValue([
      { ...baseEntry, group_names: ['Defense', 'Special Teams'] },
    ]);
    renderSection();

    expect(await screen.findByText(/Sent to Defense, Special Teams/)).toBeInTheDocument();
  });

  it('renders one card per simultaneously active quiz', async () => {
    vi.spyOn(quizzesApi, 'getActiveStatus').mockResolvedValue([
      baseEntry,
      { ...baseEntry, quiz_id: 2, access_code_id: 11, quiz_title: 'Week 2 Prep' },
    ]);
    renderSection();

    expect(await screen.findByText('Week 1 Prep')).toBeInTheDocument();
    expect(screen.getByText('Week 2 Prep')).toBeInTheDocument();
  });

  it('shows an all-caught-up note when nothing is pending', async () => {
    vi.spyOn(quizzesApi, 'getActiveStatus').mockResolvedValue([
      { ...baseEntry, in_progress: [], not_started: [] },
    ]);
    renderSection();

    await screen.findByText('Week 1 Prep');
    expect(screen.getByText('Everyone has submitted.')).toBeInTheDocument();
  });
});
