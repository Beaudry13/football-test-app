import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteErrorBoundary, RoutedErrorBoundary } from './RouteErrorBoundary';

function Boom(): React.ReactElement {
  throw new TypeError("Cannot read properties of undefined (reading 'x')");
}

function Fine() {
  return <p>Working screen</p>;
}

describe('RouteErrorBoundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // React logs the caught error; silence it so the suite output stays
    // readable, but keep the spy so the test can assert we logged at all.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders its children when nothing throws', () => {
    render(
      <MemoryRouter>
        <RouteErrorBoundary>
          <Fine />
        </RouteErrorBoundary>
      </MemoryRouter>,
    );

    expect(screen.getByText('Working screen')).toBeInTheDocument();
  });

  it('shows a recovery screen instead of unmounting the app', () => {
    render(
      <MemoryRouter>
        <RouteErrorBoundary>
          <Boom />
        </RouteErrorBoundary>
      </MemoryRouter>,
    );

    // The whole point: something is on screen. A white screen is the failure.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/ran into a problem/i)).toBeInTheDocument();
    // And it reassures rather than alarms - no data was touched.
    expect(screen.getByText(/nothing was changed or deleted/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to dashboard/i })).toBeInTheDocument();
  });

  it('logs the error so a production report is actionable', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <MemoryRouter>
        <RouteErrorBoundary>
          <Boom />
        </RouteErrorBoundary>
      </MemoryRouter>,
    );

    expect(
      spy.mock.calls.some((args) => String(args[0]).includes('Unhandled render error')),
    ).toBe(true);
  });

  it('clears itself when the route changes', async () => {
    const user = userEvent.setup();

    function App() {
      return (
        <>
          {/* OUTSIDE the boundary, like the real app's header - which is the
              whole point: navigation must survive a crashed screen. */}
          <nav>
            <Link to="/ok">go</Link>
          </nav>
          <RoutedErrorBoundary>
            <Routes>
              <Route path="/broken" element={<Boom />} />
              <Route path="/ok" element={<Fine />} />
            </Routes>
          </RoutedErrorBoundary>
        </>
      );
    }

    render(
      <MemoryRouter initialEntries={['/broken']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Navigating away must recover on its own - otherwise one crash strands
    // the coach until a full reload, barely better than the white screen.
    await user.click(screen.getByRole('link', { name: 'go' }));
    expect(screen.getByText('Working screen')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
