import { useLocation, useNavigate } from 'react-router-dom';

/**
 * BACK TO WHERE HE CAME FROM.
 *
 * PEIRA is connected now - a play opens from a quiz, a Rep from an install, a
 * retest from Results - and a fixed back link ("← Reps", Motion Lab's Home)
 * threw the coach somewhere he was not. The page he leaves hands the next one
 * `{ from: { to, label } }` as router state; the next page's back link reads
 * it ("← Week 7 - Central") and falls back to its usual destination.
 *
 * Safe by construction: the state lives in that history entry (it survives a
 * reload, and is simply absent in a new tab or a pasted URL, where the
 * fallback applies), only an in-app path is accepted, and nothing here calls
 * `navigate(-1)` - a back link never depends on what the browser happens to
 * hold.
 */
export interface From {
  to: string;
  label: string;
}

const SITE_TITLE = 'Peira';

/** The page's own name, from its document title - "Back" when it set none. */
export function pageLabel(): string {
  const title = document.title.trim();
  return title && !title.startsWith(SITE_TITLE) ? title : 'Back';
}

/** Where the coach is now, as the state to hand the page he is going to. */
export function fromHere(location: { pathname: string; search: string }, label: string = pageLabel()): { from: From } {
  return { from: { to: location.pathname + location.search, label } };
}

/** A `from` from router state - only an in-app path, never another site. */
export function readFrom(state: unknown): From | null {
  const from = (state as { from?: Partial<From> } | null)?.from;
  if (!from || typeof from.to !== 'string' || typeof from.label !== 'string') return null;
  if (!from.to.startsWith('/') || from.to.startsWith('//')) return null;
  return { to: from.to, label: from.label };
}

/** The back link for this page: where he came from, else `fallback`. */
export function useBackTo(fallback: From): From {
  return readFrom(useLocation().state) ?? fallback;
}

/** Keep the way back when a page rewrites its own URL (?tab=, ?teach=). */
export function keepFrom(state: unknown): { from: From } | null {
  const from = readFrom(state);
  return from ? { from } : null;
}

/** Go somewhere and leave the way back here: `go('/reps/12')` lands on the
 *  Rep with "← {this page}" as its back link. */
export function useGoFromHere(label?: string): (to: string) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return (to: string) => navigate(to, { state: fromHere(location, label) });
}
