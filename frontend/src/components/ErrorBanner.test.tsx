import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBanner } from './ErrorBanner';

/** A failed load is never a dead end: the message, and when the page can ask again, Try again. */
describe('ErrorBanner', () => {
  it('says what went wrong, and Try again asks again', () => {
    const retry = vi.fn();
    render(<ErrorBanner message="Could not reach the server." onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('without a way to ask again, just the message; without a message, nothing', () => {
    const { rerender } = render(<ErrorBanner message="Nope." />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    rerender(<ErrorBanner message={null} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
