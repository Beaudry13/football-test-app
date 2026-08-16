import type { DeliveredPlayerQuestion, Question } from '../../api/types';

/** THE ATTEMPT VERSION INVARIANT, applied on the client.
 *
 * Once an attempt starts it stays on the version it was delivered. But a
 * refresh mid-quiz re-runs /validate-code, which returns the quiz as it stands
 * TODAY - so after a coach correction the client holds two versions: live
 * questions from the join, and the delivered ones from /play/start.
 *
 * This merges the delivered content ONTO the live question object rather than
 * replacing it. The renderer keeps taking an ordinary `Question`, so nothing
 * downstream had to learn about versions - and the fields that decide what the
 * player READS (text, type, options, picture, annotations) all come from the
 * record of what they were actually given.
 */
export function applyDeliveredContent(
  live: Question[],
  delivered: DeliveredPlayerQuestion[] | undefined,
): Question[] {
  // No snapshot: a pre-Phase-1 attempt. The live questions are the
  // compatibility fallback - NOT a record of what was delivered, because none
  // was ever taken.
  if (!delivered || delivered.length === 0) return live;

  const liveById = new Map(live.map((question) => [question.id, question]));

  return delivered.map((d) => {
    const base = liveById.get(d.id);
    return {
      ...base,
      id: d.id,
      question_text: d.question_text,
      question_type: d.question_type,
      options: d.options.map((o, index) => ({
        id: o.id,
        question_id: d.id,
        option_text: o.option_text,
        // The DELIVERED order. The player renderer uses array order and never
        // reads this, but the snapshot's order is the one the player saw, so
        // recording today's live position here would simply be false.
        position: index,
      })),
      image: d.image
        ? {
            // Delivered url, annotations and coordinate space - the picture the
            // player was actually shown, which after a replacement is Phase 1's
            // preserved copy.
            ...base?.image,
            image_url: d.image.image_url,
            canvas_width: d.image.canvas_width,
            annotations: d.image.annotations,
            // THE DELIVERED IMAGE'S IDENTITY WINS (Phase A). A Draw Response
            // document records this as `source.image_id`, so taking it from
            // the live question would bind a drawing to whatever the coach
            // last uploaded rather than to the picture under the player's
            // strokes. The server refuses a mismatch, so this is the client
            // half of one rule rather than a second opinion.
            //
            // Falls back to the live id only when the snapshot predates
            // Phase A and genuinely does not record one.
            id: d.image.id ?? base?.image?.id,
          }
        : null,
      // Region-backed questions only. Their picture is a signed masked render
      // and the snapshot does not record region geometry, so this comes from
      // the LIVE region - truthful only while region editing stays blocked
      // after delivery. See docs/DESIGN-delivered-question-snapshots.md.
      masked_image_url: d.masked_image_url ?? base?.masked_image_url ?? null,
    } as Question;
  });
}
