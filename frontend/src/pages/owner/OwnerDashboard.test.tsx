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
