import { Icon } from './Icon';

const PATH = 'M25 30 C 110 5, 150 55, 145 104 C 140 155, 55 150, 15 178';

/**
 * The left-hand panel on auth pages (hidden below the `av` breakpoint in auth.css, where the card alone fills the
 * screen as before). Purely decorative — a value-prop line plus a few gently floating "badges" built from the
 * app's own real concepts (a completed task, a sprint's progress, a team working a launch) rather than a literal
 * screenshot, so it never goes stale as the product's UI changes. The connecting path + travelling dot behind them
 * is a small nod to what the product actually does: tracking something as it moves toward done.
 */
export function AuthVisual() {
  return (
    <div className="auth-visual" aria-hidden="true">
      <div className="av-copy">
        <span className="av-eyebrow">Project Tracker</span>
        <h2>Plan the work.<br />Track it in real time.</h2>
        <p>Projects, tasks, timesheets and reporting — one workspace your whole team actually uses.</p>
      </div>
      <div className="av-badges">
        <svg className="av-path" viewBox="0 0 360 210">
          <defs>
            <linearGradient id="av-line" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#a78bfa" stopOpacity="0" />
              <stop offset=".5" stopColor="#8b5cf6" stopOpacity=".5" />
              <stop offset="1" stopColor="#a78bfa" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={PATH} fill="none" stroke="url(#av-line)" strokeWidth="2" strokeDasharray="1 7" strokeLinecap="round" />
        </svg>
        <span className="av-dot" />
        <div className="av-badge av-badge-a">
          <span className="av-badge-icon av-tone-done"><Icon name="tick" size={14} /></span>
          <div><strong>Homepage redesign</strong><small>Marked complete · 2m ago</small></div>
        </div>
        <div className="av-badge av-badge-b">
          <span className="av-badge-icon av-tone-progress"><Icon name="target" size={14} /></span>
          <div>
            <strong>Sprint 14<span className="av-live" /></strong>
            <div className="av-bar"><span style={{ width: '82%' }} /></div>
          </div>
        </div>
        <div className="av-badge av-badge-c">
          <div className="av-avatars"><span>SP</span><span>AK</span><span>+4</span></div>
          <div><strong>Product launch</strong><small>6 people collaborating</small></div>
        </div>
      </div>
    </div>
  );
}
