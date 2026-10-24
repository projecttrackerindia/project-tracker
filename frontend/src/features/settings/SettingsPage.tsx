import { WorkspaceLogoCard } from './WorkspaceLogo';
import { ProfilePhotoCard } from './ProfilePhoto';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { authApi, meApi, workspaceApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Badge, Field, Modal, PageHead, PageLoader, SectionLayout, SubmitButton, type SectionLink } from '../../components/ui';
import { SETTINGS_GROUPS, useWorkspaceSections, type WorkspaceSection } from './sections';
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
import { MemberSecurityPanel } from '../organization/MemberSecurityPanel';
import { SignInHistory } from './SignInHistory';
import { ProjectVisibilityPanel } from '../organization/ProjectVisibilityPanel';
import { ProjectGroupsPage } from '../projects/ProjectGroupsPage';
import { TimelineTemplatesSettings } from '../projects/TimelineTemplates';
import { TimeZonePicker } from '../../components/TimeZonePicker';
import { TwoStepRow } from './TwoStep';
import { PasskeysRow } from './Passkeys';
import { PrivacyRow } from './Privacy';
import { PrioritySettings } from './PrioritySettings';
import { CustomFieldSettings } from './CustomFieldSettings';
import { WorkTypeSettings } from './WorkTypeSettings';
import { SlaSettings } from '../work/Sla';
import { ApiKeySettings } from './ApiKeySettings';
import { ConnectedApps } from '../integrations/ConnectedApps';
import { WebhookSettings } from './WebhookSettings';
import { DataSettings, GitSettings, InboundEmailSettings } from './IntegrationSettings';
import { GitHubAppCard } from '../github/GitHubApp';
import { WorkspaceAutomationSettings } from '../automation/AutomationPanel';
import { ReminderPolicySettings } from '../reminders/Policy';
import { LabelSettings } from './LabelSettings';
import { SsoSettings } from './SsoSettings';
import { PROVIDER_ICON } from '../auth/AuthPages';
import { AiWorkspaceSwitch } from '../ai/Assistant';
import { AiInstructionsCard, AiProfileCard } from '../ai/AiInstructions';
import { AiOwnKeyCard, MyAiProviderCard } from '../ai/OwnAiKey';
import { DirectoryPanel, InvitationsPanel } from '../members/MembersPage';
import { LastChanged, SectionHistory, SettingsHome, SettingsSearch, useSettingJump, useSetupHealth } from './SettingsCenter';
import { NotificationDefaultsSection } from './NotificationDefaults';
import { MobileAppSection } from './MobileAppSection';
import { ConnectedAccountsSection } from './ConnectedAccounts';
import { AiUsageCard } from '../ai/AiUsageCard';
import { SlackSettings } from './SlackSettings';
import { WhatsAppSettings } from './WhatsAppSettings';
const ResumeBuilderSection = lazy(() => import('./ResumeBuilder').then(m=>({default:m.ResumeBuilderSection})));


/** How the session was opened, in the person's words ("with a passkey · "). Empty when it is the ordinary password. */
function signedInWith(method?: string | null) {
  const m: Record<string, string> = { passkey: 'with a passkey', device: 'approved on a phone', sso: 'through single sign-on', google: 'with Google', microsoft: 'with Microsoft', github: 'with GitHub', apple: 'with Apple' };
  return method && m[method] ? `${m[method]} · ` : '';
}

function browserOf(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

// ================================================================== My account (personal, from the avatar menu)

export type AccountSection = 'profile' | 'notifications' | 'security' | 'mobile' | 'integrations' | 'resumes';

/** My account: everything about me, whatever workspace I am in. Workspace administration lives in Workspace settings. */
export function AccountPage({ section }: { section: AccountSection }) {
  const isPlatformAdmin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  useSettingJump();
  const groups: { items: SectionLink[] }[] = [{ items: [
    { to: '/account', label: 'Profile', icon: 'user' },
    ...(!isPlatformAdmin ? [{ to: '/notifications/preferences', label: 'Notification Center', icon: 'bell' as const }] : []),
    { to: '/account/security', label: 'Sign-in & security', icon: 'lock' },
    ...(!isPlatformAdmin ? [{ to: '/account/mobile', label: 'Mobile app', icon: 'bell' as const }] : []),
    ...(!isPlatformAdmin ? [{ to: '/account/integrations', label: 'Connected accounts', icon: 'video' as const }] : []),
    { to: '/account/resumes', label: 'Resume studio', icon: 'note' },
  ] }];
  return (
    <SectionLayout wide title="My account" sub="Your profile, notifications and how you sign in. These follow you to every workspace." groups={groups}>
      {section === 'profile' && <ProfileSection />}
      {section === 'security' && <SecuritySection />}
      {section === 'mobile' && <MobileAppSection />}
      {section === 'integrations' && <ConnectedAccountsSection />}
      {section === 'resumes' && <Suspense fallback={<PageLoader />}><ResumeBuilderSection /></Suspense>}
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
      <ProfilePhotoCard />
      <div className="card mb-22">
        <div className="card-head"><h3>Profile</h3></div>
        <div className="card-body">
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (name.trim()) profile.mutate(); }}>
            <Field label="Full name" required><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
            <Field label="Email" hint={ctx.user.emailVerified ? 'Verified' : 'Not verified'}><input className="input" value={ctx.user.email} disabled /></Field>
            <Field label="Time zone" hint="Every date, due date, reminder and chart follows it. More options in Notification Center → Schedule."><TimeZonePicker value={tz} onChange={(z) => z && setTz(z)} /></Field>
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
      <div data-setting="account.ai"><AiProfileCard /><MyAiProviderCard /></div>
      <DeleteAccountCard />
    </>
  );
}

/** Asking for this account and its personal data to be deleted (app stores require it in the app). Support completes it within 30 days. */
function DeleteAccountCard() {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: () => meApi.requestDeletion(reason.trim() || undefined),
    onSuccess: (r) => { setSent(r.email); setOpen(false); toast('Deletion requested. Check your e-mail for the confirmation.'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not send the request.', 'error'),
  });
  return (
    <div className="card mb-22">
      <div className="card-head"><h3>Delete my account</h3></div>
      <div className="card-body"><div className="setting-row">
        <div className="setting-info"><h4>Delete my account and personal data</h4>
          <p>{sent ? `Requested. We will complete it within 30 days and write to ${sent} when it is done.`
            : 'We remove your account and the personal data linked to it within 30 days. If you own a workspace, we first agree with you who takes it over, so your team keeps its work. Invoices are kept as long as tax law requires.'}</p></div>
        {!sent && <button type="button" className="btn btn-danger btn-sm" onClick={() => setOpen(true)}>Request deletion</button>}
      </div></div>
      {open && (
        <Modal title="Delete my account?" onClose={() => setOpen(false)}>
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); request.mutate(); }}>
            <p className="full" style={{ margin: 0 }}>Your request goes to our support team, and you get a confirmation e-mail. Nothing is deleted until support completes it.</p>
            <Field label="Why are you leaving? (optional)" full><textarea className="input" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="full"><SubmitButton busy={request.isPending}>Request deletion</SubmitButton></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function SecuritySection() {
  const logout = useAuth((s) => s.logout);
  const wid = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const [pwOpen, setPwOpen] = useState(() => params.get('change-password') === '1');
  useEffect(() => { if (params.get('change-password') === '1') { setPwOpen(true); params.delete('change-password'); setParams(params, { replace: true }); } }, [params, setParams]);
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
          <PasskeysRow />
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
                      <div className="member-main"><div className="member-name">{browserOf(s.userAgent)} {s.isCurrent && <Badge tone="success">This device</Badge>}</div><div className="member-role">{s.ipAddress ?? 'Unknown IP'} · {signedInWith(s.authMethod)}active {timeAgo(s.lastSeenAt)}</div></div>
                      {!s.isCurrent && <button className="btn btn-ghost btn-sm" onClick={async () => { await meApi.revokeSession(s.id); toast('Session signed out.', 'warning'); invalidateWorkspace(wid); }}>Sign out</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="setting-row" style={{ alignItems: 'flex-start' }}>
            <div className="setting-info" style={{ flex: 1 }}>
              <h4>Sign-in history</h4><p>Every sign-in of the last 90 days. A new browser or network is marked, and you were told about it. Not you? End it here.</p>
              <SignInHistory />
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

/**
 * Workspace settings: one place for everything an administrator maintains about this workspace, in seven groups, found by typing.
 * /settings is the overview (search, setup health, latest changes); each section shows who changed its settings, with undo.
 */
export function WorkspaceSettingsPage() {
  const { section } = useParams();
  const sections = useWorkspaceSections();
  const health = useSetupHealth();
  useSettingJump();
  if (!sections.length) return <Navigate to="/account" replace />;
  const current = sections.find((s) => s.id === section);
  if (section && !current) return <Navigate to="/settings" replace />;
  const open = health.data?.open ?? 0;
  const groups = [
    { items: [{ to: '/settings', label: 'Overview', icon: 'grid' as const, badge: open || undefined }] },
    ...SETTINGS_GROUPS.map((g) => ({ title: g, items: sections.filter((s) => s.group === g) })),
  ];
  return (
    <SectionLayout title="Workspace settings" sub="How this workspace is set up: people and access, security, notifications, integrations, AI and billing."
      groups={groups} navTop={<SettingsSearch compact />}>
      {!current && <SettingsHome />}
      {current && <SettingsSection id={current.id} />}
    </SectionLayout>
  );
}

function SettingsSection({ id }: { id: WorkspaceSection }) {
  switch (id) {
    case 'general': return <GeneralSection />;
    case 'members': return <MembersSection />;
    case 'access': return <><RolesAccessPage /><SectionHistory section="access" /></>;
    case 'visibility': return <><PageHead title="Project visibility" sub="Whether everyone sees every project, or each team sees its own." /><div data-setting="access.projectVisibility"><ProjectVisibilityPanel /><LastChanged k="access.projectVisibility" section="visibility" /></div><SectionHistory section="visibility" /></>;
    case 'security': return <><PageHead title="Sign-in rules" sub="Rules every member's sign-in must meet in this workspace, on top of their own account security." /><OrgSecurityPanel /><div data-setting="security.members"><MemberSecurityPanel /></div><SectionHistory section="security" /></>;
    case 'sso': return <><SsoSettings /><SectionHistory section="sso" /></>;
    case 'billing': return <><BillingPage /><SectionHistory section="billing" /></>;
    case 'audit': return <AuditPage />;
    case 'project-groups': return <><ProjectGroupsPage /><SectionHistory section="project-groups" /></>;
    case 'timeline-templates': return <><TimelineTemplatesSettings /><SectionHistory section="timeline-templates" /></>;
    case 'labels': return <LabelSettings />;
    case 'priorities': return <><PageHead title="Priorities" sub="The names and colours of the four priority levels." /><PrioritySettings /><SectionHistory section="priorities" /></>;
    case 'custom-fields': return <><PageHead title="Custom fields" sub="Extra fields every task in this workspace can have." /><CustomFieldSettings /><SectionHistory section="custom-fields" /></>;
    case 'work-types': return <><PageHead title="Work types" sub="The kinds of operational work people can raise, and how fast each must be answered and resolved." /><WorkTypeSettings /><SlaSettings /><SectionHistory section="work-types" /></>;
    case 'connected-apps': return <><PageHead title="Connected AI apps" sub="Claude, ChatGPT and other AI assistants working in this workspace on someone's behalf." /><ConnectedApps /><SectionHistory section="connected-apps" /></>;
    case 'api-keys': return <><PageHead title="API keys" sub="Access for scripts and other tools." /><ApiKeySettings /><SectionHistory section="api-keys" /></>;
    case 'webhooks': return <><PageHead title="Webhooks" sub="Tell your systems, and Slack or Microsoft Teams channels, when something changes here; turn alerts and forms they send into work." /><WebhookSettings /><SectionHistory section="webhooks" /></>;
    case 'email': return <><PageHead title="Email to work" sub="Turn emails from your team into operational work." /><InboundEmailSettings /><SectionHistory section="email" /></>;
    case 'whatsapp': return <><PageHead title="WhatsApp Business" sub="Your organization's own business number: the support desk for customers, and notifications for members." /><WhatsAppSettings /><SectionHistory section="whatsapp" /></>;
    case 'slack': return <SlackSection />;
    case 'git': return <><PageHead title="GitHub & Azure DevOps" sub="Link commits and pull requests to the tasks they mention." /><GitHubAppCard /><GitSettings /><SectionHistory section="git" /></>;
    case 'automation': return <><PageHead title="Automation" sub="Rules that run on every project's tasks: when something happens - or on a schedule - do something." /><WorkspaceAutomationSettings /><SectionHistory section="automation" /></>;
    case 'notifications': return <NotificationDefaultsSection />;
    case 'reminders': return <><PageHead title="Escalation" sub="Everyone gets reminders about their own work on every plan. Here: what happens when work stays overdue." /><div data-setting="reminders.escalation"><ReminderPolicySettings /><LastChanged k="reminders.escalation" section="reminders" /></div><SectionHistory section="reminders" /></>;
    case 'data': return <><PageHead title="Data & retention" sub="How long history is kept, and a full export of everything." /><DataSettings /><SectionHistory section="data" /></>;
    case 'ai': return <AiSection />;
  }
}

/** People and access → Members: everyone in the workspace (invite, change access levels, remove), and the invitations still waiting. */
function MembersSection() {
  const canInvite = useCan('members.invite');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'invitations' && canInvite ? 'invitations' : 'members';
  return (
    <>
      {canInvite && (
        <div className="seg mb-22" role="tablist" aria-label="Members">
          <button type="button" role="tab" aria-selected={tab === 'members'} className={tab === 'members' ? 'on' : ''} onClick={() => setParams({}, { replace: true })}>Members</button>
          <button type="button" role="tab" aria-selected={tab === 'invitations'} className={tab === 'invitations' ? 'on' : ''} onClick={() => setParams({ tab: 'invitations' }, { replace: true })}>Invitations</button>
        </div>
      )}
      <div data-setting={tab === 'invitations' ? 'members.invitations' : 'members.invite'}>{tab === 'invitations' ? <InvitationsPanel /> : <DirectoryPanel />}</div>
      <SectionHistory section="members" />
    </>
  );
}

/** Integrations → Slack: the one Slack page. Posting to a channel without the app is a webhook in Slack format (Integrations → Webhooks). */
function SlackSection() {
  return (
    <>
      <PageHead title="Slack" sub="Connect a Slack workspace to this organization: people link their accounts, get notifications and act on work from Slack." />
      <SlackSettings />
      <div className="explainer" role="note" style={{ marginTop: 18 }}>
        <Icon name="info" size={16} />
        <div>Only need messages in one channel? Add a webhook in <b>Slack</b> format instead, no app needed: <Link className="link" to="/settings/webhooks">Integrations → Webhooks</Link>.</div>
      </div>
      <SectionHistory section="slack" />
    </>
  );
}

/** AI → Assistant: on or off for the workspace, what it knows about the organization, and its credits. Admins only. */
function AiSection() {
  return (
    <>
      <PageHead title="Assistant" sub="The AI assistant for everyone in this workspace: whether it is on, what it knows about the organization, and the credits it uses." />
      <div data-setting="ai.enabled"><AiWorkspaceSwitch /><LastChanged k="ai.enabled" section="ai" /></div>
      <div data-setting="ai.instructions"><AiInstructionsCard /><LastChanged k="ai.instructions" section="ai" /></div>
      <div data-setting="ai.budget"><AiUsageCard /></div>
      <div data-setting="ai.ownKey"><AiOwnKeyCard /></div>
      <p className="muted" style={{ marginTop: 14, fontSize: 12.5 }}>How the assistant works with you personally (what it learned, your notes) is private to you: <Link className="link" to="/account#s-account.ai">My account → Profile</Link>.</p>
      <SectionHistory section="ai" />
    </>
  );
}

function GeneralSection() {
  const ctx = useAuth((s) => s.ctx)!;
  const reload = useAuth((s) => s.reloadContext);
  const wid = useWorkspaceId();
  const personal = useIsPersonal();
  const canOrg = useCan('org.manage');
  const seeBilling = useModule('billing') > 0;
  const [wsName, setWsName] = useState(ctx.current?.name ?? '');
  const [wsDesc, setWsDesc] = useState(ctx.current?.description ?? '');
  const [zone, setZone] = useState<string | null>(ctx.current?.timeZone ?? null);
  const [zoneBusy, setZoneBusy] = useState(false);
  const workspace = useMutation({
    mutationFn: () => workspaceApi.update({ name: wsName.trim(), description: wsDesc.trim() || undefined }),
    onSuccess: async () => { toast('Workspace updated.'); await reload(); void invalidateWorkspace(wid, 'settings'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not update the workspace.', 'error'),
  });
  // An undo elsewhere on the page changes these: follow the saved values when nothing is being typed.
  const savedName = ctx.current?.name ?? '', savedDesc = ctx.current?.description ?? '', savedZone = ctx.current?.timeZone ?? null;
  useEffect(() => { setWsName(savedName); setWsDesc(savedDesc); }, [savedName, savedDesc]);
  useEffect(() => { setZone(savedZone); }, [savedZone]);
  if (!ctx.current) return null;
  const isAdmin = ctx.current.role === 'Owner' || ctx.current.role === 'Admin';
  const saveZone = async () => {
    setZoneBusy(true);
    try { await workspaceApi.setTimeZone(zone); toast('Workspace time zone saved.'); await reload(); void invalidateWorkspace(wid, 'settings'); }
    catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the time zone.', 'error'); }
    finally { setZoneBusy(false); }
  };
  return (
    <>
      <PageHead title="General" sub={`${personal ? 'Your personal workspace' : 'Organization'} · your access level: ${ctx.current.role}`} />
      <div className="card mb-22">
        <div className="card-body">
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (wsName.trim().length >= 2) workspace.mutate(); }}>
            <div data-setting="workspace.name"><Field label="Workspace name"><input className="input" value={wsName} onChange={(e) => setWsName(e.target.value)} disabled={!canOrg} maxLength={80} /></Field><LastChanged k="workspace.name" section="general" /></div>
            <Field label="Plan"><div className="row" style={{ height: 38 }}><Badge tone="purple">{ctx.current.plan.name}</Badge>{seeBilling && <Link className="link" to="/settings/billing">Plan and billing</Link>}</div></Field>
            <div className="full" data-setting="workspace.description"><Field label="Description" full><textarea className="textarea" value={wsDesc} onChange={(e) => setWsDesc(e.target.value)} disabled={!canOrg} maxLength={500} /></Field><LastChanged k="workspace.description" section="general" /></div>
            {canOrg && <div className="full"><SubmitButton busy={workspace.isPending}>Save workspace</SubmitButton></div>}
          </form>
          {personal && <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>Want to collaborate? Use the workspace menu in the top bar to create an organization.</p>}
        </div>
      </div>
      {canOrg && (
        <div className="card mb-22" data-setting="workspace.timeZone">
          <div className="card-head"><div><h3>Workspace time zone</h3><p>What people without their own zone see, and what workspace-wide digests and service-level clocks follow. Each person's own zone (My account) still wins for everything they see.</p></div></div>
          <div className="card-body">
            <div className="row" style={{ gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 260 }}><TimeZonePicker value={zone} onChange={setZone} label="Workspace time zone" allowEmpty emptyLabel="Platform default (Asia/Kolkata)" /></div>
              <button type="button" className="btn btn-primary" disabled={zoneBusy || zone === savedZone} onClick={() => void saveZone()}>{zoneBusy ? 'Saving…' : 'Save time zone'}</button>
            </div>
            <LastChanged k="workspace.timeZone" section="general" />
          </div>
        </div>
      )}
      {!personal && <div data-setting="workspace.logo"><WorkspaceLogoCard canEdit={isAdmin} /><LastChanged k="workspace.logo" section="general" /></div>}
      <SectionHistory section="general" />
    </>
  );
}
