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
    summary: 'A guided setup, help in one place, and printable reports for the players you pick.',
    changes: [
      'A setup checklist on your dashboard takes you from an empty account to a live quiz',
      'Joined a team that already has a roster and groups? Those steps are already ticked',
      'Guides for every part of Peira now live under Help',
      'Take a short Dashboard Tour to learn where everything is',
      'Pick players on your roster and print one performance report covering all of them',
      'Reports show only your own quizzes, and never count an ungraded answer as wrong',
      'Add an image while you create a question, instead of saving and coming back',
    ],
  },
  {
    id: '2026.08.2',
    date: 'August 8, 2026',
    title: 'Playbook Quiz, Admin View, and deeper folders',
    summary: 'Turn a playbook into questions, and see across your staff when you need to.',
    changes: [
      'Upload a playbook and build questions straight from its pages',
      'Tap a play name and Peira reads it off the page as the answer. You type nothing',
      'On a diagram with nothing to tap, drag a box and type the answer yourself',
      'Players see the page with that spot blanked out, and type what belongs there',
      'Your playbook stays private. Players only ever see the spot you chose',
      'Admins get an Admin View: every quiz in the organization, by folder, with its owner',
      'Coach View now shows only your own quizzes, whether you are an admin or not',
      'Nest folders as deep as you like, so a season can hold camps, weeks, then quizzes',
    ],
  },
  {
    id: '2026.08.1',
    date: 'August 7, 2026',
    title: 'Draw Response',
    summary: 'A question players answer by drawing on an image.',
    changes: [
      'Ask a player to draw a route, an assignment or a fit straight onto an image',
      'Works with a finger on a phone and a mouse on a laptop',
      'Drawings save as they work, and come in with the rest of their answers',
      'Grade the drawings you get back in the quiz Results tab',
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
