import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** The Peira confirmation modal, once it has opened. */
export async function findConfirmDialog(): Promise<HTMLElement> {
  return screen.findByRole('alertdialog');
}

/** Clicks the modal's destructive button. Pass `name` when a test needs to
 * assert exactly which action it confirmed. */
export async function acceptConfirm(user: UserEvent, name?: string | RegExp): Promise<void> {
  const dialog = await findConfirmDialog();
  const buttons = within(dialog).getAllByRole('button');
  const confirmButton = name
    ? within(dialog).getByRole('button', { name })
    : buttons[buttons.length - 1];
  await user.click(confirmButton);
}

export async function cancelConfirm(user: UserEvent): Promise<void> {
  const dialog = await findConfirmDialog();
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
}
