import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharePeira } from './SharePeira';
import { playLink } from './playUrl';

// Stands in for the real matrix so the ENCODED VALUE can be asserted. A QR is
// opaque once rendered - a wrong url would look exactly like a right one and
// be a silent dead end for anyone who scanned it.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="qr" data-value={value} />,
}));

const CODE = '8A9FXP';
const URL = `${window.location.origin}/play/${CODE}`;

/** Installs (or removes) the two navigator capabilities this component reads.
 *
 * jsdom has neither `share` nor a working `clipboard`, which is the honest
 * starting point: a browser with no share sheet is exactly the desktop case
 * the fallback exists for. */
function stubNavigator({
  share,
  canShare,
  writeText,
}: {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  writeText?: (text: string) => Promise<void>;
}) {
  for (const [key, value] of Object.entries({ share, canShare })) {
    Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
    writable: true,
  });
}

function renderShare() {
  render(<SharePeira code={CODE} quizTitle="Inside Zone Install" />);
}

describe('SharePeira', () => {
  beforeEach(() => {
    stubNavigator({ writeText: vi.fn().mockResolvedValue(undefined) });
  });

  afterEach(() => {
    stubNavigator({});
    vi.restoreAllMocks();
  });

  it('builds the public play link from the code', () => {
    expect(playLink(CODE)).toBe(URL);
  });

  it('offers ONE primary action, not a row of transports', () => {
    // THE SIMPLICITY CHECK. The coach's question after activating is a single
    // question, so it gets a single answer. Copy / Email / Text / QR / Share
    // as five permanent buttons would make them pick a transport before they
    // have decided anything.
    renderShare();

    expect(screen.getAllByRole('button')).toHaveLength(2); // the action, and the QR disclosure
    expect(screen.getByRole('button', { name: 'Show QR code' })).toBeInTheDocument();
  });

  describe('on a device with a share sheet', () => {
    it('hands the link to the device instead of copying it', async () => {
      const share = vi.fn().mockResolvedValue(undefined);
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubNavigator({ share, canShare: () => true, writeText });
      renderShare();

      await userEvent.click(screen.getByRole('button', { name: 'Share Peira' }));

      expect(share).toHaveBeenCalledWith({
        title: 'Inside Zone Install',
        // The code travels with the link: it is what a player types if the
        // link ever fails them.
        text: `Inside Zone Install - Peira code ${CODE}`,
        url: URL,
      });
      expect(writeText).not.toHaveBeenCalled();
    });

    it('treats a dismissed share sheet as a decision, not a failure', async () => {
      const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubNavigator({ share: vi.fn().mockRejectedValue(abort), canShare: () => true, writeText });
      renderShare();

      await userEvent.click(screen.getByRole('button', { name: 'Share Peira' }));

      // No silent copy behind their back, and no error shouted at them.
      expect(writeText).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Share Peira' })).toBeInTheDocument();
    });

    it('falls back to copying when the share sheet genuinely fails', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubNavigator({
        share: vi.fn().mockRejectedValue(new Error('not allowed')),
        canShare: () => true,
        writeText,
      });
      renderShare();

      await userEvent.click(screen.getByRole('button', { name: 'Share Peira' }));

      // The coach must never be left with a button that did nothing.
      expect(writeText).toHaveBeenCalledWith(URL);
      expect(await screen.findByRole('button', { name: '✓ Link copied' })).toBeInTheDocument();
    });

    it('does not claim to share when the device refuses this payload', async () => {
      const share = vi.fn();
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubNavigator({ share, canShare: () => false, writeText });
      renderShare();

      expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));

      expect(share).not.toHaveBeenCalled();
      expect(writeText).toHaveBeenCalledWith(URL);
    });
  });

  describe('on a browser with no share sheet', () => {
    it('SAYS COPY RATHER THAN SHARE', async () => {
      // A button reading "Share" that silently copies is a button that lied.
      // The label is decided by what the device can actually do.
      renderShare();

      expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Share Peira' })).not.toBeInTheDocument();
    });

    it('copies the link and confirms it', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubNavigator({ writeText });
      renderShare();

      await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));

      expect(writeText).toHaveBeenCalledWith(URL);
      expect(await screen.findByRole('button', { name: '✓ Link copied' })).toBeInTheDocument();
    });

    it('shows a selectable link when the clipboard refuses', async () => {
      stubNavigator({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
      renderShare();

      await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));

      expect(await screen.findByLabelText('Peira link')).toHaveValue(URL);
    });

    it('shows a selectable link when there is no clipboard at all', async () => {
      stubNavigator({});
      renderShare();

      await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));

      expect(await screen.findByLabelText('Peira link')).toHaveValue(URL);
    });
  });

  describe('the QR code', () => {
    it('STAYS FOLDED AWAY until asked for', () => {
      // A coach already holding their phone never needs it. It is the answer
      // to a narrower question than the primary action, so it does not get
      // equal permanent weight.
      renderShare();

      expect(screen.queryByTestId('qr')).not.toBeInTheDocument();
    });

    it('ENCODES THE SAME LINK THE BUTTON SHARES', async () => {
      renderShare();

      await userEvent.click(screen.getByRole('button', { name: 'Show QR code' }));

      // Not "a QR rendered" - the exact url. Scanning a QR that points
      // somewhere else strands the coach with no error to see.
      expect(screen.getByTestId('qr')).toHaveAttribute('data-value', URL);
      expect(screen.getByText(/Scan with your phone/)).toBeInTheDocument();
    });

    it('folds away again', async () => {
      renderShare();

      await userEvent.click(screen.getByRole('button', { name: 'Show QR code' }));
      await userEvent.click(screen.getByRole('button', { name: 'Hide QR code' }));

      await waitFor(() => expect(screen.queryByTestId('qr')).not.toBeInTheDocument());
    });
  });

  it('sends nothing anywhere and stores no contact details', async () => {
    // THE BOUNDARY OF THIS FEATURE. Everything here happens on the device.
    // No provider, no phone number, no email address, no backend call - which
    // is exactly why it could ship without a compliance decision first.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ writeText });
    renderShare();

    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show QR code' }));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
