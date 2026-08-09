import type { ReactNode } from 'react';
import { PeiraLogo } from '../components/brand/PeiraLogo';
import styles from './Help.module.css';

/** What a menu entry does when clicked.
 *
 *  'article'  opens its `body` in a modal - the default, and all a new help
 *             topic ever needs to be.
 *  'action'   runs something instead of reading something (restoring the
 *             setup checklist).
 *  'pending'  is listed but not built yet. It renders disabled with a
 *             "Coming soon" tag rather than as a button that silently does
 *             nothing - a dead control teaches a coach the menu is broken. */
export type HelpEntryKind = 'article' | 'action' | 'pending';

/** What an action entry can ask the app to do.
 *
 *  Passed in by HelpMenu rather than imported here, so the registry stays a
 *  data file with no knowledge of routing or API calls. */
export interface HelpActionContext {
  restoreChecklist: () => Promise<void>;
}

export interface HelpEntry {
  id: string;
  title: string;
  /** One line under the title in the menu. Doubles as the answer to "is this
   *  the one I want" without opening it. */
  summary: string;
  kind: HelpEntryKind;
  /** Articles only. A function so the JSX is not built until it is opened. */
  body?: () => ReactNode;
  /** Actions only. */
  run?: (context: HelpActionContext) => Promise<void> | void;
}

/** Every help topic, in menu order.
 *
 *  THE POINT OF THIS FILE: adding a topic is appending one entry. HelpMenu
 *  maps over this list and knows nothing about what is in it, so no help
 *  content ever requires touching a component. Tours and What's New will
 *  arrive as entries here too, not as new branches in the menu.
 */
export const HELP_ENTRIES: HelpEntry[] = [
  {
    id: 'getting_started',
    title: 'Getting Started',
    summary: 'The seven steps from empty account to a quiz your players can take.',
    kind: 'article',
    body: () => (
      <>
        <p className={styles.body}>
          Peira works in one direction: build a quiz, build a roster, then connect the two.
          The setup checklist on your dashboard walks the same seven steps.
        </p>
        <ol className={styles.list}>
          <li>Create a quiz - a set of questions you send to your players.</li>
          <li>Add a question to it.</li>
          <li>Build your roster, by hand or by uploading your team.</li>
          <li>Create a group for a position or unit.</li>
          <li>Add players from your roster into that group.</li>
          <li>Activate the quiz. This creates the code players use to join.</li>
          <li>Assign the quiz to a group, so only those players can take it.</li>
        </ol>
        <p className={styles.body}>
          If you joined a team that already has a roster and groups, those steps are already
          done for you - you only need your own quiz.
        </p>
      </>
    ),
  },
  {
    id: 'dashboard_tour',
    title: 'Dashboard Tour',
    summary: 'A guided walk through the dashboard.',
    kind: 'pending',
  },
  {
    id: 'first_quiz',
    title: 'Creating Your First Quiz',
    summary: 'Question types, images, and what a quiz needs before it can be activated.',
    kind: 'article',
    body: () => (
      <>
        <p className={styles.body}>
          Create a quiz from the dashboard, then open it to add questions. Every question has
          a type:
        </p>
        <ul className={styles.list}>
          <li>
            <strong>True / False</strong> and <strong>Multiple Choice</strong> are graded
            automatically.
          </li>
          <li>
            <strong>Short Answer</strong> is typed by the player and graded by you afterwards.
          </li>
          <li>
            <strong>Draw Response</strong> asks the player to draw on an image.
          </li>
        </ul>
        <p className={styles.body}>
          You can attach an image while creating a question, and annotate it afterwards. A
          quiz cannot be activated until it has at least one question, and every Draw Response
          question has an image.
        </p>
      </>
    ),
  },
  {
    id: 'playbook_quiz',
    title: 'Playbook Quiz',
    summary: 'Turn a playbook PDF into questions by tapping the page.',
    kind: 'article',
    body: () => (
      <>
        <p className={styles.body}>
          Upload a playbook under Playbooks and Peira renders each page. Your source PDF is
          stored privately and is never served to players.
        </p>
        <p className={styles.body}>
          On a page, <strong>tap</strong> a play name or call and Peira reads it straight off
          the PDF as the accepted answer - you type nothing. On a diagram with no selectable
          text, <strong>drag</strong> a rectangle instead and type the answer yourself. Both
          work on the same page with no mode to switch.
        </p>
        <p className={styles.body}>
          Players see the page with that region masked out, and type what belongs there.
        </p>
      </>
    ),
  },
  {
    id: 'draw_response',
    title: 'Draw Response',
    summary: 'Questions players answer by drawing on an image.',
    kind: 'article',
    body: () => (
      <>
        <p className={styles.body}>
          A Draw Response question shows the player an image and asks them to draw on it -
          a route, an assignment, a fit. They answer with a finger on a phone or a mouse on a
          laptop.
        </p>
        <p className={styles.body}>
          Set the question type to Draw Response and give it an image. The quiz cannot be
          activated until it has one. Drawings arrive in the quiz&rsquo;s Results tab, where you
          grade them by hand alongside written answers.
        </p>
      </>
    ),
  },
  {
    id: 'folders',
    title: 'Folders & Organization',
    summary: 'Keeping quizzes findable as the season goes on.',
    kind: 'article',
    body: () => (
      <>
        <p className={styles.body}>
          Folders group your quizzes - by install, by week, by opponent. They nest as deeply as
          you need, so a season can hold camps, which hold weeks, which hold quizzes.
        </p>
        <p className={styles.body}>
          A quiz with no folder sits under Uncategorized. Deleting a folder never deletes its
          quizzes; they move to Uncategorized instead.
        </p>
        <p className={styles.body}>
          Your dashboard shows the quizzes you created. Admins also get an Admin View with
          every quiz in the organization, grouped by folder and labelled with its owner.
        </p>
      </>
    ),
  },
  {
    id: 'players_groups',
    title: 'Players & Groups',
    summary: 'One roster for the team, groups for the units inside it.',
    kind: 'article',
    body: () => (
      <>
        <p className={styles.body}>
          Your <strong>roster</strong> is the whole team - one record per player, shared by
          every coach in your organization. Add players by hand, or paste rows straight from a
          spreadsheet.
        </p>
        <p className={styles.body}>
          <strong>Groups</strong> are the units inside it: linebackers, first team, freshmen. A
          player can be in as many as you like. When you activate a quiz you choose which
          groups can take it, so a defensive install never reaches the offence.
        </p>
      </>
    ),
  },
  {
    id: 'results',
    title: 'Results & Analytics',
    summary: 'Grading, scores, and what the numbers do and do not count.',
    kind: 'article',
    body: () => (
      <>
        <p className={styles.body}>
          Each quiz has a Results tab showing who submitted and what they answered. Multiple
          choice and true/false are graded on arrival; written and drawn answers are marked
          correct or incorrect by you.
        </p>
        <p className={styles.body}>
          A score counts only what has actually been graded - answers you have not marked yet,
          and questions nobody answered, are left out rather than counted as wrong. A quiz with
          nothing graded shows no score at all instead of 0%.
        </p>
        <p className={styles.body}>Results export as PDF or CSV.</p>
      </>
    ),
  },
  {
    id: 'what_is_peira',
    title: 'What is Peira?',
    summary: 'Where the name comes from.',
    kind: 'article',
    // Moved here verbatim from the standalone modal that used to open by
    // itself on a coach's first visit. Same words, now something a coach
    // chooses to read rather than something between them and their work.
    body: () => (
      <>
        <div className={styles.mark}>
          <PeiraLogo variant="dark" markOnly size={40} />
        </div>
        <p className={styles.body}>
          In Greek, <em className={styles.emphasis}>pe&icirc;ra</em> (&pi;&epsilon;&#8150;&rho;&alpha;) means{' '}
          <em className={styles.emphasis}>trial, test, proof through experience</em>.
        </p>
        <p className={styles.body}>
          Every quiz you send your team is a trial - a chance for them to prove what they know.
          This is your coach dashboard: build trials, send them to your roster, and track who
          rises to the challenge.
        </p>
      </>
    ),
  },
  {
    id: 'whats_new',
    title: "What's New",
    summary: 'Recent changes to Peira.',
    kind: 'pending',
  },
];

/** Listed separately from the topics, and rendered below them: it changes the
 *  app rather than explaining it, and mixing a control in among the reading
 *  material invites a misclick. */
export const HELP_ACTIONS: HelpEntry[] = [
  {
    id: 'show_checklist',
    title: 'Show Getting Started Checklist',
    summary: 'Bring the setup checklist back to your dashboard.',
    kind: 'action',
    run: (context) => context.restoreChecklist(),
  },
];
