import { Link } from 'react-router-dom';
import { Icon, type IconName } from '../../components/Icon';

const CONTACT = 'security@projecttracker.in';

const PILLARS: { icon: IconName; title: string; points: string[] }[] = [
  {
    icon: 'lock', title: 'Encryption',
    points: [
      'All traffic is HTTPS, with HTTP Strict Transport Security.',
      'Passwords are stored only as salted PBKDF2 hashes; earlier passwords cannot be reused.',
      'Authenticator secrets, webhook secrets, sign-on client secrets and similar are encrypted at rest with AES-256-GCM.',
      'API keys, SCIM tokens and calendar addresses are stored as one-way hashes and shown only once.',
    ],
  },
  {
    icon: 'key', title: 'Identity and sign-in',
    points: [
      'Single sign-on with OpenID Connect or SAML 2.0 (signed assertions only), on domains you prove you own.',
      'Automatic provisioning and de-provisioning with SCIM 2.0.',
      'Two-step verification with authenticator apps and recovery codes, which an organization can require.',
      'Sign-in from Google, Microsoft, GitHub or Apple joins an account only through a verified e-mail address.',
      'Sessions can be reviewed and revoked; organizations can restrict access to their own IP ranges.',
    ],
  },
  {
    icon: 'shield', title: 'Access control and isolation',
    points: [
      'Every record belongs to one workspace, and every request is checked against the caller’s current membership, role and access - not just their token.',
      'Roles, per-module access levels and job-role profiles decide who can see and change what.',
      'Removing someone, or disabling their account, takes effect on their very next request.',
    ],
  },
  {
    icon: 'activity', title: 'Audit and monitoring',
    points: [
      'An audit log of sign-ins, permission, security and configuration changes.',
      'Audit records can be streamed to your SIEM through a webhook.',
      'Application tracing and metrics (OpenTelemetry) and health checks on every component.',
    ],
  },
  {
    icon: 'database', title: 'Your data',
    points: [
      'Workspace owners can export everything as JSON files in one zip, at any time.',
      'Retention you control: activity, notifications, chat and the audit log can be deleted after a period you choose.',
      'Files are kept in object storage with checksums; deleted projects’ files are purged.',
    ],
  },
  {
    icon: 'bug', title: 'Building it safely',
    points: [
      'Rate limiting on every endpoint, with stricter limits on sign-in.',
      'Webhooks are signed, and cannot point at private or internal networks.',
      'Defences against cross-site request forgery and clickjacking, and strict security headers.',
      'Continuous integration builds and tests every change and checks dependencies for known vulnerabilities.',
    ],
  },
];

/** Public page: how the service protects its customers' data, and how to report a security problem. */
export function SecurityPage() {
  return (
    <div className="sec-page">
      <header className="sec-top">
        <Link to="/" className="sec-brand"><span className="sec-logo"><Icon name="tick" size={16} /></span> Project Tracker</Link>
        <nav><Link to="/login">Sign in</Link></nav>
      </header>
      <section className="sec-hero">
        <span className="sec-kicker"><Icon name="shield" size={14} /> Security</span>
        <h1>Your work is safe here</h1>
        <p>How we protect the projects, people and history you trust us with - and how to tell us if you find a problem.</p>
      </section>
      <section className="sec-grid">
        {PILLARS.map((p) => (
          <article className="sec-card" key={p.title}>
            <div className="sec-card-icon"><Icon name={p.icon} size={20} /></div>
            <h2>{p.title}</h2>
            <ul>{p.points.map((x) => <li key={x}><Icon name="tick" size={14} />{x}</li>)}</ul>
          </article>
        ))}
      </section>
      <section className="sec-report" id="report">
        <div>
          <h2>Report a vulnerability</h2>
          <p>If you believe you have found a security problem, e-mail <a href={`mailto:${CONTACT}`}>{CONTACT}</a> with the steps to reproduce it. We reply within two working days, keep you informed while we fix it, and credit you if you wish.
            Please do not access other customers’ data, degrade the service or run automated scans against it while investigating.</p>
        </div>
        <a className="btn btn-primary" href={`mailto:${CONTACT}?subject=Security%20report`}><Icon name="mail" size={15} /> Report a problem</a>
      </section>
      <footer className="sec-foot">Machine-readable contact: <a href="/.well-known/security.txt">/.well-known/security.txt</a></footer>
    </div>
  );
}
