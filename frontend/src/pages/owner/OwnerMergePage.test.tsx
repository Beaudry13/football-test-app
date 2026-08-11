import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as ownerApi from '../../api/owner';
import { OwnerMergePage } from './OwnerMergePage';
import type { MergePreview, OwnerOrganizationRow } from '../../api/types';

const counts = {
  coaches: 1,
  players: 2,
  quizzes: 3,
  groups: 1,
  folders: 3,
  playbooks: 0,
  invitations: 1,
  questions: 4,
  access_codes: 2,
  graded_attempts: 5,
  practice_attempts: 1,
  answers: 6,
  answer_drawings: 0,
  document_pages: 0,
};

const orgs: OwnerOrganizationRow[] = [
  {
    id: 2,
    name: 'University of Cincinnati',
    coaches: 3,
    active_players: 100,
    quizzes: 10,
    graded_attempts: 100,
    practice_attempts: 0,
    last_activity: null,
    created_at: '2026-01-01T00:00:00Z',
    is_empty: false,
  },
  {
    id: 11,
    name: 'Cincinnati',
    coaches: 1,
    active_players: 6,
    quizzes: 1,
    graded_attempts: 7,
    practice_attempts: 0,
    last_activity: null,
    created_at: '2026-02-01T00:00:00Z',
    is_empty: false,
  },
];

const preview: MergePreview = {
  source: { id: 11, name: 'Cincinnati', counts },
  destination: { id: 2, name: 'University of Cincinnati', counts },
  coaches: [
    {
      coach_id: 9,
      username: 'willhoge3',
      email: 'will.hoge3@gmail.com',
      current_role: 'ADMIN',
      new_role: 'MEMBER',
      is_platform_owner: false,
      requires_decision: true,
      widens_access: false,
    },
  ],
  possible_duplicate_players: [
    { normalized_name: 'jordan smith', source_player_ids: [4], destination_player_ids: [9] },
  ],
  name_collisions: [{ type: 'groups', name: 'linebackers' }],
  invitations_to_revoke: 1,
  resulting_destination_counts: counts,
  warnings: ['1 invitation(s) will be revoked rather than redirected.'],
  blockers: [],
  requires_acknowledgement: { collisions: true, duplicate_players: true, coach_roles: [9] },
  fingerprint: 'f'.repeat(64),
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/owner/organizations/2/merge']}>
      <Routes>
        <Route path="/owner/organizations/:organizationId/merge" element={<OwnerMergePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function selectSource(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(await screen.findByLabelText('Source organization'), '11');
  await screen.findByText(/WILL BE REMOVED/);
}

describe('Owner merge page', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ownerApi, 'listOwnerOrganizations').mockResolvedValue({
      organizations: orgs,
      count: 2,
    });
    vi.spyOn(ownerApi, 'previewMerge').mockResolvedValue(preview);
  });

  it('names which organization disappears', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectSource(user);

    // "Confirm" would not tell you which one is destroyed.
    expect(screen.getByText(/WILL BE REMOVED/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Merge Cincinnati into University of Cincinnati' }),
    ).toBeInTheDocument();
  });

  it('shows the current role and offers both destination roles', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectSource(user);

    expect(screen.getByText('ADMIN — Cincinnati')).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /Member — University of Cincinnati/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /Admin — University of Cincinnati/ }),
    ).toBeInTheDocument();
  });

  it('keeps the merge button disabled until every gate is satisfied', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectSource(user);

    const button = screen.getByRole('button', {
      name: 'Merge Cincinnati into University of Cincinnati',
    });
    expect(button).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: /Member — University of Cincinnati/ }));
    expect(button).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: /remain separate people/i }));
    expect(button).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: /both copies will survive/i }));
    expect(button).toBeDisabled();

    // The last gate: the exact source name.
    await user.type(
      screen.getByLabelText('Type the source organization name to confirm'),
      'Cincinnati',
    );
    expect(button).toBeEnabled();
  });

  it('rejects a near-miss confirmation string', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectSource(user);
    await user.click(screen.getByRole('checkbox', { name: /remain separate people/i }));
    await user.click(screen.getByRole('checkbox', { name: /both copies will survive/i }));

    await user.type(
      screen.getByLabelText('Type the source organization name to confirm'),
      'University of Cincinnati',
    );

    expect(
      screen.getByRole('button', { name: 'Merge Cincinnati into University of Cincinnati' }),
    ).toBeDisabled();
  });

  it('sends the fingerprint and both acknowledgements when merging', async () => {
    const user = userEvent.setup();
    const execute = vi.spyOn(ownerApi, 'executeMerge').mockResolvedValue({
      merged: true,
      audit_id: 1,
      source: { id: 11, name: 'Cincinnati' },
      destination: { id: 2, name: 'University of Cincinnati' },
      counts_moved: {},
      invitations_revoked: 1,
    });
    renderPage();
    await selectSource(user);
    await user.click(screen.getByRole('radio', { name: /Member — University of Cincinnati/ }));
    await user.click(screen.getByRole('checkbox', { name: /remain separate people/i }));
    await user.click(screen.getByRole('checkbox', { name: /both copies will survive/i }));
    await user.type(
      screen.getByLabelText('Type the source organization name to confirm'),
      'Cincinnati',
    );
    await user.click(
      screen.getByRole('button', { name: 'Merge Cincinnati into University of Cincinnati' }),
    );

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          source_organization_id: 11,
          destination_organization_id: 2,
          fingerprint: 'f'.repeat(64),
          acknowledge_collisions: true,
          acknowledge_duplicate_players: true,
        }),
      ),
    );
  });

  it('re-previews when a role decision changes, so the consequence is visible first', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(ownerApi, 'previewMerge').mockResolvedValue(preview);
    renderPage();
    await selectSource(user);
    spy.mockClear();

    await user.click(screen.getByRole('radio', { name: /Admin — University of Cincinnati/ }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ coach_roles: { '9': 'ADMIN' } }),
      ),
    );
  });

  it('states that duplicate players are not combined', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectSource(user);

    expect(screen.getByText(/Same name is not proof of the same person/i)).toBeInTheDocument();
    expect(screen.getByText(/each keeps its own id and history/i)).toBeInTheDocument();
    const row = screen.getByText('jordan smith').closest('tr');
    expect(within(row!).getByText('4')).toBeInTheDocument();
    expect(within(row!).getByText('9')).toBeInTheDocument();
  });

  it('does not offer the destination as its own source', async () => {
    renderPage();
    const select = await screen.findByLabelText('Source organization');

    expect(within(select).queryByText('University of Cincinnati')).not.toBeInTheDocument();
    expect(within(select).getByText('Cincinnati')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------
  // REGRESSION: the exact production dead end.
  //
  // Destination has coaches, source has one ADMIN, no decision supplied.
  // The old UI bound a <select> to the server's computed new_role - already
  // "MEMBER" - so picking Member selected an already-selected option and
  // fired no change event. The safe choice was literally unselectable, and
  // `ready` never checked coach_roles, so the merge button enabled anyway and
  // the backend's refusal surfaced only after clicking Merge.
  // -------------------------------------------------------------------

  it('renders the source admin and an undecided role control', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectSource(user);

    expect(screen.getByText('Coach roles after merge')).toBeInTheDocument();
    expect(screen.getByText('willhoge3')).toBeInTheDocument();
    expect(screen.getByText('will.hoge3@gmail.com')).toBeInTheDocument();
    expect(screen.getByText('ADMIN — Cincinnati')).toBeInTheDocument();

    const member = screen.getByRole('radio', { name: /Member — University of Cincinnati/ });
    const admin = screen.getByRole('radio', { name: /Admin — University of Cincinnati/ });
    // NEITHER is preselected - that is what makes choosing Member a real event.
    expect(member).not.toBeChecked();
    expect(admin).not.toBeChecked();
    expect(screen.getByText('Decision required')).toBeInTheDocument();
  });

  it('blocks the merge until the role decision is made', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectSource(user);
    await user.click(screen.getByRole('checkbox', { name: /remain separate people/i }));
    await user.click(screen.getByRole('checkbox', { name: /both copies will survive/i }));
    await user.type(
      screen.getByLabelText('Type the source organization name to confirm'),
      'Cincinnati',
    );

    // Everything else satisfied, but the role is still undecided.
    expect(
      screen.getByRole('button', { name: 'Merge Cincinnati into University of Cincinnati' }),
    ).toBeDisabled();
    expect(screen.getByText(/Choose a role for every source coach/i)).toBeInTheDocument();
  });

  it('selecting MEMBER re-previews with the explicit decision and clears the blocker', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(ownerApi, 'previewMerge').mockResolvedValue(preview);
    renderPage();
    await selectSource(user);
    spy.mockClear();

    await user.click(screen.getByRole('radio', { name: /Member — University of Cincinnati/ }));

    // The decision reaches the server - the whole point of the fix.
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ coach_roles: { '9': 'MEMBER' } }),
      ),
    );
    expect(
      screen.getByRole('radio', { name: /Member — University of Cincinnati/ }),
    ).toBeChecked();
    await waitFor(() =>
      expect(screen.queryByText(/still required before this merge/i)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('Decision required')).not.toBeInTheDocument();
    expect(screen.getByText('Does not widen access')).toBeInTheDocument();
  });

  it('shows the full merge preview alongside the decision, not instead of it', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectSource(user);

    // The rest of the preview must remain visible while a decision is pending.
    expect(screen.getByText('What moves')).toBeInTheDocument();
    expect(screen.getByText(/WILL BE REMOVED/)).toBeInTheDocument();
    expect(screen.getByText('Possible duplicate players')).toBeInTheDocument();
  });

  it('choosing ADMIN warns that access is widened', async () => {
    const user = userEvent.setup();
    const widened: MergePreview = {
      ...preview,
      coaches: [{ ...preview.coaches[0], new_role: 'ADMIN', widens_access: true }],
      warnings: [
        ...preview.warnings,
        "will.hoge3@gmail.com will KEEP ADMIN and gain Admin View over University of Cincinnati's data.",
      ],
    };
    const spy = vi.spyOn(ownerApi, 'previewMerge').mockResolvedValue(preview);
    renderPage();
    await selectSource(user);
    spy.mockResolvedValue(widened);

    await user.click(screen.getByRole('radio', { name: /Admin — University of Cincinnati/ }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ coach_roles: { '9': 'ADMIN' } })),
    );
    await waitFor(() => expect(screen.getByText('Widens access')).toBeInTheDocument());
    expect(screen.getByText(/will KEEP ADMIN and gain Admin View/i)).toBeInTheDocument();
  });

  it('an explicit MEMBER decision is what reaches execute', async () => {
    const user = userEvent.setup();
    const execute = vi.spyOn(ownerApi, 'executeMerge').mockResolvedValue({
      merged: true,
      audit_id: 1,
      source: { id: 11, name: 'Cincinnati' },
      destination: { id: 2, name: 'University of Cincinnati' },
      counts_moved: {},
      invitations_revoked: 1,
    });
    renderPage();
    await selectSource(user);
    await user.click(screen.getByRole('radio', { name: /Member — University of Cincinnati/ }));
    await user.click(screen.getByRole('checkbox', { name: /remain separate people/i }));
    await user.click(screen.getByRole('checkbox', { name: /both copies will survive/i }));
    await user.type(
      screen.getByLabelText('Type the source organization name to confirm'),
      'Cincinnati',
    );
    await user.click(
      screen.getByRole('button', { name: 'Merge Cincinnati into University of Cincinnati' }),
    );

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ coach_roles: { '9': 'MEMBER' } }),
      ),
    );
  });
});
