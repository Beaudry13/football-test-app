import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/reps', () => ({ getConceptTrends: vi.fn() }));
import * as repsApi from '../../api/reps';
import { ConceptTrends } from './ConceptTrends';

/** IS IT GETTING BETTER? One line per football problem across the Reps that tested it. */

beforeEach(() => vi.clearAllMocks());

describe('Concept trends', () => {
  it('says the change and how many reps, and who still misses it', async () => {
    vi.mocked(repsApi.getConceptTrends).mockResolvedValue([
      { concept_id: 3, name: 'Motion adjustment', reps: 3, first_pct: 64, last_pct: 82, last_missed: 2, last_rep_id: 9 },
      { concept_id: 4, name: 'Leverage', reps: 1, first_pct: 100, last_pct: 100, last_missed: 0, last_rep_id: 1 },
    ]);
    render(
      <MemoryRouter>
        <ConceptTrends />
      </MemoryRouter>,
    );
    const list = within(await screen.findByRole('list'));
    const motion = list.getByRole('link', { name: /Motion adjustment/ });
    expect(motion).toHaveAttribute('href', '/reps/concepts/3');
    expect(motion.textContent).toMatch(/64% → 82%3 repsstill missed by 2/);
    expect(list.getByRole('link', { name: /Leverage/ }).textContent).toMatch(/100%1 rep$/);
  });

  it('says nothing when no rep has been run', async () => {
    vi.mocked(repsApi.getConceptTrends).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <ConceptTrends />
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('region', { name: 'Concept trends' })).toBeNull();
  });
});
