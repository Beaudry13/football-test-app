import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HelpArticleModal } from './HelpArticleModal';

/** Ported from the standalone onboarding modal this replaced. The dialog
 *  moved and the content became registry-driven, but the focus trap, scroll
 *  lock and portal behaviour are the same contract and still need holding. */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open help
      </button>
      {open && (
        <HelpArticleModal title="Getting Started" onDismiss={() => setOpen(false)}>
          <p>Seven steps from empty account to a quiz.</p>
        </HelpArticleModal>
      )}
    </div>
  );
}

async function open() {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open help' }));
  return user;
}

describe('HelpArticleModal', () => {
  it('shows the article it was given', async () => {
    await open();

    expect(screen.getByRole('heading', { name: 'Getting Started' })).toBeInTheDocument();
    expect(screen.getByText('Seven steps from empty account to a quiz.')).toBeInTheDocument();
  });

  it('renders through a portal under document.body, not inside the trigger tree', async () => {
    // The header has its own stacking context; nested, the panel would paint
    // under the page content.
    await open();

    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('div[data-testid]')).toBeNull();
    expect(document.body.contains(dialog)).toBe(true);
  });

  it('closes via the close (X) button', async () => {
    const user = await open();

    await user.click(screen.getByRole('button', { name: 'Close help' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes via the button at the foot of the article', async () => {
    const user = await open();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = await open();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on a backdrop click but not on a click inside the panel', async () => {
    const user = await open();

    await user.click(screen.getByRole('heading', { name: 'Getting Started' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(document.querySelector('[class*="backdrop"]') as Element);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves focus into the dialog on open and back to the trigger on close', async () => {
    const user = await open();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open help' }));
  });

  it('locks body scroll while open and restores it once closed', async () => {
    const user = await open();
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');

    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('leaves no overlay behind after dismissal', async () => {
    const user = await open();

    await user.keyboard('{Escape}');

    expect(document.querySelector('[class*="backdrop"]')).toBeNull();
  });
});
