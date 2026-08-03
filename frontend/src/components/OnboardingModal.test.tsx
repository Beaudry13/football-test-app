import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { OnboardingModal } from './OnboardingModal';
import nb from '../styles/notebook.module.css';
import modalStyles from './OnboardingModal.module.css';

/** Mirrors how NotebookHeader actually uses this: a real focusable trigger
 * that mounts/unmounts the modal, so focus-in/focus-out behavior is
 * exercised the same way it is in production, not simulated. */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        What is Peira?
      </button>
      {open && <OnboardingModal onDismiss={() => setOpen(false)} />}
    </div>
  );
}

function renderHarness() {
  render(<Harness />);
  return userEvent.setup();
}

describe('OnboardingModal', () => {
  it('opens when triggered and shows its content', async () => {
    const user = renderHarness();
    await user.click(screen.getByRole('button', { name: 'What is Peira?' }));

    expect(screen.getByRole('dialog', { name: 'Welcome to Peira' })).toBeInTheDocument();
  });

  it('renders a solid dedicated panel class, not the shared translucent card surface', async () => {
    const user = renderHarness();
    await user.click(screen.getByRole('button', { name: 'What is Peira?' }));

    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain(modalStyles.card);
    expect(panel.className).not.toContain(nb.card);
  });

  it('renders through a portal directly under document.body, not nested in the trigger\'s tree', async () => {
    const user = renderHarness();
    await user.click(screen.getByRole('button', { name: 'What is Peira?' }));

    const panel = screen.getByRole('dialog');
    const trigger = screen.getByRole('button', { name: 'What is Peira?' });
    expect(trigger.closest('div')?.contains(panel)).toBe(false);
    expect(document.body.contains(panel)).toBe(true);
  });

  it('closes via the close (X) button', async () => {
    const user = renderHarness();
    await user.click(screen.getByRole('button', { name: 'What is Peira?' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes via the Begin button', async () => {
    const user = renderHarness();
    await user.click(screen.getByRole('button', { name: 'What is Peira?' }));
    await user.click(screen.getByRole('button', { name: 'Begin' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = renderHarness();
    await user.click(screen.getByRole('button', { name: 'What is Peira?' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on a backdrop click but not on a click inside the panel', async () => {
    const user = renderHarness();
    await user.click(screen.getByRole('button', { name: 'What is Peira?' }));

    // A click on the panel's own heading must not bubble into a dismiss.
    await user.click(screen.getByText('Welcome to Peira'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // The backdrop is the dialog's parent - clicking it (outside the panel) closes.
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement;
    await user.click(backdrop);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves focus into the modal on open', async () => {
    const user = renderHarness();
    await user.click(screen.getByRole('button', { name: 'What is Peira?' }));

    await waitFor(() => expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement));
  });

  it('returns focus to the trigger on close', async () => {
    const user = renderHarness();
    const trigger = screen.getByRole('button', { name: 'What is Peira?' });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('locks body scroll while open and restores it once closed', async () => {
    const user = renderHarness();
    expect(document.body.style.overflow).not.toBe('hidden');

    await user.click(screen.getByRole('button', { name: 'What is Peira?' }));
    expect(document.body.style.overflow).toBe('hidden');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('leaves no overlay in the document after dismissal', async () => {
    const user = renderHarness();
    await user.click(screen.getByRole('button', { name: 'What is Peira?' }));
    await user.click(screen.getByRole('button', { name: 'Begin' }));

    expect(document.querySelector(`.${modalStyles.scrim}`)).not.toBeInTheDocument();
  });
});
