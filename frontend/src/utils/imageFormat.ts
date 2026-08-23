/** What Peira can actually do with a picture, and how to say so.
 *
 * ONE LIST, TWO SURFACES, AND A SERVER THAT HAS THE FINAL SAY. The question
 * form and the annotation screen both take images, and both used to carry
 * their own copy of the allowed types - which is how the annotation screen
 * ended up doing no check at all and letting the server answer instead, a
 * round trip and a jargon message later.
 *
 * These types mirror the server's ALLOWED_IMAGE_EXTENSIONS ({png, jpg, jpeg,
 * webp}). This file is a courtesy, not the rule: the server re-validates every
 * upload and is the only thing that decides. If the two ever disagree, the
 * upload fails with the server's message, which is the correct outcome - it is
 * the one that knows.
 */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** What to put in a file input's `accept`.
 *
 * DELIBERATELY WIDER THAN WHAT WE ACCEPT, and only for phones' benefit. Given
 * a narrow list, iOS shows the photo library with most photos greyed out and
 * its HEIC-to-JPEG conversion is inconsistent; given `image/*` it converts a
 * chosen HEIC to JPEG far more reliably, so the wide filter actually produces
 * MORE usable files than the strict one did. Anything that still arrives in a
 * format we cannot read is caught below, immediately, before any upload.
 */
export const IMAGE_FILE_ACCEPT = 'image/*';

const HEIC_TYPES = ['image/heic', 'image/heif'];
const HEIC_EXTENSIONS = ['.heic', '.heif'];

function looksLikeHeic(file: File): boolean {
  const type = (file.type || '').toLowerCase();
  if (HEIC_TYPES.some((t) => type.includes(t.replace('image/', '')))) return true;
  const name = (file.name || '').toLowerCase();
  return HEIC_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** A human sentence when we cannot use this file, or null when we can.
 *
 * NO MIME TYPES. The message this replaces read "That file is a image/heic."
 * - which names the problem in a vocabulary the reader does not have, gets the
 * grammar wrong, and offers nothing to do next. A coach on a field needs to
 * know what to do, in one sentence, without knowing what a MIME type is.
 *
 * HEIC gets its own sentence because it is not a mistake - it is the DEFAULT
 * on every recent iPhone, so the coach did nothing wrong and telling them to
 * "choose a valid image" would be telling them their own camera roll is
 * invalid. Taking a new photo genuinely fixes it, because the camera capture
 * path hands back a JPEG.
 */
export function describeUnsupportedImage(file: File): string | null {
  if (ACCEPTED_IMAGE_TYPES.includes(file.type)) return null;

  if (looksLikeHeic(file)) {
    return "That's an iPhone photo in a format Peira can't read yet. Take a new photo instead, or pick a JPEG, PNG or WebP image from your library.";
  }

  /* An empty file.type is normal rather than suspicious - some Android
     pickers and some desktop drags supply no type at all - so this says the
     same helpful thing rather than treating it as a different failure. */
  return 'Peira can only use JPEG, PNG and WebP images. Take a new photo, or pick one of those.';
}
