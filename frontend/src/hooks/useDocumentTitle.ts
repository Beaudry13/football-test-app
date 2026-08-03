import { useEffect } from 'react';

/** Sets `document.title` while mounted, restoring whatever it was before on
 * unmount. `title` is optional so a caller can wire this up before a title
 * has loaded yet (e.g. a quiz-title fetch still in flight) without setting
 * a blank tab title in the meantime - a falsy value is a no-op. */
export function useDocumentTitle(title?: string | null): void {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
