import { useEffect } from 'react';

/** iOS-safe body scroll lock.
 *
 * `overflow: hidden` alone does NOT stop iOS Safari - the page still
 * rubber-bands, and on some versions it scrolls the document behind a fixed
 * overlay entirely. The reliable approach is to take the body out of flow
 * at a negative offset equal to the current scroll position, then put the
 * scroll position back on release. Without that restore step the player
 * returns to the top of a long quiz and loses their place, which is worse
 * than not locking at all.
 *
 * Extracted as its own hook because `ImageLightbox` currently has no scroll
 * lock whatsoever (only an Escape handler) and should adopt this too - a
 * pre-existing gap this feature happens to surface.
 */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    const { body } = document;
    const scrollY = window.scrollY;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
      overscrollBehavior: body.style.overscrollBehavior,
    };

    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';

    // Safari fires these non-standard gesture events for pinch independently
    // of Pointer Events; without preventing them the whole PAGE zooms while
    // the player is trying to zoom the image.
    const blockGesture = (event: Event) => event.preventDefault();
    document.addEventListener('gesturestart', blockGesture, { passive: false });
    document.addEventListener('gesturechange', blockGesture, { passive: false });

    return () => {
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.width = previous.width;
      body.style.overflow = previous.overflow;
      body.style.overscrollBehavior = previous.overscrollBehavior;
      window.scrollTo(0, scrollY);
      document.removeEventListener('gesturestart', blockGesture);
      document.removeEventListener('gesturechange', blockGesture);
    };
  }, [active]);
}
