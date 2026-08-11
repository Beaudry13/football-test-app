import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultsTab } from './ResultsTab';
import * as gradingApi from '../../api/grading';
import * as downloadUtil from '../../utils/download';
import * as authContext from '../../auth/AuthContext';
import type { Coach, PlayerResponse, Quiz, QuizDashboard } from '../../api/types';

/** ResponseRow (rendered once a response is expanded) reads the signed-in
 * coach to decide whether to show the "Reset attempt" button. */
function mockAuth() {
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
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    coach: currentCoach,
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
  title: 'Week 1 Prep!',
  description: null,
  one_question_at_a_time: true,
  require_all_answers: false,
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
  missing_players: [],
  question_breakdown: [],
};

function renderResultsTab(quiz: Quiz = sampleQuiz) {
  render(
    <MemoryRouter>
      <ResultsTab quiz={quiz} />
    </MemoryRouter>,
  );
}

describe('ResultsTab exports', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(sampleDashboard);
    vi.spyOn(gradingApi, 'listResponses').mockResolvedValue([]);
    vi.spyOn(downloadUtil, 'downloadBlob').mockImplementation(() => {});
  });

  it('exports the Detailed PDF (primary) with a slugified filename derived from the quiz title', async () => {
    const user = userEvent.setup();
    const pdfBlob = new Blob(['%PDF-'], { type: 'application/pdf' });
    const exportSpy = vi.spyOn(gradingApi, 'exportResultsDetailedPdf').mockResolvedValue(pdfBlob);
    renderResultsTab();

    await user.click(await screen.findByRole('button', { name: 'Detailed PDF' }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledWith(1));
    expect(downloadUtil.downloadBlob).toHaveBeenCalledWith(pdfBlob, 'week-1-prep-detailed-results.pdf');
  });

  it('exports the Summary PDF with a slugified filename derived from the quiz title', async () => {
    const user = userEvent.setup();
    const pdfBlob = new Blob(['%PDF-'], { type: 'application/pdf' });
    const exportSpy = vi.spyOn(gradingApi, 'exportResultsPdf').mockResolvedValue(pdfBlob);
    renderResultsTab();

    await user.click(await screen.findByRole('button', { name: 'Summary PDF' }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledWith(1));
    expect(downloadUtil.downloadBlob).toHaveBeenCalledWith(pdfBlob, 'week-1-prep-summary-results.pdf');
  });

  it('exports CSV with a slugified filename derived from the quiz title', async () => {
    const user = userEvent.setup();
    const csvBlob = new Blob(['player,question'], { type: 'text/csv' });
    const exportSpy = vi.spyOn(gradingApi, 'exportResultsCsv').mockResolvedValue(csvBlob);
    renderResultsTab();

    await user.click(await screen.findByRole('button', { name: 'CSV' }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledWith(1));
    expect(downloadUtil.downloadBlob).toHaveBeenCalledWith(csvBlob, 'week-1-prep-results.csv');
  });

  it('exports and disables every export button while the request is in flight', async () => {
    const user = userEvent.setup();
    let resolveExport!: (blob: Blob) => void;
    vi.spyOn(gradingApi, 'exportResultsDetailedPdf').mockReturnValue(
      new Promise((resolve) => {
        resolveExport = resolve;
      }),
    );
    renderResultsTab();

    const detailedButton = await screen.findByRole('button', { name: 'Detailed PDF' });
    const csvButton = screen.getByRole('button', { name: 'CSV' });
    await user.click(detailedButton);

    expect(await screen.findByRole('button', { name: 'Exporting…' })).toBeInTheDocument();
    expect(csvButton).toBeDisabled();

    resolveExport(new Blob(['%PDF-'], { type: 'application/pdf' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Detailed PDF' })).not.toBeDisabled());
  });

  it('shows an error banner when the export request fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(gradingApi, 'exportResultsCsv').mockRejectedValue(new Error('Request failed'));
    renderResultsTab();

    await user.click(await screen.findByRole('button', { name: 'CSV' }));

    expect(await screen.findByText('Request failed')).toBeInTheDocument();
    expect(downloadUtil.downloadBlob).not.toHaveBeenCalled();
  });

  it('lists roster players who have not submitted yet', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue({
      ...sampleDashboard,
      missing_players: ['Alex Lee', 'Sam Park'],
    });
    renderResultsTab();

    expect(await screen.findByText("Haven't submitted yet (2)")).toBeInTheDocument();
    expect(screen.getByText('Alex Lee')).toBeInTheDocument();
    expect(screen.getByText('Sam Park')).toBeInTheDocument();
  });

  it('omits the missing-players card once everyone has submitted', async () => {
    renderResultsTab();

    await screen.findByRole('button', { name: 'CSV' });
    expect(screen.queryByText(/Haven't submitted yet/)).not.toBeInTheDocument();
  });

  it('shows who graded an answer once graded_by_username is present', async () => {
    mockAuth();
    const user = userEvent.setup();
    const quizWithQuestion: Quiz = {
      ...sampleQuiz,
      questions: [
        {
          id: 10,
          quiz_id: 1,
          question_text: 'Describe your assignment.',
          question_type: 'written',
          position: 0,
          options: [],
          image: null,
        },
      ],
    };
    const response: PlayerResponse = {
      id: 100,
      quiz_id: 1,
      access_code_id: 5,
      player_name: 'Jordan Smith',
      display_name: 'Jordan Smith',
      submitted_at: '2026-01-05T00:00:00Z',
      answers: [
        {
          id: 200,
          question_id: 10,
          answer_text: 'I set the edge.',
          selected_option_id: null,
          is_correct: true,
          coach_feedback: 'Nice work.',
          graded_at: '2026-01-06T00:00:00Z',
          graded_by_username: 'coach_amy',
        },
      ],
    };
    vi.spyOn(gradingApi, 'listResponses').mockResolvedValue([response]);
    renderResultsTab(quizWithQuestion);

    await user.click(await screen.findByRole('button', { name: /Expand answers for/ }));

    expect(await screen.findByText('Graded by coach_amy')).toBeInTheDocument();
  });

  it('does not show a graded-by line when the answer has not been graded yet', async () => {
    mockAuth();
    const user = userEvent.setup();
    const quizWithQuestion: Quiz = {
      ...sampleQuiz,
      questions: [
        {
          id: 10,
          quiz_id: 1,
          question_text: 'Describe your assignment.',
          question_type: 'written',
          position: 0,
          options: [],
          image: null,
        },
      ],
    };
    const response: PlayerResponse = {
      id: 100,
      quiz_id: 1,
      access_code_id: 5,
      player_name: 'Jordan Smith',
      display_name: 'Jordan Smith',
      submitted_at: '2026-01-05T00:00:00Z',
      answers: [
        {
          id: 200,
          question_id: 10,
          answer_text: 'I set the edge.',
          selected_option_id: null,
          is_correct: null,
          coach_feedback: null,
          graded_at: null,
          graded_by_username: null,
        },
      ],
    };
    vi.spyOn(gradingApi, 'listResponses').mockResolvedValue([response]);
    renderResultsTab(quizWithQuestion);

    await user.click(await screen.findByRole('button', { name: /Expand answers for/ }));

    expect(await screen.findByText('I set the edge.')).toBeInTheDocument();
    expect(screen.queryByText(/Graded by/)).not.toBeInTheDocument();
  });
});
