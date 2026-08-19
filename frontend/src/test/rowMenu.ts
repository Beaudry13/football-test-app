import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

/** Open a quiz card's actions menu.
 *
 * Management actions moved off the card and behind one quiet "…" - so every
 * test that used to click Duplicate, Move or Delete directly now goes through
 * here. Named by the quiz, because a list of twenty cards has twenty of these
 * and "More" twenty times would be untestable and unusable alike.
 */
export async function openRowMenu(
  user: ReturnType<typeof userEvent.setup>,
  quizTitle: string,
) {
  await user.click(screen.getByRole('button', { name: `Actions for ${quizTitle}` }));
}
