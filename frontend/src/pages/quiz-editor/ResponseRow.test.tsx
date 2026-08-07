import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResponseRow } from './ResponseRow';
import * as gradingApi from '../../api/grading';
import * as authContext from '../../auth/AuthContext';
import { acceptConfirm, cancelConfirm } from '../../test/confirmDialog';
import type { Coach, PlayerResponse, Quiz } from '../../api/types';

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
  question_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const sampleResponse: PlayerResponse = {
  id: 7,
  quiz_id: 1,
  access_code_id: 9,
  player_name: 'Jordan Smith',
  display_name: 'Jordan Smith',
  submitted_at: '2026-01-01T00:05:00Z',
  answers: [],
};

function renderRow(overrides: Partial<PlayerResponse> = {}) {
  render(
    <MemoryRouter>
      <ResponseRow quiz={sampleQuiz} response={{ ...sampleResponse, ...overrides }} onChanged={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('ResponseRow player name display', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the canonical Player's current display_name, not the historical player_name snapshot", () => {
    mockAuth({ id: 1 });
    renderRow({ player_name: 'Chris Smith', display_name: 'Christopher Smith-Jones' });

    expect(screen.getByRole('link', { name: 'Christopher Smith-Jones' })).toBeInTheDocument();
    expect(screen.queryByText('Chris Smith')).not.toBeInTheDocument();
  });

  it("still shows a legacy attempt's player_name when no canonical Player is linked", () => {
    mockAuth({ id: 1 });
    renderRow({ player_name: 'Jordan Legacy', display_name: 'Jordan Legacy' });

    expect(screen.getByRole('link', { name: 'Jordan Legacy' })).toBeInTheDocument();
  });
});

describe('ResponseRow reset attempt', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows Reset attempt to the quiz's creator", () => {
    mockAuth({ id: 1 });
    renderRow();
    expect(screen.getByRole('button', { name: 'Reset attempt' })).toBeInTheDocument();
  });

  it('shows Reset attempt to an org admin, even if not the creator', () => {
    mockAuth({ id: 99, role: 'admin' });
    renderRow();
    expect(screen.getByRole('button', { name: 'Reset attempt' })).toBeInTheDocument();
  });

  it('hides Reset attempt from a teammate who is neither creator nor admin', () => {
    mockAuth({ id: 99, role: 'member' });
    renderRow();
    expect(screen.queryByRole('button', { name: 'Reset attempt' })).not.toBeInTheDocument();
  });

  it('does nothing if the confirmation is declined', async () => {
    const user = userEvent.setup();
    mockAuth({ id: 1 });
    const resetSpy = vi.spyOn(gradingApi, 'resetAttempt');
    renderRow();

    await user.click(screen.getByRole('button', { name: 'Reset attempt' }));
    await cancelConfirm(user);

    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('resets the attempt once confirmed and refreshes the list', async () => {
    const user = userEvent.setup();
    mockAuth({ id: 1 });
    const resetSpy = vi.spyOn(gradingApi, 'resetAttempt').mockResolvedValue(undefined);
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <ResponseRow quiz={sampleQuiz} response={sampleResponse} onChanged={onChanged} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Reset attempt' }));
    await acceptConfirm(user, 'Reset Attempt');

    await waitFor(() => expect(resetSpy).toHaveBeenCalledWith(1, 7));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('shows an error and re-enables the button if the reset request fails', async () => {
    const user = userEvent.setup();
    mockAuth({ id: 1 });
    vi.spyOn(gradingApi, 'resetAttempt').mockRejectedValue(new Error('Request failed'));
    renderRow();

    await user.click(screen.getByRole('button', { name: 'Reset attempt' }));
    await acceptConfirm(user, 'Reset Attempt');

    expect(await screen.findByText('Request failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset attempt' })).not.toBeDisabled();
  });
});


// --- Draw Response in Results ------------------------------------------
//
// Phase 3's other half: the drawing has to reach the coach's screen, clearly
// attributed to the player who drew it. The viewer builds a Fabric
// StaticCanvas jsdom cannot back, so it is stubbed - these cover which
// component ResponseRow chooses and what it hands over, not the rendering.
vi.mock('../../components/drawing/DrawingViewer', () => ({
  DrawingViewer: (props: { imageUrl: string; alt: string }) => (
    <div data-testid="drawing-viewer" data-image-url={props.imageUrl} aria-label={props.alt} />
  ),
}));

const DRAWN_DOC = {
  format: 'peira.drawing',
  version: 1,
  source: { image_id: '7', image_version: null, natural_width: 1600, natural_height: 1000 },
  coordinate_width: 1400,
  coordinate_height: 875,
  strokes: [
    { id: 'a', tool: 'pen', layer: 'player', points: [0, 0, 9, 9], color: '#00E5FF', width: 6, order: 0 },
  ],
};

const drawQuiz: Quiz = {
  ...sampleQuiz,
  question_count: 1,
  questions: [
    {
      id: 5,
      quiz_id: 1,
      question_text: 'Draw your run fit',
      question_type: 'draw_response',
      position: 0,
      options: [],
      image: {
        id: 7,
        question_id: 5,
        image_url: '/uploads/still.png',
        annotations: [],
        canvas_width: 1400,
        updated_at: '2026-08-07T00:00:00Z',
      },
    },
  ],
};

function drawAnswer(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    question_id: 5,
    answer_text: null,
    selected_option_id: null,
    is_correct: null,
    coach_feedback: null,
    graded_at: null,
    graded_by_username: null,
    drawing: {
      id: 1,
      answer_id: 1,
      document: DRAWN_DOC,
      revision: 2,
      preview_url: null,
      updated_at: '2026-08-07T00:00:00Z',
    },
    ...overrides,
  };
}

async function renderDrawRow(answer: Record<string, unknown>, quiz: Quiz = drawQuiz) {
  render(
    <MemoryRouter>
      <ResponseRow
        quiz={quiz}
        response={{ ...sampleResponse, answers: [answer as never] }}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  // A response row starts collapsed; the answers - and so any drawing - only
  // exist once a coach opens it.
  await userEvent.click(screen.getByLabelText(/Expand answers/));
}

describe('Draw Response in Results', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAuth({ id: 1 });
  });

  it('renders the submitted drawing over the question image', async () => {
    await renderDrawRow(drawAnswer());

    const viewer = screen.getByTestId('drawing-viewer');
    expect(viewer).toBeInTheDocument();
    expect(viewer.getAttribute('data-image-url')).toContain('/uploads/still.png');
  });

  it('names the question in the drawing label, so a coach can tell them apart', async () => {
    await renderDrawRow(drawAnswer());

    expect(screen.getByLabelText('Drawing submitted for: Draw your run fit')).toBeInTheDocument();
  });

  it('says so plainly when the player drew nothing', async () => {
    await renderDrawRow(drawAnswer({ drawing: null }));

    expect(screen.queryByTestId('drawing-viewer')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing drawn')).toBeInTheDocument();
  });

  it('shows no drawing viewer on an ordinary question', async () => {
    const writtenQuiz: Quiz = {
      ...sampleQuiz,
      question_count: 1,
      questions: [
        {
          id: 9,
          quiz_id: 1,
          question_text: 'Describe your fit',
          question_type: 'written',
          position: 0,
          options: [],
          image: null,
        },
      ],
    };
    await renderDrawRow(
      { ...drawAnswer({ drawing: null }), question_id: 9, answer_text: 'I set the edge.' },
      writtenQuiz,
    );

    expect(screen.queryByTestId('drawing-viewer')).not.toBeInTheDocument();
    expect(screen.getByText('I set the edge.')).toBeInTheDocument();
  });
});
