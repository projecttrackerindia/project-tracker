import { DataLocationSection, HolidaysSection, StatusPageSection } from '../platform/PlatformSettings';
import { AttendanceSettings } from '../attendance/AttendanceSettings';
import { createPortal } from 'react-dom';
import { WorkspaceLogoCard } from './WorkspaceLogo';
import { ProfilePhotoCard } from './ProfilePhoto';
import { ThemeSwitch } from '../../components/ThemeSwitch';
import { TeamLensPicker } from '../../components/TeamLensPicker';
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { authApi, meApi, workspaceApi } from '../../api/endpoints';
import { Icon, type IconName } from '../../components/Icon';
import { Badge, Embedded, Field, Modal, PageHead, PageLoader, Segmented, SubmitButton } from '../../components/ui';
import { SGroup, SPaneHead, SRow, STile } from './Grouped';
import { NotificationsOverview } from './NotificationsOverview';
import './settings-mac.css';
import { leafHref, PLACE_LEAVES, PLACE_OF, useWorkspaceSections, type SettingsPlace, type WorkspaceSection } from './sections';
import { NotificationCenterPage } from '../notifications/NotificationCenter';
import { AiSettings, type AiTab } from './AiControlCentre';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import './settings-ds.css';
import { useAuth, useCan, useIsPersonal, useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
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
import { AiProfileCard } from '../ai/AiInstructions';
import { MyAiProviderCard } from '../ai/OwnAiKey';
import { LastChanged, LatestChanges, SectionHistory, SettingsSearch, SetupHealthCard, useSettingJump } from './SettingsCenter';
import { NotificationDefaultsSection } from './NotificationDefaults';
import { MobileAppSection } from './MobileAppSection';
import { ConnectedAccountsSection } from './ConnectedAccounts';
import { MailIntegrationSettings } from './MailIntegration';
import { SlackSettings } from './SlackSettings';
import { WhatsAppSettings } from './WhatsAppSettings';


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

// ================================================================== Settings (v2): ten sections, two about you and eight about the workspace

const PLACE_INFO: Record<SettingsPlace, { label: string; icon: IconName; sub: string }> = {
  profile: { label: 'Profile & sign-in', icon: 'user', sub: 'Your profile, sign-in, phone app, connected accounts and how the assistant works with you. These follow you to every workspace.' },
  notifications: { label: 'Notifications', icon: 'bell', sub: 'What reaches you, where, and when.' },
  general: { label: 'General', icon: 'building', sub: 'Name, description, logo and time zone.' },
  people: { label: 'People', icon: 'users', sub: 'Who is in the workspace and who sees which projects.' },
  fields: { label: 'Fields & types', icon: 'list', sub: 'Custom fields, labels, priorities and work types.' },
  timelines: { label: 'Timelines & automation', icon: 'flag', sub: 'Timeline templates, project groups and automation rules.' },
  security: { label: 'Security & audit', icon: 'lock', sub: 'Sign-in rules, single sign-on, roles and access, the audit log and data retention.' },
  integrations: { label: 'Integrations', icon: 'link', sub: 'Slack, WhatsApp, GitHub, webhooks, API keys, mail and outside AI apps.' },
  ai: { label: 'AI', icon: 'sparkle', sub: 'What the AI knows, what it may do, and what it costs.' },
  billing: { label: 'Billing', icon: 'card', sub: 'Plan, seats, invoices and payment.' },
};
const WORKSPACE_PLACES = ['general', 'people', 'fields', 'timelines', 'security', 'integrations', 'ai', 'billing'] as const;
const PLACE_IDS = new Set<string>(['profile', 'notifications', ...WORKSPACE_PLACES]);

interface SubTab { id: string; label: string }

type NavId = 'profile' | 'workspace' | 'people' | 'ai' | 'notifications' | 'integrations' | 'security' | 'billing' | 'appearance';
/** The left list of the macOS System Settings layout: coloured icon tiles, in three groups (apple/s-settings). */
const NAV: { id: NavId; label: string; color: string; glyph: string; sub: string }[] = [
  { id: 'profile', label: 'Profile', color: '#8e8e93', glyph: '☺', sub: PLACE_INFO.profile.sub },
  { id: 'workspace', label: 'Workspace', color: '#0071e3', glyph: '▦', sub: 'Name, logo, time zone, fields and types, timelines and automation.' },
  { id: 'people', label: 'People & roles', color: '#5856d6', glyph: '⚇', sub: PLACE_INFO.people.sub },
  { id: 'ai', label: 'AI', color: 'linear-gradient(135deg,#5e5ce6,#bf5af2)', glyph: '✦', sub: PLACE_INFO.ai.sub },
  { id: 'notifications', label: 'Notifications', color: '#ff3b30', glyph: '◉', sub: 'Choose where things reach you. Project Tracker only interrupts for what matters.' },
  { id: 'integrations', label: 'Integrations', color: '#28cd41', glyph: '⇄', sub: PLACE_INFO.integrations.sub },
  { id: 'security', label: 'Security', color: '#636366', glyph: '⚿', sub: 'Your password, passkeys, two-step verification and devices; the workspace’s sign-in rules, single sign-on, roles, audit log and retention.' },
  { id: 'billing', label: 'Billing', color: '#ff9500', glyph: '₹', sub: PLACE_INFO.billing.sub },
  { id: 'appearance', label: 'Appearance', color: '#1d1d1f', glyph: '◐', sub: 'Light or dark, and whose work your lists and numbers show.' },
];
const NAV_GAP_AFTER = new Set<NavId>(['ai', 'integrations']);
const WORKSPACE_LEAVES: WorkspaceSection[] = [...PLACE_LEAVES.general, ...PLACE_LEAVES.fields, ...PLACE_LEAVES.timelines];

/**
 * Settings (macOS System Settings layout): a left list with search, your profile card and ten sections with coloured icon tiles; the right
 * pane holds grouped inset rows. The sections map onto the existing pages and addresses: a section with several pages shows them as tabs
 * under its header, and each tab is in the address (/settings/security/sso), so a link, a search result or Back lands on it. Addresses of
 * the old pages (/settings/sso, /settings/labels …) move to the section and tab that hold them now.
 */
export function SettingsPage() {
  const { section, sub: asked } = useParams();
  const loc = useLocation();
  const nav = useNavigate();
  const leaves = useWorkspaceSections();
  const ctx = useAuth((s) => s.ctx);
  const isPlatformAdmin = !!ctx?.user.isPlatformAdmin;
  useSettingJump();
  // Mail is connected in one place: Integrations › Mail (the old "Mail accounts" address lands there).
  if (section === 'mail') return <Navigate to={`/settings/integrations/mail${loc.search}${loc.hash}`} replace />;
  if (!section || (section !== 'profile' && section !== 'appearance' && !(section === 'security' && asked === 'account') && isPlatformAdmin)) return <Navigate to={`/settings/profile${loc.search}${loc.hash}`} replace />;
  // An old section id: its new section and tab, keeping anything else in the address.
  if (!PLACE_IDS.has(section) && section !== 'appearance') {
    const leaf = section as WorkspaceSection;
    if (!PLACE_OF[leaf]) return <Navigate to="/settings/profile" replace />;
    const [path, query] = leafHref(leaf).split('?');
    const q = new URLSearchParams(loc.search);
    new URLSearchParams(query ?? '').forEach((v, k) => q.set(k, v));
    const s = q.toString();
    return <Navigate to={`${path}${s ? `?${s}` : ''}${loc.hash}`} replace />;
  }
  const open = new Set(leaves.map((l) => l.id));
  // Integrations is open to everyone (their own mail accounts live there); its workspace pages stay for admins.
  const places = WORKSPACE_PLACES.filter((p) => PLACE_LEAVES[p].some((l) => open.has(l)) || (p === 'integrations' && !isPlatformAdmin));
  if (section === 'appearance') return <SettingsShell nav={nav} places={places} current="appearance" isPlatformAdmin={isPlatformAdmin}><AppearancePane /></SettingsShell>;
  const place = section as SettingsPlace;
  // Your own sign-in security moved from Profile to the top-level Security section.
  if (place === 'profile' && asked === 'security') return <Navigate to={`/settings/security/account${loc.search}${loc.hash}`} replace />;
  if (place !== 'profile' && place !== 'notifications' && place !== 'security' && !places.includes(place)) return <Navigate to="/settings/profile" replace />;
  const wsSecurity = places.includes('security');

  const inWorkspace = place === 'general' || place === 'fields' || place === 'timelines';
  const notifTabs: SubTab[] = [{ id: 'delivery', label: 'Every event' }, { id: 'device', label: 'This device' }, { id: 'schedule', label: 'Schedule & time zone' }, { id: 'history', label: 'History' },
    ...leaves.filter((l) => PLACE_LEAVES.notifications.includes(l.id)).map((l) => ({ id: l.id, label: l.id === 'notifications' ? 'Member defaults' : l.label }))];
  const tabs: SubTab[] = place === 'profile'
    ? [{ id: 'profile', label: 'Profile' },
      ...(!isPlatformAdmin ? [{ id: 'mobile', label: 'Mobile app' }, { id: 'accounts', label: 'Connected accounts' }, { id: 'assistant', label: 'Groot' }] : [])]
    : place === 'notifications' ? [{ id: 'overview', label: 'Overview' }, ...notifTabs]
      : place === 'ai' ? []
      : place === 'security' ? [{ id: 'account', label: 'Your account' }, ...(wsSecurity ? leaves.filter((l) => PLACE_LEAVES.security.includes(l.id)).sort((a, b) => PLACE_LEAVES.security.indexOf(a.id) - PLACE_LEAVES.security.indexOf(b.id)).map((l) => ({ id: l.id, label: l.label })) : [])]
      : place === 'integrations' ? [{ id: 'mail', label: 'Mail' }, ...leaves.filter((l) => PLACE_LEAVES.integrations.includes(l.id)).sort((a, b) => PLACE_LEAVES.integrations.indexOf(a.id) - PLACE_LEAVES.integrations.indexOf(b.id)).map((l) => ({ id: l.id, label: l.label }))]
      : inWorkspace ? leaves.filter((l) => WORKSPACE_LEAVES.includes(l.id)).sort((a, b) => WORKSPACE_LEAVES.indexOf(a.id) - WORKSPACE_LEAVES.indexOf(b.id)).map((l) => ({ id: l.id, label: l.label }))
      : leaves.filter((l) => PLACE_LEAVES[place].includes(l.id)).sort((a, b) => PLACE_LEAVES[place].indexOf(a.id) - PLACE_LEAVES[place].indexOf(b.id)).map((l) => ({ id: l.id, label: l.label }));
  // AI: the control centre, usage and the tracker are for admins; Project agent for whoever leads a project.
  const aiAdmin = open.has('ai'), aiAgent = open.has('project-agent');
  const aiFirst = aiAdmin ? 'control' : 'project-agent';
  const placeFirst = inWorkspace ? PLACE_LEAVES[place].find((l) => open.has(l)) : undefined;
  const sub = place === 'ai' ? ((asked === 'usage' || asked === 'tracker') && aiAdmin ? asked : asked === 'project-agent' && aiAgent ? asked : aiFirst)
    : inWorkspace ? tabs.find((t) => t.id === (asked ?? placeFirst))?.id ?? tabs[0]?.id
    : place === 'security' ? tabs.find((t) => t.id === asked)?.id ?? (wsSecurity ? 'security' : 'account')
    : place === 'integrations' ? tabs.find((t) => t.id === asked)?.id ?? (tabs[1]?.id ?? 'mail')
    : tabs.find((t) => t.id === asked)?.id ?? tabs[0]?.id;
  const first = place === 'ai' ? aiFirst : place === 'security' ? (wsSecurity ? 'security' : 'account') : place === 'integrations' ? (tabs[1]?.id ?? 'mail') : tabs[0]?.id;
  const choose = (v: string) => (inWorkspace ? nav(leafHref(v as WorkspaceSection)) : nav(v === first ? `/settings/${place}` : `/settings/${place}/${v}`));

  const current: NavId = place === 'profile' ? 'profile'
    : inWorkspace ? 'workspace' : (place as NavId);
  const body = place === 'profile' ? <ProfileTab sub={sub} />
    : place === 'notifications' ? (sub === 'overview' ? <NotificationsOverview more={notifTabs} /> : <NotificationsTab sub={sub} />)
    : place === 'security' && sub === 'account' ? <SecuritySection head={tabs.length <= 1} />
    : place === 'ai' ? <AiSettings tab={sub as AiTab} onTab={choose} admin={aiAdmin} agent={aiAgent} />
    : place === 'integrations' && sub === 'mail' ? <MailIntegrationSettings />
    : <SettingsSection id={sub as WorkspaceSection} />;
  const info = NAV.find((n) => n.id === current)!;
  const headTitle = place === 'profile' ? PLACE_INFO.profile.label : info.label;
  return (
    <SettingsShell nav={nav} places={places} current={current} isPlatformAdmin={isPlatformAdmin}>
      {place === 'notifications' && sub === 'overview' ? body : tabs.length > 1 ? (
        <div className="set-place">
          <div className="set-place-head">
            <SPaneHead icon={info.glyph} color={info.color} title={headTitle} sub={info.sub || PLACE_INFO[place].sub} />
            <Segmented label={`${PLACE_INFO[place].label} sections`} value={sub} onChange={choose} options={tabs} />
          </div>
          <Embedded>{body}</Embedded>
        </div>
      ) : body}
    </SettingsShell>
  );
}

/** The window: "Settings" in the toolbar row, the left list and the pane. */
function SettingsShell({ nav, places, current, isPlatformAdmin, children }: { nav: (to: string) => void; places: readonly string[]; current: NavId; isPlatformAdmin: boolean; children: React.ReactNode }) {
  const me = useAuth((s) => s.ctx?.user);
  const ws = useAuth((s) => s.ctx?.current);
  const has = (p: string) => places.includes(p);
  const target: Record<NavId, string | null> = {
    profile: '/settings/profile',
    workspace: has('general') ? '/settings/general' : has('fields') ? '/settings/fields' : has('timelines') ? '/settings/timelines' : null,
    people: has('people') ? '/settings/people' : null,
    ai: has('ai') ? '/settings/ai' : null,
    notifications: isPlatformAdmin ? null : '/settings/notifications',
    integrations: has('integrations') ? '/settings/integrations' : null,
    security: '/settings/security/account',
    billing: has('billing') ? '/settings/billing' : null,
    appearance: '/settings/appearance',
  };
  const initials = (me?.displayName ?? '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="set-mac">
      <h1 className="set-mac-title">Settings</h1>
      <ToolbarTitle>Settings</ToolbarTitle>
      <nav className="set-mac-nav" aria-label="Settings sections">
        <SettingsSearch compact />
        <Link to="/settings/profile" className="set-mac-me">
          <span className="set-mac-av" aria-hidden="true">{initials}</span>
          <span><b>{me?.displayName}</b><small>{[ws?.role === 'Owner' || ws?.role === 'Admin' ? 'Admin' : ws?.role, ws?.name].filter(Boolean).join(' · ')}</small></span>
        </Link>
        {NAV.filter((n) => target[n.id]).map((n) => (
          <span key={n.id} className={NAV_GAP_AFTER.has(n.id) ? 'set-mac-gap' : undefined}>
            <a href={target[n.id]!} className={`set-mac-item${current === n.id ? ' on' : ''}`} aria-current={current === n.id ? 'page' : undefined}
              onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); nav(target[n.id]!); }}>
              <STile color={n.color} size={20}>{n.glyph}</STile><span>{n.label}</span>
            </a>
          </span>
        ))}
      </nav>
      <div className="set-mac-pane"><Embedded>{children}</Embedded></div>
    </div>
  );
}

/** The page's name in the toolbar row on wide screens (as the macOS window title). */
function ToolbarTitle({ children }: { children: string }) {
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => { setHost(document.querySelector('.v2-tb')); }, []);
  return host ? createPortal(<span className="v2-tb-title" aria-hidden="true">{children}</span>, host) : null;
}

/** Appearance: light or dark, and the team view (moved out of Profile into its own section). */
function AppearancePane() {
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  return (
    <div className="sg-pane" data-setting="me.appearance">
      <SPaneHead icon="◐" color="#1d1d1f" title="Appearance" sub="Light or dark, and whose work your lists and numbers show." />
      <SGroup label="Theme">
        <SRow icon={<STile color="#1d1d1f"><Icon name="moon" size={14} /></STile>} title="Dark mode" sub="Follows this device until you choose."><ThemeSwitch className="theme-toggle" /></SRow>
      </SGroup>
      {!admin && (
        <SGroup label="Team view">
          <SRow icon={<STile color="#5856d6"><Icon name="users" size={14} /></STile>} title="Team view" sub="Whose work lists and numbers show."><span className="v2-lens"><TeamLensPicker /></span></SRow>
        </SGroup>
      )}
    </div>
  );
}

function ProfileTab({ sub }: { sub: string }) {
  switch (sub) {
    case 'mobile': return <MobileAppSection />;
    case 'accounts': return <ConnectedAccountsSection />;
    case 'assistant': return <><PageHead title="Groot" sub="How Groot, your assistant, works with you: what it learned, your own notes, and the organisation’s AI account." /><div data-setting="account.ai"><AiProfileCard /><MyAiProviderCard /></div></>;
    default: return <ProfileSection />;
  }
}

function NotificationsTab({ sub }: { sub: string }) {
  switch (sub) {
    case 'notifications': return <NotificationDefaultsSection />;
    case 'reminders': return <><PageHead title="Escalation" sub="Everyone gets reminders about their own work on every plan. Here: what happens when work stays overdue." /><div data-setting="reminders.escalation"><ReminderPolicySettings /><LastChanged k="reminders.escalation" section="reminders" /></div><SectionHistory section="reminders" /></>;
    case 'device': return <NotificationCenterPage section="devices" />;
    case 'schedule': return <NotificationCenterPage section="schedule" />;
    case 'history': return <NotificationCenterPage section="inbox" />;
    default: return <NotificationCenterPage section="preferences" />;
  }
}

function ProfileSection() {
  const ctx = useAuth((s) => s.ctx)!;
  const reload = useAuth((s) => s.reloadContext);
  const [name, setName] = useState(ctx.user.displayName);
  const profile = useMutation({
    mutationFn: () => meApi.updateProfile({ displayName: name.trim(), timeZone: ctx.user.timeZone }),
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
            <Field label="Email" hint={ctx.user.emailVerified ? 'Verified' : 'Not verified yet'}><div style={{ display: 'flex', gap: 8 }}><input className="input" value={ctx.user.email} disabled />
              {!ctx.user.emailVerified && <button type="button" className="btn btn-sm" onClick={() => void authApi.resendVerification(ctx.user.email).then(() => toast(`We sent a new link to ${ctx.user.email}.`, 'success')).catch(() => toast('Could not send the link. Try again in a minute.', 'error'))}>Send link again</button>}</div></Field>
            <Field label="Time zone" hint="Every date, due date, reminder and chart follows it."><div className="input input-static">{ctx.user.timeZone} <Link className="link" to="/settings/notifications/schedule">Change</Link></div></Field>
            <div className="full"><SubmitButton busy={profile.isPending}>Save profile</SubmitButton></div>
          </form>
        </div>
      </div>
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

function SecuritySection({ head = true }: { head?: boolean }) {
  const logout = useAuth((s) => s.logout);
  const wid = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const [pwOpen, setPwOpen] = useState(() => params.get('change-password') === '1');
  useEffect(() => { if (params.get('change-password') === '1') { setPwOpen(true); params.delete('change-password'); setParams(params, { replace: true }); } }, [params, setParams]);
  const sessions = useWsQuery(['sessions'], meApi.sessions);
  return (
    <>
      {head && <SPaneHead icon="⚿" color="#636366" title="Security" sub="Your password, passkeys, two-step verification, sign-in methods and the devices you are signed in on." />}
      <SGroup label="Sign-in">
        <div className="setting-row" data-setting="account.password">
          <div className="setting-info"><h4>Password</h4><p>Changing your password signs you out of your other devices.</p></div>
          <button className="btn btn-ghost" onClick={() => setPwOpen(true)}><Icon name="lock" /> Change password</button>
        </div>
        <PasskeysRow />
        <TwoStepRow />
        <SignInMethods />
      </SGroup>
      <SGroup label="Devices">
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
        <div className="setting-row">
          <div className="setting-info"><h4>Sign out everywhere</h4><p>End every session on every device, including this one.</p></div>
          <button className="btn btn-danger" onClick={async () => { if (await confirmDialog({ title: 'Sign out everywhere?', confirmText: 'Sign out everywhere', message: 'You will need to sign in again on all your devices.' })) { await authApi.logoutAll(); await logout(); } }}><Icon name="logout" /> Sign out everywhere</button>
        </div>
      </SGroup>
      <SGroup label="Privacy & history">
        <PrivacyRow />
        <div className="setting-row" style={{ alignItems: 'flex-start' }}>
          <div className="setting-info" style={{ flex: 1 }}>
            <h4>Sign-in history</h4><p>Every sign-in of the last 90 days. A new browser or network is marked, and you were told about it. Not you? End it here.</p>
            <SignInHistory />
          </div>
        </div>
      </SGroup>
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
    </>
  );
}

/** Outside accounts that can sign in to this one: connect Google / Microsoft / GitHub / Apple, or disconnect them. */
function SignInMethods() {
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
        <h4>Sign-in methods</h4><p>Other ways to sign in to this account. Two-step verification still applies.</p>
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

// ================================================================== the workspace pages, one per tab

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
    case 'connected-apps': return <><PageHead title="Outside AI apps" sub="Claude, ChatGPT and other AI assistants working in this workspace on someone's behalf, through its MCP address." /><ConnectedApps /><SectionHistory section="connected-apps" /></>;
    case 'api-keys': return <><PageHead title="API keys" sub="Access for scripts and other tools." /><ApiKeySettings /><SectionHistory section="api-keys" /></>;
    case 'webhooks': return <><PageHead title="Webhooks" sub="Tell your systems, and Slack or Microsoft Teams channels, when something changes here; turn alerts and forms they send into work." /><WebhookSettings /><SectionHistory section="webhooks" /></>;
    case 'email': return <><PageHead title="Email to work" sub="Turn emails from your team into operational work." /><InboundEmailSettings /><SectionHistory section="email" /></>;
    case 'whatsapp': return <><PageHead title="WhatsApp Business" sub="Your organization's own business number: the support desk for customers, and notifications for members." /><WhatsAppSettings /><SectionHistory section="whatsapp" /></>;
    case 'slack': return <SlackSection />;
    case 'git': return <><PageHead title="GitHub & Azure DevOps" sub="Link commits and pull requests to the tasks they mention." /><GitHubAppCard /><GitSettings /><SectionHistory section="git" /></>;
    case 'automation': return <><PageHead title="Automation" sub="Rules that run on every project's tasks: when something happens - or on a schedule - do something." /><WorkspaceAutomationSettings /><SectionHistory section="automation" /></>;
    case 'notifications': case 'reminders': return <NotificationsTab sub={id} />;
    case 'holidays': return <HolidaysSection />;
    case 'attendance': return <AttendanceSettings />;
    case 'data-location': return <DataLocationSection />;
    case 'status-page': return <StatusPageSection />;
    case 'data': return <><PageHead title="Data & retention" sub="How long history is kept, and a full export of everything." /><DataSettings /><SectionHistory section="data" /></>;
    case 'ai': return null;
  }
}

/** Settings › People › Members: the people themselves are managed on People (one home); this tab says where, and how many seats are used. */
function MembersSection() {
  return (
    <>
      <PageHead title="Members" sub="Invite people, change access levels and remove members on People." />
      <div className="card mb-22" data-setting="members.invite"><div className="card-body">
        <div className="setting-row">
          <div className="setting-info"><h4>Everyone in the workspace</h4><p>Directory, teams and the org chart; invite people and change what they may do.</p></div>
          <Link className="btn btn-primary btn-sm" to="/people">Open People ›</Link>
        </div>
        <div className="setting-row" data-setting="members.invitations">
          <div className="setting-info"><h4>Pending invitations</h4><p>Resend or revoke invitations that have not been accepted yet.</p></div>
          <Link className="btn btn-ghost btn-sm" to="/people/invitations">Invitations ›</Link>
        </div>
      </div></div>
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
      {isAdmin && <div className="mb-22"><SetupHealthCard /></div>}
      <LatestChanges />
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
