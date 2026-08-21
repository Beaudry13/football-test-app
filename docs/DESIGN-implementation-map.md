# Claude Design implementation map

Where the approved design direction lands on the real codebase. This is a map,
not a plan to execute: nothing here has been implemented.

Read `docs/DESIGN-light-theme-migration.md` alongside it — this document says
*where the surfaces are*, that one says *what changing their colour costs*.

## The one fact that shapes everything

**The coach theme is already token-driven and already scoped.**
`styles/notebook.module.css` defines every `--nb-*` alias **on `.page`**, not
on `:root`, and every one is an alias of a `--peira-*` token in
`styles/tokens.css`. There is not a single raw colour literal in
`notebook.module.css`'s class definitions.

Three consequences:

1. The theme boundary is the `.page` class (`components/notebook/NotebookPage.tsx`).
2. **Competition reads zero `--peira-*`, `--nb-*` or `--color-*` tokens** — it
   is a self-contained palette on its own `.stage` root. Making the coach
   theme light cannot reach it.
3. The player theme is `index.css`'s `:root`, already light, and `.page`
   locally re-declares the generic `--color-*` names to shadow it. That
   shadowing is the thing to re-examine when the coach theme goes light — see
   the migration doc.

## Shared primitives (all surfaces depend on these)

| Primitive | File | Notes |
|---|---|---|
| Tabs | `components/ui/Tabs.tsx` | New (`67f2a2e`). Team + Owner. The quiz editor does **not** use it — it has its own tab strip. |
| MenuButton | `components/ui/MenuButton.tsx` + `menuPosition.ts` | `position: fixed`, viewport-clamped. Used by quiz cards, folder rows, question rows. |
| Modal | `components/ui/Modal.tsx` | **Portals outside `.page`** — reads `--peira-*` directly. Any theme change must cover it separately. |
| Alert / EmptyState / LoadingState / Icon | `components/ui/` | |
| notebook.module.css | `styles/notebook.module.css` | `.page .card .table .badge .btn*` — the de-facto design system. 42 `nb.card` uses, 11 `nb.table` uses. |
| tokens.css | `styles/tokens.css` | 52 tokens. The single file a light theme edits. |

**No Card, Badge, Table or Breadcrumb component exists, and none should be
built** — see the primitive audit in the previous work block. Card and Badge
are already shared as CSS classes; Table has two deliberately different
designs; Breadcrumb has one caller.

---

## Surface map

### Public landing page
- **Route** `/` · **Component** `pages/HomePage.tsx` · **CSS** `HomePage.module.css` (the largest module in the repo)
- **Theme** Own palette, inside `NotebookPage`. **Responsive** one `60rem` query.
- **Tests** `HomePage.test.tsx`.
- **Must not change** the Peira etymology copy; the Early Access framing.
- **Safe to change** essentially all of it — this is the freest surface.
- **Risk** it is the only surface with no logged-in state to break.

### Early Access / Request Access / Beta invite / Join org
- **Routes** `/register`, `/request-access`, `/invite/:token`, `/join/:inviteCode`
- **Components** `EarlyAccessPage`, `RequestAccessPage`, `BetaInvitePage`, `JoinOrgPage` · **CSS** `AuthPages.module.css`
- **Tests** four page suites.
- **Must not change** the wording distinction between an *invite* and a
  *request*; "Peira Invite" / "Early Access Invite", never "Access Code".
- **Safe to change** layout, type, colour. All are one-screen forms at 375px.

### Login
- **Route** `/login` · `pages/LoginPage.tsx` · `AuthPages.module.css`
- **Must not change** that the backend public-registration endpoint stays open.

### Dashboard
- **Route** `/dashboard` · `pages/DashboardPage.tsx` (+ `FolderRow.tsx`, `QuizCard.tsx`, `FirstSuccessChecklist.tsx`)
- **CSS** `DashboardPage.module.css`, `QuizCard.module.css`, `FirstSuccessChecklist.module.css`
- **Primitives** MenuButton (quiz cards, folder rows), notebook `.card`
- **Responsive** `40rem`
- **Tests** `DashboardPage.test.tsx` — the largest page suite; covers folder navigation and card menus.
- **Must not change** `FolderRow`'s `::after { inset: 0 }` stretch (it is what
  makes 92% of the row tappable), or that the card is one big link with the
  menu escaping it.
- **Safe to change** card visual design, checklist prominence, information order.
- **Risk** this is where the S1 menu-clipping bug lived. Any change to card
  `overflow` interacts with MenuButton.

### Folders
- **Route** `/folders/:folderId` · `pages/FolderPage.tsx` · `FolderPage.module.css`
- Holds the **only breadcrumb in the product** (`.breadcrumb/.crumbs/.crumb*`).
- **Tests** `FolderPage.test.tsx`.
- **Must not change** the breadcrumb walking the full ancestor chain.

### Quiz Editor (shell, questions, preview, activation)
The densest surface: **11 CSS modules, 18 test files.**
- **Route** `/quizzes/:quizId` · `pages/quiz-editor/QuizEditorPage.tsx`
- **Tabs** `QuestionsTab`, `RosterTab`, `AccessCodesTab`, `ResultsTab`
- **Own tab strip**, not `components/ui/Tabs` — wraps at 375 since `bc19aef`.
- **Sub-components** `QuestionEditor`, `ResponseRow`, `SharePeira`, `AvailableUntil`, `ExcludeQuestionDialog`, `MoveToPosition`
- **Preview** `/quizzes/:quizId/preview` — renders the **player** theme, not the coach theme. Do not "unify" it.
- **Must not change** the delivered-question invariants, the exclusion/retirement
  vocabulary, `to_player_payload`'s shape, or the OrderBadge rule (PRACTICE only).
- **Safe to change** tab styling, card design, spacing, the activation block's
  visual hierarchy.
- **Risk (highest in the app)** 18 test files pin behaviour here, and several
  assert on text. Restyling is safe; re-ordering or re-wording controls will
  break tests that are protecting real product rules.

### Playbooks
- **Routes** `/documents`, `/documents/:documentId` · `pages/documents/`
- **CSS** 4 modules incl. `RegionDraw.module.css`
- **Tests** 5 files.
- **Must not change** that playbooks are private and never shared by link; the
  page-thumbnail strip's horizontal scroll.
- **Risk** `RegionDraw` hardcodes `#4a9eff` and `#10131a` — see migration doc.

### Team / Players / Groups / Coaches
- **Routes** `/team`, `/team/groups`, `/team/coaches` under `TeamLayout` (`Outlet` shell)
- **Components** `MasterRosterPage`, `GroupsPage`, `TeamPage`, `GroupDetailPage`, `PlayerProfilePage`
- **Primitives** `components/ui/Tabs` (since `67f2a2e`), notebook `.table`
- **Tests** `TeamLayout.test.tsx` (10), `MasterRosterPage.test.tsx`, plus group/player suites.
- **Must not change** the `/roster` and `/groups` redirects; the staff-invite-request flow (a request is structurally not an invite).
- **Safe to change** table design, the roster's dense row treatment.
- **Note** `GroupDetailPage` has no `<h1>` (P2-4).

### Results
- **In-editor** `ResultsTab`; **player-facing** `ResultsView`, `PlayerHistoryPage`, `ResultsCheckPage`
- **Must not change** the grading vocabulary or the score rule — `None`, never
  `0.0`, when nothing is graded. Two frontend surfaces compute their own
  percentages **on purpose** (`PlayerHistoryPage`, `practiceSummary.ts`); do
  not unify them without a product decision.
- **Safe to change** the visual treatment of scores, chips, and the table.

### Player experience
- **Routes** `/play`, `/play/:code`, `/results`
- **Theme** `index.css` light — **already the target aesthetic**, and already
  the most phone-ready surface in the product.
- **Tests** 12 files under `pages/play/`.
- **Must not change** the light theme, the resume-by-revision rule, or
  `to_player_payload`'s security boundary.
- **Recommendation** treat the player UI as a *reference* for the light coach
  theme rather than a surface to redesign.

### Competition — separate
- **Routes** `/compete/*`, `/quizzes/:quizId/compete`
- **Deliberately outside `NotebookLayout`**; own `.stage` root; own palette;
  **zero shared tokens**; 9 test files; frozen at M2.
- **Stays dark. Do not touch.** Its isolation is already structural, not a
  convention that could be broken by accident.
