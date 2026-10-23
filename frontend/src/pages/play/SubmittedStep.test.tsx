import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubmittedStep } from './SubmittedStep';
import * as playApi from '../../api/play';
import type { PlayerResultsResponse } from '../../api/types';

const results: PlayerResultsResponse = {
  quiz_title: 'Week 1 Prep',
  player_name: 'Jordan Smith',
  submitted_at: '2026-01-01T00:05:00Z',
  answers: [],
};

describe('SubmittedStep', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the Quiz submitted celebration immediately, then fades it after a few seconds', async () => {
    vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue(results);
    render(<MemoryRouter><SubmittedStep code="ABC123" playerName="Jordan Smith" playerId={undefined} /></MemoryRouter>);

    // Present right away - this step only ever mounts after a real,
    // already-successful submission, so there's nothing to "simulate" here.
    expect(screen.getByText('Quiz submitted')).toBeInTheDocument();
    expect(await screen.findByText('Results for Jordan Smith')).toBeInTheDocument();
    // The real results are already visible underneath the celebration -
    // it's a brief overlay, not something blocking access to the results.

    await vi.advanceTimersByTimeAsync(1800);

    await waitFor(() => expect(screen.queryByText('Quiz submitted')).not.toBeInTheDocument());
    expect(screen.getByText('Results for Jordan Smith')).toBeInTheDocument();
  });

  it('says his answers are in, shows the real error, and offers Try again and Done when results fail to load', async () => {
    vi.spyOn(playApi, 'getPlayerResults').mockRejectedValue(new Error('Could not reach the server.'));
    render(<MemoryRouter><SubmittedStep code="ABC123" playerName="Jordan Smith" playerId={undefined} /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Your answers are in.' })).toBeInTheDocument();
    expect(screen.getByText(/Could not reach the server\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Done' })).toHaveAttribute('href', '/play');
  });

  it('ends on Done - back to his work - once the results are up', async () => {
    vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue({
      player_name: 'Jordan Smith',
      quiz_title: 'Week 7',
      total_questions: 0,
      correct_count: 0,
      graded_count: 0,
      answers: [],
    } as never);
    render(<MemoryRouter><SubmittedStep code="ABC123" playerName="Jordan Smith" playerId={undefined} /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'Done' })).toHaveAttribute('href', '/play');
  });

  it('passes playerId to the results lookup and into the bookmark link, so two same-name players never collide', async () => {
    const resultsSpy = vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue({
      ...results,
      player_name: 'Chris Smith',
    });
    render(<MemoryRouter><SubmittedStep code="ABC123" playerName="Chris Smith" playerId={501} /></MemoryRouter>);

    await waitFor(() => expect(resultsSpy).toHaveBeenCalledWith('ABC123', 'Chris Smith', 501));
    await vi.advanceTimersByTimeAsync(1800);

    expect(await screen.findByRole('link', { name: 'this link' })).toHaveAttribute(
      'href',
      '/results/ABC123/Chris%20Smith?player_id=501',
    );
  });
});
