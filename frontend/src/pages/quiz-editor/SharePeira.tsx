import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { playLink } from './playUrl';
import nb from '../../styles/notebook.module.css';
import styles from './SharePeira.module.css';

/**
 * Getting an activated Peira out of Peira and into a team group text.
 *
 * THE PROBLEM THIS EXISTS FOR. A coach activates on a laptop, and the link is
 * then stranded on the wrong device: copy it, email it to yourself, open the
 * mail on your phone, copy it again, paste it into the group text. Five steps
 * outside the product to finish a job the product started.
 *
 * ONE PRIMARY ACTION, NOT A ROW OF CHANNELS. The coach's question after
 * activating is a single question - how do I get this to my players - so there
 * is a single answer. Adding Copy / Email / Text / QR / Share as five
 * permanent buttons would make the coach choose a TRANSPORT before they have
 * decided anything, which is not a choice they came here to make.
 *
 * THE BUTTON USES THE DEVICE'S OWN SHARE SHEET WHERE THERE IS ONE.
 * `navigator.share` opens Messages, Mail, WhatsApp - whatever that coach
 * actually uses - and Peira does not have to know about any of them, store a
 * phone number, or send anything. On a phone this collapses the whole five-step
 * detour into two taps. Where the browser has no share sheet the same button
 * copies instead, and SAYS SO: the label is decided by what the device can
 * actually do, because a button reading "Share" that silently copies is a
 * button that lied.
 *
 * THE QR IS THE DESKTOP HALF OF THE SAME ANSWER, and it is why it is worth a
 * disclosure rather than being cut. A laptop with no share sheet cannot hand
 * anything to a phone; a scannable code can, and it is the ONLY route here
 * that needs no clipboard, no email and no typing. It stays folded away because
 * a coach already holding their phone never needs it.
 *
 * NOTHING HERE TOUCHES THE BACKEND. No message is sent, no contact is stored,
 * and the link is the same public /play URL the code has always produced.
 */

const COPIED_FEEDBACK_MS = 2000;

/** Whether this browser can hand a URL to another app.
 *
 * Checked at click time rather than render time so a stubbed navigator in a
 * test - and a browser that only exposes `share` in a secure context - are
 * both read at the moment it matters.
 */
function canShareUrl(url: string): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false;
  // canShare is the only way to ask before opening the sheet. Where it is
  // missing, `share` existing is the best signal available.
  if (typeof navigator.canShare === 'function') {
    try {
      return navigator.canShare({ url });
    } catch {
      return false;
    }
  }
  return true;
}

export function SharePeira({ code, quizTitle }: { code: string; quizTitle: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'fallback'>('idle');
  const [showQr, setShowQr] = useState(false);

  const url = playLink(code);
  // Read once per render for the LABEL. The click path re-checks, so a wrong
  // guess here costs a word, never a broken action.
  const shareable = canShareUrl(url);

  async function copy() {
    if (!navigator.clipboard) {
      setState('fallback');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
      setTimeout(() => setState((s) => (s === 'copied' ? 'idle' : s)), COPIED_FEEDBACK_MS);
    } catch {
      setState('fallback');
    }
  }

  async function handleShare() {
    if (canShareUrl(url)) {
      try {
        await navigator.share({
          title: quizTitle,
          // Both, because a group text wants a sentence and a link, and the
          // code is what a player types if the link ever fails them.
          text: `${quizTitle} - Peira code ${code}`,
          url,
        });
        return;
      } catch (err) {
        // Dismissing the share sheet is a decision, not a failure. Anything
        // else falls through to the clipboard so the coach is never left with
        // a button that did nothing.
        if (err instanceof Error && err.name === 'AbortError') return;
      }
    }
    await copy();
  }

  return (
    <div className={styles.share}>
      <button type="button" className={nb.btnPrimary} onClick={handleShare}>
        {state === 'copied' ? '✓ Link copied' : shareable ? 'Share Peira' : 'Copy link'}
      </button>

      <button
        type="button"
        className={styles.qrToggle}
        onClick={() => setShowQr((open) => !open)}
        aria-expanded={showQr}
      >
        {showQr ? 'Hide QR code' : 'Show QR code'}
      </button>

      {showQr && (
        <div className={styles.qrBlock}>
          {/* Pure black on white with a real quiet zone, deliberately outside
              the coach theme: a QR tinted to match a dark page scans badly,
              which would trade the only thing it is for against how it looks.
              Same reasoning as the competition lobby's JoinQr. */}
          <div className={styles.qrPlate}>
            <QRCodeSVG value={url} size={512} level="M" marginSize={4} />
          </div>
          <p className={styles.qrHint}>Scan with your phone to open this Peira there.</p>
        </div>
      )}

      {state === 'fallback' && (
        <div className={styles.fallback}>
          <p>Clipboard access isn't available here - copy the link below manually:</p>
          <input
            className={nb.input}
            readOnly
            value={url}
            aria-label="Peira link"
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}
    </div>
  );
}
