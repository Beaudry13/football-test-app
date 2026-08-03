// Netlify Edge Function (Deno runtime) - rewrites the SPA shell's
// <title>/og:title/og:description on /play/CODE URLs before it reaches the
// requester, so a link-preview crawler (which never executes the client's
// JS, unlike a real player's browser) sees the actual Peira's name rather
// than generic branding. See netlify.toml's [[edge_functions]] block for
// the path match, and frontend/src/hooks/useDocumentTitle.ts + PlayPage.tsx
// for the equivalent client-side tab-title fix a real browser gets instead.
import { HTMLRewriter } from 'https://deno.land/x/html_rewriter@v0.1.0-pre.17/index.ts';
import type { Config, Context } from '@netlify/edge-functions';

const API_BASE_URL = 'https://football-quiz-backend-d2f5.onrender.com/api';
const DEFAULT_TITLE = 'Peira | Know it before you play it';
const DEFAULT_DESCRIPTION =
  "Peira helps coaches create, distribute, and analyze football knowledge assessments so players can master their assignments, prepare with confidence, and play faster.";

function extractCode(pathname: string): string | null {
  const match = pathname.match(/^\/play\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default async (request: Request, context: Context): Promise<Response> => {
  const response = await context.next();

  const code = extractCode(new URL(request.url).pathname);
  if (!code) return response;

  let title = DEFAULT_TITLE;
  let description = DEFAULT_DESCRIPTION;

  try {
    // Same lightweight, never-errors-on-a-bad-code lookup the client uses
    // (backend/app/routes/play.py's GET /play/quiz-by-code/<code>) - a
    // fetch failure or a null quiz_title (invalid/expired/deactivated code)
    // both fall through to the generic Peira tags already in index.html,
    // rather than this function failing the whole page load.
    const apiResponse = await fetch(`${API_BASE_URL}/play/quiz-by-code/${encodeURIComponent(code)}`);
    if (apiResponse.ok) {
      const data = await apiResponse.json();
      if (data.quiz_title) {
        title = `${data.quiz_title} | Peira`;
        description = `You've been invited to take "${data.quiz_title}" on Peira. Know it before you play it.`;
      }
    }
  } catch {
    // Fall through to the generic Peira tags.
  }

  return new HTMLRewriter()
    .on('title', {
      element(element) {
        element.setInnerContent(title);
      },
    })
    .on('meta[property="og:title"]', {
      element(element) {
        element.setAttribute('content', title);
      },
    })
    .on('meta[property="og:description"]', {
      element(element) {
        element.setAttribute('content', description);
      },
    })
    .on('meta[name="twitter:title"]', {
      element(element) {
        element.setAttribute('content', title);
      },
    })
    .on('meta[name="twitter:description"]', {
      element(element) {
        element.setAttribute('content', description);
      },
    })
    .transform(response);
};

export const config: Config = {
  path: '/play/*',
};
