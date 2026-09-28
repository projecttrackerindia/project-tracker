import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Last line of defence: a rendering error shows a recoverable message instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Unhandled UI error', error, info.componentStack); }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1 className="auth-title">Something went wrong</h1>
          <p className="auth-sub">An unexpected error occurred while displaying this page. Your data is safe.</p>
          <div className="row">
            <button className="btn btn-primary" onClick={() => { this.setState({ error: null }); }}>Try again</button>
            <button className="btn btn-ghost" onClick={() => location.assign('/')}>Go to dashboard</button>
          </div>
        </div>
      </div>
    );
  }
}
