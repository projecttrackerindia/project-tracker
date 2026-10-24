import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { connectedAccountsApi, integrationsApi, meApi, microsoftApi, type ConnectedAccounts, type MeetingServiceKey, type SlackMessagesChoice } from '../../api/endpoints';
import { Icon, type IconName } from '../../components/Icon';
import { PageLoader } from '../../components/ui';
import { StudioHero } from '../../components/StudioHero';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { continueConnectionInBrowser } from '../../lib/personalConnection';
import { isDesktopApp } from '../../lib/desktop';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import './PersonalProductivity.css';
import './connectedAccounts.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

type Feature = { key: string; name: string; does: string; on: boolean; available: boolean; turnOn: () => Promise<void>; turnOff?: () => Promise<unknown> };

const OUTCOMES: Record<string, Record<string, [string, 'success' | 'info' | 'error']>> = {
  google: { connected: ['Google account connected.', 'success'], declined: ['Google sign-in was not completed.', 'info'], error: ['Could not connect your Google account. Please try again.', 'error'] },
  microsoft: {
    connected: ['Microsoft account connected.', 'success'], permission: ['Microsoft did not grant every permission that was asked for. Try again and accept them all.', 'info'],
    declined: ['Microsoft sign-in was cancelled.', 'info'], error: ['Could not connect your Microsoft account. Please try again.', 'error'],
  },
  slack: {
    connected: ['Slack linked. Things that need you now reach you there too.', 'success'], declined: ['Slack sign-in was not completed.', 'info'],
    team: ['That Slack account is in another Slack workspace than the one connected here. Sign in to the right one.', 'error'],
    taken: ['That Slack account is already linked to someone else in this workspace.', 'error'], error: ['Could not link Slack. Please try again.', 'error'],
  },
};

/**
 * My account > Connected accounts: the person's own Google, Microsoft, Slack and GitHub. Each thing an account is used for is turned on or
 * off on its own (stopping Gmail never stops Calendar and Meet), and the person chooses where their meetings go.
 */
export function ConnectedAccountsSection() {
  const wid = useWorkspaceId();
  const uid = useAuth((s) => s.ctx?.user.id);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const active = () => alive.current && useAuth.getState().ctx?.user.id === uid && useAuth.getState().ctx?.current?.id === wid;
  const q = useWsQuery(['account', 'connected'], connectedAccountsApi.get);
  const [busy, setBusy] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  // Back from Google, Microsoft or Slack: say how it went, once.
  useEffect(() => {
    let changed = false;
    const next = new URLSearchParams(params);
    for (const p of ['google', 'microsoft', 'slack'] as const) {
      const outcome = params.get(p);
      if (!outcome) continue;
      // Connected from Mailbox: finish there.
      if (p === 'microsoft') {
        let toMailbox = false;
        try { toMailbox = sessionStorage.getItem('pt.mailbox-return') === '1'; sessionStorage.removeItem('pt.mailbox-return'); } catch { /* stay here */ }
        if (toMailbox) { navigate(`/mailbox?microsoft=${encodeURIComponent(outcome)}`, { replace: true }); return; }
      }
      const [text, kind] = OUTCOMES[p][outcome] ?? OUTCOMES[p].error;
      toast(text, kind);
      next.delete(p); changed = true;
    }
    if (changed) { setParams(next, { replace: true }); void invalidateWorkspace(wid, 'account'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => invalidateWorkspace(wid, 'account');
  const run = async (key: string, fn: () => Promise<unknown>, done?: string, fallback = 'That did not work. Please try again.') => {
    if (!active()) return;
    setBusy(key);
    try { await fn(); if (active()) { if (done) toast(done); await refresh(); } }
    catch (e) { if (active()) toast(errText(e, fallback), 'error'); }
    finally { if (active()) setBusy(null); }
  };
  /** Sends the whole page to the provider's consent screen (it comes back here). */
  const go = async (key: string, url: () => Promise<{ url: string }>) => {
    if (continueConnectionInBrowser() || !active()) return;
    setBusy(key);
    try { const r = await url(); if (active()) window.location.assign(r.url); }
    catch (e) { if (active()) { toast(errText(e, 'Could not start the connection.'), 'error'); setBusy(null); } }
  };

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <p role="alert">Could not load your connected accounts. <button className="btn btn-sm" onClick={() => void q.refetch()}>Retry</button></p>;
  const a = q.data;
  const g = a.google, m = a.microsoft;
  const back = '/account/integrations';
  const googleConfigured = g.connected || g.configured !== false;

  const googleFeatures: Feature[] = [
    { key: 'calendar', name: 'Calendar and Google Meet', does: 'Meetings you schedule go to your Google Calendar with a Meet link; invitations and replies stay real.',
      on: !!g.connected && g.calendarAccess !== false, available: true, turnOn: () => go('g-calendar', () => integrationsApi.googleConnectUrl(back)), turnOff: () => integrationsApi.googleFeatureOff('calendar') },
    { key: 'mail', name: 'Send mail from Gmail', does: 'Replies and updates you send from Project Tracker go from your own address.',
      on: !!g.mailSendAccess, available: !!g.mailEnabled, turnOn: () => go('g-mail', () => integrationsApi.googleConnectUrl(back, true)), turnOff: () => integrationsApi.googleFeatureOff('mail') },
    { key: 'inbox', name: 'Read your Gmail inbox', does: 'Read and answer mail in Mailbox; the mail agent can turn mail into task updates.',
      on: !!g.inboxAccess, available: !!g.inboxEnabled, turnOn: () => go('g-inbox', () => integrationsApi.googleConnectUrl(back, true, true)), turnOff: () => integrationsApi.googleFeatureOff('inbox') },
    { key: 'transcripts', name: 'Meeting transcripts', does: 'The project agent reads finished Google Meet transcripts for notes and follow-ups.',
      on: !!g.transcriptAccess, available: true, turnOn: () => go('g-transcripts', () => integrationsApi.googleConnectUrl(back, false, false, true)), turnOff: () => integrationsApi.googleFeatureOff('transcripts') },
  ];
  const msReady = !!m.enabled && !!m.configured;
  const msConnect = (inbox: boolean, calendars: boolean, meetings: boolean) => () => go('ms', () => microsoftApi.connect(inbox || !!m.inboxAccess, calendars || !!m.calendarAccess, meetings || !!m.meetingsAccess, back));
  const microsoftFeatures: Feature[] = [
    { key: 'meetings', name: 'Outlook calendar and Teams meetings', does: 'Meetings you schedule go to your Outlook calendar with a Teams link; Outlook sends the invitations.',
      on: !!m.meetingsAccess, available: msReady && m.meetingsEnabled !== false, turnOn: msConnect(false, false, true), turnOff: () => microsoftApi.featureOff('meetings') },
    { key: 'calendar', name: 'Calendar availability', does: 'Check when you and others are free before planning.',
      on: !!m.calendarAccess, available: msReady && !!m.calendarsEnabled, turnOn: msConnect(false, true, false), turnOff: () => microsoftApi.featureOff('calendar') },
    { key: 'mail', name: 'Send mail from Outlook', does: 'Replies and updates you send from Project Tracker go from your own address.',
      on: !!m.mailSendAccess, available: msReady, turnOn: msConnect(false, false, false), turnOff: () => microsoftApi.featureOff('mail') },
    { key: 'inbox', name: 'Read your Outlook inbox', does: 'Read and answer mail in Mailbox; the mail agent can turn mail into task updates.',
      on: !!m.inboxAccess, available: msReady && !!m.inboxEnabled, turnOn: msConnect(true, false, false), turnOff: () => microsoftApi.featureOff('inbox') },
  ];

  const disconnectGoogle = async () => {
    if (!(await confirmDialog({ title: 'Disconnect your Google account?', message: 'Everything above stops, and Google is told to forget the permission. Meetings already scheduled stay in your calendar. To stop only one thing, turn just that off instead.', confirmText: 'Disconnect Google', danger: true }))) return;
    await run('g-off', integrationsApi.googleDisconnect, 'Google account disconnected.');
  };
  const disconnectMicrosoft = async () => {
    if (!(await confirmDialog({ title: 'Disconnect your Microsoft account?', message: 'Everything above stops and Project Tracker deletes its stored Microsoft credentials. To revoke the app in Microsoft too, remove it at myapps.microsoft.com. To stop only one thing, turn just that off instead.', confirmText: 'Disconnect Microsoft', danger: true }))) return;
    await run('ms-off', microsoftApi.disconnect, 'Microsoft account disconnected.');
  };
  const featureOff = async (f: Feature, account: string) => {
    if (!(await confirmDialog({ title: `Turn off "${f.name}"?`, message: `Project Tracker stops using this part of your ${account} account. Everything else you turned on keeps working.`, confirmText: 'Turn off' }))) return;
    await run(`${account}-${f.key}`, f.turnOff!, `${f.name}: off.`);
  };

  return (
    <div className="ca">
      <StudioHero title="Connected accounts" eyebrow="My account" icon="link"
        description="Sign in to your own accounts. Project Tracker uses only what you turn on here, and you can turn each part off on its own.">
        <span className="studio-chip"><Icon name="lock" />Private to you</span>
      </StudioHero>
      {isDesktopApp() && <div className="connection-browser-note"><Icon name="link" /><p>Account connections open in your browser. Finish there, then come back and refresh.</p><button type="button" className="btn" onClick={() => continueConnectionInBrowser()}>Open in browser</button></div>}

      <MeetingChoice accounts={a} busy={busy} onPick={(k) => void run('meetings', () => connectedAccountsApi.save({ meetingService: k }), k === 'auto' ? 'Meetings now go to the best connected service.' : undefined)} />

      <div className="ca-grid">
        <AccountCard icon="video" title="Google" who={g.connected ? g.googleEmail ?? 'Connected' : null} problem={g.lastError}
          note={!googleConfigured ? 'Google is not set up on this installation.' : null}
          features={googleFeatures} busy={busy} prefix="google" onOff={(f) => void featureOff(f, 'google')}
          footer={g.connected
            ? <button type="button" className="btn btn-ghost btn-sm danger" disabled={busy !== null} onClick={() => void disconnectGoogle()}>Disconnect Google</button>
            : <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void googleFeatures[0].turnOn()} data-testid="ca-google-connect"><Icon name="video" size={14} /> Sign in with Google</button>} />

        <AccountCard icon="mail" title="Microsoft" who={m.connected ? m.email ?? 'Connected' : null} problem={null}
          note={!msReady ? 'Microsoft is not set up on this installation yet. Your administrator registers the app once.' : null}
          features={microsoftFeatures} busy={busy} prefix="microsoft" onOff={(f) => void featureOff(f, 'microsoft')}
          footer={!msReady ? null : m.connected
            ? <button type="button" className="btn btn-ghost btn-sm danger" disabled={busy !== null} onClick={() => void disconnectMicrosoft()}>Disconnect Microsoft</button>
            : <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void microsoftFeatures[0].turnOn()} data-testid="ca-microsoft-connect"><Icon name="mail" size={14} /> Sign in with Microsoft</button>} />

        <SlackCard accounts={a} busy={busy}
          onLink={() => void go('slack', connectedAccountsApi.slackConnect)}
          onChoose={(v) => void run('slack-msg', () => connectedAccountsApi.save({ slackMessages: v }), v === 'off' ? 'Slack messages off.' : 'Saved.')}
          onUnlink={async () => {
            if (!(await confirmDialog({ title: 'Unlink Slack?', message: 'The Project Tracker bot stops sending you direct messages. Your Slack account itself is not changed.', confirmText: 'Unlink Slack' }))) return;
            await run('slack-off', connectedAccountsApi.slackUnlink, 'Slack unlinked.');
          }} />

        <GitHubCard accounts={a} busy={busy} onLink={() => void go('github', () => meApi.linkLogin('github'))}
          onUnlink={async () => {
            if (!(await confirmDialog({ title: 'Unlink GitHub?', message: 'Your review queue and reviewer suggestions stop recognising your pull requests. You can no longer sign in with GitHub.', confirmText: 'Unlink GitHub' }))) return;
            await run('github-off', async () => { const id = (await meApi.logins()).find((l) => l.provider.toLowerCase() === 'github')?.id; if (id) await meApi.unlinkLogin(id); }, 'GitHub unlinked.');
          }} />
      </div>

      <div className="connection-mailbox-note"><Icon name="mail" size={16} /><p>Mail from Gmail, Outlook and Rediffmail is read and answered in <b>Mailbox</b>.</p><Link className="btn btn-sm" to="/mailbox">Open Mailbox</Link></div>
    </div>
  );
}

const SERVICES: { key: MeetingServiceKey; name: string; icon: IconName; note: string }[] = [
  { key: 'auto', name: 'Automatic', icon: 'sparkle', note: 'Google Meet if Google is connected, else Teams, else a Project Tracker call' },
  { key: 'google', name: 'Google Meet', icon: 'video', note: 'Your Google Calendar' },
  { key: 'microsoft', name: 'Microsoft Teams', icon: 'mail', note: 'Your Outlook calendar' },
  { key: 'ours', name: 'Project Tracker call', icon: 'agent', note: 'Our own calls; the project agent joins without a lobby' },
];

function MeetingChoice({ accounts, busy, onPick }: { accounts: ConnectedAccounts; busy: string | null; onPick: (k: MeetingServiceKey) => void }) {
  const c = accounts.meetings;
  const ready: Record<MeetingServiceKey, boolean> = { auto: true, google: !!c?.googleReady, microsoft: !!c?.microsoftReady, ours: !!c?.ownCallsReady };
  return (
    <section className="ca-meetings" aria-labelledby="ca-meetings-title" data-testid="ca-meetings">
      <div className="ca-meetings-head">
        <h2 id="ca-meetings-title">Where your meetings go</h2>
        <p className="ca-now" role="status">
          {c ? <>Your next meeting: <b>{c.name}</b>. {c.reason}</> : <span className="ca-problem">{accounts.meetingProblem}</span>}
        </p>
      </div>
      <div className="ca-services" role="radiogroup" aria-label="Meeting service">
        {SERVICES.map((s) => {
          const chosen = accounts.meetingService === s.key;
          const disabled = busy !== null || (!ready[s.key] && !chosen);
          return (
            <button key={s.key} type="button" role="radio" aria-checked={chosen} disabled={disabled} className={`ca-service ${chosen ? 'on' : ''}`} onClick={() => !chosen && onPick(s.key)} data-testid={`ca-service-${s.key}`}>
              <Icon name={s.icon} size={16} />
              <span><b>{s.name}</b><small>{ready[s.key] ? s.note : s.key === 'ours' ? 'Not set up on this installation' : 'Turn it on below first'}</small></span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function AccountCard({ icon, title, who, problem, note, features, busy, prefix, onOff, footer }: {
  icon: IconName; title: string; who: string | null; problem: string | null | undefined; note: string | null; features: Feature[]; busy: string | null; prefix: string;
  onOff: (f: Feature) => void; footer: React.ReactNode;
}) {
  return (
    <section className="personal-account-card ca-card" data-testid={`ca-${prefix}`}>
      <header>
        <span className="personal-account-symbol"><Icon name={icon} size={19} /></span>
        <div><h2>{title}</h2><span className={`ca-who ${who ? 'on' : ''}`}>{who ?? 'Not connected'}</span></div>
      </header>
      {note ? <p className="muted">{note}</p> : (
        <ul className="ca-features">
          {features.filter((f) => f.available || f.on).map((f) => (
            <li key={f.key} className={f.on ? 'on' : ''}>
              <div><b>{f.name}</b><p>{f.does}</p></div>
              {f.on
                ? <button type="button" className="btn btn-sm ca-toggle on" aria-label={`Turn off ${f.name}`} disabled={busy !== null || !f.turnOff} onClick={() => onOff(f)} data-testid={`ca-${prefix}-${f.key}-off`}><Icon name="checkCircle" size={13} /> On</button>
                : <button type="button" className="btn btn-sm ca-toggle" aria-label={`Turn on ${f.name}`} disabled={busy !== null} onClick={() => void f.turnOn()} data-testid={`ca-${prefix}-${f.key}-on`}>Turn on</button>}
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="ca-problem" role="alert"><Icon name="alert" size={13} /> {problem}</p>}
      {footer && <div className="ca-card-foot">{footer}</div>}
    </section>
  );
}

const SLACK_CHOICES: { key: SlackMessagesChoice; label: string }[] = [{ key: 'off', label: 'Off' }, { key: 'needs', label: 'What needs me' }, { key: 'all', label: 'Everything' }];

function SlackCard({ accounts, busy, onLink, onChoose, onUnlink }: { accounts: ConnectedAccounts; busy: string | null; onLink: () => void; onChoose: (v: SlackMessagesChoice) => void; onUnlink: () => void }) {
  const s = accounts.slack;
  return (
    <section className="personal-account-card ca-card" data-testid="ca-slack">
      <header>
        <span className="personal-account-symbol"><Icon name="message" size={19} /></span>
        <div><h2>Slack</h2><span className={`ca-who ${s.linked ? 'on' : ''}`}>{s.linked ? `${s.name ?? 'Linked'}${s.teamName ? ` · ${s.teamName}` : ''}` : 'Not linked'}</span></div>
      </header>
      {!s.linked ? (
        <>
          <p className="muted">Sign in with Slack so the Project Tracker bot can send you direct messages: assignments, mentions, approvals, reminders.</p>
          {s.problem && <p className="ca-problem">{s.problem}</p>}
          <div className="ca-card-foot"><button type="button" className="btn btn-primary btn-sm" disabled={busy !== null || !s.workspaceConnected} onClick={onLink} data-testid="ca-slack-link"><Icon name="message" size={14} /> Sign in with Slack</button></div>
        </>
      ) : (
        <>
          <p className="muted">Get these in Slack as direct messages from the Project Tracker bot. Quiet hours and do-not-disturb apply.</p>
          <div className="ca-segment" role="radiogroup" aria-label="Slack messages">
            {SLACK_CHOICES.map((c) => (
              <button key={c.key} type="button" role="radio" aria-checked={s.messages === c.key} className={s.messages === c.key ? 'on' : ''} disabled={busy !== null} onClick={() => s.messages !== c.key && onChoose(c.key)} data-testid={`ca-slack-${c.key}`}>{c.label}</button>
            ))}
          </div>
          {s.problem && <p className="ca-problem" role="alert"><Icon name="alert" size={13} /> {s.problem}</p>}
          <div className="ca-card-foot"><button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={onUnlink}>Unlink Slack</button></div>
        </>
      )}
    </section>
  );
}

function GitHubCard({ accounts, busy, onLink, onUnlink }: { accounts: ConnectedAccounts; busy: string | null; onLink: () => void; onUnlink: () => void }) {
  const gh = accounts.gitHub;
  return (
    <section className="personal-account-card ca-card" data-testid="ca-github">
      <header>
        <span className="personal-account-symbol"><Icon name="git" size={19} /></span>
        <div><h2>GitHub</h2><span className={`ca-who ${gh.linked ? 'on' : ''}`}>{gh.linked ? gh.email ?? 'Linked' : 'Not linked'}</span></div>
      </header>
      <p className="muted">Sign in with GitHub so your pull requests and review requests are recognised as yours: your review queue on Home, and reviewer suggestions on tasks.{!gh.appInstalled && ' Your administrator installs the GitHub App for repositories to show up.'}</p>
      <div className="ca-card-foot">
        {!gh.available && !gh.linked ? <span className="muted">GitHub sign-in is not set up on this installation.</span>
          : gh.linked ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={onUnlink}>Unlink GitHub</button>
          : <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={onLink} data-testid="ca-github-link"><Icon name="git" size={14} /> Sign in with GitHub</button>}
      </div>
    </section>
  );
}
