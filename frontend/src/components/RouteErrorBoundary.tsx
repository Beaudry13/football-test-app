import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import nb from '../styles/notebook.module.css';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Stops one broken screen from blanking the entire application.
 *
 * WHY THIS EXISTS. A playbook opened to a white screen in production - not a
 * broken panel, the whole app gone. React unmounts the entire tree when a
 * render throws and nothing catches it, so a single undefined field in one
 * component took down the header, the navigation and every route with it. The
 * coach had no way back except reloading and avoiding that playbook forever.
 *
 * The underlying bug is fixed, but the CLASS of failure is what matters: any
 * component can dereference something the server did not send. This guarantees
 * the blast radius is one screen.
 *
 * Deliberately a class component - `componentDidCatch` has no hook equivalent,
 * and this is the one place in the codebase where that is true. */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // No error-reporting service is wired up yet, so the console is the only
    // record. Logging the component stack alongside the error is what makes a
    // production report actionable instead of "it went white".
    // eslint-disable-next-line no-console
    console.error('Unhandled render error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className={nb.card} style={{ padding: 24, margin: 24 }} role="alert">
        <h1 className={nb.heading}>This screen ran into a problem</h1>
        <p className={nb.subheading}>
          Something on this page could not be displayed. Your data is safe — nothing was changed or
          deleted. The rest of Peira is still working.
        </p>
        <p className={nb.subheading}>
          Try going back and opening it again. If it keeps happening, this message means the problem
          is ours to fix, not something you did wrong.
        </p>
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <Link to="/dashboard" className={nb.btnSecondary}>
            Back to dashboard
          </Link>
          <button type="button" className={nb.btnSm} onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}


/** The boundary wired to the current route.
 *
 * Keying on the pathname means navigating away from a crashed screen clears
 * the error by itself. Without it a single crash would persist until a full
 * reload, which is barely better than the white screen it replaced. */
export function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  // `key` rather than a reset prop: changing it REMOUNTS the boundary, which
  // clears the captured error without a setState during update. Resetting in
  // componentDidUpdate would work but triggers a second render pass, and
  // React rightly warns about it.
  return <RouteErrorBoundary key={location.pathname}>{children}</RouteErrorBoundary>;
}
