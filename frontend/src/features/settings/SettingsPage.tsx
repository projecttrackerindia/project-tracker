import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { authApi, meApi, workspaceApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Badge, Field, Modal, PageHead, PageLoader, SectionLayout, SubmitButton, type SectionLink } from '../../components/ui';
import { useWorkspaceSections } from './sections';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useIsPersonal, useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { ThemeSwitch } from '../../components/ThemeSwitch';
import { PasswordChecklist, passwordProblem, usePasswordPolicy } from '../auth/passwordPolicy';
import { AuditPage } from '../activity/ActivityPages';
import { BillingPage } from '../billing/BillingPage';
import { RolesAccessPage } from '../organization/RolesAccess';
import { OrgSecurityPanel } from '../organization/OrgSecurityPanel';
import { ProjectGroupsPage } from '../projects/ProjectGroupsPage';
import { TimelineTemplatesSettings } from '../projects/TimelineTemplates';
import { NotificationSettings } from './NotificationSettings';
import { TwoStepRow } from './TwoStep';
import { PrivacyRow } from './Privacy';
import { PrioritySettings } from './PrioritySettings';
import { CustomFieldSettings } from './CustomFieldSettings';
import { WorkTypeSettings } from './WorkTypeSettings';
import { SlaSettings } from '../work/Sla';
import { ApiKeySettings } from './ApiKeySettings';
import { WebhookSettings } from './WebhookSettings';
import { DataSettings, GitSettings, InboundEmailSettings } from './IntegrationSettings';
import { WorkspaceAutomationSettings } from '../automation/AutomationPanel';
import { ReminderPolicySettings } from '../reminders/Policy';
import { LabelSettings } from './LabelSettings';
import { SsoSettings } from './SsoSettings';
import { PROVIDER_ICON } from '../auth/AuthPages';
import { Select } from '../../components/Select';
import { AiWorkspaceSwitch } from '../ai/Assistant';
import { AiInstructionsCard, AiProfileCard } from '../ai/AiInstructions';
import { AiUsageCard } from '../ai/AiUsageCard';

const TIME_ZONES = ['Asia/Kolkata', 'UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];

function browserOf(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

// ================================================================== My account (personal, from the avatar menu)

export type AccountSection = 'profile' | 'notifications' | 'security';

/** My account: everything about me, whatever workspace I am in. Workspace administration lives in Workspace settings. */
export function AccountPage({ section }: { section: AccountSection }) {
  const isPlatformAdmin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  const groups: { items: SectionLink[] }[] = [{ items: [
    { to: '/account', label: 'Profile', icon: 'user' },
    ...(!isPlatformAdmin ? [{ to: '/account/notifications', label: 'Notifications', icon: 'bell' as const }] : []),
    { to: '/account/security', label: 'Sign-in & security', icon: 'lock' },
  ] }];
  return (
    <SectionLayout title="My account" sub="Your profile, notifications and how you sign in. These follow you to every workspace." groups={groups}>
      {section === 'profile' && <ProfileSection />}
      {section === 'notifications' && <NotificationSettings />}
      {section === 'security' && <SecuritySection />}
    </SectionLayout>
  );
}

function ProfileSection() {
  const ctx = useAuth((s) => s.ctx)!;
  const reload = useAuth((s) => s.reloadContext);
  const [name, setName] = useState(ctx.user.displayName);
  const [tz, setTz] = useState(ctx.user.timeZone);
  const profile = useMutation({
    mutationFn: () => meApi.updateProfile({ displayName: name.trim(), timeZone: tz }),
    onSuccess: async () => { toast('Profile saved.'); await reload(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not save your profile.', 'error'),
  });
  return (
    <>
      <PageHead title="Profile" sub="How you appear to others, and how dates are shown to you." />
      <div className="card mb-22">
        <div className="card-head"><h3>Profile</h3></div>
        <div className="card-body">
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (name.trim()) profile.mutate(); }}>
            <Field label="Full name" required><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
            <Field label="Email" hint={ctx.user.emailVerified ? 'Verified' : 'Not verified'}><input className="input" value={ctx.user.email} disabled /></Field>
            <Field label="Time zone" hint="Used to display dates and times."><Select className="select" value={tz} onChange={(e) => setTz(e.target.value)}>{[...new Set([tz, ...TIME_ZONES])].map((z) => <option key={z}>{z}</option>)}</Select></Field>
            <div className="full"><SubmitButton busy={profile.isPending}>Save profile</SubmitButton></div>
          </form>
        </div>
      </div>
      <div className="card mb-22">
        <div className="card-head"><h3>Appearance</h3></div>
        <div className="card-body"><div className="setting-row">
          <div className="setting-info"><h4>Dark mode</h4><p>Switch between light and dark themes. Your preference is remembered on this device.</p></div>
          <ThemeSwitch />
        </div></div>
      </div>
    </>
  );
}

function SecuritySection() {
  const logout = useAuth((s) => s.logout);
  const wid = useWorkspaceId();
  const [pwOpen, setPwOpen] = useState(false);
  const sessions = useWsQuery(['sessions'], meApi.sessions);
  return (
    <>
      <PageHead title="Sign-in & security" sub="Your password, two-step verification and the devices you are signed in on." />
      <div className="card mb-22">
        <div className="card-body">
          <div className="setting-row">
            <div className="setting-info"><h4>Password</h4><p>Changing your password signs you out of your other devices.</p></div>
            <button className="btn btn-ghost" onClick={() => setPwOpen(true)}><Icon name="lock" /> Change password</button>
          </div>
          <TwoStepRow />
          <ConnectedAccounts />
          <PrivacyRow />
          <div className="setting-row" style={{ alignItems: 'flex-start' }}>
            <div className="setting-info" style={{ flex: 1 }}>
              <h4>Active sessions</h4><p>Devices currently signed in to your account.</p>
              {sessions.isLoading ? <PageLoader /> : (
                <div className="member-list" style={{ marginTop: 12 }}>
                  {sessions.data?.map((s) => (
                    <div className="member-item" key={s.id}>
                      <Icon name="monitor" />
                      <div className="member-main"><div className="member-name">{browserOf(s.userAgent)} {s.isCurrent && <Badge tone="success">This device</Badge>}</div><div className="member-role">{s.ipAddress ?? 'Unknown IP'} · active {timeAgo(s.lastSeenAt)}</div></div>
                      {!s.isCurrent && <button className="btn btn-ghost btn-sm" onClick={async () => { await meApi.revokeSession(s.id); toast('Session signed out.', 'warning'); invalidateWorkspace(wid); }}>Sign out</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info"><h4>Sign out everywhere</h4><p>End every session on every device, including this one.</p></div>
            <button className="btn btn-danger" onClick={async () => { if (await confirmDialog({ title: 'Sign out everywhere?', confirmText: 'Sign out everywhere', message: 'You will need to sign in again on all your devices.' })) { await authApi.logoutAll(); await logout(); } }}><Icon name="logout" /> Sign out everywhere</button>
          </div>
        </div>
      </div>
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
    </>
  );
}

/** Outside accounts that can sign in to this one: connect Google / Microsoft / GitHub / Apple, or disconnect them. */
function ConnectedAccounts() {
  const wid = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const logins = useWsQuery(['me', 'logins'], meApi.logins);
  const providers = useWsQuery(['auth', 'providers'], authApi.providers, { staleTime: 5 * 60_000 });
  // Back from connecting one: say how it went, once.
  useEffect(() => {
    const linked = params.get('linked'), failed = params.get('link_error');
    if (!linked && !failed) return;
    if (linked) toast(`${linked[0].toUpperCase()}${linked.slice(1)} is connected. You can sign in with it now.`);
    else toast(params.get('message') ?? 'Could not connect the account.', 'error');
    const n = new URLSearchParams(params); ['linked', 'link_error', 'message'].forEach((k) => n.delete(k)); setParams(n, { replace: true });
    void invalidateWorkspace(wid, 'me', 'logins');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const connect = async (id: string) => {
    try { window.location.assign((await meApi.linkLogin(id)).url); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not start connecting.', 'error'); }
  };
  const remove = async (id: string, name: string) => {
    if (!(await confirmDialog({ title: `Disconnect ${name}?`, message: `You will no longer be able to sign in with ${name}.`, confirmText: 'Disconnect' }))) return;
    try { await meApi.unlinkLogin(id); toast(`${name} disconnected.`, 'warning'); void invalidateWorkspace(wid, 'me', 'logins'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not disconnect.', 'error'); }
  };
  const rows = logins.data ?? [];
  const available = (providers.data?.providers ?? []).filter((p) => !rows.some((r) => r.provider === p.id));
  return (
    <div className="setting-row" style={{ alignItems: 'flex-start' }}>
      <div className="setting-info" style={{ flex: 1 }}>
        <h4>Connected accounts</h4><p>Other ways to sign in to this account. Two-step verification still applies.</p>
        {rows.length > 0 && (
          <div className="linked-list">
            {rows.map((r) => (
              <div className="linked-item" key={r.id}>
                <span className="linked-mark">{r.provider === 'sso' ? <Icon name="key" size={15} /> : PROVIDER_ICON[r.provider as keyof typeof PROVIDER_ICON] ?? <Icon name="user" size={15} />}</span>
                <span className="linked-main"><b>{r.name}</b><span>{r.email ?? ''}{r.lastUsedAt ? ` · last used ${timeAgo(r.lastUsedAt)}` : ''}</span></span>
                {r.provider !== 'sso' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove(r.id, r.name)}>Disconnect</button>}
              </div>
            ))}
          </div>
        )}
        {available.length > 0 && (
          <div className="linked-connect">
            {available.map((p) => <button key={p.id} type="button" className="btn btn-ghost btn-sm" onClick={() => void connect(p.id)}>{PROVIDER_ICON[p.id]} Connect {p.name}</button>)}
          </div>
        )}
        {rows.length === 0 && available.length === 0 && <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>No other sign-in options are set up on this installation.</p>}
      </div>
    </div>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const policy = usePasswordPolicy();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => meApi.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => { toast('Password changed. Other devices were signed out.'); onClose(); },
    onError: (e) => {
      const fe: Record<string, string> = {};
      if (e instanceof ApiError) e.errors.forEach((x) => { fe[x.field ?? 'newPassword'] = x.message; });
      setErrors(Object.keys(fe).length ? fe : { newPassword: 'Could not change the password.' });
    },
  });
  return (
    <Modal size="sm" title="Change password" onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        const er: Record<string, string> = {};
        if (!current) er.currentPassword = 'Enter your current password.';
        const problem = passwordProblem(policy, next);
        if (problem) er.newPassword = problem;
        setErrors(er);
        if (!Object.keys(er).length) save.mutate();
      }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>Update password</SubmitButton></>}>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="Current password" error={errors.currentPassword}><input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" error={errors.newPassword}><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <PasswordChecklist policy={policy} password={next} showHistory />
      </div>
    </Modal>
  );
}

// ================================================================== Workspace settings (the gear; administration of this workspace)

/** Workspace settings: one place for everything an administrator maintains about this workspace. */
export function WorkspaceSettingsPage() {
  const { section } = useParams();
  const sections = useWorkspaceSections();
  if (!sections.length) return <Navigate to="/account" replace />;
  const current = sections.find((s) => s.id === section);
  if (!current) return <Navigate to={sections[0].to} replace />;
  const groups = (['Workspace', 'Configuration', 'Integrations'] as const).map((g) => ({ title: g, items: sections.filter((s) => s.group === g) }));
  return (
    <SectionLayout title="Workspace settings" sub="How this workspace is set up: access, security, master lists, integrations and billing." groups={groups}>
      {current.id === 'general' && <GeneralSection />}
      {current.id === 'access' && <RolesAccessPage />}
      {current.id === 'security' && <><PageHead title="Security" sub="Rules every member's sign-in must meet." /><OrgSecurityPanel /></>}
      {current.id === 'sso' && <SsoSettings />}
      {current.id === 'billing' && <BillingPage />}
      {current.id === 'audit' && <AuditPage />}
      {current.id === 'project-groups' && <ProjectGroupsPage />}
      {current.id === 'timeline-templates' && <TimelineTemplatesSettings />}
      {current.id === 'labels' && <LabelSettings />}
      {current.id === 'priorities' && <><PageHead title="Priorities" sub="The names and colours of the four priority levels." /><PrioritySettings /></>}
      {current.id === 'custom-fields' && <><PageHead title="Custom fields" sub="Extra fields every task in this workspace can have." /><CustomFieldSettings /></>}
      {current.id === 'work-types' && <><PageHead title="Work types" sub="The kinds of operational work people can raise, and how fast each must be answered and resolved." /><WorkTypeSettings /><SlaSettings /></>}
      {current.id === 'api-keys' && <><PageHead title="API keys" sub="Access for scripts and other tools." /><ApiKeySettings /></>}
      {current.id === 'webhooks' && <><PageHead title="Webhooks, Slack & Teams" sub="Tell channels and other systems when something changes here." /><WebhookSettings /></>}
      {current.id === 'email' && <><PageHead title="Email to work" sub="Turn emails from your team into operational work." /><InboundEmailSettings /></>}
      {current.id === 'git' && <><PageHead title="GitHub & Azure DevOps" sub="Link commits and pull requests to the tasks they mention." /><GitSettings /></>}
      {current.id === 'automation' && <><PageHead title="Automation" sub="Rules that run on every project's tasks: when something happens - or on a schedule - do something." /><WorkspaceAutomationSettings /></>}
      {current.id === 'reminders' && <><PageHead title="Reminders" sub="Everyone gets reminders about their own work on every plan. Here: what happens when work stays overdue." /><ReminderPolicySettings /></>}
      {current.id === 'data' && <><PageHead title="Data & retention" sub="How long history is kept, and a full export of everything." /><DataSettings /></>}
    </SectionLayout>
  );
}

function GeneralSection() {
  const ctx = useAuth((s) => s.ctx)!;
  const reload = useAuth((s) => s.reloadContext);
  const personal = useIsPersonal();
  const canOrg = useCan('org.manage');
  const seeBilling = useModule('billing') > 0;
  const [wsName, setWsName] = useState(ctx.current?.name ?? '');
  const [wsDesc, setWsDesc] = useState(ctx.current?.description ?? '');
  const workspace = useMutation({
    mutationFn: () => workspaceApi.update({ name: wsName.trim(), description: wsDesc.trim() || undefined }),
    onSuccess: async () => { toast('Workspace updated.'); await reload(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not update the workspace.', 'error'),
  });
  if (!ctx.current) return null;
  return (
    <>
      <PageHead title="General" sub={`${personal ? 'Your personal workspace' : 'Organization'} · your access level: ${ctx.current.role}`} />
      <div className="card">
        <div className="card-body">
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (wsName.trim().length >= 2) workspace.mutate(); }}>
            <Field label="Workspace name"><input className="input" value={wsName} onChange={(e) => setWsName(e.target.value)} disabled={!canOrg} maxLength={80} /></Field>
            <Field label="Plan"><div className="row" style={{ height: 38 }}><Badge tone="purple">{ctx.current.plan.name}</Badge>{seeBilling && <Link className="link" to="/settings/billing">Plan and billing</Link>}</div></Field>
            <Field label="Description" full><textarea className="textarea" value={wsDesc} onChange={(e) => setWsDesc(e.target.value)} disabled={!canOrg} maxLength={500} /></Field>
            {canOrg && <div className="full"><SubmitButton busy={workspace.isPending}>Save workspace</SubmitButton></div>}
          </form>
          {personal && <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>Want to collaborate? Use the workspace menu in the top bar to create an organization.</p>}
        </div>
      </div>
      {(ctx.current.role === 'Owner' || ctx.current.role === 'Admin') && <><AiWorkspaceSwitch /><AiInstructionsCard /><AiUsageCard /></>}
      <AiProfileCard />
    </>
  );
}
