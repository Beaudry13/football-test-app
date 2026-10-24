import { fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { fromHere, keepFrom, readFrom, useBackTo, useGoFromHere } from './backTo';

/**
 * BACK TO WHERE HE CAME FROM: the page he leaves hands the next one its way
 * back; the next page's back link uses it, else its usual destination. Only
 * in-app paths, never another site.
 */

function BackLink() {
  const back = useBackTo({ to: '/reps', label: 'Reps' });
  return <Link to={back.to}>← {back.label}</Link>;
}
function Where() {
  return <p>at {useLocation().pathname + useLocation().search}</p>;
}
function Leave() {
  const go = useGoFromHere('Week 7 - Central');
  return (
    <button type="button" onClick={() => go('/reps/12')}>
      Retest the 3
    </button>
  );
}

describe('the way back', () => {
  it('a page handed a way back offers it; without one, its usual link', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/reps/12', state: { from: { to: '/installs/4', label: 'Week 7 - Central' } } }]}>
        <BackLink />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: '← Week 7 - Central' })).toHaveAttribute('href', '/installs/4');
  });

  it('a pasted URL or a new tab has no state: the usual link', () => {
    render(
      <MemoryRouter initialEntries={['/reps/12']}>
        <BackLink />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: '← Reps' })).toHaveAttribute('href', '/reps');
  });

  it('only an in-app path is ever followed', () => {
    expect(readFrom({ from: { to: 'https://example.com', label: 'x' } })).toBeNull();
    expect(readFrom({ from: { to: '//example.com', label: 'x' } })).toBeNull();
    expect(readFrom({ from: { to: '/installs/4' } })).toBeNull();
    expect(readFrom(null)).toBeNull();
    expect(readFrom({ from: { to: '/installs/4?teach=1&at=2', label: 'Week 7' } })).toEqual({ to: '/installs/4?teach=1&at=2', label: 'Week 7' });
    expect(keepFrom({ from: { to: '/q/1', label: 'Q' } })).toEqual({ from: { to: '/q/1', label: 'Q' } });
    expect(keepFrom({})).toBeNull();
    expect(fromHere({ pathname: '/quizzes/9', search: '?tab=results' }, 'Red zone')).toEqual({ from: { to: '/quizzes/9?tab=results', label: 'Red zone' } });
  });

  it('leaving with go() lands with the way back to the page it left', () => {
    render(
      <MemoryRouter initialEntries={['/installs/4']}>
        <Routes>
          <Route path="/installs/4" element={<Leave />} />
          <Route
            path="/reps/12"
            element={
              <>
                <Where />
                <BackLink />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retest the 3' }));
    expect(screen.getByText('at /reps/12')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Week 7 - Central' })).toHaveAttribute('href', '/installs/4');
  });
});
