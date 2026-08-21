/** The Dashboard Tour, as data.
 *
 *  TARGETS ARE `data-tour` ATTRIBUTES, NEVER CSS CLASSES OR DOM SHAPE.
 *  A class name is a styling decision that changes whenever the design does;
 *  a `data-tour` attribute is a promise that something is tourable. The
 *  dashboard labels its regions and knows nothing about this file - which is
 *  what stops a layout change from silently breaking the tour.
 *
 *  Every target here is allowed to be absent. A step whose target cannot be
 *  found is skipped, never fatal (see DashboardTour) - that is what makes
 *  "Admin View, admins only" fall out of the data rather than needing a role
 *  check, and what keeps the tour working while the dashboard evolves.
 */
export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** One selector, or several unioned into a single spotlight. "Roster &
   *  Groups" is one idea living in two adjacent nav links, and lighting them
   *  separately would be two tooltips 40px apart saying nearly the same
   *  thing. */
  target: string | string[];
}

export const DASHBOARD_TOUR: TourStep[] = [
  {
    id: 'quizzes',
    title: 'My Quizzes',
    body: 'Your quizzes live here. Create, organize, and open them from this workspace — each quiz holds its own questions, roster and results.',
    target: '[data-tour="quizzes"]',
  },
  {
    id: 'folders',
    title: 'Folders',
    body: 'Use folders to organize quizzes by season, week, install, opponent, or however your staff works.',
    target: '[data-tour="folders"]',
  },
  {
    id: 'playbooks',
    title: 'Playbooks',
    body: 'Upload PDFs and turn playbook pages directly into quiz questions.',
    target: '[data-tour="playbooks"]',
  },
  {
    id: 'roster_groups',
    title: 'Roster & Groups',
    body: 'Your roster is everyone in the organization. Groups are the units inside it — position groups, first team, or any group you want to assign a quiz to.',
    target: ['[data-tour="roster"]', '[data-tour="groups"]'],
  },
  {
    id: 'help',
    title: 'Help',
    body: 'Come back here anytime for guides, the Dashboard Tour, and product updates.',
    target: '[data-tour="help"]',
  },
  {
    // Present only for admins. No role check anywhere - the element simply
    // is not in a member's header, and a missing target is skipped.
    id: 'admin_view',
    title: 'Admin View',
    body: 'Your name opens your account menu, and Admin View is inside it. Admin View lets you see and manage quizzes across the entire organization; your normal Coach View still shows only your own work.',
    target: '[data-tour="admin-view"]',
  },
];

/** Selectors for a step, always as a list. */
export function selectorsOf(step: TourStep): string[] {
  return Array.isArray(step.target) ? step.target : [step.target];
}
