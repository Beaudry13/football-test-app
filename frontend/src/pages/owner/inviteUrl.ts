/**
 * The URL an invited coach opens to create their Peira account.
 *
 * KEPT SEPARATE FROM THE COMPONENT ON PURPOSE, for the same reason
 * `quiz-editor/playUrl.ts` and `compete/joinUrl.ts` are: what needs guarding is
 * the CONTENT of the link - that it addresses the existing invite flow and
 * carries exactly the token and nothing else. Clipboards, share sheets and QR
 * renderers all just move a string around; the string is where a mistake would
 * matter, and a pure function is something a test can assert exactly.
 *
 * IT POINTS AT THE EXISTING REGISTRATION FLOW. `/invite/:token` is the route
 * `BetaInvitePage` already serves and that `EarlyAccessPage` already navigates
 * to for a hand-typed code. Scanning the QR and typing the code reach the same
 * screen; there is deliberately no second registration path.
 *
 * WHY THE ORIGIN IS DERIVED RATHER THAN CONFIGURED
 * -------------------------------------------------
 * Hard-coding the production domain would mean a link generated from a staging
 * build sent a coach to production. `window.location.origin` is whatever the
 * owner is actually running, so dev, preview and production are each correct by
 * construction rather than by remembering to change a constant.
 *
 * WHAT THIS LINK IS
 * -----------------
 * Unlike a quiz play link - whose access code is read off a whiteboard and is
 * not a secret - this URL CONTAINS A CREDENTIAL. Anyone holding it can create
 * one coach account and one organization. That is inherent to sending somebody
 * a registration link and is how `/invite/:token` has always worked; it is
 * stated here so nobody later treats this string as harmless. It should be sent
 * to the intended coach, not posted somewhere.
 */

/**
 * Build the registration URL for a coach invite token.
 *
 * @param token  the full invite code, e.g. "PEIRA-K7M4-QX92-BD3F"
 * @param origin defaults to the running application's origin
 */
export function inviteLink(token: string, origin?: string): string {
  const base = (origin ?? window.location.origin).replace(/\/+$/, '');
  // Encoded for the same reason playUrl encodes: user-visible data reaching a
  // URL, even though the generated alphabet cannot currently produce a
  // character that needs it.
  return `${base}/invite/${encodeURIComponent(token.trim())}`;
}
