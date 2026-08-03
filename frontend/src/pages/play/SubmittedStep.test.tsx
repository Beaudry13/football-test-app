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

  it('shows the Trial Complete celebration immediately, then fades it after a few seconds', async () => {
    vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue(results);
    render(<SubmittedStep code="ABC123" playerName="Jordan Smith" />);

    // Present right away - this step only ever mounts after a real,
    // already-successful submission, so there's nothing to "simulate" here.
    expect(screen.getByText('Trial Complete')).toBeInTheDocument();
    expect(await screen.findByText('Results for Jordan Smith')).toBeInTheDocument();
    // The real results are already visible underneath the celebration -
    // it's a brief overlay, not something blocking access to the results.

    await vi.advanceTimersByTimeAsync(1800);

    await waitFor(() => expect(screen.queryByText('Trial Complete')).not.toBeInTheDocument());
    expect(screen.getByText('Results for Jordan Smith')).toBeInTheDocument();
  });

  it('shows the real error, not a raw one, when results fail to load', async () => {
    vi.spyOn(playApi, 'getPlayerResults').mockRejectedValue(new Error('Could not reach the server.'));
    render(<SubmittedStep code="ABC123" playerName="Jordan Smith" />);

    expect(await screen.findByText('Could not reach the server.')).toBeInTheDocument();
  });
});
