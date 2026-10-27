import { createContext, lazy, Suspense, useContext, useEffect, useReducer, useRef, useState, type ComponentType } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { orgFromPath, firstSegment } from './lib/orgPath';
import { setTitleParts } from './lib/title';
import { ApiError } from './api/client';
import { consentApi, meApi } from './api/endpoints';
import type { ConsentDocument } from './api/types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon } from './components/Icon';
import { SuccessCurtain } from './components/SuccessCurtain';
import { UpdateBanner } from './components/UpdateBanner';
import { Field, Modal, PageLoader, SubmitButton } from './components/ui';
import { PasswordChecklist, passwordProblem, usePasswordPolicy } from './features/auth/passwordPolicy';
import { AppSplash } from './components/AppSplash';
import { useVisibleKinds } from './features/workitems/workItems';
import { AppLayout } from './layouts/AppLayout';
import { CallRoute } from './features/calls/CallHost';
import { MeetingCallRoute } from './features/calls/MeetingCallRoute';
import { registerPage } from './lib/prefetchPages';

/**
 * An address from before v2 (or before an earlier regrouping): go to where that page lives now, keeping the query (a project, a task …)
 * and the #anchor, and adding any the new place needs, so bookmarks and links in old e-mails, notifications and AI answers keep working.
 * `prefix`: the old address's start is swapped for `to` and the rest is kept (/projects/7/x → /work/projects/7/x).
 */
function Moved({ to, prefix, rename }: { to: string; prefix?: string; /** Query names the new place calls differently (Meet's ?open= is Talk's ?meeting=). */ rename?: Record<string, string> }) {
  const loc = useLocation();
  const [base, extra] = to.split('?');
  const path = prefix ? `${base}${loc.pathname.slice(prefix.length)}`.replace(/\/+$/, '') || '/' : base;
  const q = new URLSearchParams(loc.search);
  new URLSearchParams(extra ?? '').forEach((v, k) => q.set(k, v));
  for (const [from, name] of Object.entries(rename ?? {})) { const v = q.get(from); if (v !== null && !q.has(name)) q.set(name, v); }
  const s = q.toString();
  return <Navigate to={`${path}${s ? `?${s}` : ''}${loc.hash}`} replace state={loc.state} />;   // and what the page was opened with (a new document, a question in hand)
}

/**
 * Pages are loaded when they are first opened rather than all up front, so the first visit downloads a fraction of the app. Each page
 * module exports its page by name; `page` picks that export for React.lazy.
 */
function page<K extends string>(load: () => Promise<Record<K, ComponentType<any>>>, name: K) {
  // Sign-in pages are not wanted by someone already in; everything else is fetched ahead while idle.
  if (load !== loadAuthPages) registerPage(load);
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
// The sign-in pages (and the form and validation libraries only they use) are not needed by someone already signed in. They are fetched
// straight away when the address is one of them, alongside the session check rather than after it.
const loadAuthPages = () => import('./features/auth/AuthPages');
if (typeof window !== 'undefined' && /^\/(login|register|verify-email|forgot-password|reset-password|invite|auth)(\/|$)/.test(window.location.pathname)) void loadAuthPages().catch(() => undefined);
const LoginPage = page(loadAuthPages, 'LoginPage');
const RegisterPage = page(loadAuthPages, 'RegisterPage');
const VerifyEmailPage = page(loadAuthPages, 'VerifyEmailPage');
const ForgotPasswordPage = page(loadAuthPages, 'ForgotPasswordPage');
const ResetPasswordPage = page(loadAuthPages, 'ResetPasswordPage');
const AcceptInvitePage = page(loadAuthPages, 'AcceptInvitePage');
const AuthCompletePage = page(loadAuthPages, 'AuthCompletePage');
// Two-step setup (and its QR-code library) is only shown here when a workspace insists on it.
const TwoStepRow = page(() => import('./features/settings/TwoStep'), 'TwoStepRow');
const AdminPage = page(() => import('./features/admin/AdminPage'), 'AdminPage');
// The five places of v2, the project pages, People and Settings (V2-PLAN §1).
const HomePage = page(() => import('./features/home/HomePage'), 'HomePage');
const WorkPage = page(() => import('./features/work/WorkPage'), 'WorkPage');
// Release 1: the support desk and Quality (testers) as their own places.
const DeskPage = page(() => import('./features/desk/DeskPage'), 'DeskPage');
const QualityPage = page(() => import('./features/quality/QualityPage'), 'QualityPage');
const ProjectsHome = page(() => import('./features/projects/ProjectsHome'), 'ProjectsHome');
const ProjectPage = page(() => import('./features/projects/ProjectPage'), 'ProjectPage');
const TalkPage = page(() => import('./features/talk/TalkPage'), 'TalkPage');
const LibraryPage = page(() => import('./features/library/LibraryPage'), 'LibraryPage');
const InsightsPage = page(() => import('./features/insights/InsightsPage'), 'InsightsPage');
const PeoplePage = page(() => import('./features/people/PeoplePage'), 'PeoplePage');
const SettingsPage = page(() => import('./features/settings/SettingsPage'), 'SettingsPage');
const ConnectPage = page(() => import('./features/integrations/ConnectPage'), 'ConnectPage');
const MailboxPage = page(() => import('./features/dev/MailboxPage'), 'MailboxPage');
const LegalPage = page(() => import('./features/legal/LegalPage'), 'LegalPage');
const UnsubscribePage = page(() => import('./features/auth/UnsubscribePage'), 'UnsubscribePage');
const ApprovePage = page(() => import('./features/auth/ApprovePage'), 'ApprovePage');
const ReminderActionPage = page(() => import('./features/reminders/ActionPage'), 'ReminderActionPage');
const SecretLinkPage = page(() => import('./features/vault/SecretLinkPage'), 'SecretLinkPage');
const ActivityPage = page(() => import('./features/activity/ActivityPages'), 'ActivityPage');
import { toast } from './stores/ui';
import { useAuth, useCan, useIsPersonal, useModule } from './stores/auth';
import { OfflineWork } from './features/offline/offline';

/** No workspace is active right now: either the account genuinely has none, or one specific workspace refused this sign-in. */
function NoWorkspace() {
  const ctx = useAuth((s) => s.ctx)!;
  const [switching, setSwitching] = useState<string | null>(null);
  const blocked = ctx.blocked;
  const elsewhere = ctx.workspaces.filter((w) => w.id !== blocked?.workspaceId);

  const trySwitch = async (id: string) => {
    setSwitching(id);
    try { await useAuth.getState().switchWorkspace(id); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not switch to that workspace.', 'error'); }
    finally { setSwitching(null); }
  };

  return (
    <div className="auth-shell"><div className="auth-card" style={{ maxWidth: 480 }}>
      <h1 className="auth-title">{blocked ? 'This workspace refused this sign-in' : 'No workspace available'}</h1>
      <p className="auth-sub">
        {blocked ? blocked.message : 'Your account is not a member of any active workspace. Ask an administrator to restore access, or sign in with a different account.'}
      </p>

      {blocked?.code === 'ORG_MFA_REQUIRED' && (
        <div className="card" style={{ marginBottom: 18 }}><div className="card-body"><Suspense fallback={<PageLoader />}><TwoStepRow /></Suspense></div></div>
      )}
      {blocked?.code === 'ORG_IP_BLOCKED' && (
        <button className="btn btn-ghost" style={{ marginBottom: 18 }} onClick={() => void useAuth.getState().reloadContext()}>
          I've switched networks — try again
        </button>
      )}

      {elsewhere.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <p className="auth-sub" style={{ marginBottom: 8 }}>Or switch to another workspace you belong to:</p>
          <div style={{ display: 'grid', gap: 8 }}>
            {elsewhere.map((w) => (
              <button key={w.id} type="button" className="btn btn-ghost" style={{ justifyContent: 'space-between' }}
                disabled={switching !== null} onClick={() => void trySwitch(w.id)}>
                {w.name}{switching === w.id && <span className="spinner" />}
              </button>
            ))}
          </div>
        </div>
      )}

      <button className="btn btn-primary" onClick={() => useAuth.getState().logout()}>Sign out</button>
    </div></div>
  );
}

/** We've published a new Terms of Service / Privacy Policy version and this person hasn't accepted it yet. Not workspace-specific:
 * shown before anything else so it can't be dodged by switching workspaces, and it never signs anyone out. */
function PendingConsent({ pending }: { pending: ConsentDocument[] }) {
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<ConsentDocument | null>(null);
  const accept = async () => {
    setBusy(true);
    try { await consentApi.accept(pending.map((d) => d.type)); await useAuth.getState().reloadContext(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save your acceptance.', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="auth-shell"><div className="auth-card" style={{ maxWidth: 520 }}>
      <h1 className="auth-title">We've updated our terms</h1>
      <p className="auth-sub">Please review and accept the current {pending.map((d) => d.title).join(' and ')} to keep using your account.</p>
      <div style={{ display: 'grid', gap: 8, marginBottom: 18 }}>
        {pending.map((d) => (
          <button key={d.type} type="button" className="btn btn-ghost" style={{ justifyContent: 'space-between' }} onClick={() => setViewing(d)}>{d.title}</button>
        ))}
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={() => void accept()} style={{ marginBottom: 8, width: '100%' }}>
        {busy ? 'Saving…' : 'I accept'}
      </button>
      <button className="btn btn-ghost" onClick={() => useAuth.getState().logout()}>Sign out</button>
      {viewing && (
        <Modal size="lg" title={viewing.title} onClose={() => setViewing(null)} footer={<button type="button" className="btn btn-primary" onClick={() => setViewing(null)}>Close</button>}>
          <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{viewing.body}</p>
        </Modal>
      )}
    </div></div>
  );
}

/**
 * An administrator created this account and chose its first password, so it is only good for choosing a new one: the server refuses
 * everything else until that is done. Shown before anything else, in place of the app.
 */
/** A password box with its own eye button; the three fields of this screen share one shown/hidden state. */
function RevealInput({ revealed, onToggle, ...rest }: { revealed: boolean; onToggle: () => void } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="password-box">
      <input className="input" type={revealed ? 'text' : 'password'} {...rest} />
      <button type="button" className="password-toggle" tabIndex={-1} aria-pressed={revealed} aria-label={revealed ? 'Hide passwords' : 'Show passwords'} onClick={onToggle}>
        <Icon name={revealed ? 'eyeOff' : 'eye'} size={16} />
      </button>
    </div>
  );
}

function MustChangePassword() {
  const policy = usePasswordPolicy();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);   // one switch shows or hides all three fields, so a typing slip is easy to see
  const matches = again.length > 0 && again === next;
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!current) er.currentPassword = 'Enter the temporary password you were given.';
    const problem = passwordProblem(policy, next);
    if (problem) er.newPassword = problem;
    else if (next !== again) er.again = 'The two passwords do not match.';
    setErrors(er);
    if (Object.keys(er).length) return;
    setBusy(true);
    try { await meApi.changePassword({ currentPassword: current, newPassword: next }); toast('Password saved. Welcome!'); await useAuth.getState().reloadContext(); }
    catch (err) {
      const fe: Record<string, string> = {};
      if (err instanceof ApiError) err.errors.forEach((x) => { fe[x.field ?? 'newPassword'] = x.message; });
      setErrors(Object.keys(fe).length ? fe : { newPassword: 'Could not save the new password.' });
    } finally { setBusy(false); }
  };
  return (
    <div className="auth-shell"><form className="auth-card" style={{ maxWidth: 480 }} onSubmit={(e) => void submit(e)}>
      <h1 className="auth-title">Choose your password</h1>
      <p className="auth-sub">Your administrator gave you a temporary password. Choose one of your own to continue.</p>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr', marginBottom: 14 }}>
        <Field label="Temporary password" error={errors.currentPassword}>
          <RevealInput revealed={show} onToggle={() => setShow((v) => !v)} autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" error={errors.newPassword}>
          <RevealInput revealed={show} onToggle={() => setShow((v) => !v)} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <PasswordChecklist policy={policy} password={next} showHistory />
        <Field label="Confirm new password" error={errors.again}>
          <RevealInput revealed={show} onToggle={() => setShow((v) => !v)} autoComplete="new-password" value={again} onChange={(e) => { setAgain(e.target.value); setErrors((x) => ({ ...x, again: '' })); }} />
        </Field>
        {again.length > 0 && !errors.again && (
          <p className={`pw-match ${matches ? 'ok' : ''}`} role="status">{matches ? '✓ The two passwords match' : 'The two passwords do not match yet'}</p>
        )}
      </div>
      <SubmitButton busy={busy}>Save and continue</SubmitButton>
      <button type="button" className="btn btn-ghost" style={{ marginLeft: 8 }} onClick={() => useAuth.getState().logout()}>Sign out</button>
    </form></div>
  );
}

function RequireAuth() {
  const status = useAuth((s) => s.status);
  const ctx = useAuth((s) => s.ctx);
  const loc = useLocation();
  if (status === 'loading') return <AppSplash />;
  if (status === 'offline') return <OfflineWork />;
  if (status === 'anonymous') {
    // Someone signed out who opened the home address sees the public page (index.html), not the sign-in form.
    if (document.documentElement.classList.contains('landing')) return null;
    return <Navigate to={`/login?redirect=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  }
  // Terms first: accepting them works while the password is still temporary, but the password change is a write that the terms gate
  // refuses until they have been accepted.
  if (ctx?.pendingConsent && ctx.pendingConsent.length > 0) return <PendingConsent pending={ctx.pendingConsent} />;
  if (ctx?.user.mustChangePassword) return <MustChangePassword />;
  if (!ctx?.current) return <NoWorkspace />;
  // Platform administrators have an admin-only interface; workspace pages are for customers.
  // Their own profile and sign-in (Settings › Profile, and its old address /account) stay open to them.
  if (ctx.user.isPlatformAdmin && !loc.pathname.startsWith('/admin') && !loc.pathname.startsWith('/account') && loc.pathname !== '/settings' && !loc.pathname.startsWith('/settings/profile') && loc.pathname !== '/settings/security/account' && loc.pathname !== '/settings/appearance') return <Navigate to="/admin" replace />;
  return <AppLayout />;
}

/** The old Documents library (a project's documents): that project's documentation in Library. */
function LegacyDocuments() {
  const loc = useLocation();
  const project = new URLSearchParams(loc.search).get('project');
  return <Navigate to={project ? `/library/p/${encodeURIComponent(project)}` : '/library'} replace />;
}

/** A task by id alone (a #task mention in a document): it opens in the Work side panel. */
function TaskLink() {
  const { id = '' } = useParams();
  const loc = useLocation();
  return <Navigate to={`/work?item=${encodeURIComponent(id)}${loc.hash}`} replace />;
}

/**
 * Old links to one task, issue or action item on its project (/projects/7?task=…, ?tab=issues&issue=…, ?tab=actions&action=…, from
 * notifications, e-mails and the AI): the item opens in the Work side panel. Anything else on /projects/… goes to the project as before.
 */
function ProjectsMoved() {
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  const id = q.get('task') ?? q.get('issue') ?? q.get('action');
  if (id) return <Navigate to={`/work?item=${encodeURIComponent(id)}${loc.hash}`} replace />;
  return <Moved to="/work/projects" prefix="/projects" />;
}

/**
 * The old Operations page: a ticket (?task=) opens in the Work side panel over Work › Tickets; its views (?view=board, whatsapp …) and
 * its queue filters (?project=, ?type=, ?sla= …, which only the desk's queue understands) open the ticket desk under Tickets.
 */
function OperationsMoved() {
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  const id = q.get('task');
  if (id) return <Navigate to={`/work?tab=tickets&item=${encodeURIComponent(id)}${loc.hash}`} replace />;
  const queue = !q.has('view') && ['project', 'type', 'sla', 'open', 'unassigned', 'status', 'priority'].some((k) => q.has(k));
  return <Moved to={`/work?tab=tickets${queue ? '&view=queue' : ''}`} />;
}

/** Hide pages the current role / workspace type cannot use, instead of showing a screen of 403s. */
function Guard({ allow, children }: { allow: boolean; children: React.ReactNode }) {
  return allow ? <>{children}</> : <Navigate to="/" replace />;
}

/** /timesheet/approvals, /meet/past …: the place that holds the page now, with the old section as `s`. */
function SectionMoved({ to, rename }: { to: string; rename?: Record<string, string> }) {
  const { s = '' } = useParams();
  return <Moved to={`${to}&s=${encodeURIComponent(s)}`} rename={rename} />;
}

/**
 * A project's tab as a path (/work/projects/7/board, /projects/7/issues …, from before v2): the project page with ?tab=, which then opens the
 * tab that holds it now (Board → Work, Files → Docs, Agent → Activity …), keeping the query and the #anchor.
 */
function ProjectTabMoved() {
  const { id = '', tab = '' } = useParams();
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  if (!q.has('tab')) q.set('tab', tab);
  return <Navigate to={`/work/projects/${encodeURIComponent(id)}?${q.toString()}${loc.hash}`} replace state={loc.state} />;
}

/** /ai/<conversation> from before v2: the conversation now lives on Home (?c=). */
function AiConversationMoved() {
  const { id = '' } = useParams();
  return <Navigate to={`/?tab=assistant&c=${encodeURIComponent(id)}`} replace />;
}

function NotFound() {
  return (
    <div className="empty" style={{ paddingTop: 80 }}>
      <h4>Page not found</h4><p>The page you are looking for does not exist.</p><Link className="btn btn-primary" to="/">Back to Home</Link>
    </div>
  );
}

/**
 * An address with no organization in front of it ("/projects/1", from before addresses carried one, or from an old e-mail) goes to the same page
 * inside the person's current organization. An address that already names one of their organizations (right after signing in to a link) just
 * needs the app to pick that up. No page reload either way.
 */
function OrgRedirect() {
  const refresh = useContext(OrgGateContext);
  const loc = useLocation();
  const ctx = useAuth((s) => s.ctx);
  useEffect(() => {
    const slug = ctx?.current?.slug;
    if (!slug) return;
    if (!orgFromPath(loc.pathname, ctx.workspaces)) {
      const path = loc.pathname === '/' ? '/' : loc.pathname;
      window.history.replaceState(null, '', `/${slug}${path}${loc.search}${loc.hash}`);
    }
    refresh();
  }, [loc.pathname, loc.search, loc.hash, ctx, refresh]);
  return <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center' }}><PageLoader /></div>;
}

const OrgGateContext = createContext<() => void>(() => undefined);

const PUBLIC_PAGES = new Set(['login', 'register', 'verify-email', 'forgot-password', 'reset-password', 'invite', 'unsubscribe', 'auth', 'security', 'download', 'r', 's', 'dev']);

function AppRoutes({ scoped }: { scoped: boolean }) {
  const loc = useLocation();
  const user = useAuth((s) => s.ctx);
  const signedIn = useAuth((s) => s.status === 'authenticated' && !!s.ctx?.current);
  // Signed in with no organization in the address: send the page to where it lives now. The screens that stop a person first (terms, a
  // temporary password) are not pages of an organization and keep their own address; so do the pages that need no organization.
  const gated = !!user && ((user.pendingConsent?.length ?? 0) > 0 || user.user.mustChangePassword);
  const redirecting = signedIn && !scoped && !gated && !PUBLIC_PAGES.has(firstSegment(loc.pathname));
  const personal = useIsPersonal();
  const hasReports = (useAuth((s) => s.ctx?.current?.reportCount) ?? 0) > 0;
  const mReports = useModule('reports') > 0, mTasks = useModule('tasks') > 0, mProjects = useModule('projects') > 0, mWork = useModule('work') > 0;
  const mActivity = useModule('activity') > 0, mDocuments = useModule('documents') > 0;
  const permReports = useCan('reports.view'), broad = useCan('reports.broad');
  const canReports = permReports && mReports;
  const isGuest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const permVault = useCan('vault.use');
  const canVault = permVault && !isGuest;
  const kinds = useVisibleKinds();
  const work = kinds.length > 0 || mWork || mProjects;
  const insights = (!personal && (hasReports || broad)) || canReports || mWork || mTasks;
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/invite" element={<AcceptInvitePage />} />
      <Route path="/unsubscribe" element={<Suspense fallback={<PageLoader />}><UnsubscribePage /></Suspense>} />
      <Route path="/auth/complete" element={<AuthCompletePage />} />
      <Route path="/terms" element={<LegalPage type="tos" />} />
      <Route path="/privacy" element={<LegalPage type="privacy" />} />
      {/* Done / snooze from a reminder e-mail or push notification: the link's one-time key stands in for signing in. */}
      <Route path="/r/:token" element={<Suspense fallback={<PageLoader />}><ReminderActionPage /></Suspense>} />
      {/* A one-time secret from the vault: opened without signing in; the key is in the link's #fragment and never reaches a server. */}
      <Route path="/s/:token" element={<Suspense fallback={<PageLoader />}><SecretLinkPage /></Suspense>} />
      {import.meta.env.DEV && <Route path="/dev/mailbox" element={<MailboxPage />} />}

      {redirecting ? <Route path="*" element={<OrgRedirect />} /> : <Route element={<RequireAuth />}>
        {/* ---------------------------------------------------------------- the five places (V2-PLAN §1) */}
        <Route index element={<HomePage />} />
        <Route path="approve/:id" element={<ApprovePage />} />
        <Route path="work" element={<Guard allow={work}><WorkPage /></Guard>} />
        <Route path="work/projects" element={<Guard allow={mProjects}><ProjectsHome /></Guard>} />
        <Route path="desk" element={<Guard allow={mWork}><DeskPage /></Guard>} />
        <Route path="quality" element={<Guard allow={mWork}><QualityPage /></Guard>} />
        <Route path="work/projects/:id" element={<Guard allow={mProjects}><ProjectPage /></Guard>} />
        <Route path="work/projects/:id/:tab" element={<ProjectTabMoved />} />
        <Route path="talk" element={<TalkPage />} />
        <Route path="talk/:conversationId" element={<TalkPage />} />
        <Route path="library" element={<Guard allow={mDocuments || canVault}><LibraryPage /></Guard>} />
        <Route path="library/:section" element={<Guard allow={mDocuments || canVault}><LibraryPage /></Guard>} />
        <Route path="library/:section/:id" element={<Guard allow={mDocuments || canVault}><LibraryPage /></Guard>} />
        <Route path="library/p/:projectId/*" element={<Guard allow={mDocuments}><LibraryPage /></Guard>} />
        <Route path="insights" element={<Guard allow={insights}><InsightsPage /></Guard>} />
        <Route path="activity" element={<Guard allow={mActivity}><ActivityPage /></Guard>} />
        <Route path="calls/:id" element={<CallRoute />} />
        <Route path="calls/meeting/:meetingId" element={<MeetingCallRoute />} />
        <Route path="calls/meeting/w/:meetingId" element={<MeetingCallRoute workspace />} />
        <Route path="connect" element={<ConnectPage />} />
        <Route path="tasks/:id" element={<TaskLink />} />
        {/* People and Settings: behind the avatar (each People section checks its own access) */}
        <Route path="people" element={<PeoplePage section="directory" />} />
        <Route path="people/invitations" element={<PeoplePage section="invitations" />} />
        <Route path="people/org-chart" element={<PeoplePage section="org-chart" />} />
        <Route path="people/teams" element={<PeoplePage section="teams" />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/:section" element={<SettingsPage />} />
        <Route path="settings/:section/:sub" element={<SettingsPage />} />
        <Route path="admin/:tab?" element={<AdminPage />} />

        {/* ---------------------------------------------------------------- where pages used to be: query and #anchor are kept */}
        <Route path="dashboard" element={<Moved to="/" />} />
        <Route path="command-center" element={<Moved to="/" />} />
        <Route path="calendar" element={<Moved to="/?tab=calendar" />} />
        <Route path="reminders" element={<Moved to="/?tab=reminders" />} />
        <Route path="reminders/*" element={<Moved to="/?tab=reminders" />} />
        <Route path="agents/*" element={<Moved to="/" />} />
        <Route path="project-agent" element={<Moved to="/?tab=proposals" />} />
        <Route path="project-agent/assigned" element={<Moved to="/?tab=given" />} />
        <Route path="project-agent/my-inbox" element={<Moved to="/?tab=mail-agent" />} />
        <Route path="project-agent/meeting-bot" element={<Moved to="/talk?f=meetings&s=notetaker" />} />
        <Route path="project-agent/*" element={<Moved to="/" />} />
        <Route path="ai" element={<Moved to="/?tab=assistant" />} />
        <Route path="ai/operations" element={<Moved to="/insights?tab=workflows" />} />
        <Route path="ai/:id" element={<AiConversationMoved />} />
        <Route path="agent-tracker" element={<Moved to="/settings/ai/tracker" />} />
        <Route path="my-work" element={<Moved to="/work" />} />
        <Route path="operations/*" element={<OperationsMoved />} />
        <Route path="support" element={<OperationsMoved />} />
        <Route path="work/mine" element={<Moved to="/work" />} />
        <Route path="work/reports" element={<Moved to="/insights?tab=reports&s=operations" />} />
        <Route path="projects" element={<Moved to="/work/projects" />} />
        <Route path="projects/*" element={<ProjectsMoved />} />
        <Route path="portfolio/*" element={<Moved to="/work/projects?view=portfolio" />} />
        <Route path="project-status" element={<Moved to="/work/projects?view=portfolio" />} />
        <Route path="chat" element={<Moved to="/talk?f=chat" />} />
        <Route path="chat/*" element={<Moved to="/talk" prefix="/chat" />} />
        <Route path="mailbox" element={<Moved to="/talk?f=mail" />} />
        <Route path="meet" element={<Moved to="/talk?f=meetings" rename={{ open: 'meeting' }} />} />
        <Route path="meet/:s" element={<SectionMoved to="/talk?f=meetings" rename={{ open: 'meeting' }} />} />
        <Route path="notetaker" element={<Moved to="/talk?f=meetings&s=notetaker" />} />
        <Route path="doctracker/*" element={<Moved to="/library/docs" />} />   {/* LibraryPage sends ?p= / ?ep= / ?view= on to the new addresses */}
        <Route path="documents" element={<LegacyDocuments />} />
        <Route path="documents/*" element={<Moved to="/library/docs" prefix="/documents" />} />
        <Route path="vault/*" element={<Moved to="/library/vault" prefix="/vault" />} />
        <Route path="timesheet" element={<Moved to="/insights?tab=time" />} />
        <Route path="timesheet/:s" element={<SectionMoved to="/insights?tab=time" />} />
        <Route path="workload" element={<Moved to="/insights" />} />
        <Route path="workload/capacity" element={<Moved to="/work?tab=team&s=capacity" />} />
        <Route path="my-team" element={<Moved to="/insights" />} />
        <Route path="reports" element={<Moved to="/insights?tab=reports" />} />
        <Route path="reports/operations" element={<Moved to="/insights?tab=reports&s=operations" />} />
        <Route path="account" element={<Moved to="/settings/profile" />} />
        <Route path="account/security" element={<Moved to="/settings/security/account" />} />
        <Route path="account/mobile" element={<Moved to="/settings/profile/mobile" />} />
        <Route path="account/integrations" element={<Moved to="/settings/profile/accounts" />} />
        <Route path="account/notifications" element={<Moved to="/settings/notifications" />} />
        <Route path="account/*" element={<Moved to="/settings/profile" />} />
        <Route path="notifications" element={<Moved to="/settings/notifications/history" />} />
        <Route path="notifications/preferences" element={<Moved to="/settings/notifications/delivery" />} />
        <Route path="notifications/devices" element={<Moved to="/settings/notifications/device" />} />
        <Route path="notifications/schedule" element={<Moved to="/settings/notifications/schedule" />} />
        <Route path="notifications/*" element={<Moved to="/settings/notifications" />} />
        <Route path="project-groups" element={<Moved to="/settings/timelines/project-groups" />} />
        <Route path="members" element={<Moved to="/people" />} />
        <Route path="teams" element={<Moved to="/people/teams" />} />
        <Route path="organization" element={<Moved to="/people/org-chart" />} />
        <Route path="billing" element={<Moved to="/settings/billing" />} />
        <Route path="audit" element={<Moved to="/settings/security/audit" />} />
        <Route path="*" element={<NotFound />} />
      </Route>}
    </Routes>
  );
}

/**
 * Chooses the router's base path from the address: /acme-bank/projects/1 is the page "projects/1" of the organization "acme-bank", so every
 * link and navigation inside keeps working unchanged and the organization is always in the address. A link into another of the person's
 * organizations switches to it first; the Back button between organizations does the same.
 */
function OrgRouter() {
  const status = useAuth((s) => s.status);
  const ctx = useAuth((s) => s.ctx);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const activating = useRef<string | null>(null);
  useEffect(() => {
    // The address can change from outside the router that is showing (the Back button, or a navigation started by a page that has just been
    // replaced, like the sign-in page when its welcome animation ends): look again whenever it does, so the organization is always in it.
    window.addEventListener('popstate', refresh);
    const { pushState, replaceState } = window.history;
    const notify = () => queueMicrotask(refresh);
    window.history.pushState = function (...args) { const r = pushState.apply(this, args); notify(); return r; };
    window.history.replaceState = function (...args) { const r = replaceState.apply(this, args); notify(); return r; };
    return () => { window.removeEventListener('popstate', refresh); window.history.pushState = pushState; window.history.replaceState = replaceState; };
  }, []);

  const ready = status === 'authenticated' && !!ctx?.current;
  // The organization is in the tab's title too, so several tabs of different organizations are told apart.
  const orgName = ready ? ctx!.current!.name : null;
  useEffect(() => { setTitleParts({ org: orgName, unread: orgName ? undefined : 0 }); }, [orgName]);
  const mine = ready ? orgFromPath(window.location.pathname, ctx!.workspaces) : undefined;
  const other = !!mine && mine.id !== ctx!.current!.id;
  useEffect(() => {
    if (!mine || !other || activating.current === mine.id) return;
    activating.current = mine.id;
    useAuth.getState().activateWorkspace(mine.id)
      .catch(() => { window.location.replace(`/${ctx!.current!.slug}/`); })   // no longer a member, or the organization is blocked for them
      .finally(() => { activating.current = null; });
  }, [mine, other, ctx]);
  if (other) return <AppSplash message="Opening the organization" />;

  return (
    <OrgGateContext.Provider value={refresh}>
      <BrowserRouter key={mine?.slug ?? 'root'} basename={mine ? `/${mine.slug}` : undefined}>
        <Suspense fallback={<AppSplash />}>
          <AppRoutes scoped={!!mine} />
        </Suspense>
      </BrowserRouter>
      {/* Outside the router on purpose: the router is rebuilt when the organization appears in the address, and the welcome moment must
          carry on through that, not start again. */}
      <SuccessCurtain />
    </OrgGateContext.Provider>
  );
}

export default function App() {
  useEffect(() => { void useAuth.getState().bootstrap(); }, []);
  return (
    <>
      <ErrorBoundary>
        <OrgRouter />
      </ErrorBoundary>
      {/* Outside the router and the error screen: a newer release is worth knowing about everywhere, signed in or not, and most of all when
          a page of the old one fails to load. */}
      <UpdateBanner />
    </>
  );
}
