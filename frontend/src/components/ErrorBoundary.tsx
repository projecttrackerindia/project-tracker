import { Component, type ErrorInfo, type ReactNode } from 'react';

/** A new version was deployed while this page was open: its old script files are gone. Reloading fetches the new ones. */
const isStale = (e: Error) => /dynamically imported module|Importing a module script failed|error loading dynamically|ChunkLoadError/i.test(`${e.name} ${e.message}`);

/** Last line of defence: a rendering error shows a recoverable message instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; details: boolean }> {
  state = { error: null as Error | null, details: false };

  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled UI error', error, info.componentStack);
    // Once per tab: a stale deployment is fixed by reloading, without the person seeing the error page at all.
    if (isStale(error)) { try { if (sessionStorage.getItem('pm_stale_reload') !== '1') { sessionStorage.setItem('pm_stale_reload', '1'); location.reload(); } } catch { /* storage unavailable */ } }
  }

  render() {
    const { error, details } = this.state;
    if (!error) { try { sessionStorage.removeItem('pm_stale_reload'); } catch { /* storage unavailable */ } return this.props.children; }
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1 className="auth-title">Something went wrong</h1>
          <p className="auth-sub">{isStale(error) ? 'The app was updated while this page was open. Reload to continue; your data is safe.' : 'An unexpected error occurred while displaying this page. Your data is safe.'}</p>
          <div className="row">
            {isStale(error) ? <button className="btn btn-primary" onClick={() => location.reload()}>Reload</button> : <button className="btn btn-primary" onClick={() => { this.setState({ error: null }); }}>Try again</button>}
            <button className="btn btn-ghost" onClick={() => location.assign('/')}>Go to dashboard</button>
            <button className="btn btn-ghost" onClick={() => this.setState({ details: !details })} aria-expanded={details}>{details ? 'Hide details' : 'Details'}</button>
          </div>
          {details && <pre style={{ marginTop: 14, maxHeight: 160, overflow: 'auto', fontSize: 11.5, whiteSpace: 'pre-wrap', color: 'var(--text-3)' }}>{error.name}: {error.message}</pre>}
        </div>
      </div>
    );
  }
}
