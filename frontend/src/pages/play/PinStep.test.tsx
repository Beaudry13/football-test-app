import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { PinStep } from './PinStep';

const JORDAN = { playerId: 501, name: 'Jordan Smith', jerseyNumber: '7', position: 'QB' };

function renderPin(onSubmitPin = vi.fn().mockResolvedValue(undefined), extra: { notice?: string } = {}) {
  const onNotYou = vi.fn();
  render(
    <PinStep title="Week 1 Prep" player={JORDAN} notice={extra.notice} onSubmitPin={onSubmitPin} onNotYou={onNotYou} />,
  );
  return { onSubmitPin, onNotYou, input: screen.getByLabelText('Enter your PIN') as HTMLInputElement };
}

describe('PinStep', () => {
  it('shows who the PIN is for, and brings up the number keypad', () => {
    const { input } = renderPin();
    expect(screen.getByText('Jordan Smith')).toBeInTheDocument();
    expect(screen.getByText('#7 · QB')).toBeInTheDocument();
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveFocus();
  });

  it('checks the PIN as soon as the sixth digit is typed, ignoring anything but digits', async () => {
    const user = userEvent.setup();
    const { onSubmitPin, input } = renderPin();

    await user.type(input, '48-29 1a5');

    await waitFor(() => expect(onSubmitPin).toHaveBeenCalledWith('482915'));
    expect(onSubmitPin).toHaveBeenCalledTimes(1);
  });

  it('keeps Continue off until there are six digits', async () => {
    const user = userEvent.setup();
    const { input } = renderPin(vi.fn(() => new Promise<void>(() => {})));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.type(input, '48291');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it.each([
    ['pin_incorrect', 401, undefined, 'Incorrect PIN. Try again.'],
    ['pin_cooldown', 429, 120, 'Too many attempts. Try again in 2 minutes.'],
    ['pin_locked', 423, undefined, 'Too many attempts. Ask your coach to reset your PIN.'],
    ['pin_not_set', 403, undefined, "You don't have a PIN yet. Ask your coach."],
  ])('a %s refusal reads in plain words and clears the box', async (reason, status, retry, words) => {
    const user = userEvent.setup();
    const onSubmitPin = vi.fn().mockRejectedValue(new ApiError('server words', status, undefined, reason, retry));
    const { input } = renderPin(onSubmitPin);

    await user.type(input, '111111');

    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.getByLabelText('Enter your PIN')).toHaveValue('');
    expect(screen.queryByText('server words')).not.toBeInTheDocument();
  });

  it('shows why the player was sent here', () => {
    renderPin(undefined, { notice: 'Your PIN was changed. Enter your new PIN to keep going.' });
    expect(screen.getByText('Your PIN was changed. Enter your new PIN to keep going.')).toBeInTheDocument();
  });

  it('"Not you?" is always a way out', async () => {
    const user = userEvent.setup();
    const { onNotYou } = renderPin();
    await user.click(screen.getByRole('button', { name: 'Not you? Choose your name' }));
    expect(onNotYou).toHaveBeenCalled();
  });
});
