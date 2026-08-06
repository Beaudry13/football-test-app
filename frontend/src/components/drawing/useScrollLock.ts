import { useEffect } from 'react';

/** Locks the page behind a fullscreen overlay.
 *
 * `overflow: hidden` on its own is not enough on iOS Safari - the page still
 * rubber-bands, and once it does, the touch stream the drawing board depends
 * on gets stolen mid-stroke. The reliable pattern is to take the body out of
 * flow entirely (`position: fixed`) and hold the scroll offset as a negative
 * `top`, so the page cannot move at all while the board is open.
 *
 * Doing that discards the scroll position, hence the save-and-restore: a
 * player who was halfway down a long Peira must land back on the same
 * question when the board closes, not at the top of the page.
 *
 * Every style is captured and restored verbatim, including the empty string
 * for properties that were never set, so an unexpected unmount (navigation,
 * an error boundary, a hot reload) cannot leave the app permanently unable
 * to scroll.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    const { body, documentElement } = document;
    const scrollY = window.scrollY;

    const previous = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
      overscrollBehavior: body.style.overscrollBehavior,
      htmlOverscrollBehavior: documentElement.style.overscrollBehavior,
    };

    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    // Without an explicit width, `position: fixed` collapses the body to its
    // content width, which reflows the page underneath and makes the restored
    // scroll position land somewhere else.
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    // Blocks pull-to-refresh and scroll chaining, both of which otherwise
    // interrupt a stroke that starts near the top or bottom edge.
    body.style.overscrollBehavior = 'none';
    documentElement.style.overscrollBehavior = 'none';

    return () => {
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.left = previous.left;
      body.style.right = previous.right;
      body.style.width = previous.width;
      body.style.overflow = previous.overflow;
      body.style.overscrollBehavior = previous.overscrollBehavior;
      documentElement.style.overscrollBehavior = previous.htmlOverscrollBehavior;
      // Restored after the styles, or the browser clamps the scroll to a
      // page that is still fixed and zero-height.
      window.scrollTo(0, scrollY);
    };
  }, [active]);
}
