/** A PLAYER'S PROFILE WHEN PINS ARE OPTIONAL.
 *
 *  With the organization's setting off, "No PIN" beside somebody's name reads
 *  as a fault when nothing is wrong, so the status badge is not drawn. The PIN
 *  ACTIONS stay - quietly, among Edit and Deactivate - because a staff getting
 *  ready to turn the setting on has to be able to issue PINs first. The ON
 *  state is covered in PlayerProfilePagePins.test.tsx.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerProfilePage } from './PlayerProfilePage';
import * as playersApi from '../api/players';
import * as groupsApi from '../api/groups';
import * as orgApi from '../api/organizations';
import type { Organization, Player, PlayerHistory, PinStatus } from '../api/types';

const player: Player = {
  id: 1,
  organization_id: 1,
  first_name: 'John',
  last_name: 'Smith',
  full_name: 'John Smith',
  jersey_number: '12',
  position: 'QB',
  photo_url: null,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const history = (pin_status: PinStatus): PlayerHistory => ({
  player,
  current_groups: [],
  assigned_count: 0,
  completed_count: 0,
  completion_percent: null,
  average_score_percent: null,
  recent_results: [],
  pin_status,
});

const organization = (enabled: boolean): Organization => ({
  id: 1,
  name: 'Wildcats',
  player_pin_security_enabled: enabled,
  players_without_pins: 1,
  members: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/roster/1']}>
      <Routes>
        <Route path="/roster/:playerId" element={<PlayerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(groupsApi, 'listGroups').mockResolvedValue([]);
  vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(history('missing'));
});

describe('a player profile with Player PIN Security OFF', () => {
  beforeEach(() => {
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(organization(false));
  });

  it('does not flag a missing PIN as a problem', async () => {
    renderPage();

    expect(await screen.findByText('John Smith')).toBeInTheDocument();
    expect(screen.queryByText('No PIN')).not.toBeInTheDocument();
    expect(screen.queryByText('PIN set')).not.toBeInTheDocument();
  });

  it('still lets a staff issue one quietly, for a roster getting ready', async () => {
    renderPage();

    expect(await screen.findByRole('button', { name: 'Generate PIN' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set PIN manually' })).toBeInTheDocument();
    // The ordinary profile controls are untouched.
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });
});

describe('a player profile with Player PIN Security ON', () => {
  beforeEach(() => {
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(organization(true));
  });

  it('shows the status, because now it matters', async () => {
    renderPage();

    expect(await screen.findByText('No PIN')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate PIN' })).toBeInTheDocument();
  });

  it('says "PIN set" for a player who has one', async () => {
    vi.spyOn(playersApi, 'getPlayerHistory').mockResolvedValue(history('set'));

    renderPage();

    expect(await screen.findByText('PIN set')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset PIN' })).toBeInTheDocument();
  });
});
