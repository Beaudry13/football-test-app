/** A small always-on-top Start/Stop control, for recording football film that
 *  lives in another application.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 *
 * A coach records from Hudl or Football HD. They choose that window, switch to
 * it, find the play - and then have to hunt back through a row of browser tabs
 * to press Start. By the time they are back the film has usually moved. The
 * controls need to be where the coach is looking, which is not this tab.
 *
 * Document Picture-in-Picture is the only browser-native way to do that. It is
 * a real, separate, always-on-top browser window running a document we own.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEVER OPENS OVER A WHOLE-SCREEN CAPTURE
 * ---------------------------------------------------------------------------
 *
 * A floating control burned into the middle of a coach's football clip would
 * be far worse than the tab-hunting it replaces, and it cannot be undone after
 * the take.
 *
 * So the surface decides, and the reasoning is about what each surface IS
 * rather than about browser internals:
 *
 *   window   capturing ONE application window. A separate browser window is
 *            not that window, so it is not in the composition.
 *   browser  capturing a TAB's contents. A separate window is not tab content.
 *   monitor  capturing the whole screen, and this control sits ON that screen.
 *            REFUSED - the coach keeps the in-page controls instead.
 *
 * `monitor` is refused rather than risked, and anything we cannot identify is
 * treated as `monitor`. An unknown surface is not an invitation to guess.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT VERIFIED, STATED PLAINLY
 * ---------------------------------------------------------------------------
 *
 * Document PiP could not be exercised in the environment this was written in:
 * the embedded browser has no real window to detach one from, and
 * `requestWindow` fails there with `InvalidStateError: no window` even on a
 * direct click. So two things are reasoned rather than measured:
 *
 *   * that the window genuinely floats above another application, and
 *   * that a window/tab capture really does exclude it.
 *
 * Everything here is therefore built to FAIL BACK, not to fail. If the API is
 * missing, refuses, or throws for any reason, the caller keeps exactly the
 * in-page READY controls that shipped before this existed. The worst case is
 * the behaviour we already have.
 */

/** Surfaces where a separate window cannot end up inside the recording. */
const FLOATABLE_SURFACES = ['window', 'browser'] as const;

export type FloatingPhase = 'ready' | 'recording';

export interface FloatingControls {
  /** Moves the control between READY and RECORDING. */
  setPhase: (phase: FloatingPhase) => void;
  /** The running count, in whole seconds. */
  setSeconds: (seconds: number) => void;
  close: () => void;
}

export interface FloatingHandlers {
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
  /** The coach closed the floating window itself. */
  onClosed?: () => void;
  maxSeconds: number;
}

/** Whether a floating control is safe for the surface the coach chose.
 *
 *  Defaults to NO. A surface string we do not recognise gets the same answer
 *  as `monitor`, because the cost of being wrong is a control burned into
 *  football that cannot be removed afterwards. */
export function canFloatOver(displaySurface: string | undefined | null): boolean {
  if (!displaySurface) return false;
  return (FLOATABLE_SURFACES as readonly string[]).includes(displaySurface);
}

interface PiPApi {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>;
}

function pipApi(): PiPApi | null {
  const api = (window as unknown as { documentPictureInPicture?: PiPApi })
    .documentPictureInPicture;
  return api && typeof api.requestWindow === 'function' ? api : null;
}

/** True when this browser exposes Document Picture-in-Picture at all. */
export function floatingControlsSupported(): boolean {
  return pipApi() !== null;
}

/** Opens the floating control, or returns null if it cannot be opened.
 *
 *  NULL IS A NORMAL ANSWER, not an error: an unsupported browser, a refused
 *  request and a whole-screen capture all mean "use the page controls", and
 *  the caller treats them identically. */
export async function openFloatingControls(
  displaySurface: string | undefined | null,
  handlers: FloatingHandlers,
): Promise<FloatingControls | null> {
  if (!canFloatOver(displaySurface)) return null;
  const api = pipApi();
  if (!api) return null;

  let win: Window;
  try {
    win = await api.requestWindow({ width: 300, height: 168 });
  } catch {
    // Unsupported, refused, or called without the activation the browser
    // wanted. None of these are worth interrupting the coach over - the page
    // still has every control they need.
    return null;
  }

  const doc = win.document;
  doc.body.style.cssText =
    'margin:0;padding:14px;background:#0E1013;color:#F2F4F7;' +
    "font:14px/1.45 -apple-system,'Segoe UI',system-ui,sans-serif;";

  const title = doc.createElement('div');
  title.textContent = 'Peira Record Clip';
  title.style.cssText = 'font-weight:700;margin-bottom:4px';

  const status = doc.createElement('div');
  status.style.cssText =
    'color:#8B93A1;font-size:12px;margin-bottom:12px;font-variant-numeric:tabular-nums';
  status.textContent = 'Screen shared — not recording';

  const primary = doc.createElement('button');
  primary.type = 'button';
  primary.textContent = 'Start recording';
  primary.style.cssText =
    'min-height:40px;padding:0 14px;border-radius:8px;border:0;background:#D9A441;' +
    'color:#0E1013;font:inherit;font-weight:700;cursor:pointer;margin-right:8px';

  const secondary = doc.createElement('button');
  secondary.type = 'button';
  secondary.textContent = 'Cancel';
  secondary.style.cssText =
    'min-height:40px;padding:0 12px;border-radius:8px;border:1px solid #2C323C;' +
    'background:#242932;color:#F2F4F7;font:inherit;cursor:pointer';

  doc.body.append(title, status, primary, secondary);

  let phase: FloatingPhase = 'ready';
  primary.addEventListener('click', () => {
    if (phase === 'ready') handlers.onStart();
    else handlers.onStop();
  });
  secondary.addEventListener('click', () => handlers.onCancel());

  // The coach closing the floating window is a deliberate act, and it must not
  // leave a capture running with no visible way to stop it.
  if (handlers.onClosed) {
    win.addEventListener('pagehide', handlers.onClosed, { once: true });
  }

  return {
    setPhase(next) {
      phase = next;
      if (next === 'recording') {
        primary.textContent = 'Stop recording';
        primary.style.background = '#F2685E';
        primary.style.color = '#FFFFFF';
        secondary.style.display = 'none';
        status.textContent = 'Recording · 00 / ' + handlers.maxSeconds + ' sec';
      } else {
        primary.textContent = 'Start recording';
        primary.style.background = '#D9A441';
        primary.style.color = '#0E1013';
        secondary.style.display = '';
        status.textContent = 'Screen shared — not recording';
      }
    },
    setSeconds(seconds) {
      if (phase !== 'recording') return;
      status.textContent =
        'Recording · ' +
        String(seconds).padStart(2, '0') +
        ' / ' +
        handlers.maxSeconds +
        ' sec';
    },
    close() {
      try {
        win.close();
      } catch {
        // Already gone. Nothing to do, and nothing worth reporting.
      }
    },
  };
}
