/**
 * The scannable way into a competition.
 *
 * A CONVENIENCE, NEVER A GATE. Scanning this lands a player on the same public
 * identity picker they reach by typing the code, and nothing more: it claims no
 * seat, carries no credential, and skips no step. The projected code remains
 * the primary route in, so a dead camera, a locked-down phone or a failed
 * render all still leave a working room. That is why the code above it is the
 * hero and this sits underneath.
 *
 * FUNCTIONAL FIRST, DECORATED SECOND. The matrix is pure black on pure white
 * with a real quiet zone, deliberately outside the Competition palette. The
 * stage is dark and warm, and a QR tinted to match it scans badly under
 * projector glare - which would trade the only thing this component is for
 * against how it looks.
 */

import { Component, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';

import { competitionJoinUrl } from './joinUrl';
import styles from './Competition.module.css';

/**
 * A render failure here must not cost the coach their lobby.
 *
 * The join code, the counters and the roster are all still on screen, and the
 * room works without this. An error boundary rather than a try/catch because a
 * throw during render is the failure mode a try/catch around JSX would miss.
 */
export class QrBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

export function JoinQr({ code }: { code: string }) {
  if (!code) return null;
  const url = competitionJoinUrl(code);

  return (
    <QrBoundary>
      <div className={styles.qrBlock}>
        <div className={styles.qrPlate}>
          <QRCodeSVG
            value={url}
            // Sized by CSS from the card, not fixed here - see .qrPlate. The
            // rendered SVG scales to its box, so this is only the intrinsic
            // ratio.
            size={512}
            level="M"
            // Four modules, the quiet zone the QR spec actually asks for.
            // Without it a camera has nothing to lock the matrix against.
            marginSize={4}
            fgColor="#000000"
            bgColor="#ffffff"
            // The URL is the accessible content; the squares are decoration to
            // a screen reader.
            role="img"
            aria-label={`Scan to join competition ${code.toUpperCase()}`}
            style={{ width: '100%', height: 'auto', display: 'block' }}
          />
        </div>
        <div className={styles.qrCaption}>Scan or enter the code</div>
      </div>
    </QrBoundary>
  );
}

export default JoinQr;
