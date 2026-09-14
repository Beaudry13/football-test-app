/** The one-time PIN sheet.
 *
 * What these protect: the PINs are shown clearly and grouped, two same-named
 * players stay distinguishable, printing prints, closing is never accidental,
 * and nothing about the PINs is kept anywhere once the sheet is gone.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssuedPin } from '../../api/players';
import { CLOSE_WARNING, PinSheetDialog } from './PinSheetDialog';

const pin = (over: Partial<IssuedPin>): IssuedPin => ({
  player_id: 1,
  first_name: 'Jordan',
  last_name: 'Lee',
  full_name: 'Jordan Lee',
  jersey_number: '4',
  position: 'WR',
  pin: '482915',
  ...over,
});

const SMITHS = [
  pin({ player_id: 21, first_name: 'John', last_name: 'Smith', full_name: 'John Smith', jersey_number: '12', position: 'QB', pin: '103948' }),
  pin({ player_id: 22, first_name: 'John', last_name: 'Smith', full_name: 'John Smith', jersey_number: '37', position: 'LB', pin: '572031' }),
];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

describe('showing the PINs', () => {
  it('groups each PIN three and three', () => {
    render(<PinSheetDialog pins={[pin({})]} onClosed={vi.fn()} />);
    expect(screen.getByText('482 915')).toBeInTheDocument();
  });

  it('names a single player in the heading', () => {
    render(<PinSheetDialog pins={[pin({})]} onClosed={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'PIN for Jordan Lee' })).toBeInTheDocument();
  });

  it('counts a batch in the heading', () => {
    render(<PinSheetDialog pins={SMITHS} onClosed={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Player PINs (2)' })).toBeInTheDocument();
  });

  it('says plainly that this is the only time they are shown', () => {
    render(<PinSheetDialog pins={[pin({})]} onClosed={vi.fn()} />);
    expect(screen.getByText(/only time these PINs are shown/i)).toBeInTheDocument();
  });

  it('keeps two John Smiths apart by their jersey and position', () => {
    render(<PinSheetDialog pins={SMITHS} onClosed={vi.fn()} />);
    const qb = screen.getByText('103 948').closest('tr') as HTMLElement;
    const lb = screen.getByText('572 031').closest('tr') as HTMLElement;
    expect(within(qb).getByText('#12')).toBeInTheDocument();
    expect(within(qb).getByText('QB')).toBeInTheDocument();
    expect(within(lb).getByText('#37')).toBeInTheDocument();
    expect(within(lb).getByText('LB')).toBeInTheDocument();
  });

  it('shows a dash rather than inventing a jersey or position', () => {
    render(<PinSheetDialog pins={[pin({ jersey_number: null, position: null })]} onClosed={vi.fn()} />);
    const row = screen.getByText('482 915').closest('tr') as HTMLElement;
    expect(within(row).getAllByText('—')).toHaveLength(2);
  });
});

describe('printing', () => {
  it('prints on request', async () => {
    const user = userEvent.setup();
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<PinSheetDialog pins={[pin({})]} onClosed={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Print' }));

    expect(print).toHaveBeenCalledTimes(1);
  });
});

describe('closing is never accidental', () => {
  it('Done asks first, with the warning', async () => {
    const user = userEvent.setup();
    const onClosed = vi.fn();
    render(<PinSheetDialog pins={[pin({})]} onClosed={onClosed} />);

    await user.click(screen.getByRole('button', { name: 'Done' }));

    const warning = await screen.findByRole('alertdialog');
    expect(warning).toHaveTextContent(CLOSE_WARNING);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('Keep open keeps the sheet and its PINs', async () => {
    const user = userEvent.setup();
    const onClosed = vi.fn();
    render(<PinSheetDialog pins={[pin({})]} onClosed={onClosed} />);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(await screen.findByRole('button', { name: 'Keep open' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByText('482 915')).toBeInTheDocument();
  });

  it('confirming closes it', async () => {
    const user = userEvent.setup();
    const onClosed = vi.fn();
    render(<PinSheetDialog pins={[pin({})]} onClosed={onClosed} />);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(await screen.findByRole('button', { name: 'Close sheet' }));

    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
  });

  it('Escape asks first too', async () => {
    const user = userEvent.setup();
    const onClosed = vi.fn();
    render(<PinSheetDialog pins={[pin({})]} onClosed={onClosed} />);

    await user.keyboard('{Escape}');

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(CLOSE_WARNING);
    expect(onClosed).not.toHaveBeenCalled();
  });
});

describe('nothing is kept', () => {
  it('writes no PIN to browser storage', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PinSheetDialog pins={SMITHS} onClosed={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(await screen.findByRole('button', { name: 'Close sheet' }));
    unmount();

    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    for (const entry of SMITHS) expect(stored).not.toContain(entry.pin);
  });

  it('offers no link that could reopen it', () => {
    render(<PinSheetDialog pins={[pin({})]} onClosed={vi.fn()} />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});
