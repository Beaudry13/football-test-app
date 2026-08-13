/**
 * The public URL a player scans to reach one competition's join screen.
 *
 * KEPT SEPARATE FROM THE QR COMPONENT ON PURPOSE. What actually needs
 * guarding here is the CONTENT of the link - that it addresses the right
 * competition, and that it carries nothing private. A QR renderer turns a
 * string into squares; the string is where a mistake would matter, and a pure
 * function is something a test can assert on exactly.
 *
 * WHY THE ORIGIN IS DERIVED RATHER THAN CONFIGURED
 * -------------------------------------------------
 * Hard-coding the production domain would mean a QR projected from a staging
 * build sent a room to production, which is the sort of thing nobody notices
 * until thirty people are in the wrong place. `window.location.origin` is
 * whatever the coach is actually running, so dev, preview and production are
 * each correct by construction rather than by remembering to change a
 * constant.
 *
 * In local development this naturally encodes http://localhost:5173/..., which
 * a phone on another device cannot reach. That is correct rather than broken -
 * the QR points at the server the coach is really using. Running the dev server
 * with `--host` and opening it by LAN address makes the QR work on a phone too.
 *
 * WHAT MUST NEVER GO IN HERE
 * ---------------------------
 * The join code is public - it is projected on a wall in letters a foot high,
 * so putting it in a URL reveals nothing new. Everything else about a
 * competition is not: the reconnect token is a seat CREDENTIAL, and the coach's
 * JWT is an account credential. A URL is the worst place for either, because it
 * lands in browser history, access logs and Referer headers - which is exactly
 * why the token travels in a header (see COMPETITION-API.md §1.1). Nothing but
 * the code is accepted below, and a test asserts the result carries no query
 * string at all.
 */

/** The route a scanned code should land on - the identity picker, not a seat. */
export const JOIN_ROUTE = '/compete/:code/join';

/**
 * Build the scannable join URL for a competition.
 *
 * @param code   the public six-character join code
 * @param origin defaults to the running application's origin
 */
export function competitionJoinUrl(code: string, origin?: string): string {
  const base = (origin ?? window.location.origin).replace(/\/+$/, '');
  // Uppercased to match what is on the projector, and encoded because a code
  // is user-visible data reaching a URL - even though the alphabet cannot
  // currently produce a character that needs it.
  const safe = encodeURIComponent(code.trim().toUpperCase());
  return `${base}/compete/${safe}/join`;
}
