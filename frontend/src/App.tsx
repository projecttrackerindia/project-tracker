import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError } from './api/client';
import { consentApi, meApi } from './api/endpoints';
import type { ConsentDocument } from './api/types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Field, Modal, PageLoader, SubmitButton } from './components/ui';
import { AdminPage } from './features/admin/AdminPage';
import { ActivityPage, AuditPage, NotificationsPage } from './features/activity/ActivityPages';
import { PasswordChecklist, passwordProblem, usePasswordPolicy } from './features/auth/passwordPolicy';
import { AcceptInvitePage, ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage, VerifyEmailPage } from './features/auth/AuthPages';
import { BillingPage } from './features/billing/BillingPage';
import { CalendarPage } from './features/calendar/CalendarPage';
import { ChatPage } from './features/chat/ChatPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { MailboxPage } from './features/dev/MailboxPage';
import { MembersPage } from './features/members/MembersPage';
import { OrgPage } from './features/organization/OrgPage';
import { ProjectDetailPage } from './features/projects/ProjectDetailPage';
import { ProjectsPage } from './features/projects/ProjectsPage';
import { ProjectGroupsPage } from './features/projects/ProjectGroupsPage';
import { ProjectStatusPage } from './features/projects/ProjectStatusPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { TwoStepRow } from './features/settings/TwoStep';
import { TimesheetPage } from './features/time/TimesheetPage';
import { WorkTasksPage } from './features/work/WorkTasksPage';
import { WorkReportsPage } from './features/work/WorkReportsPage';
import { MyTeamPage } from './features/team/MyTeamPage';
import { TeamsPage } from './features/teams/TeamsPage';
import { AppLayout } from './layouts/AppLayout';
import { toast } from './stores/ui';
import { useAuth, useCan, useIsPersonal, useModule } from './stores/auth';

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
function MustChangePassword() {
  const policy = usePasswordPolicy();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
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
        <Field label="Temporary password" error={errors.currentPassword}><input className="input" type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" error={errors.newPassword}><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <PasswordChecklist policy={policy} password={next} showHistory />
        <Field label="Confirm new password" error={errors.again}><input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
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
  if (status === 'anonymous') return <Navigate to={`/login?redirect=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  // Terms first: accepting them works while the password is still temporary, but the password change is a write that the terms gate
  // refuses until they have been accepted.
  if (ctx?.pendingConsent && ctx.pendingConsent.length > 0) return <PendingConsent pending={ctx.pendingConsent} />;
  if (ctx?.user.mustChangePassword) return <MustChangePassword />;
  if (!ctx?.current) return <NoWorkspace />;
  // Platform administrators have an admin-only interface; workspace pages are for customers.
  if (ctx.user.isPlatformAdmin && !loc.pathname.startsWith('/admin') && loc.pathname !== '/settings') return <Navigate to="/admin" replace />;
  return <AppLayout />;
}

/** Hide pages the current role / workspace type cannot use, instead of showing a screen of 403s. */
function Guard({ allow, children }: { allow: boolean; children: React.ReactNode }) {
  return allow ? <>{children}</> : <Navigate to="/" replace />;
}

function NotFound() {
  return (
    <div className="empty" style={{ paddingTop: 80 }}>
      <h4>Page not found</h4><p>The page you are looking for does not exist.</p><Link className="btn btn-primary" to="/">Back to dashboard</Link>
    </div>
  );
}

function AppRoutes() {
  const personal = useIsPersonal();
  const hasReports = (useAuth((s) => s.ctx?.current?.reportCount) ?? 0) > 0;
  const mReports = useModule('reports') > 0, mAudit = useModule('audit') > 0, mTasks = useModule('tasks') > 0, mProjects = useModule('projects') > 0, mWork = useModule('work') > 0;
  const mCalendar = useModule('calendar') > 0, mTeams = useModule('teams') > 0, mMembers = useModule('members') > 0, mActivity = useModule('activity') > 0;
  const mBilling = useModule('billing') > 0, mOrg = useModule('organization') > 0;
  const canReports = useCan('reports.view') && mReports;
  const canAudit = useCan('audit.view') && mAudit;
  const isGuest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/invite" element={<AcceptInvitePage />} />
      {import.meta.env.DEV && <Route path="/dev/mailbox" element={<MailboxPage />} />}

      <Route element={<RequireAuth />}>
        <Route index element={<DashboardPage />} />
        <Route path="work" element={<Guard allow={mWork}><WorkTasksPage /></Guard>} />
        <Route path="work/mine" element={<Guard allow={mWork}><WorkTasksPage mine /></Guard>} />
        <Route path="work/reports" element={<Guard allow={mWork}><WorkReportsPage /></Guard>} />
        <Route path="timesheet" element={<Guard allow={mTasks}><TimesheetPage /></Guard>} />
        <Route path="my-team" element={<Guard allow={mTasks && hasReports}><MyTeamPage /></Guard>} />
        <Route path="projects" element={<Guard allow={mProjects}><ProjectsPage /></Guard>} />
        <Route path="projects/:id" element={<Guard allow={mProjects}><ProjectDetailPage /></Guard>} />
        <Route path="project-status" element={<Guard allow={mProjects}><ProjectStatusPage /></Guard>} />
        <Route path="project-groups" element={<Guard allow={mProjects}><ProjectGroupsPage /></Guard>} />
        <Route path="calendar" element={<Guard allow={mCalendar}><CalendarPage /></Guard>} />
        <Route path="chat" element={<Guard allow={!personal && !isGuest}><ChatPage /></Guard>} />
        <Route path="chat/:id" element={<Guard allow={!personal && !isGuest}><ChatPage /></Guard>} />
        <Route path="teams" element={<Guard allow={!personal && mTeams}><TeamsPage /></Guard>} />
        <Route path="members" element={<Guard allow={!personal && mMembers}><MembersPage /></Guard>} />
        <Route path="organization" element={<Guard allow={!personal && !isGuest && mOrg}><OrgPage /></Guard>} />
        <Route path="reports" element={<Guard allow={canReports}><ReportsPage /></Guard>} />
        <Route path="activity" element={<Guard allow={mActivity}><ActivityPage /></Guard>} />
        <Route path="audit" element={<Guard allow={!personal && canAudit}><AuditPage /></Guard>} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="billing" element={<Guard allow={mBilling}><BillingPage /></Guard>} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin/:tab?" element={<AdminPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  useEffect(() => { void useAuth.getState().bootstrap(); }, []);
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
