/** Peira's three primary destinations.
 *
 * ONE LIST, TWO PRESENTATIONS. The top header shows these on a desktop; the
 * fixed bottom bar shows them on a phone. They are never both on screen -
 * showing a coach the same three destinations twice would spend the vertical
 * space this arrangement exists to give back.
 *
 * `isActive` is a PREFIX check, not an exact match, so that being deep inside
 * a section still lights that section: /quizzes/5 keeps Quizzes lit, and
 * /roster/12 keeps Team lit. It lives here rather than in either component so
 * the two can never disagree about which destination a coach is in.
 */
export interface SectionLink {
  to: string;
  label: string;
  isActive: (path: string) => boolean;
  /** Labels this link as tourable. An attribute, not a class, so restyling
   *  can never silently unhook the tour. */
  tour?: string;
}

export const SECTION_LINKS: SectionLink[] = [
  {
    to: '/dashboard',
    label: 'Quizzes',
    isActive: (path) => path === '/dashboard' || path.startsWith('/quizzes'),
  },
  {
    to: '/documents',
    label: 'Playbooks',
    isActive: (path) => path.startsWith('/documents'),
    tour: 'playbooks',
  },
  // ONE DESTINATION FOR PEOPLE. Roster, Groups and Team were three tabs all
  // describing people in the same program - and "Roster" and "Team" are the
  // same word to most coaches, so which one held what was something to
  // remember rather than something to read. They are now areas inside Team;
  // see TeamLayout.tsx.
  //
  // isActive still covers the old paths because /roster/:playerId and
  // /groups/:groupId are still real destinations - opening one player should
  // keep Team lit rather than leaving no section active at all.
  {
    to: '/team',
    label: 'Team',
    isActive: (path) =>
      path.startsWith('/team') || path.startsWith('/roster') || path.startsWith('/groups'),
    tour: 'roster',
  },
];
