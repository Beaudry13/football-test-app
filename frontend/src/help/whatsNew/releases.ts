/** The release history shown in What's New, newest first.
 *
 *  SHIPPING A RELEASE IS ONE ENTRY IN THIS ARRAY.
 *  Add it at the top, deploy. Nothing else: the newest release is simply
 *  `RELEASES[0]`, so there is no separate "latest" constant that someone can
 *  forget to bump, and no per-release UI work. Every coach whose stored
 *  `seen_version` no longer equals the new id sees the unread dot again.
 *
 *  WRITING THE COPY
 *  Say what changed and why a coach should care. No marketing language, no
 *  "we're excited to announce". A coach reads this between meetings.
 *
 *  GROUPING
 *  A release is a themed batch, not a commit. Several days of related work
 *  belong in one entry; a typo fix belongs in none.
 */
export interface Release {
  /** Stable and unique. Compared by equality against the coach's stored
   *  `whats_new_seen_version`, so it never needs to be orderable - but
   *  date-ordered ids make the file readable, which is why they look like
   *  this. Max 32 characters (the column's width). */
  id: string;
  /** Display date, e.g. "August 9, 2026". Free text: it is shown, never
   *  parsed or compared. */
  date: string;
  title: string;
  /** One line under the title, explaining the theme of the release. */
  summary: string;
  /** The meaningful changes, as short phrases. */
  changes: string[];
  /* FUTURE: screenshots and video belong here as an optional field on the
   * release - e.g. `media?: { kind: 'image' | 'video'; src: string; alt:
   * string }[]` - rendered under `changes` by ReleaseNotes. Deliberately not
   * built yet: adding the field is additive and needs no migration, because
   * nothing about a release is stored server-side. */
}

export const RELEASES: Release[] = [
  {
    id: '2026.08.3',
    date: 'August 9, 2026',
    title: 'Getting started, help, and performance reports',
    summary:
      'A guided setup for new coaches, one home for help, and a printable report across selected players.',
    changes: [
      'A Getting Started checklist on the dashboard tracks the seven steps from an empty account to a quiz your players can take',
      'If you joined a team that already has a roster and groups, those steps are already done for you',
      'A Help menu in the header with guides for every part of Peira',
      'A Dashboard Tour that walks you through the main areas',
      'Select players on your roster and generate one cumulative performance PDF for all of them',
      'The report covers only your own quizzes, and reports ungraded answers separately instead of counting them wrong',
      'Questions can now be created with their image in a single save, rather than saving first and adding the image afterwards',
    ],
  },
  {
    id: '2026.08.2',
    date: 'August 8, 2026',
    title: 'Playbook Quiz, Admin View, and deeper folders',
    summary:
      'Turn a playbook PDF into questions, and see across the organization when you need to.',
    changes: [
      'Upload playbook PDFs and build questions straight from the pages',
      'Tap a play name or call and Peira reads it off the PDF as the accepted answer - you type nothing',
      'Drag a rectangle over a diagram where there is no selectable text, and type the answer yourself',
      'Players see the page with that region masked out and type what belongs there',
      'Your source PDF is stored privately and is never served to players',
      'Admins get an Admin View showing every quiz in the organization, grouped by folder and labelled with its owner',
      'Coach View now shows only your own quizzes, for admins and coaches alike',
      'Folders nest as deeply as you need, so a season can hold camps, which hold weeks, which hold quizzes',
    ],
  },
  {
    id: '2026.08.1',
    date: 'August 7, 2026',
    title: 'Draw Response',
    summary: 'A question type players answer by drawing on an image.',
    changes: [
      'Ask a player to draw a route, an assignment or a fit directly on an image',
      'Works with a finger on a phone and a mouse on a laptop',
      'Drawings are saved as the player works and submit with the rest of their answers',
      'Submitted drawings appear in the quiz Results tab for you to grade by hand',
    ],
  },
];

/** The release a coach must have seen to be considered up to date.
 *
 *  Derived, never hand-maintained - see the note at the top of this file. */
export const LATEST_RELEASE_ID = RELEASES[0].id;

/** True when this coach has releases they have not seen.
 *
 *  Equality, not ordering: `seen` is whatever id was stored last, and any
 *  value that is not the newest id (including null, meaning "never opened")
 *  counts as unread. That is what gives every existing coach the indicator
 *  once, with no backfill. */
export function hasUnreadReleases(seenVersion: string | null): boolean {
  return seenVersion !== LATEST_RELEASE_ID;
}
