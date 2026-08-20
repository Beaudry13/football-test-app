import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { TeamLayout } from './TeamLayout';

/** The real route shape from App.tsx, with cheap stand-ins for the three
 *  panels - what is under test is the SHELL and the addresses, not the pages,
 *  which are unchanged and have their own suites. */
function renderTeam(path = '/team') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/team" element={<TeamLayout />}>
          <Route index element={<p>Players panel</p>} />
          <Route path="groups" element={<p>Groups panel</p>} />
          <Route path="coaches" element={<p>Coaches panel</p>} />
        </Route>
        <Route path="/roster" element={<Navigate to="/team" replace />} />
        <Route path="/groups" element={<Navigate to="/team/groups" replace />} />
        <Route path="/roster/:playerId" element={<p>One player</p>} />
        <Route path="/groups/:groupId" element={<p>One group</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TeamLayout', () => {
  describe('the three-second test', () => {
    it('answers "I need to find a player"', async () => {
      renderTeam();

      expect(screen.getByRole('link', { name: 'Players' })).toBeInTheDocument();
      expect(await screen.findByText('Players panel')).toBeInTheDocument();
    });

    it('answers "I need to make a position group"', async () => {
      const user = userEvent.setup();
      renderTeam();

      await user.click(screen.getByRole('link', { name: 'Groups' }));

      expect(await screen.findByText('Groups panel')).toBeInTheDocument();
    });

    it('answers "I need to add another coach"', async () => {
      const user = userEvent.setup();
      renderTeam();

      await user.click(screen.getByRole('link', { name: 'Coaches' }));

      expect(await screen.findByText('Coaches panel')).toBeInTheDocument();
    });
  });

  describe('only the selected area is on screen', () => {
    it('SHOWS ONE PANEL, NOT THREE STACKED', async () => {
      // THE PROPERTY THAT MAKES THIS CONSOLIDATION RATHER THAN A DUMPING
      // GROUND. Players + Groups + Coaches down one page would have moved the
      // clutter, not removed it - the same mistake the dashboard just stopped
      // making with folders.
      renderTeam();

      expect(await screen.findByText('Players panel')).toBeInTheDocument();
      expect(screen.queryByText('Groups panel')).not.toBeInTheDocument();
      expect(screen.queryByText('Coaches panel')).not.toBeInTheDocument();
    });

    it('swaps the panel rather than adding to it', async () => {
      const user = userEvent.setup();
      renderTeam();
      await screen.findByText('Players panel');

      await user.click(screen.getByRole('link', { name: 'Coaches' }));

      expect(await screen.findByText('Coaches panel')).toBeInTheDocument();
      expect(screen.queryByText('Players panel')).not.toBeInTheDocument();
    });

    it('marks which area you are in', async () => {
      const user = userEvent.setup();
      renderTeam();

      await user.click(screen.getByRole('link', { name: 'Groups' }));

      // aria-current is what a screen reader and a coach both rely on to know
      // where they are; the underline alone says nothing to the former.
      expect(screen.getByRole('link', { name: 'Groups' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });
  });

  describe('old addresses keep working', () => {
    it('/roster still means the player list', async () => {
      renderTeam('/roster');

      expect(await screen.findByText('Players panel')).toBeInTheDocument();
    });

    it('/groups still means the group list', async () => {
      renderTeam('/groups');

      expect(await screen.findByText('Groups panel')).toBeInTheDocument();
    });

    it('A SINGLE PLAYER IS STILL ITS OWN DESTINATION', async () => {
      // Detail pages are not tabs. /roster/:playerId and /groups/:groupId are
      // places you open one thing, and folding them into the shell would have
      // been a real loss of functionality dressed up as tidying.
      renderTeam('/roster/7');

      expect(await screen.findByText('One player')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Players' })).not.toBeInTheDocument();
    });

    it('a single group is still its own destination', async () => {
      renderTeam('/groups/3');

      expect(await screen.findByText('One group')).toBeInTheDocument();
    });
  });
});
