import { createContext, lazy, Suspense, useContext, useEffect, useReducer, useRef, useState, type ComponentType } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { orgFromPath, firstSegment } from './lib/orgPath';
import { setTitleParts } from './lib/title';
import { ApiError } from './api/client';
import { consentApi, meApi } from './api/endpoints';
import type { ConsentDocument } from './api/types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon } from './components/Icon';
import { SuccessCurtain } from './components/SuccessCurtain';
import { Field, Modal, PageLoader, SubmitButton } from './components/ui';
import { PasswordChecklist, passwordProblem, usePasswordPolicy } from './features/auth/passwordPolicy';
import { AcceptInvitePage, AuthCompletePage, ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage, VerifyEmailPage } from './features/auth/AuthPages';
import { TwoStepRow } from './features/settings/TwoStep';
import { useVisibleKinds } from './features/workitems/workItems';
import { AppLayout } from './layouts/AppLayout';

/**
 * Pages are loaded when they are first opened rather than all up front, so the first visit downloads a fraction of the app. Each page
 * module exports its page by name; `page` picks that export for React.lazy.
 */
function page<K extends string>(load: () => Promise<Record<K, ComponentType<any>>>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
const AdminPage = page(() => import('./features/admin/AdminPage'), 'AdminPage');
const AiPage = page(() => import('./features/ai/AiPage'), 'AiPage');
const CalendarPage = page(() => import('./features/calendar/CalendarPage'), 'CalendarPage');
const ChatPage = page(() => import('./features/chat/ChatPage'), 'ChatPage');
const DocumentsPage = page(() => import('./features/documents/DocumentsPage'), 'DocumentsPage');
const DocumentPage = page(() => import('./features/documents/DocumentPage'), 'DocumentPage');
const DashboardPage = page(() => import('./features/dashboard/DashboardPage'), 'DashboardPage');
const MailboxPage = page(() => import('./features/dev/MailboxPage'), 'MailboxPage');
const PeoplePage = page(() => import('./features/people/PeoplePage'), 'PeoplePage');
const ProjectDetailPage = page(() => import('./features/projects/ProjectDetailPage'), 'ProjectDetailPage');
const ProjectsPage = page(() => import('./features/projects/ProjectsPage'), 'ProjectsPage');
const ProjectStatusPage = page(() => import('./features/projects/ProjectStatusPage'), 'ProjectStatusPage');
const ReportsPage = page(() => import('./features/reports/ReportsPage'), 'ReportsPage');
const LegalPage = page(() => import('./features/legal/LegalPage'), 'LegalPage');
const TimesheetPage = page(() => import('./features/time/TimesheetPage'), 'TimesheetPage');
const WorkTasksPage = page(() => import('./features/work/WorkTasksPage'), 'WorkTasksPage');
const MyWorkPage = page(() => import('./features/workitems/MyWorkPage'), 'MyWorkPage');
const RemindersPage = page(() => import('./features/reminders/RemindersPage'), 'RemindersPage');
const UnsubscribePage = page(() => import('./features/auth/UnsubscribePage'), 'UnsubscribePage');
const ApprovePage = page(() => import('./features/auth/ApprovePage'), 'ApprovePage');
const ReminderActionPage = page(() => import('./features/reminders/ActionPage'), 'ReminderActionPage');
const WorkloadPage = page(() => import('./features/workitems/WorkloadPage'), 'WorkloadPage');
const ActivityPage = page(() => import('./features/activity/ActivityPages'), 'ActivityPage');
const NotificationsPage = page(() => import('./features/activity/ActivityPages'), 'NotificationsPage');
const AccountPage = page(() => import('./features/settings/SettingsPage'), 'AccountPage');
const WorkspaceSettingsPage = page(() => import('./features/settings/SettingsPage'), 'WorkspaceSettingsPage');
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
        <div className="card" style={{ marginBottom: 18 }}><div className="card-body"><TwoStepRow /></div></div>
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
  if (status === 'loading') return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><PageLoader /></div>;
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
  if (ctx.user.isPlatformAdmin && !loc.pathname.startsWith('/admin') && !loc.pathname.startsWith('/account') && loc.pathname !== '/settings') return <Navigate to="/admin" replace />;
  return <AppLayout />;
}

/** Hide pages the current role / workspace type cannot use, instead of showing a screen of 403s. */
function Guard({ allow, children }: { allow: boolean; children: React.ReactNode }) {
  return allow ? <>{children}</> : <Navigate to="/" replace />;
}

/**
 * An address from before the navigation was regrouped: go to where that page lives now, keeping the query (a project, a task ...)
 * and adding any the new place needs, so bookmarks and links in old notifications and emails keep working.
 */
function Moved({ to }: { to: string }) {
  const loc = useLocation();
  const [path, extra] = to.split('?');
  const q = new URLSearchParams(loc.search);
  new URLSearchParams(extra ?? '').forEach((v, k) => q.set(k, v));
  const s = q.toString();
  return <Navigate to={`${path}${s ? `?${s}` : ''}`} replace />;
}

function NotFound() {
  return (
    <div className="empty" style={{ paddingTop: 80 }}>
      <h4>Page not found</h4><p>The page you are looking for does not exist.</p><Link className="btn btn-primary" to="/">Back to dashboard</Link>
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

const PUBLIC_PAGES = new Set(['login', 'register', 'verify-email', 'forgot-password', 'reset-password', 'invite', 'unsubscribe', 'auth', 'security', 'download', 'r', 'dev']);

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
  const mCalendar = useModule('calendar') > 0, mActivity = useModule('activity') > 0, mDocuments = useModule('documents') > 0;
  const permReports = useCan('reports.view'), broad = useCan('reports.broad');
  const canReports = permReports && mReports;
  const isGuest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const kinds = useVisibleKinds();
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
      {import.meta.env.DEV && <Route path="/dev/mailbox" element={<MailboxPage />} />}

      {redirecting ? <Route path="*" element={<OrgRedirect />} /> : <Route element={<RequireAuth />}>
        {/* Home */}
        <Route index element={<DashboardPage />} />
        <Route path="approve/:id" element={<ApprovePage />} />
        <Route path="my-work" element={<Guard allow={kinds.length > 0}><MyWorkPage /></Guard>} />
        <Route path="ai" element={<AiPage />} />
        <Route path="ai/:id" element={<AiPage />} />
        <Route path="reminders" element={<RemindersPage />} />
        <Route path="timesheet" element={<Guard allow={mTasks || mWork}><TimesheetPage /></Guard>} />
        <Route path="timesheet/approvals" element={<Guard allow={mTasks || mWork}><TimesheetPage section="approvals" /></Guard>} />
        <Route path="calendar" element={<Guard allow={mCalendar}><CalendarPage /></Guard>} />
        <Route path="chat" element={<Guard allow={!personal && !isGuest}><ChatPage /></Guard>} />
        <Route path="chat/:id" element={<Guard allow={!personal && !isGuest}><ChatPage /></Guard>} />
        {/* Delivery */}
        <Route path="projects" element={<Guard allow={mProjects}><ProjectsPage /></Guard>} />
        <Route path="projects/:id" element={<Guard allow={mProjects}><ProjectDetailPage /></Guard>} />
        <Route path="portfolio" element={<Guard allow={mProjects}><ProjectStatusPage /></Guard>} />
        <Route path="operations" element={<Guard allow={mWork}><WorkTasksPage /></Guard>} />
        <Route path="documents" element={<Guard allow={mDocuments}><DocumentsPage /></Guard>} />
        <Route path="documents/:id" element={<Guard allow={mDocuments}><DocumentPage /></Guard>} />
        {/* Insights */}
        <Route path="workload" element={<Guard allow={!personal && (hasReports || broad)}><WorkloadPage /></Guard>} />
        <Route path="workload/capacity" element={<Guard allow={!personal && (hasReports || broad)}><WorkloadPage section="capacity" /></Guard>} />
        <Route path="reports" element={<Guard allow={canReports || mWork}><ReportsPage section="generate" /></Guard>} />
        <Route path="reports/operations" element={<Guard allow={mWork}><ReportsPage section="operations" /></Guard>} />
        <Route path="activity" element={<Guard allow={mActivity}><ActivityPage /></Guard>} />
        {/* People (each section checks its own access) */}
        <Route path="people" element={<PeoplePage section="directory" />} />
        <Route path="people/invitations" element={<PeoplePage section="invitations" />} />
        <Route path="people/org-chart" element={<PeoplePage section="org-chart" />} />
        <Route path="people/teams" element={<PeoplePage section="teams" />} />
        {/* Workspace settings and My account */}
        <Route path="settings" element={<WorkspaceSettingsPage />} />
        <Route path="settings/:section" element={<WorkspaceSettingsPage />} />
        <Route path="account" element={<AccountPage section="profile" />} />
        <Route path="account/notifications" element={<AccountPage section="notifications" />} />
        <Route path="account/security" element={<AccountPage section="security" />} />
        <Route path="account/mobile" element={<AccountPage section="mobile" />} />
        <Route path="account/integrations" element={<AccountPage section="integrations" />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="admin/:tab?" element={<AdminPage />} />
        {/* Where pages used to be */}
        <Route path="work" element={<Moved to="/operations" />} />
        <Route path="work/mine" element={<Moved to="/my-work?kind=Operational" />} />
        <Route path="work/reports" element={<Moved to="/reports/operations" />} />
        <Route path="my-team" element={<Moved to="/workload" />} />
        <Route path="project-status" element={<Moved to="/portfolio" />} />
        <Route path="project-groups" element={<Moved to="/settings/project-groups" />} />
        <Route path="members" element={<Moved to="/people" />} />
        <Route path="teams" element={<Moved to="/people/teams" />} />
        <Route path="organization" element={<Moved to="/people/org-chart" />} />
        <Route path="billing" element={<Moved to="/settings/billing" />} />
        <Route path="audit" element={<Moved to="/settings/audit" />} />
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
  if (other) return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><PageLoader /></div>;

  return (
    <OrgGateContext.Provider value={refresh}>
      <BrowserRouter key={mine?.slug ?? 'root'} basename={mine ? `/${mine.slug}` : undefined}>
        <Suspense fallback={<div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center' }}><PageLoader /></div>}>
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
    <ErrorBoundary>
      <OrgRouter />
    </ErrorBoundary>
  );
}
