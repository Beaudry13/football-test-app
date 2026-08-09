import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirstSuccessChecklist } from './FirstSuccessChecklist';
import * as onboardingApi from '../../api/onboarding';
import type { OnboardingProgress, OnboardingStep } from '../../api/onboarding';

const STEP_IDS = [
  'create_quiz',
  'add_question',
  'build_roster',
  'create_group',
  'add_players_to_group',
  'activate_quiz',
  'assign_to_group',
] as const;

const TITLES: Record<string, string> = {
  create_quiz: 'Create your first quiz',
  add_question: 'Add your first question',
  build_roster: 'Build your roster',
  create_group: 'Create your first group',
  add_players_to_group: 'Add players to a group',
  activate_quiz: 'Activate your quiz',
  assign_to_group: 'Assign your quiz to a group',
};

/** Mirrors a real GET /api/onboarding response. `completeIds` decides which
 *  steps are ticked, exactly as the server's derivation would. */
function makeProgress(
  completeIds: string[] = [],
  overrides: Partial<OnboardingProgress> = {},
): OnboardingProgress {
  const steps: OnboardingStep[] = STEP_IDS.map((id) => ({
    id,
    title: TITLES[id],
    description: `Do the ${id} thing.`,
    scope: ['build_roster', 'create_group', 'add_players_to_group'].includes(id)
      ? 'organization'
      : 'coach',
    action_label: `Action ${id}`,
    route: `/route-${id}`,
    secondary_action:
      id === 'build_roster' ? { label: 'Upload a roster', route: '/roster?import=1' } : null,
    complete: completeIds.includes(id),
  }));

  return {
    steps,
    completed_count: completeIds.length,
    total_count: steps.length,
    complete: completeIds.length === steps.length,
    next_step_id: steps.find((s) => !s.complete)?.id ?? null,
    dismissed: false,
    dismissed_at: null,
    milestone:
      completeIds.length === steps.length
        ? {
            id: 'first_player_completion',
            title: 'Have your first player complete a quiz',
            description: 'Share the access code with your team.',
            action_label: 'View the code',
            route: '/route-milestone',
            complete: false,
          }
        : null,
    ...overrides,
  };
}

function renderChecklist() {
  return render(
    <MemoryRouter>
      <FirstSuccessChecklist />
    </MemoryRouter>,
  );
}

describe('FirstSuccessChecklist', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(onboardingApi, 'dismissOnboarding').mockResolvedValue(makeProgress([]));
  });

  it('shows exactly the seven setup steps', async () => {
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(makeProgress());
    renderChecklist();

    for (const id of STEP_IDS) {
      expect(await screen.findByText(TITLES[id])).toBeInTheDocument();
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
  });

  it('never lists the player-completion milestone as a step', async () => {
    // It cannot be finished by the coach alone, so it must never appear as
    // unfinished setup.
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(makeProgress());
    renderChecklist();

    await screen.findByText(TITLES.create_quiz);
    expect(screen.queryByText(/have your first player/i)).not.toBeInTheDocument();
  });

  it('shows how far along the coach is', async () => {
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(
      makeProgress(['create_quiz', 'add_question']),
    );
    renderChecklist();

    expect(await screen.findByText('2 of 7 done')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '2');
    expect(bar).toHaveAttribute('aria-valuemax', '7');
  });

  it('marks the next step so it is obvious where to go', async () => {
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(makeProgress(['create_quiz']));
    renderChecklist();

    expect(await screen.findByText('Next')).toBeInTheDocument();
    // Exactly one - "next" means nothing if two rows claim it.
    expect(screen.getAllByText('Next')).toHaveLength(1);
  });

  it('uses the route the server returned rather than one of its own', async () => {
    // The whole point of the single endpoint: routing lives in one place. A
    // frontend id-to-URL map here would be a second copy of the rules.
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(makeProgress());
    renderChecklist();

    const link = await screen.findByTestId('onboarding-action-build_roster');
    expect(link).toHaveAttribute('href', '/route-build_roster');
  });

  it('offers both ways to build a roster', async () => {
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(makeProgress());
    renderChecklist();

    expect(await screen.findByRole('link', { name: 'Upload a roster' })).toHaveAttribute(
      'href',
      '/roster?import=1',
    );
    expect(screen.getByTestId('onboarding-action-build_roster')).toBeInTheDocument();
  });

  it('drops the action button once a step is done', async () => {
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(makeProgress(['create_quiz']));
    renderChecklist();

    await screen.findByText(TITLES.create_quiz);
    expect(screen.queryByTestId('onboarding-action-create_quiz')).not.toBeInTheDocument();
    expect(screen.getByTestId('onboarding-action-add_question')).toBeInTheDocument();
  });

  it('explains why an inherited step is already ticked', async () => {
    // The invited-coach case: they joined a team that already had a roster
    // and groups, and should not be left wondering who ticked them.
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(
      makeProgress(['build_roster', 'create_group', 'add_players_to_group']),
    );
    renderChecklist();

    expect(await screen.findByText('3 of 7 done')).toBeInTheDocument();
    expect(screen.getAllByText('already set up for your team')).toHaveLength(3);
    // ...and their own work is still in front of them.
    expect(screen.getByTestId('onboarding-action-create_quiz')).toBeInTheDocument();
  });

  it('renders nothing while loading, and nothing if the request fails', async () => {
    vi.spyOn(onboardingApi, 'getOnboarding').mockRejectedValue(new Error('offline'));
    const { container } = renderChecklist();

    // A guidance card that cannot load must not put an error across a
    // dashboard the coach opened to do something else.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing when it was dismissed on an earlier visit', async () => {
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(
      makeProgress([], { dismissed: true, dismissed_at: '2026-08-09T00:00:00Z' }),
    );
    const { container } = renderChecklist();

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('FirstSuccessChecklist dismissal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('hides on request and tells the coach how to get it back', async () => {
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(makeProgress());
    const dismiss = vi
      .spyOn(onboardingApi, 'dismissOnboarding')
      .mockResolvedValue(makeProgress([], { dismissed: true }));
    const { container } = renderChecklist();

    expect(await screen.findByText(/bring this back later from help/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));

    expect(dismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('still hides when the server never hears about it', async () => {
    // Hiding is what the coach asked for. Leaving the card up because a
    // request failed argues with them about their own dashboard.
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(makeProgress());
    vi.spyOn(onboardingApi, 'dismissOnboarding').mockRejectedValue(new Error('offline'));
    const { container } = renderChecklist();

    await screen.findByText(TITLES.create_quiz);
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('FirstSuccessChecklist completion', () => {
  const allDone = [...STEP_IDS];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a success state instead of a finished checklist', async () => {
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(makeProgress(allDone));
    vi.spyOn(onboardingApi, 'dismissOnboarding').mockResolvedValue(
      makeProgress(allDone, { dismissed: true }),
    );
    renderChecklist();

    expect(await screen.findByText(/you.re set up/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(TITLES.create_quiz)).not.toBeInTheDocument();
  });

  it('offers the milestone as a next step, not as unfinished setup', async () => {
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(makeProgress(allDone));
    vi.spyOn(onboardingApi, 'dismissOnboarding').mockResolvedValue(
      makeProgress(allDone, { dismissed: true }),
    );
    renderChecklist();

    expect(
      await screen.findByText('Next: Have your first player complete a quiz'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View the code' })).toHaveAttribute(
      'href',
      '/route-milestone',
    );
  });

  it('dismisses itself on completion so the card never becomes permanent', async () => {
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(makeProgress(allDone));
    const dismiss = vi
      .spyOn(onboardingApi, 'dismissOnboarding')
      .mockResolvedValue(makeProgress(allDone, { dismissed: true }));
    renderChecklist();

    await screen.findByText(/you.re set up/i);
    // Auto-dismissed, but still on screen for this visit - the coach just
    // earned it and should see it once.
    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/you.re set up/i)).toBeInTheDocument();
  });

  it('survives the re-fetch that its own auto-dismiss provokes', async () => {
    // The bug this exists to stop: the dashboard refreshes the checklist
    // whenever it changes something, so the fetch right after auto-dismiss
    // comes back saying dismissed. Read naively, that hides the success card
    // in the same breath as it appears - seven steps of work, nothing shown.
    const get = vi
      .spyOn(onboardingApi, 'getOnboarding')
      .mockResolvedValueOnce(makeProgress(allDone))
      .mockResolvedValue(makeProgress(allDone, { dismissed: true, dismissed_at: 'now' }));
    vi.spyOn(onboardingApi, 'dismissOnboarding').mockResolvedValue(
      makeProgress(allDone, { dismissed: true }),
    );

    const { rerender } = render(
      <MemoryRouter>
        <FirstSuccessChecklist reloadSignal={0} />
      </MemoryRouter>,
    );
    await screen.findByText(/you.re set up/i);

    rerender(
      <MemoryRouter>
        <FirstSuccessChecklist reloadSignal={1} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/you.re set up/i)).toBeInTheDocument();
  });

  it('shows nothing at all on the next visit', async () => {
    vi.spyOn(onboardingApi, 'getOnboarding').mockResolvedValue(
      makeProgress(allDone, { dismissed: true, dismissed_at: '2026-08-09T00:00:00Z' }),
    );
    const dismiss = vi.spyOn(onboardingApi, 'dismissOnboarding');
    const { container } = renderChecklist();

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(dismiss).not.toHaveBeenCalled();
  });
});
