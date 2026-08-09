import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardTour } from './DashboardTour';
import { DASHBOARD_TOUR } from './tourSteps';

/** A stand-in dashboard carrying the same `data-tour` attributes the real
 *  one does. The tour finds targets by attribute, so a fake page with the
 *  right labels exercises exactly the same code path as the real page - and
 *  leaving one out is how "a missing target is skipped" gets tested. */
function FakePage({ include }: { include: string[] }) {
  return (
    <div>
      {include.map((name) => (
        <div key={name} data-tour={name}>
          {name}
        </div>
      ))}
    </div>
  );
}

const ALL_TARGETS = ['quizzes', 'folders', 'playbooks', 'roster', 'groups', 'help', 'admin-view'];
const MEMBER_TARGETS = ALL_TARGETS.filter((t) => t !== 'admin-view');

function renderTour(include: string[] = ALL_TARGETS) {
  const onFinish = vi.fn();
  render(
    <>
      <FakePage include={include} />
      <DashboardTour onFinish={onFinish} />
    </>,
  );
  return { onFinish };
}

/** jsdom gives everything a zero rect; the tour only needs *a* rect, but
 *  giving each element a distinct one lets the spotlight geometry be
 *  asserted rather than assumed. */
function stubRects(width = 100, height = 40) {
  let n = 0;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const index = Number(this.dataset.rectIndex ?? (this.dataset.rectIndex = String(n++)));
    const top = 100 + index * 60;
    const left = 50 + index * 30;
    return {
      x: left, y: top, top, left,
      right: left + width, bottom: top + height,
      width, height,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

describe('DashboardTour', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubRects();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens on the first step', async () => {
    renderTour();

    expect(await screen.findByRole('heading', { name: 'My Quizzes' })).toBeInTheDocument();
    expect(screen.getByText(/Your quizzes live here/)).toBeInTheDocument();
  });

  it('dims the page and lights the target', async () => {
    renderTour();
    await screen.findByRole('heading', { name: 'My Quizzes' });

    const spotlight = await screen.findByTestId('tour-spotlight');
    // The dim is the spotlight's own outer shadow, so a lit box implies a
    // dimmed page - there is no second scrim that could fall out of sync.
    expect(spotlight).toBeInTheDocument();
    expect(spotlight.style.width).not.toBe('');
  });

  it('walks forward with Next and back with Back', async () => {
    const user = userEvent.setup();
    renderTour();
    await screen.findByRole('heading', { name: 'My Quizzes' });

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Folders' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'My Quizzes' })).toBeInTheDocument();
  });

  it('cannot go back from the first step', async () => {
    renderTour();
    await screen.findByRole('heading', { name: 'My Quizzes' });

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  it('ends on Skip', async () => {
    const user = userEvent.setup();
    const { onFinish } = renderTour();
    await screen.findByRole('heading', { name: 'My Quizzes' });

    await user.click(screen.getByRole('button', { name: 'Skip' }));

    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('ends on Escape', async () => {
    const user = userEvent.setup();
    const { onFinish } = renderTour();
    await screen.findByRole('heading', { name: 'My Quizzes' });

    await user.keyboard('{Escape}');

    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('offers Done on the last step, and ends there', async () => {
    const user = userEvent.setup();
    const { onFinish } = renderTour(ALL_TARGETS);
    await screen.findByRole('heading', { name: 'My Quizzes' });

    for (let i = 0; i < DASHBOARD_TOUR.length - 1; i += 1) {
      await user.click(screen.getByRole('button', { name: 'Next' }));
    }

    expect(await screen.findByRole('heading', { name: 'Admin View' })).toBeInTheDocument();
    const done = screen.getByRole('button', { name: 'Done' });
    await user.click(done);

    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('drives with the arrow keys', async () => {
    const user = userEvent.setup();
    renderTour();
    await screen.findByRole('heading', { name: 'My Quizzes' });

    await user.keyboard('{ArrowRight}');
    expect(await screen.findByRole('heading', { name: 'Folders' })).toBeInTheDocument();

    await user.keyboard('{ArrowLeft}');
    expect(await screen.findByRole('heading', { name: 'My Quizzes' })).toBeInTheDocument();
  });

  it('puts focus in the panel so the keyboard works immediately', async () => {
    renderTour();
    const panel = await screen.findByRole('dialog');

    await waitFor(() => expect(document.activeElement).toBe(panel));
  });
});

describe('DashboardTour missing targets', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubRects();
  });

  it('skips the admin step for a coach who has no Admin View', async () => {
    // THE case this rule exists for. There is no role check anywhere in the
    // tour - the element simply is not in a member's header.
    const user = userEvent.setup();
    const { onFinish } = renderTour(MEMBER_TARGETS);
    await screen.findByRole('heading', { name: 'My Quizzes' });

    for (let i = 0; i < DASHBOARD_TOUR.length - 2; i += 1) {
      await user.click(screen.getByRole('button', { name: 'Next' }));
    }
    expect(await screen.findByRole('heading', { name: 'Help' })).toBeInTheDocument();

    // Labelled Done, not Next: nothing comes after it for this coach, and
    // promising a step that will never arrive is its own small lie.
    const done = await screen.findByRole('button', { name: 'Done' });
    await user.click(done);
    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
  });

  it('steps over a missing middle target instead of stalling', async () => {
    const user = userEvent.setup();
    renderTour(ALL_TARGETS.filter((t) => t !== 'folders'));
    await screen.findByRole('heading', { name: 'My Quizzes' });

    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Folders is gone, so the tour lands on Playbooks - it does not sit on a
    // blank step or throw.
    expect(await screen.findByRole('heading', { name: 'Playbooks' })).toBeInTheDocument();
  });

  it('keeps travelling backwards over a missing target', async () => {
    const user = userEvent.setup();
    renderTour(ALL_TARGETS.filter((t) => t !== 'folders'));
    await screen.findByText(/Your quizzes live here/);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Playbooks' });

    await user.click(screen.getByRole('button', { name: 'Back' }));

    // Back from Playbooks skips the absent Folders and reaches My Quizzes,
    // rather than bouncing forward again.
    expect(await screen.findByRole('heading', { name: 'My Quizzes' })).toBeInTheDocument();
  });

  it('survives a page with no tour targets at all', async () => {
    const { onFinish } = renderTour([]);

    // Nothing to show, so it ends rather than dimming the screen forever.
    await waitFor(() => expect(onFinish).toHaveBeenCalled(), { timeout: 4000 });
  });
});

describe('DashboardTour spotlight tracking', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubRects();
  });

  it('unions the two nav links behind the "Roster & Groups" step', async () => {
    const user = userEvent.setup();
    renderTour();
    await screen.findByRole('heading', { name: 'My Quizzes' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('heading', { name: 'Roster & Groups' })).toBeInTheDocument();
    const spotlight = screen.getByTestId('tour-spotlight');
    const roster = document.querySelector('[data-tour="roster"]')!.getBoundingClientRect();
    const groups = document.querySelector('[data-tour="groups"]')!.getBoundingClientRect();

    // One spotlight covering both, not one of them.
    const height = parseFloat(spotlight.style.height);
    expect(height).toBeGreaterThanOrEqual(groups.bottom - roster.top);
  });

  it('re-measures the target when it moves under a scroll', async () => {
    renderTour();
    await screen.findByTestId('tour-spotlight');
    const before = screen.getByTestId('tour-spotlight').style.top;

    // The target moves, as it would under a scroll, and the page reports it.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 5, top: 5, left: 10, right: 110, bottom: 45, width: 100, height: 40,
      toJSON: () => ({}),
    } as DOMRect);
    window.dispatchEvent(new Event('scroll'));

    await waitFor(() =>
      expect(screen.getByTestId('tour-spotlight').style.top).not.toBe(before),
    );
  });

  it('re-measures the target when the viewport resizes', async () => {
    renderTour();
    await screen.findByTestId('tour-spotlight');
    const before = screen.getByTestId('tour-spotlight').style.left;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 400, y: 5, top: 5, left: 400, right: 500, bottom: 45, width: 100, height: 40,
      toJSON: () => ({}),
    } as DOMRect);
    window.dispatchEvent(new Event('resize'));

    await waitFor(() =>
      expect(screen.getByTestId('tour-spotlight').style.left).not.toBe(before),
    );
  });

  it('re-aligns after a reflow, which fires no scroll or resize event', async () => {
    // The bug the browser caught: a card above the target finished loading,
    // the target moved 17px down, and the spotlight stayed where it was
    // because nothing dispatches an event for a reflow.
    renderTour();
    await screen.findByTestId('tour-spotlight');
    const before = screen.getByTestId('tour-spotlight').style.top;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 500, top: 500, left: 10, right: 110, bottom: 540, width: 100, height: 40,
      toJSON: () => ({}),
    } as DOMRect);
    // Deliberately no event dispatched.

    await waitFor(() =>
      expect(screen.getByTestId('tour-spotlight').style.top).not.toBe(before),
    );
  });

  it('does not lock body scroll', async () => {
    // Deliberate: the coach can keep scrolling and the spotlight follows,
    // which is better than pinning them to one screenful.
    renderTour();
    await screen.findByTestId('tour-spotlight');

    expect(document.body.style.overflow).not.toBe('hidden');
  });
});
