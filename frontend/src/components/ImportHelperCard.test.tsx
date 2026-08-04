import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_ROSTER_PROMPT, ImportHelperCard } from './ImportHelperCard';

function stubClipboard(value: { writeText: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('ImportHelperCard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders the helper with its title and the three import paths', () => {
    render(<ImportHelperCard />);

    expect(screen.getByText('Need Help Creating a CSV?')).toBeInTheDocument();
    expect(screen.getByText(/it's easy/)).toBeInTheDocument();
    expect(screen.getByText(/Three ways to import/)).toBeInTheDocument();
    expect(screen.getByText(/AI tools aren't required/)).toBeInTheDocument();
  });

  it('copies the exact AI prompt to the clipboard and shows success feedback that reverts', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    render(<ImportHelperCard />);

    await user.click(screen.getByRole('button', { name: 'Copy AI Prompt' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(AI_ROSTER_PROMPT));
    expect(await screen.findByRole('button', { name: '✓ Prompt Copied' })).toBeInTheDocument();

    // Fire the scheduled revert directly instead of racing real/fake timers.
    const revertCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 2000);
    const [revertCallback] = revertCall as [() => void, number];
    act(() => revertCallback());

    expect(screen.getByRole('button', { name: 'Copy AI Prompt' })).toBeInTheDocument();
  });

  it('falls back to a visible, selectable textarea when clipboard access fails', async () => {
    const user = userEvent.setup();
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    render(<ImportHelperCard />);

    await user.click(screen.getByRole('button', { name: 'Copy AI Prompt' }));

    const fallbackTextarea = await screen.findByLabelText('AI roster conversion prompt');
    expect(fallbackTextarea).toHaveValue(AI_ROSTER_PROMPT);
  });

  it('falls back immediately when the Clipboard API is unavailable', async () => {
    const user = userEvent.setup();
    stubClipboard(undefined);
    render(<ImportHelperCard />);

    await user.click(screen.getByRole('button', { name: 'Copy AI Prompt' }));

    expect(await screen.findByLabelText('AI roster conversion prompt')).toHaveValue(AI_ROSTER_PROMPT);
  });

  it('keeps the example collapsed by default and expands it on demand', async () => {
    const user = userEvent.setup();
    render(<ImportHelperCard />);

    const details = screen.getByText('See Example').closest('details');
    expect(details).not.toHaveAttribute('open');

    await user.click(screen.getByText('See Example'));

    expect(details).toHaveAttribute('open');
    expect(screen.getByText(/First Name,Last Name,Jersey Number,Position/)).toBeInTheDocument();
  });
});
