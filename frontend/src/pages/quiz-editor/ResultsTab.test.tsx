import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultsTab } from './ResultsTab';
import * as gradingApi from '../../api/grading';
import * as downloadUtil from '../../utils/download';
import type { Quiz, QuizDashboard } from '../../api/types';

const sampleQuiz: Quiz = {
  id: 1,
  coach_id: 1,
  title: 'Week 1 Prep!',
  description: null,
  one_question_at_a_time: true,
  folder_id: null,
  question_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

const sampleDashboard: QuizDashboard = {
  quiz_id: 1,
  roster_size: 2,
  response_count: 1,
  response_rate: 0.5,
  question_breakdown: [],
};

function renderResultsTab() {
  render(<ResultsTab quiz={sampleQuiz} />);
}

describe('ResultsTab exports', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(sampleDashboard);
    vi.spyOn(gradingApi, 'listResponses').mockResolvedValue([]);
    vi.spyOn(downloadUtil, 'downloadBlob').mockImplementation(() => {});
  });

  it('exports CSV with a slugified filename derived from the quiz title', async () => {
    const user = userEvent.setup();
    const csvBlob = new Blob(['player,question'], { type: 'text/csv' });
    const exportSpy = vi.spyOn(gradingApi, 'exportResultsCsv').mockResolvedValue(csvBlob);
    renderResultsTab();

    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledWith(1));
    expect(downloadUtil.downloadBlob).toHaveBeenCalledWith(csvBlob, 'week-1-prep-results.csv');
  });

  it('exports PDF and disables both buttons while the request is in flight', async () => {
    const user = userEvent.setup();
    let resolveExport!: (blob: Blob) => void;
    vi.spyOn(gradingApi, 'exportResultsPdf').mockReturnValue(
      new Promise((resolve) => {
        resolveExport = resolve;
      }),
    );
    renderResultsTab();

    const pdfButton = await screen.findByRole('button', { name: 'Export PDF' });
    const csvButton = screen.getByRole('button', { name: 'Export CSV' });
    await user.click(pdfButton);

    expect(await screen.findByRole('button', { name: 'Exporting…' })).toBeInTheDocument();
    expect(csvButton).toBeDisabled();

    resolveExport(new Blob(['%PDF-'], { type: 'application/pdf' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Export PDF' })).not.toBeDisabled());
  });

  it('shows an error banner when the export request fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(gradingApi, 'exportResultsCsv').mockRejectedValue(new Error('Request failed'));
    renderResultsTab();

    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));

    expect(await screen.findByText('Request failed')).toBeInTheDocument();
    expect(downloadUtil.downloadBlob).not.toHaveBeenCalled();
  });
});
