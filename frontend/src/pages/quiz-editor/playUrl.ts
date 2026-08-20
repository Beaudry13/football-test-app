/**
 * The public URL a player opens to take one activated Peira.
 *
 * KEPT SEPARATE FROM THE SHARE COMPONENT ON PURPOSE, for the same reason
 * `compete/joinUrl.ts` is separate from its QR: what needs guarding is the
 * CONTENT of the link - that it addresses the right quiz and carries nothing
 * private. Share sheets, clipboards and QR renderers all just move a string
 * around; the string is where a mistake would matter, and a pure function is
 * something a test can assert exactly.
 *
 * WHY THE ORIGIN IS DERIVED RATHER THAN CONFIGURED
 * -------------------------------------------------
 * Hard-coding the production domain would mean a link shared from a staging
 * build sent a squad to production. `window.location.origin` is whatever the
 * coach is actually running, so dev, preview and production are each correct
 * by construction rather than by remembering to change a constant.
 *
 * In local development this encodes http://localhost:5173/..., which a phone
 * on another device cannot reach. That is correct rather than broken - it
 * points at the server the coach is really using. `npm run dev -- --host` and
 * opening by LAN address makes it reachable from a phone too.
 *
 * WHAT MUST NEVER GO IN HERE
 * ---------------------------
 * The access code is public - it is read off a whiteboard and typed by
 * fourteen-year-olds, so putting it in a URL reveals nothing new. The coach's
 * JWT is not, and a URL is the worst place for it: links land in browser
 * history, access logs, Referer headers and, once shared, in a group text read
 * by twenty people. Nothing but the code is accepted below.
 */

/**
 * Build the shareable play URL for an activated access code.
 *
 * @param code   the public access code
 * @param origin defaults to the running application's origin
 */
export function playLink(code: string, origin?: string): string {
  const base = (origin ?? window.location.origin).replace(/\/+$/, '');
  // Encoded because a code is user-visible data reaching a URL, even though
  // the generated alphabet cannot currently produce a character that needs it.
  return `${base}/play/${encodeURIComponent(code.trim())}`;
}
