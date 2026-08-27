import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as ownerApi from '../../api/owner';
import * as authModule from '../../auth/AuthContext';
import { OwnerLayout } from './OwnerLayout';
import { OwnerOverviewPage } from './OwnerOverviewPage';
import { OwnerOrganizationsPage } from './OwnerOrganizationsPage';
import { OwnerOrganizationDetailPage } from './OwnerOrganizationDetailPage';
import { OwnerCoachesPage } from './OwnerCoachesPage';
import { relativeDay, shortDate, UNKNOWN } from './ownerFormat';
import type {
  CoachInvite,
  OwnerCoachRow,
  OwnerOrganizationDetail,
  OwnerOrganizationRow,
  PlatformOverview,
} from '../../api/types';

const overview: PlatformOverview = {
  totals: {
    organizations: 12,
    coaches: 31,
    active_players: 847,
    players: 900,
    quizzes: 142,
    graded_attempts: 3418,
    practice_attempts: 632,
    documents: 17,
  },
  windows: {
    '7': {
      new_organizations: 2,
      new_coaches: 4,
      new_quizzes: 9,
      documents_uploaded: 1,
      graded_attempts: 120,
      practice_attempts: 44,
      active_organizations: 8,
    },
    '30': {
      new_organizations: 6,
      new_coaches: 11,
      new_quizzes: 38,
      documents_uploaded: 5,
      graded_attempts: 640,
      practice_attempts: 210,
      active_organizations: 11,
    },
  },
  feature_adoption: [
    { key: 'draw_response', label: 'Draw Response', organizations: 8 },
    { key: 'practice_mode', label: 'Practice Mode', organizations: 6 },
    { key: 'groups', label: 'Groups', organizations: 5 },
    { key: 'playbook_quiz', label: 'Playbook Quiz', organizations: 4 },
    { key: 'nested_folders', label: 'Nested Folders', organizations: 2 },
  ],
  generated_at: '2026-08-10T12:00:00Z',
};

const cincy: OwnerOrganizationRow = {
  id: 1,
  name: 'Cincinnati Football',
  coaches: 4,
  active_players: 112,
  quizzes: 38,
  graded_attempts: 1842,
  practice_attempts: 632,
  last_activity: new Date().toISOString(),
  created_at: '2026-01-04T00:00:00Z',
  is_empty: false,
};

const probe: OwnerOrganizationRow = {
  id: 2,
  name: 'ZZ Prod Probe',
  coaches: 1,
  active_players: 0,
  quizzes: 0,
  graded_attempts: 0,
  practice_attempts: 0,
  last_activity: null,
  created_at: '2026-08-01T00:00:00Z',
  is_empty: true,
};

const coachRow: OwnerCoachRow = {
  id: 9,
  username: 'cincycoach',
  email: 'coach@cincy.test',
  role: 'admin',
  is_platform_owner: false,
  organization_id: 1,
  organization_name: 'Cincinnati Football',
  joined_at: '2026-01-04T00:00:00Z',
  quizzes_created: 12,
  last_attributed_activity: '2026-08-09T00:00:00Z',
};

const quietCoach: OwnerCoachRow = {
  ...coachRow,
  id: 10,
  username: 'quietcoach',
  email: 'quiet@cincy.test',
  role: 'member',
  quizzes_created: 0,
  last_attributed_activity: null,
};

const detail: OwnerOrganizationDetail = {
  id: 1,
  name: 'Cincinnati Football',
  created_at: '2026-01-04T00:00:00Z',
  last_activity: new Date().toISOString(),
  usage: {
    coaches: 4,
    active_players: 112,
    players: 130,
    groups: 6,
    folders: 9,
    quizzes: 38,
    documents: 3,
    graded_attempts: 1842,
    practice_attempts: 632,
  },
  features: [
    { key: 'practice_mode', label: 'Practice Mode', organizations: 6, used: true },
    { key: 'draw_response', label: 'Draw Response', organizations: 8, used: false },
  ],
  coaches: [coachRow, quietCoach],
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/owner" element={<OwnerOverviewPage />} />
        <Route path="/owner/organizations" element={<OwnerOrganizationsPage />} />
        <Route
          path="/owner/organizations/:organizationId"
          element={<OwnerOrganizationDetailPage />}
        />
        <Route path="/owner/coaches" element={<OwnerCoachesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Owner overview', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ownerApi, 'getPlatformOverview').mockResolvedValue(overview);
    // The access-request list loads independently of the metrics, so every
    // overview test needs it defined - empty unless the test says otherwise.
    vi.spyOn(ownerApi, 'listAccessRequests').mockResolvedValue({ access_requests: [] });
    vi.spyOn(ownerApi, 'listCoachInvites').mockResolvedValue({ coach_invites: [] });
  });

  it('shows the platform totals', async () => {
    renderAt('/owner');

    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByText('847')).toBeInTheDocument();
    expect(screen.getByText('3,418')).toBeInTheDocument();
    expect(screen.getByText('Practice attempts')).toBeInTheDocument();
  });

  it('shows both rolling windows', async () => {
    renderAt('/owner');

    expect(await screen.findByText('Last 7 days')).toBeInTheDocument();
    expect(screen.getByText('Last 30 days')).toBeInTheDocument();
  });

  it('states what "activity" means instead of leaving it to be guessed', async () => {
    renderAt('/owner');

    // The number is easy to misread as logins, so the definition is on the
    // page rather than in a doc nobody opens.
    expect(await screen.findByText(/Signing in is not counted/i)).toBeInTheDocument();
    expect(screen.getByText(/Peira does not record logins/i)).toBeInTheDocument();
  });

  it('labels feature adoption as ever-used rather than frequency', async () => {
    renderAt('/owner');

    expect(await screen.findByText(/adoption, not frequency/i)).toBeInTheDocument();
    expect(screen.getByText('Draw Response')).toBeInTheDocument();
  });

  it('invents no DAU/MAU metric', async () => {
    const { container } = renderAt('/owner');
    await screen.findByText('Feature adoption');

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\bDAU\b|\bMAU\b/);
    expect(text).not.toMatch(/last seen|logged in|last login/i);
  });
});

describe('Owner organizations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ownerApi, 'listOwnerOrganizations').mockResolvedValue({
      organizations: [cincy, probe],
      count: 2,
    });
  });

  it('lists organizations by their own registered name', async () => {
    renderAt('/owner/organizations');

    expect(await screen.findByRole('link', { name: 'Cincinnati Football' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ZZ Prod Probe' })).toBeInTheDocument();
  });

  it('flags an empty organization so leftover probes are findable', async () => {
    renderAt('/owner/organizations');

    const row = (await screen.findByRole('link', { name: 'ZZ Prod Probe' })).closest('tr');
    expect(within(row!).getByText('Empty')).toBeInTheDocument();
  });

  it('shows an em dash, not a date, when an organization has never done anything', async () => {
    renderAt('/owner/organizations');

    const row = (await screen.findByRole('link', { name: 'ZZ Prod Probe' })).closest('tr');
    // Never "Never" and never a fabricated timestamp.
    expect(within(row!).getByText(UNKNOWN)).toBeInTheDocument();
  });

  it('asks the server for only empty organizations when the filter is on', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(ownerApi, 'listOwnerOrganizations').mockResolvedValue({
      organizations: [probe],
      count: 1,
    });
    renderAt('/owner/organizations');
    await screen.findByRole('link', { name: 'ZZ Prod Probe' });

    await user.click(screen.getByRole('button', { name: 'Empty only' }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith({ search: undefined, filter: 'empty' }));
  });

  it('says emptiness is derived from data, not from the name', async () => {
    renderAt('/owner/organizations');

    expect(await screen.findByText(/never from the organization/i)).toBeInTheDocument();
  });

  it('passes the search term to the server', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(ownerApi, 'listOwnerOrganizations').mockResolvedValue({
      organizations: [cincy],
      count: 1,
    });
    renderAt('/owner/organizations');

    await user.type(screen.getByLabelText('Search organizations'), 'cincy');

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ search: 'cincy', filter: undefined }),
    );
  });

  it('offers no destructive control', async () => {
    const { container } = renderAt('/owner/organizations');
    await screen.findByRole('link', { name: 'Cincinnati Football' });

    // V1 is read-only. A destructive CONTROL appearing here should be a
    // decision, not a drift - checked against buttons and links rather than
    // page text, since the page itself says it deletes nothing.
    const controls = [
      ...container.querySelectorAll('button'),
      ...container.querySelectorAll('a'),
    ].map((el) => el.textContent ?? '');
    expect(controls.join(' ')).not.toMatch(/delete|suspend|impersonate|remove/i);
  });
});

describe('Owner organization detail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ownerApi, 'getOwnerOrganization').mockResolvedValue(detail);
  });

  it('shows identity, usage counts and the coach list', async () => {
    renderAt('/owner/organizations/1');

    expect(await screen.findByText('Cincinnati Football')).toBeInTheDocument();
    expect(screen.getByText('Groups')).toBeInTheDocument();
    expect(screen.getByText('coach@cincy.test')).toBeInTheDocument();
  });

  it('reports players as a count and never as a list of names', async () => {
    renderAt('/owner/organizations/1');
    await screen.findByText('Cincinnati Football');

    expect(screen.getByText('112')).toBeInTheDocument();
    expect(screen.getByText('Active players')).toBeInTheDocument();
    // No roster anywhere on the page.
    expect(screen.queryByText(/roster/i)).not.toBeInTheDocument();
  });

  it('shows which features this organization has used', async () => {
    renderAt('/owner/organizations/1');
    await screen.findByText('Cincinnati Football');

    const practice = screen.getByText('Practice Mode').closest('div')?.parentElement;
    expect(within(practice!).getByText('Yes')).toBeInTheDocument();
  });
});

describe('Owner coaches', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ownerApi, 'listOwnerCoaches').mockResolvedValue({
      coaches: [coachRow, quietCoach],
      count: 2,
    });
  });

  it('shows account metadata needed to support a customer', async () => {
    renderAt('/owner/coaches');

    expect(await screen.findByText('cincycoach')).toBeInTheDocument();
    expect(screen.getByText('coach@cincy.test')).toBeInTheDocument();
    // Once per coach row - both fixtures share an organization.
    expect(screen.getAllByText('Cincinnati Football')).toHaveLength(2);
  });

  it('uses the exact phrase "Last attributed activity"', async () => {
    renderAt('/owner/coaches');

    // Deliberately not "Last active", "Last login" or "Last seen" - none of
    // which the data supports.
    expect(await screen.findByText('Last attributed activity')).toBeInTheDocument();
    expect(screen.queryByText('Last active')).not.toBeInTheDocument();
    expect(screen.queryByText('Last login')).not.toBeInTheDocument();
    expect(screen.queryByText('Last seen')).not.toBeInTheDocument();
  });

  it('explains what the column can and cannot tell you', async () => {
    renderAt('/owner/coaches');

    expect(await screen.findByText(/It undercounts/i)).toBeInTheDocument();
    expect(screen.getByText(/access codes do not record which coach sent them/i)).toBeInTheDocument();
  });

  it('shows an em dash for a coach with nothing attributable', async () => {
    renderAt('/owner/coaches');

    const row = (await screen.findByText('quietcoach')).closest('tr');
    expect(within(row!).getByText(UNKNOWN)).toBeInTheDocument();
  });

  it('phrases the filter around attribution, not activity', async () => {
    renderAt('/owner/coaches');

    expect(await screen.findByRole('button', { name: 'None attributable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /inactive/i })).not.toBeInTheDocument();
  });

  it('passes the filter to the server', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(ownerApi, 'listOwnerCoaches').mockResolvedValue({
      coaches: [quietCoach],
      count: 1,
    });
    renderAt('/owner/coaches');
    await screen.findByText('quietcoach');

    await user.click(screen.getByRole('button', { name: 'None attributable' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ search: undefined, filter: 'no_activity' }),
    );
  });
});

describe('ownerFormat', () => {
  it('renders an em dash for null rather than inventing a value', () => {
    expect(relativeDay(null)).toBe(UNKNOWN);
    expect(shortDate(null)).toBe(UNKNOWN);
  });

  it('describes recency in elapsed time, which is the operator question', () => {
    expect(relativeDay(new Date().toISOString())).toBe('Today');
    expect(relativeDay(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe('3d ago');
    expect(relativeDay(new Date(Date.now() - 60 * 86_400_000).toISOString())).toBe('2mo ago');
  });

  it('survives a malformed timestamp instead of rendering "Invalid Date"', () => {
    expect(relativeDay('not-a-date')).toBe(UNKNOWN);
    expect(shortDate('not-a-date')).toBe(UNKNOWN);
  });
});

describe('OwnerLayout access', () => {
  function renderLayout(coach: { is_platform_owner: boolean } | null) {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({
      coach: coach as never,
    } as never);
    return render(
      <MemoryRouter initialEntries={['/owner']}>
        <Routes>
          <Route path="/owner" element={<OwnerLayout />}>
            <Route index element={<div>owner content</div>} />
          </Route>
          <Route path="/dashboard" element={<div>coach dashboard</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the dashboard for a platform owner', () => {
    renderLayout({ is_platform_owner: true });

    expect(screen.getByText('owner content')).toBeInTheDocument();
  });

  it('bounces a non-owner without ever naming the area', () => {
    renderLayout({ is_platform_owner: false });

    // Not just "no data" - no heading either. The API answers 404 rather than
    // 403 so that the area's existence is not confirmed; the chrome must not
    // undo that by rendering "Peira — Owner Dashboard" to anyone who guesses
    // the URL.
    expect(screen.getByText('coach dashboard')).toBeInTheDocument();
    expect(screen.queryByText(/Owner Dashboard/)).not.toBeInTheDocument();
  });
});


describe('Access requests on the owner overview', () => {
  /** WHY THIS SECTION EXISTS.
   *
   * Peira accepts access requests from the public site and has always stored
   * them correctly. What was missing was anywhere inside Peira to read them:
   * the only viewer was a Flask CLI command, so a form linked from the front
   * page could only be answered by somebody with a server shell. This is an
   * operations improvement, not a repair - nothing was ever lost.
   *
   * Read-only throughout: no approve, deny, delete, status or note exists.
   */
  const requests = [
    {
      id: 3,
      name: 'Dana Reyes',
      email: 'dana@northside.test',
      team: 'Northside HS',
      requested_at: '2026-08-20T12:00:00Z',
    },
    {
      id: 1,
      name: 'Sam Okafor',
      email: 'sam@example.test',
      team: null,
      requested_at: '2026-08-18T09:00:00Z',
    },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ownerApi, 'getPlatformOverview').mockResolvedValue(overview);
    vi.spyOn(ownerApi, 'listCoachInvites').mockResolvedValue({ coach_invites: [] });
  });

  it('lists who has asked, with name, email, team and date', async () => {
    vi.spyOn(ownerApi, 'listAccessRequests').mockResolvedValue({ access_requests: requests });
    renderAt('/owner');

    expect(await screen.findByText('Access requests')).toBeInTheDocument();
    expect(screen.getByText('Dana Reyes')).toBeInTheDocument();
    expect(screen.getByText('dana@northside.test')).toBeInTheDocument();
    expect(screen.getByText('Northside HS')).toBeInTheDocument();
    expect(screen.getByText(shortDate('2026-08-20T12:00:00Z'))).toBeInTheDocument();
  });

  it('renders a missing team as unknown rather than blank', async () => {
    vi.spyOn(ownerApi, 'listAccessRequests').mockResolvedValue({ access_requests: requests });
    renderAt('/owner');

    await screen.findByText('Sam Okafor');
    const row = screen.getByText('Sam Okafor').closest('li') as HTMLElement;
    expect(within(row).getByText(UNKNOWN)).toBeInTheDocument();
  });

  it('keeps the order the server sent, newest first', async () => {
    vi.spyOn(ownerApi, 'listAccessRequests').mockResolvedValue({ access_requests: requests });
    renderAt('/owner');

    await screen.findByText('Dana Reyes');
    const names = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    const dana = names.findIndex((t) => t.includes('Dana Reyes'));
    const sam = names.findIndex((t) => t.includes('Sam Okafor'));
    expect(dana).toBeLessThan(sam);
  });

  it('says so plainly when nobody has asked', async () => {
    vi.spyOn(ownerApi, 'listAccessRequests').mockResolvedValue({ access_requests: [] });
    renderAt('/owner');

    expect(await screen.findByText('No access requests yet.')).toBeInTheDocument();
  });

  it('OFFERS NO WAY TO ACT ON A REQUEST', async () => {
    // Read-only is the whole scope. Replying is a person writing an email.
    vi.spyOn(ownerApi, 'listAccessRequests').mockResolvedValue({ access_requests: requests });
    renderAt('/owner');

    /* Scoped to the access-requests SECTION. The page now also has a "Create
       invite" button under Coach invites, which is a different concept - an
       invite is issued to anybody, and is not an approval of this request. */
    const row = (await screen.findByText('Dana Reyes')).closest('li') as HTMLElement;
    const section = row.closest('section') as HTMLElement;
    for (const label of [/approve/i, /deny/i, /reject/i, /delete/i, /invite/i]) {
      expect(within(section).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('A FAILURE HERE DOES NOT TAKE DOWN THE DASHBOARD', async () => {
    /* The metrics are the page's reason to exist. A request list that errors
       must not replace them with a banner. */
    vi.spyOn(ownerApi, 'listAccessRequests').mockRejectedValue(new Error('boom'));
    renderAt('/owner');

    // The platform totals still render...
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByText('Practice attempts')).toBeInTheDocument();
    expect(screen.getByText('Feature adoption')).toBeInTheDocument();
    // ...and the failure is reported inside its own section.
    expect(screen.getByText('Access requests')).toBeInTheDocument();
  });

  it('a metrics failure does not hide the requests section either', async () => {
    vi.spyOn(ownerApi, 'getPlatformOverview').mockRejectedValue(new Error('nope'));
    vi.spyOn(ownerApi, 'listAccessRequests').mockResolvedValue({ access_requests: requests });
    renderAt('/owner');

    // Documents the CURRENT behaviour: the page short-circuits on a metrics
    // error, so the section is not reachable. Asserted so that if the page is
    // ever made resilient, this is a deliberate change rather than a surprise.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Dana Reyes')).not.toBeInTheDocument();
  });
});


describe('Coach invites on the owner overview', () => {
  /** A COACH INVITE IS NOT A QUIZ ACCESS CODE. A player's access code unlocks
   *  one quiz for a day; this creates an account and the organization behind
   *  it. The machinery already existed and was reachable only from a Flask CLI
   *  command - this section is what lets the owner use it. */
  const invite = (over: Partial<CoachInvite> = {}): CoachInvite => ({
    id: 1,
    token_prefix: 'K7M4',
    label: 'Coach Smith - Madeira',
    created_at: '2026-08-26T12:00:00Z',
    expires_at: '2026-09-02T12:00:00Z',
    redeemed_at: null,
    redeemed_by_coach_id: null,
    revoked_at: null,
    is_usable: true,
    status: 'pending',
    ...over,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ownerApi, 'getPlatformOverview').mockResolvedValue(overview);
    vi.spyOn(ownerApi, 'listAccessRequests').mockResolvedValue({ access_requests: [] });
  });

  it('shows each invite with its label, prefix and state', async () => {
    vi.spyOn(ownerApi, 'listCoachInvites').mockResolvedValue({ coach_invites: [invite()] });
    renderAt('/owner');

    expect(await screen.findByText('Coach invites')).toBeInTheDocument();
    // The list loads separately from the heading, so await the row itself.
    expect(await screen.findByText('Coach Smith - Madeira')).toBeInTheDocument();
    expect(screen.getByText(/PEIRA-K7M4/)).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(
      screen.getByText('Expires ' + shortDate('2026-09-02T12:00:00Z')),
    ).toBeInTheDocument();
  });

  it('NEVER shows a full code in the list', async () => {
    /* Only the SHA-256 is stored, so the plaintext cannot be re-read. A list
       that showed one would mean a leaked backup was a set of live
       account-creation grants. */
    vi.spyOn(ownerApi, 'listCoachInvites').mockResolvedValue({ coach_invites: [invite()] });
    renderAt('/owner');

    await screen.findByText('Coach Smith - Madeira');
    expect(screen.getByText(/PEIRA-K7M4\u2026/)).toBeInTheDocument();
  });

  it('shows the code ONCE when it is created, and says it will not return', async () => {
    const user = userEvent.setup();
    vi.spyOn(ownerApi, 'listCoachInvites').mockResolvedValue({ coach_invites: [] });
    vi.spyOn(ownerApi, 'createCoachInvite').mockResolvedValue({
      ...invite(),
      token: 'PEIRA-K7M4-QX92-BD3F',
    });
    renderAt('/owner');

    await user.click(await screen.findByRole('button', { name: 'Create invite' }));
    await user.type(screen.getByLabelText('Who is this for?'), 'Coach Smith');
    await user.click(screen.getByRole('button', { name: 'Create invite' }));

    expect(await screen.findByText('PEIRA-K7M4-QX92-BD3F')).toBeInTheDocument();
    expect(screen.getByText(/cannot be shown again/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
  });

  it('sends the label and the chosen expiry', async () => {
    const user = userEvent.setup();
    vi.spyOn(ownerApi, 'listCoachInvites').mockResolvedValue({ coach_invites: [] });
    const create = vi.spyOn(ownerApi, 'createCoachInvite').mockResolvedValue({
      ...invite(),
      token: 'PEIRA-AAAA-BBBB-CCCC',
    });
    renderAt('/owner');

    await user.click(await screen.findByRole('button', { name: 'Create invite' }));
    await user.type(screen.getByLabelText('Who is this for?'), 'Coach Jones');
    await user.selectOptions(screen.getByLabelText('Expires'), '14');
    await user.click(screen.getByRole('button', { name: 'Create invite' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ label: 'Coach Jones', expires_in_days: 14 }),
    );
  });

  it('copies the code to the clipboard', async () => {
    const user = userEvent.setup();
    // navigator.clipboard is getter-only in jsdom, and userEvent.setup()
    // installs its own stub - so spy on that rather than replacing it.
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined);
    vi.spyOn(ownerApi, 'listCoachInvites').mockResolvedValue({ coach_invites: [] });
    vi.spyOn(ownerApi, 'createCoachInvite').mockResolvedValue({
      ...invite(),
      token: 'PEIRA-K7M4-QX92-BD3F',
    });
    renderAt('/owner');

    await user.click(await screen.findByRole('button', { name: 'Create invite' }));
    await user.type(screen.getByLabelText('Who is this for?'), 'Coach Smith');
    await user.click(screen.getByRole('button', { name: 'Create invite' }));
    await user.click(await screen.findByRole('button', { name: 'Copy code' }));

    expect(writeText).toHaveBeenCalledWith('PEIRA-K7M4-QX92-BD3F');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('renders redeemed, expired and revoked states distinctly', async () => {
    vi.spyOn(ownerApi, 'listCoachInvites').mockResolvedValue({
      coach_invites: [
        // Labels deliberately share no word with any status, so an
        // assertion about the status cannot match the label instead.
        invite({
          id: 1, label: 'Alpha', status: 'redeemed', is_usable: false,
          redeemed_at: '2026-08-28T12:00:00Z',
        }),
        invite({ id: 2, label: 'Bravo', status: 'expired', is_usable: false }),
        invite({ id: 3, label: 'Charlie', status: 'revoked', is_usable: false }),
      ],
    });
    renderAt('/owner');

    const rowFor = async (label: string) =>
      ((await screen.findByText(label)).closest('li') as HTMLElement);

    expect(within(await rowFor('Alpha')).getByText(/^Redeemed/)).toBeInTheDocument();
    expect(within(await rowFor('Bravo')).getByText('Expired')).toBeInTheDocument();
    expect(within(await rowFor('Charlie')).getByText('Revoked')).toBeInTheDocument();
  });

  it('offers Revoke only on an invite that is still usable', async () => {
    vi.spyOn(ownerApi, 'listCoachInvites').mockResolvedValue({
      coach_invites: [
        invite({ id: 1, label: 'Still open', is_usable: true }),
        invite({ id: 2, label: 'Already used', status: 'redeemed', is_usable: false }),
      ],
    });
    renderAt('/owner');

    await screen.findByText('Still open');
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
  });

  it('says so plainly when none have been issued', async () => {
    vi.spyOn(ownerApi, 'listCoachInvites').mockResolvedValue({ coach_invites: [] });
    renderAt('/owner');

    expect(await screen.findByText('No coach invites yet.')).toBeInTheDocument();
  });

  it('A FAILURE HERE DOES NOT TAKE DOWN THE DASHBOARD', async () => {
    vi.spyOn(ownerApi, 'listCoachInvites').mockRejectedValue(new Error('boom'));
    renderAt('/owner');

    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByText('Feature adoption')).toBeInTheDocument();
    expect(screen.getByText('Coach invites')).toBeInTheDocument();
  });
});
