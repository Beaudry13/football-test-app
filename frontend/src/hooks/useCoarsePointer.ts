import { useEffect, useState } from 'react';

const COARSE = '(pointer: coarse)';

function readCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(COARSE).matches;
  } catch {
    return false;
  }
}

/** Whether the coach is driving this with a finger rather than a mouse.
 *
 * POINTER, NOT WIDTH, and the difference is the whole reason this exists. The
 * question it answers is "can this person take a photo and are keyboard
 * shortcuts meaningless to them", which is about the input device. A narrow
 * desktop window is still a desktop - it has Ctrl+V, it has drag and drop, and
 * it has no camera. A tablet at 1024px has none of those and does have one.
 * Keying the image UI off a breakpoint would get both of those backwards.
 *
 * Defaults to FALSE wherever the query cannot be run - jsdom does not
 * implement matchMedia at all. False is the safe default because the
 * desktop-shaped UI keeps every capability: paste, drag-and-drop and the file
 * picker all still work on a phone if this is wrong. The reverse is not true -
 * showing a phone "Paste an image, Ctrl+V" is showing them nothing they can
 * do.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(readCoarsePointer);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia(COARSE);
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    // Re-read on mount too: the first render used the same query, but a
    // hydration or a device-mode toggle can land between the two.
    setCoarse(query.matches);
    // Safari only grew addEventListener on MediaQueryList in 14; addListener
    // is deprecated everywhere else but is the only thing older iOS has, and
    // iOS is precisely the device this hook exists to detect.
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    }
    query.addListener?.(onChange);
    return () => query.removeListener?.(onChange);
  }, []);

  return coarse;
}
