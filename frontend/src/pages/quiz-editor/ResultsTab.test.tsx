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
    registerWithBetaInvite: vi.fn(),
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
  concept_breakdown: [],
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

describe('the stats row when the roster denominator is gone', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(gradingApi, 'listResponses').mockResolvedValue([]);
  });

  it('reports the responses and DROPS the two stats that would lie', async () => {
    /* roster_size is who is eligible under the quiz's currently active code,
       so it falls to 0 once that code expires - while response_count keeps
       every submission the quiz ever received. This tab used to print
       "Roster size 0" and "Response rate 0%" over a quiz players finished. */
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue({
      quiz_id: 1,
      roster_size: 0,
      response_count: 17,
      response_rate: null,
      missing_players: [],
      question_breakdown: [],
  concept_breakdown: [],
    });
    renderResultsTab();

    // The LABELS stay - a dash that says what is unavailable beats a card
    // that silently vanishes. Only the fabricated numbers go.
    expect(await screen.findByText('Responses')).toBeInTheDocument();
    expect(screen.getByText('17')).toBeInTheDocument();
    expect(screen.getByText('Roster size')).toBeInTheDocument();
    expect(screen.getByText('Response rate')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('keeps both stats whenever the roster is real', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(sampleDashboard);
    renderResultsTab();

    expect(await screen.findByText('Roster size')).toBeInTheDocument();
    expect(screen.getByText('Response rate')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });
});

describe('Results leads with what to teach next', () => {
  const conceptRow = {
    concept_id: 1,
    concept_name: 'Force / Contain',
    question_count: 2,
    correct_count: 16,
    incorrect_count: 6,
    ungraded_count: 0,
    graded_count: 22,
    miss_rate: 27.3,
    has_enough_responses: true,
    players_missed: [
      { player_name: 'Jordan Smith', display_name: 'Jordan Smith', position_at_attempt: 'CB' },
    ],
    top_distractor: { option_text: 'Safety', count: 5, of_misses: 6 },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(gradingApi, 'listResponses').mockResolvedValue([]);
  });

  it('puts the weakest concept ABOVE the averages, and keeps the averages', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue({
      ...sampleDashboard,
      concept_breakdown: [conceptRow],
    });
    renderResultsTab();

    expect(await screen.findByText('Teach next')).toBeInTheDocument();
    expect(screen.getByText('Force / Contain')).toBeInTheDocument();
    // Demoted, NOT deleted - this is how a coach checks the claim above it.
    expect(screen.getByText('Responses')).toBeInTheDocument();
    expect(screen.getByText('Response rate')).toBeInTheDocument();
  });

  it('FALLS BACK to ordinary Results when nothing is tagged', async () => {
    // Every quiz that predates concept tagging is in this state.
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue({
      ...sampleDashboard,
      concept_breakdown: [],
    });
    renderResultsTab();

    expect(await screen.findByText('Responses')).toBeInTheDocument();
    expect(screen.queryByText('Teach next')).not.toBeInTheDocument();
  });

  it('surfaces ungraded answers as an ACTION, only when there are some', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue({
      ...sampleDashboard,
      concept_breakdown: [],
      question_breakdown: [
        {
          question_id: 1,
          question_number: 1,
          question_text: 'Describe your assignment.',
          question_type: 'written',
          answered_count: 5,
          correct_count: 2,
          incorrect_count: 0,
          ungraded_count: 3,
          is_excluded: false,
          exclusions: [],
        },
      ],
    });
    renderResultsTab();

    expect(await screen.findByText(/3 answers need grading/)).toBeInTheDocument();
    // And it says what that means, rather than letting a coach assume wrong.
    expect(screen.getByText(/not counted right or wrong/)).toBeInTheDocument();
  });

  it('says nothing about grading when there is nothing to grade', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue({
      ...sampleDashboard,
      concept_breakdown: [],
    });
    renderResultsTab();

    await screen.findByText('Responses');
    expect(screen.queryByText(/need(s)? grading/)).not.toBeInTheDocument();
  });

  it('keeps the per-question detail reachable, including untagged questions', async () => {
    vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue({
      ...sampleDashboard,
      concept_breakdown: [conceptRow],
      question_breakdown: [
        {
          question_id: 1,
          question_number: 1,
          question_text: 'An untagged legacy question',
          question_type: 'true_false',
          answered_count: 4,
          correct_count: 4,
          incorrect_count: 0,
          ungraded_count: 0,
          is_excluded: false,
          exclusions: [],
          concept: null,
        },
      ],
    });
    renderResultsTab();

    // Untagged questions do not RANK, but they must not disappear either.
    expect(await screen.findByText('Per-question breakdown')).toBeInTheDocument();
    expect(screen.getByText('An untagged legacy question')).toBeInTheDocument();
  });
});
