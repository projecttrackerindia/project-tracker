import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiUrl } from '../../api/client';
import { integrationsApi } from '../../api/endpoints';
import { microsoftApi, workApi } from '../../api/endpoints.platform';
import { taskApi } from '../../api/endpoints.projects';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Modal, PasswordInput, Spinner } from '../../components/ui';
import { formatDateTime, initials } from '../../lib/format';
import { continueConnectionInBrowser } from '../../lib/personalConnection';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { addressOf, displayName, mailboxApi } from './mailboxApi';
import type { CompanyMailInput, ComposeMode, MailAccounts, MailAssist, MailFolder, MailMessage, MailTaskSuggestion } from './mailboxApi';
import { offerReminderAfterSend } from '../reminders/Suggestions';
import './mailbox.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
/** Set before leaving for Microsoft's consent page, so the landing page sends the person back here. */
export const MAILBOX_RETURN_KEY = 'pt.mailbox-return';

interface Account { key: string; label: string; email: string; kind: 'gmail' | 'outlook' | 'imap'; canRead: boolean; canSend: boolean; needs?: string; error?: string | null }
type Row = MailMessage & { account: string; accountLabel: string; kind: Account['kind'] };

const KIND_COLOR: Record<Account['kind'], string> = { gmail: '#ea4335', outlook: '#0a64d6', imap: '#d6262a' };
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
function shortDate(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso); const now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (now.getTime() - d.getTime() < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
const quote = (m: MailMessage) => `\n\nOn ${m.date ? formatDateTime(m.date) : ''}, ${m.from} wrote:\n` + (m.body ?? '').split('\n').map(l => '> ' + l).join('\n');

export function MailboxPage() {
  const wid = useWorkspaceId();
  const uid = useAuth(s => s.ctx?.user.id);
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const google = useWsQuery(['account', 'google-status'], integrationsApi.googleStatus);
  const ms = useWsQuery(['account', 'microsoft-status'], microsoftApi.status);
  const imap = useWsQuery(['mailbox', 'accounts'], mailboxApi.accounts);
  const agentOpts = useWsQuery(['mailbox', 'agent-options'], mailboxApi.agentOptions, { staleTime: 300_000 });
  const [scope, setScope] = useState<string>('all');        // 'all' or one account key
  const [folder, setFolder] = useState<MailFolder>('inbox');
  const [filter, setFilter] = useState<'all' | 'unread' | 'attachments'>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<{ account: string; id: string } | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [guide, setGuide] = useState<'gmail' | 'outlook' | null>(null);
  const [composeOpen, setComposeOpen] = useState<null | { to?: string; subject?: string; body?: string }>(null);
  const [cursors, setCursors] = useState<Record<string, string | null>>({});
  const [extra, setExtra] = useState<Record<string, MailMessage[]>>({});

  // "Create › Email" on the phone opens a new message straight away.
  useEffect(() => {
    if (params.get('compose') !== '1') return;
    setComposeOpen({});
    const n = new URLSearchParams(params); n.delete('compose'); setParams(n, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Landing back from a provider's consent page.
  useEffect(() => {
    const g = params.get('google'), m = params.get('microsoft');
    if (!g && !m) return;
    const outcome = g ?? m;
    toast(outcome === 'connected' ? `${g ? 'Gmail' : 'Outlook'} connected. Your mail is syncing.` : outcome === 'declined' ? 'The connection was cancelled.' : 'The mail account could not be connected. Try again.', outcome === 'connected' ? 'success' : 'info');
    void invalidateWorkspace(wid, 'account');
    const n = new URLSearchParams(params); n.delete('google'); n.delete('microsoft'); setParams(n, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accounts: Account[] = useMemo(() => {
    const list: Account[] = [];
    const g = google.data;
    if (g?.connected) list.push({ key: 'google', label: 'Gmail', email: g.googleEmail ?? '', kind: 'gmail', canRead: !!g.inboxAccess, canSend: !!g.mailSendAccess,
      needs: !g.inboxAccess || !g.mailSendAccess ? 'Allow Gmail to read and send mail' : undefined, error: g.lastError });
    const o = ms.data;
    if (o?.connected) list.push({ key: 'microsoft', label: 'Outlook', email: o.email ?? '', kind: 'outlook', canRead: !!o.inboxAccess, canSend: !!o.mailSendAccess,
      needs: !o.inboxAccess ? 'Allow Outlook to read your inbox' : undefined });
    for (const a of imap.data?.imap ?? []) list.push({ key: `imap:${a.id}`, label: a.name, email: a.email, kind: 'imap', canRead: true, canSend: true, error: a.lastError });
    return list;
  }, [google.data, ms.data, imap.data]);
  const readable = accounts.filter(a => a.canRead);
  const shown = scope === 'all' ? readable : readable.filter(a => a.key === scope);
  const loadingAccounts = google.isLoading || ms.isLoading || imap.isLoading;

  const lists = useQueries({
    queries: shown.map(a => ({
      queryKey: [wid, 'mailbox', 'list', a.key, folder, query],
      queryFn: ({ signal }: { signal: AbortSignal }) => mailboxApi.messages(a.key, folder, null, a.kind === 'imap' ? query : undefined, signal),
      staleTime: 60_000, refetchInterval: 120_000, retry: 1,
    })),
  });
  useEffect(() => { setCursors({}); setExtra({}); }, [scope, folder, query]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    shown.forEach((a, i) => {
      const data = lists[i]?.data;
      const msgs = [...(data?.messages ?? []), ...(extra[a.key] ?? [])];
      for (const m of msgs) out.push({ ...m, account: a.key, accountLabel: a.label, kind: a.kind });
    });
    const q = query.trim().toLowerCase();
    return out
      .filter(r => filter === 'all' || (filter === 'unread' ? r.unread : r.hasAttachments))
      .filter(r => !q || r.kind === 'imap' || `${r.subject} ${r.from} ${r.to}`.toLowerCase().includes(q))
      .sort((x, y) => (y.date ? Date.parse(y.date) : 0) - (x.date ? Date.parse(x.date) : 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists.map(l => l.dataUpdatedAt).join(','), extra, filter, query, shown.map(a => a.key).join(',')]);
  const listLoading = lists.some(l => l.isLoading);
  const listErrors = shown.map((a, i) => ({ a, e: lists[i]?.error })).filter(x => x.e);
  const unreadCount = (key: string) => {
    const i = shown.findIndex(a => a.key === key);
    return i >= 0 ? (lists[i]?.data?.messages ?? []).filter(m => m.unread).length : 0;
  };

  const loadMore = async () => {
    if (shown.length !== 1) return;
    const a = shown[0]; const cursor = a.key in cursors ? cursors[a.key] : lists[0]?.data?.cursor;
    if (!cursor) return;
    try {
      const page = await mailboxApi.messages(a.key, folder, cursor, a.kind === 'imap' ? query : undefined);
      setExtra(e => ({ ...e, [a.key]: [...(e[a.key] ?? []), ...page.messages] }));
      setCursors(c => ({ ...c, [a.key]: page.cursor }));
    } catch (e) { toast(errText(e, 'Could not load more mail.'), 'error'); }
  };
  const hasMore = shown.length === 1 && !!(shown[0].key in cursors ? cursors[shown[0].key] : lists[0]?.data?.cursor);
  const refresh = () => { void qc.invalidateQueries({ queryKey: [wid, 'mailbox'] }); };

  const selectedRow = rows.find(r => selected && r.account === selected.account && r.id === selected.id) ?? null;
  const selectedAccount = accounts.find(a => a.key === selected?.account);

  const modals = <>
    {connectOpen && <ConnectModal accountsData={imap.data} presets={imap.data?.presets ?? []} google={google.data} microsoft={ms.data} imapAccounts={imap.data?.imap ?? []}
      guide={guide} onClose={() => { setConnectOpen(false); setGuide(null); }} onConnected={() => { void invalidateWorkspace(wid, 'mailbox', 'accounts'); }} />}
    {composeOpen && <ComposeModal accounts={accounts.filter(a => a.canSend)} initial={composeOpen} agent={!!agentOpts.data?.available}
      onClose={() => setComposeOpen(null)} onSent={refresh} />}
  </>;

  // Nothing connected yet: the whole page is the invitation (design: "Your mail, with an assistant built in.").
  if (!loadingAccounts && accounts.length === 0) {
    const gmailAvailable = google.data?.inboxEnabled !== false;
    const outlookAvailable = !!(ms.data?.enabled && ms.data.configured && ms.data.inboxEnabled !== false);
    const open = (g: 'gmail' | 'outlook' | null) => { setGuide(g); setConnectOpen(true); };
    return (
      <div className="mb-hero" key={`${wid}-${uid}`} data-testid="mail-hero">
        <span className="mb-hero-ico" aria-hidden="true"><Icon name="mail" size={26} /></span>
        <h1>Your mail, with an assistant built in.</h1>
        <p className="mb-hero-sub">Summaries of every thread, drafted replies and task updates — read live from your provider, never shared with the workspace.</p>
        <div className="mb-hero-card">
          {imap.data?.company
            ? <CompanyConnect accounts={imap.data} onConnected={() => void invalidateWorkspace(wid, 'mailbox', 'accounts')} />
            : <div className="mb-hero-plain">
                <b>Connect your mail</b>
                <small>Gmail, Outlook, Rediffmail and other mail you can read over IMAP.</small>
                <button type="button" className="btn btn-primary btn-block" onClick={() => open(null)}>Connect mail</button>
              </div>}
          <p className="mb-hero-private">Private to you. Stored encrypted.</p>
        </div>
        <div className="ds-chips mb-hero-chips" aria-label={imap.data?.company ? 'Other mail accounts' : 'Mail providers'}>
          <button type="button" className="ds-chip" onClick={() => (gmailAvailable ? void reconnect('gmail') : open('gmail'))}>Gmail</button>
          <button type="button" className="ds-chip" onClick={() => (outlookAvailable ? void reconnect('outlook') : open('outlook'))}>Outlook</button>
          <button type="button" className="ds-chip" onClick={() => open(null)}>Other IMAP</button>
        </div>
        <div className="mb-hero-features">
          <div><b>Summaries</b><span>Long threads in three lines.</span></div>
          <div><b>Draft replies</b><span>You review, you send.</span></div>
          <div><b>Task updates</b><span>Mail becomes project progress.</span></div>
        </div>
        {modals}
      </div>
    );
  }

  return (
    <div className={`mailbox ${selected ? 'has-selection' : ''}`} key={`${wid}-${uid}`}>
      <h1 className="sr-only">Mailbox</h1>
      <aside className="mb-rail" aria-label="Mail accounts and folders">
        <button className="btn btn-primary mb-new" onClick={() => setComposeOpen({})} disabled={!accounts.some(a => a.canSend)}><Icon name="edit" size={16} /> New mail</button>
        <nav className="mb-folders">
          <button className={scope === 'all' && folder === 'inbox' ? 'active' : ''} onClick={() => { setScope('all'); setFolder('inbox'); setSelected(null); }}>
            <Icon name="inbox" size={16} /><span>All inboxes</span>
          </button>
          {accounts.map(a => (
            <div key={a.key} className="mb-account">
              <div className="mb-account-head" title={a.email}>
                <span className="mb-dot" style={{ background: KIND_COLOR[a.kind] }} />
                <span className="mb-account-name"><b>{a.label}</b><small>{a.email}</small></span>
              </div>
              {a.canRead ? (['inbox', 'sent'] as MailFolder[]).map(f => (
                <button key={f} className={scope === a.key && folder === f ? 'active' : ''} onClick={() => { setScope(a.key); setFolder(f); setSelected(null); }}>
                  <Icon name={f === 'inbox' ? 'inbox' : 'send'} size={15} /><span>{f === 'inbox' ? 'Inbox' : 'Sent'}</span>
                  {f === 'inbox' && scope === a.key && unreadCount(a.key) > 0 && <em>{unreadCount(a.key)}</em>}
                </button>
              )) : <button className="mb-needs" onClick={() => {
                const ready = a.kind === 'gmail' ? google.data?.inboxEnabled !== false : ms.data?.enabled && ms.data.configured && ms.data.inboxEnabled !== false;
                if (ready) void reconnect(a.kind); else { setGuide(a.kind === 'gmail' ? 'gmail' : 'outlook'); setConnectOpen(true); }
              }}><Icon name="lock" size={14} /><span>{a.needs}</span></button>}
              {a.error && <p className="mb-account-error">{a.error}</p>}
            </div>
          ))}
        </nav>
        <button className="btn mb-connect" onClick={() => setConnectOpen(true)}><Icon name="plus" size={16} /> Connect mail</button>
        <p className="mb-private"><Icon name="lock" size={12} /> Private to you. Mail is read live from your provider and never shared with your workspace.</p>
      </aside>

      <section className="mb-list" aria-label="Messages">
        <header className="mb-list-head">
          <form className="mb-search" onSubmit={e => { e.preventDefault(); setQuery(search); }} role="search">
            <Icon name="search" size={15} />
            <input value={search} onChange={e => { setSearch(e.target.value); if (!e.target.value) setQuery(''); }} placeholder="Search mail" aria-label="Search mail" />
          </form>
          <button className="btn btn-ghost btn-icon" onClick={refresh} title="Sync now" aria-label="Sync now"><Icon name="refresh" size={16} /></button>
        </header>
        <div className="mb-filters" role="tablist" aria-label="Filter messages">
          {(['all', 'unread', 'attachments'] as const).map(f => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'unread' ? 'Unread' : 'Attachments'}</button>
          ))}
          <span className="mb-scope">{scope === 'all' ? 'All inboxes' : `${accounts.find(a => a.key === scope)?.label ?? ''} · ${folder === 'inbox' ? 'Inbox' : 'Sent'}`}</span>
        </div>
        {listErrors.map(({ a, e }) => <div key={a.key} className="mb-banner" role="alert"><Icon name="alert" size={14} /> {a.label}: {errText(e, 'Could not sync this mailbox.')}</div>)}
        <div className="mb-rows">
          {loadingAccounts ? <div className="mb-center"><Spinner /></div> : readable.length === 0 ? (
            <div className="mb-empty">
              <span className="mb-empty-art"><Icon name="mail" size={30} /></span>
              <h2>Bring your mail here</h2>
              {imap.data?.company ? <CompanyConnect accounts={imap.data} onConnected={() => void invalidateWorkspace(wid, 'mailbox', 'accounts')} />
                : <p>Connect Gmail, Outlook or Rediffmail to read, reply and let the mail agent turn emails into tasks.</p>}
              <button className={imap.data?.company ? 'btn btn-ghost' : 'btn btn-primary'} onClick={() => setConnectOpen(true)}><Icon name="plus" size={15} /> {imap.data?.company ? 'Other mail accounts' : 'Connect mail'}</button>
            </div>
          ) : listLoading && rows.length === 0 ? <div className="mb-center"><Spinner /></div> : rows.length === 0 ? (
            <div className="mb-empty small"><Icon name="checkCircle" size={22} /><p>{query ? 'No messages match your search.' : 'Nothing here. You are all caught up.'}</p></div>
          ) : rows.map(r => {
            const name = displayName(folder === 'sent' && r.to ? r.to : r.from) || '(unknown)';
            const active = selected?.account === r.account && selected.id === r.id;
            return (
              <button key={`${r.account}-${r.id}`} className={`mb-row ${r.unread ? 'unread' : ''} ${active ? 'active' : ''}`} onClick={() => setSelected({ account: r.account, id: r.id })}>
                <span className="mb-avatar" style={{ background: `color-mix(in srgb, ${KIND_COLOR[r.kind]} 14%, transparent)`, color: KIND_COLOR[r.kind] }}>{initials(name)}</span>
                <span className="mb-row-main">
                  <span className="mb-row-top"><b>{name}</b><time>{shortDate(r.date)}</time></span>
                  <span className="mb-row-subject">{r.subject || '(no subject)'}</span>
                  <span className="mb-row-meta">
                    {scope === 'all' && <span className="mb-tag" style={{ color: KIND_COLOR[r.kind] }}>{r.accountLabel}</span>}
                    {r.hasAttachments && <Icon name="paperclip" size={12} />}
                  </span>
                </span>
              </button>
            );
          })}
          {hasMore && <button className="btn btn-ghost mb-more" onClick={() => void loadMore()}>Load older mail</button>}
        </div>
      </section>

      <section className="mb-reader" aria-label="Reading pane">
        {selected && selectedAccount ? (
          <Reader key={`${selected.account}-${selected.id}`} account={selectedAccount} folder={folder} messageId={selected.id} row={selectedRow}
            agent={!!agentOpts.data?.available} onBack={() => setSelected(null)}
            onSent={refresh} />
        ) : (
          <div className="mb-reader-empty"><Icon name="mail" size={36} /><p>Select a message to read it.</p>
            {agentOpts.data?.available && <small><Icon name="sparkle" size={12} /> The mail agent summarises each conversation, drafts replies and suggests task updates.</small>}</div>
        )}
      </section>

      {modals}
    </div>
  );
}

async function reconnect(kind: Account['kind']) {
  if (continueConnectionInBrowser()) return;
  try {
    if (kind === 'gmail') { const { url } = await integrationsApi.googleConnectUrl('/mailbox', true, true); window.location.assign(url); }
    else if (kind === 'outlook') {
      try { sessionStorage.setItem(MAILBOX_RETURN_KEY, '1'); } catch { /* the person lands in settings instead */ }
      const { url } = await microsoftApi.connect(true); window.location.assign(url);
    }
  } catch (e) { toast(errText(e, 'Could not start the connection.'), 'error'); }
}

/* ---------------- reading pane ---------------- */

function Reader({ account, folder, messageId, row, agent, onBack, onSent }: {
  account: Account; folder: MailFolder; messageId: string; row: Row | null; agent: boolean; onBack: () => void; onSent: () => void;
}) {
  const wid = useWorkspaceId();
  const t = useWsQuery(['mailbox', 'thread', account.key, folder, messageId], () => mailboxApi.thread(account.key, folder, messageId), { staleTime: 300_000, retry: 1 });
  const [reply, setReply] = useState<null | { all: boolean; body: string }>(null);
  const [assist, setAssist] = useState<MailAssist | null>(null);
  const [assisting, setAssisting] = useState(false);
  const [forwarding, setForwarding] = useState<MailMessage | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const replyRef = useRef<HTMLDivElement>(null);
  const thread = t.data;
  const last = thread?.messages[thread.messages.length - 1];

  useEffect(() => { if (thread && last) setOpen(new Set([last.id])); }, [thread?.threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (reply) replyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [!!reply]); // eslint-disable-line react-hooks/exhaustive-deps

  const runAssist = async () => {
    setAssisting(true);
    try { setAssist(await mailboxApi.assist({ account: account.key, folder, messageId })); }
    catch (e) { toast(errText(e, 'The mail agent could not read this conversation.'), 'error'); }
    finally { setAssisting(false); }
  };
  const startReply = (all: boolean, body = '') => setReply({ all, body });

  if (t.isLoading) return <div className="mb-center"><Spinner /></div>;
  if (t.isError || !thread) return <div className="mb-reader-empty"><Icon name="alert" size={28} /><p>{errText(t.error, 'This message could not be opened.')}</p><button className="btn" onClick={() => void t.refetch()}>Try again</button></div>;
  const subject = last?.subject || row?.subject || '(no subject)';

  return (
    <div className="mb-read">
      <header className="mb-read-head">
        <button className="btn btn-ghost btn-icon mb-back" onClick={onBack} aria-label="Back to messages"><Icon name="arrowLeft" size={18} /></button>
        <h2>{subject}</h2>
        <div className="mb-read-actions">
          <button className="btn btn-sm" disabled={!account.canSend} onClick={() => startReply(false)}><Icon name="undo" size={14} /> Reply</button>
          <button className="btn btn-sm" disabled={!account.canSend} onClick={() => startReply(true)}><Icon name="users" size={14} /> Reply all</button>
          <button className="btn btn-sm btn-ghost" disabled={!account.canSend} onClick={() => last && setForwarding(last)}><Icon name="arrowRight" size={14} /> Forward</button>
          {agent && <button className="btn btn-sm mb-agent-btn" disabled={assisting} onClick={() => void runAssist()}>{assisting ? <Spinner /> : <Icon name="sparkle" size={14} />} {assist ? 'Re-read' : 'Ask agent'}</button>}
        </div>
      </header>
      <div className="mb-read-body">
        {(assisting || assist) && <AgentPanel assist={assist} busy={assisting} wid={wid} onReply={(body) => startReply(false, body)} />}
        {thread.truncated && <p className="mb-note"><Icon name="info" size={13} /> Older messages in this conversation are not shown.</p>}
        {thread.messages.map(m => {
          const expanded = open.has(m.id);
          return (
            <article key={m.id} className={`mb-msg ${expanded ? 'open' : ''}`}>
              <button className="mb-msg-head" onClick={() => setOpen(s => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })} aria-expanded={expanded}>
                <span className="mb-avatar lg">{initials(displayName(m.from))}</span>
                <span className="mb-msg-from"><b>{displayName(m.from)}</b><small>{addressOf(m.from)}</small>
                  {expanded && (m.to || m.cc) && <small className="mb-msg-to">To: {m.to}{m.cc ? ` · Cc: ${m.cc}` : ''}</small>}
                  {!expanded && <small className="mb-msg-snip">{(m.body ?? '').slice(0, 140)}</small>}
                </span>
                <time>{m.date ? formatDateTime(m.date) : ''}</time>
              </button>
              {expanded && <div className="mb-msg-body">{m.body}{m.bodyTruncated && <p className="mb-note">This message is longer than shown here. Open it in your mail app to see all of it.</p>}
                {m.hasAttachments && <p className="mb-note"><Icon name="paperclip" size={13} /> This message has attachments. Open it in your mail app to download them.</p>}</div>}
            </article>
          );
        })}
        {reply && last && (
          <div ref={replyRef}>
            <ReplyBox account={account} folder={folder} message={last} all={reply.all} initial={reply.body} agent={agent}
              onCancel={() => setReply(null)} onSent={() => { setReply(null); onSent(); }} />
          </div>
        )}
        {!reply && account.canSend && (
          <div className="mb-quick">
            <button onClick={() => startReply(false)}><Icon name="undo" size={14} /> Reply</button>
            <button onClick={() => startReply(true)}><Icon name="users" size={14} /> Reply all</button>
            <button onClick={() => last && setForwarding(last)}><Icon name="arrowRight" size={14} /> Forward</button>
          </div>
        )}
      </div>
      {forwarding && <ForwardModal account={account} folder={folder} message={forwarding} onClose={() => setForwarding(null)} onSent={onSent} />}
    </div>
  );
}

/* ---------------- the mail agent ---------------- */

const INTENT: Record<string, string> = { action_required: 'Action required', question: 'Question for you', meeting: 'Meeting', fyi: 'For your information', follow_up: 'Follow-up', approval: 'Needs approval', promotional: 'Promotional' };

function AgentPanel({ assist, busy, wid, onReply }: { assist: MailAssist | null; busy: boolean; wid: string | null; onReply: (body: string) => void }) {
  const [applyAll, setApplyAll] = useState(0);
  if (busy && !assist) return <div className="mb-agent loading"><Icon name="sparkle" size={16} /><span>The mail agent is reading the conversation and your open work…</span><Spinner /></div>;
  if (!assist) return null;
  return (
    <section className="mb-agent" aria-label="Mail agent">
      <header><Icon name="sparkle" size={15} /><b>Mail agent</b>
        <span className={`mb-chip intent-${assist.intent}`}>{INTENT[assist.intent] ?? assist.intent}</span>
        <span className={`mb-chip urgency-${assist.urgency}`}>{assist.urgency === 'high' ? 'Urgent' : assist.urgency === 'medium' ? 'Soon' : 'No rush'}</span>
      </header>
      <p className="mb-agent-summary">{assist.summary}</p>
      {(assist.keyFacts.length > 0 || assist.actionItems.length > 0) && <div className="mb-agent-grid">
        {assist.keyFacts.length > 0 && <div><h4>Key facts</h4><ul>{assist.keyFacts.map((f, i) => <li key={i}>{f}</li>)}</ul></div>}
        {assist.actionItems.length > 0 && <div><h4>For you to do</h4><ul className="checks">{assist.actionItems.map((f, i) => <li key={i}>{f}</li>)}</ul></div>}
      </div>}
      {assist.tasks.length > 0 && <div className="mb-agent-tasks">
        <div className="mb-agent-tasks-head"><h4>Suggested task updates</h4>
          {assist.tasks.length > 1 && <button type="button" className="btn btn-sm" onClick={() => setApplyAll((n) => n + 1)}><Icon name="checks" size={13} /> Apply all</button>}</div>
        {assist.tasks.map((t, i) => <TaskSuggestion key={i} s={t} wid={wid} trigger={applyAll} />)}</div>}
      {assist.replies.length > 0 && <div className="mb-agent-replies"><h4>Suggested replies</h4>
        <div className="mb-reply-chips">{assist.replies.map((r, i) => <button key={i} onClick={() => onReply(r.body)} title={r.body}><Icon name="edit" size={13} /> {r.label}</button>)}</div></div>}
      <small className="mb-agent-foot">Suggestions only. Nothing is sent or changed until you choose it.</small>
    </section>
  );
}

const STATUS_LABEL: Record<string, string> = { ToDo: 'To do', InProgress: 'In progress', OnHold: 'On hold', Completed: 'Completed', Cancelled: 'Cancelled' };

function TaskSuggestion({ s, wid, trigger = 0 }: { s: MailTaskSuggestion; wid: string | null; trigger?: number }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [link, setLink] = useState<string | null>(s.kind === 'update' ? (s.taskKind === 'task' && s.projectId ? `/projects/${s.projectId}?task=${s.taskId}` : `/operations?task=${s.taskId}`) : null);
  const types = useWsQuery(['work-types'], () => workApi.types(), { enabled: s.kind === 'create', staleTime: 300_000 });
  const [typeId, setTypeId] = useState('');
  const type = typeId || types.data?.find(t => t.isActive !== false)?.id || '';
  const apply = async () => {
    setState('busy');
    try {
      if (s.kind === 'create') {
        if (!type) throw new Error('Add a work type in Operations first.');
        const created = await workApi.create({ title: s.title, description: [s.detail, s.reason ? `From email: ${s.reason}` : ''].filter(Boolean).join('\n\n'), workTypeId: type,
          priority: s.priority ?? 'Medium', dueDate: s.due, assigneeId: useAuth.getState().ctx?.user.id ?? null });
        setLink(`/operations?task=${created.id}`);
        void invalidateWorkspace(wid, 'work');
      } else if (s.taskId) {
        const note = [s.detail, s.reason].filter(Boolean).join('\n\n') || 'Update from email.';
        if (s.taskKind === 'work') {
          if (s.status) await workApi.setStatus(s.taskId, s.status);
          await workApi.addComment(s.taskId, `From email: ${note}`);
          void invalidateWorkspace(wid, 'work');
        } else {
          await taskApi.addComment(s.taskId, { body: `From email: ${note}` });
        }
      }
      setState('done'); toast(s.kind === 'create' ? 'Task created.' : 'Task updated.');
    } catch (e) { setState('idle'); toast(errText(e, e instanceof Error ? e.message : 'Could not apply this suggestion.'), 'error'); }
  };
  // "Apply all": each suggestion still applies itself (its own checks and messages), once.
  useEffect(() => { if (trigger > 0 && state === 'idle') void apply(); }, [trigger]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`mb-task ${state === 'done' ? 'done' : ''}`}>
      <span className="mb-task-kind">{s.kind === 'create' ? <Icon name="plus" size={13} /> : <Icon name="refresh" size={13} />}</span>
      <div className="mb-task-main">
        <b>{s.kind === 'create' ? 'Create: ' : `Update ${s.taskRef ?? ''}: `}{s.title}</b>
        <small>{[s.status && `Status → ${STATUS_LABEL[s.status] ?? s.status}`, s.priority && s.kind === 'create' && `${s.priority} priority`, s.due && `due ${s.due}`].filter(Boolean).join(' · ')}</small>
        {s.detail && <p>{s.detail}</p>}
        {s.reason && <p className="mb-task-why">“{s.reason}”</p>}
        {s.kind === 'create' && state !== 'done' && (types.data?.length ?? 0) > 1 && (
          <Select className="select" aria-label="Work type" value={type} onChange={e => setTypeId(e.target.value)}>{types.data!.filter(t => t.isActive !== false).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        )}
      </div>
      <div className="mb-task-actions">
        {state === 'done' ? <><span className="mb-done"><Icon name="check" size={13} /> Done</span>{link && <Link className="btn btn-sm btn-ghost" to={link}>Open</Link>}</>
          : <><button className="btn btn-sm btn-primary" disabled={state === 'busy'} onClick={() => void apply()}>{state === 'busy' ? <Spinner /> : s.kind === 'create' ? 'Create task' : s.status ? 'Apply update' : 'Add note'}</button>
            {link && <Link className="btn btn-sm btn-ghost" to={link}>View</Link>}</>}
      </div>
    </div>
  );
}

/* ---------------- writing ---------------- */

const TOOLS: { mode: ComposeMode; label: string; needsText: boolean }[] = [
  { mode: 'reply', label: 'Draft reply', needsText: false }, { mode: 'improve', label: 'Improve', needsText: true }, { mode: 'shorter', label: 'Shorter', needsText: true },
  { mode: 'formal', label: 'Formal', needsText: true }, { mode: 'friendly', label: 'Friendly', needsText: true }, { mode: 'complete', label: 'Finish it', needsText: true },
];

function AgentTools({ draft, setDraft, context, agent, replying }: { draft: string; setDraft: (s: string) => void; context?: { account: string; folder: MailFolder; messageId: string }; agent: boolean; replying: boolean }) {
  const [busy, setBusy] = useState<ComposeMode | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  if (!agent) return null;
  const run = async (mode: ComposeMode) => {
    setBusy(mode);
    try { const r = await mailboxApi.compose({ ...context, draft, mode }); setUndo(draft); setDraft(r.body); }
    catch (e) { toast(errText(e, 'The mail agent could not help with this draft.'), 'error'); }
    finally { setBusy(null); }
  };
  return (
    <div className="mb-tools" role="toolbar" aria-label="Writing help">
      <Icon name="sparkle" size={14} />
      {TOOLS.filter(t => replying || t.mode !== 'reply').map(t => (
        <button key={t.mode} type="button" disabled={!!busy || (t.needsText && !draft.trim())} onClick={() => void run(t.mode)}>{busy === t.mode ? <Spinner /> : null}{t.label}</button>
      ))}
      {undo !== null && !busy && <button type="button" className="mb-undo" onClick={() => { setDraft(undo); setUndo(null); }}><Icon name="undo" size={12} /> Undo</button>}
    </div>
  );
}

function ReplyBox({ account, folder, message, all, initial, agent, onCancel, onSent }: {
  account: Account; folder: MailFolder; message: MailMessage; all: boolean; initial: string; agent: boolean; onCancel: () => void; onSent: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [replyAll, setReplyAll] = useState(all);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setBody(initial); }, [initial]);
  useEffect(() => { area.current?.focus(); }, []);
  const recipients = replyAll ? [displayName(message.from), ...(message.to ? ['others on this thread'] : [])].join(', ') : displayName(message.from);
  const send = async () => {
    if (!body.trim()) return;
    if (!(await confirmDialog({ title: replyAll ? 'Send reply to everyone?' : 'Send reply?', message: `From ${account.email} to ${replyAll ? 'the sender and everyone on the conversation' : displayName(message.from)}.`, confirmText: 'Send' }))) return;
    setSending(true);
    try {
      const r = await mailboxApi.send({ account: account.key, folder, replyToId: message.id, replyAll, body: body.trimEnd() + quote(message), confirmed: true });
      toast(r.to ? `Reply sent to ${r.to}.` : 'Reply sent.');
      offerReminderAfterSend(body, 'email');
      onSent();
    } catch (e) { toast(errText(e, 'The reply could not be sent.'), 'error'); }
    finally { setSending(false); }
  };
  return (
    <div className="mb-compose inline">
      <div className="mb-compose-to">
        <Icon name={replyAll ? 'users' : 'undo'} size={14} />
        <span>{replyAll ? 'Reply all' : 'Reply'} to <b>{recipients}</b></span>
        <button type="button" className="mb-link" onClick={() => setReplyAll(v => !v)}>{replyAll ? 'Only the sender' : 'Everyone'}</button>
      </div>
      <textarea ref={area} value={body} onChange={e => setBody(e.target.value)} rows={8} placeholder="Write your reply…" aria-label="Reply"
        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send(); }} />
      <AgentTools draft={body} setDraft={setBody} agent={agent} replying context={{ account: account.key, folder, messageId: message.id }} />
      <footer>
        <button className="btn btn-primary" disabled={sending || !body.trim()} onClick={() => void send()}>{sending ? <Spinner /> : <Icon name="send" size={14} />} Send</button>
        <button className="btn btn-ghost" onClick={onCancel}>Discard</button>
        <small>The original message is quoted below your reply. Ctrl+Enter to send.</small>
      </footer>
    </div>
  );
}

/** Forwards the message itself, with its attachments, from the account it arrived in. A note goes above it. */
function ForwardModal({ account, folder, message, onClose, onSent }: { account: Account; folder: MailFolder; message: MailMessage; onClose: () => void; onSent: () => void }) {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const subject = /^(fwd?|fw):/i.test(message.subject) ? message.subject : `Fwd: ${message.subject || '(no subject)'}`;
  const send = async () => {
    if (!(await confirmDialog({ title: 'Forward this email?', message: `From ${account.email} to ${to}${cc ? `, cc ${cc}` : ''}${message.hasAttachments ? ', with its attachments' : ''}.`, confirmText: 'Forward' }))) return;
    setSending(true);
    try {
      const r = await mailboxApi.forward({ account: account.key, folder, messageId: message.id, to, cc: cc || undefined, note: note.trim() || undefined, confirmed: true });
      toast(`Forwarded to ${r.to || to}.`);
      onSent(); onClose();
    } catch (e) { toast(errText(e, 'The email could not be forwarded.'), 'error'); }
    finally { setSending(false); }
  };
  return (
    <Modal title="Forward" onClose={onClose} size="lg" footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Discard</button>
      <button className="btn btn-primary" disabled={sending || !to.trim()} onClick={() => void send()}>{sending ? <Spinner /> : <Icon name="arrowRight" size={14} />} Forward</button>
    </>}>
      <div className="mb-compose" data-testid="mail-forward">
        <div className="mb-line"><span>From</span><b>{account.email}</b></div>
        <label className="mb-line"><span>To</span><input value={to} onChange={e => setTo(e.target.value)} placeholder="name@example.com, …" autoFocus />
          {!showCc && <button type="button" className="mb-link" onClick={() => setShowCc(true)}>Cc</button>}</label>
        {showCc && <label className="mb-line"><span>Cc</span><input value={cc} onChange={e => setCc(e.target.value)} /></label>}
        <div className="mb-line"><span>Subject</span><span>{subject}</span></div>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={5} placeholder="Add a note (optional)…" aria-label="Note" />
        <p className="mb-note"><Icon name={message.hasAttachments ? 'paperclip' : 'mail'} size={13} /> {displayName(message.from)}’s message goes below your note{message.hasAttachments ? ', with its attachments' : ''}.</p>
      </div>
    </Modal>
  );
}

function ComposeModal({ accounts, initial, agent, onClose, onSent }: { accounts: Account[]; initial: { to?: string; subject?: string; body?: string }; agent: boolean; onClose: () => void; onSent: () => void }) {
  const [from, setFrom] = useState(accounts[0]?.key ?? '');
  const [to, setTo] = useState(initial.to ?? '');
  const [cc, setCc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(initial.subject ?? '');
  const [body, setBody] = useState(initial.body ?? '');
  const [sending, setSending] = useState(false);
  const account = accounts.find(a => a.key === from);
  const send = async () => {
    if (!account) return;
    if (!(await confirmDialog({ title: 'Send this email?', message: `From ${account.email} to ${to}${cc ? `, cc ${cc}` : ''}.`, confirmText: 'Send' }))) return;
    setSending(true);
    try { await mailboxApi.send({ account: account.key, to, cc, subject, body, confirmed: true }); toast('Email sent.'); offerReminderAfterSend(body, 'email'); onSent(); onClose(); }
    catch (e) { toast(errText(e, 'The email could not be sent.'), 'error'); }
    finally { setSending(false); }
  };
  return (
    <Modal title="New mail" onClose={onClose} size="lg" footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Discard</button>
      <button className="btn btn-primary" disabled={sending || !to.trim() || !body.trim() || !account} onClick={() => void send()}>{sending ? <Spinner /> : <Icon name="send" size={14} />} Send</button>
    </>}>
      {accounts.length === 0 ? <p className="muted">Connect a mail account that can send first.</p> : <div className="mb-compose">
        <label className="mb-line"><span>From</span>
          <Select className="select" aria-label="From" value={from} onChange={e => setFrom(e.target.value)}>{accounts.map(a => <option key={a.key} value={a.key}>{a.label} · {a.email}</option>)}</Select>
        </label>
        <label className="mb-line"><span>To</span><input value={to} onChange={e => setTo(e.target.value)} placeholder="name@example.com, …" autoFocus />
          {!showCc && <button type="button" className="mb-link" onClick={() => setShowCc(true)}>Cc</button>}</label>
        {showCc && <label className="mb-line"><span>Cc</span><input value={cc} onChange={e => setCc(e.target.value)} /></label>}
        <label className="mb-line"><span>Subject</span><input value={subject} onChange={e => setSubject(e.target.value)} /></label>
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={12} placeholder="Write your message…" aria-label="Message" />
        <AgentTools draft={body} setDraft={setBody} agent={agent} replying={false} />
      </div>}
    </Modal>
  );
}

/* ---------------- connecting ---------------- */

function ConnectModal({ accountsData, presets, google, microsoft, imapAccounts, onClose, onConnected, guide: initialGuide = null }: {
  accountsData?: MailAccounts; presets: { id: string; name: string; domain: string }[];
  google?: { connected: boolean; inboxEnabled?: boolean; inboxAccess?: boolean; mailSendAccess?: boolean; googleEmail?: string | null } | undefined;
  microsoft?: { enabled: boolean; configured: boolean; connected: boolean; inboxEnabled?: boolean; inboxAccess?: boolean; mailSendAccess?: boolean; email?: string | null } | undefined;
  imapAccounts: { id: string; name: string; email: string }[]; onClose: () => void; onConnected: () => void; guide?: 'gmail' | 'outlook' | null;
}) {
  const wid = useWorkspaceId();
  const [pick, setPick] = useState<string | null>(null);
  const [guide, setGuide] = useState<'gmail' | 'outlook' | null>(initialGuide);
  const role = useAuth(s => s.ctx?.current?.role);
  const canSetUp = role === 'Owner' || role === 'Admin' || !!useAuth.getState().ctx?.user.isPlatformAdmin;
  const gmailAvailable = google?.inboxEnabled !== false;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const preset = presets.find(p => p.id === pick);
  const gmailReady = google?.connected && google.inboxAccess && google.mailSendAccess;
  const outlookReady = microsoft?.connected && microsoft.inboxAccess;
  const outlookAvailable = microsoft?.enabled && microsoft.configured && microsoft.inboxEnabled !== false;
  const connectImap = async () => {
    setBusy(true);
    try { await mailboxApi.connectImap({ provider: pick!, email, password }); setPassword(''); toast(`${preset?.name ?? 'Mailbox'} connected.`); onConnected(); onClose(); }
    catch (e) { toast(errText(e, 'The mailbox could not be connected.'), 'error'); }
    finally { setBusy(false); }
  };
  const remove = async (id: string, name: string) => {
    if (!(await confirmDialog({ title: `Disconnect ${name}?`, message: 'The stored password is deleted. Your mail stays with your provider.', confirmText: 'Disconnect', danger: true }))) return;
    try { await mailboxApi.disconnectImap(id); void invalidateWorkspace(wid, 'mailbox'); toast('Mailbox disconnected.'); }
    catch (e) { toast(errText(e, 'Could not disconnect.'), 'error'); }
  };
  // Mail only: Calendar, Meet and Teams on the same account keep working. The whole account is disconnected in My account > Connected accounts.
  const disconnectProvider = async (kind: 'gmail' | 'outlook') => {
    const name = kind === 'gmail' ? 'Gmail' : 'Outlook mail';
    if (!(await confirmDialog({ title: `Stop ${name} here?`, message: `Project Tracker stops reading and sending your ${kind === 'gmail' ? 'Gmail' : 'Outlook'} mail. Your calendar and meetings on the same account keep working. To remove the account completely, use My account › Connected accounts.`, confirmText: `Stop ${name}`, danger: true }))) return;
    try {
      if (kind === 'gmail') { await integrationsApi.googleFeatureOff('inbox'); await integrationsApi.googleFeatureOff('mail'); }
      else { await microsoftApi.featureOff('inbox'); await microsoftApi.featureOff('mail'); }
      void invalidateWorkspace(wid, 'account'); void invalidateWorkspace(wid, 'mailbox'); toast(`${name} stopped. Calendar and meetings still work.`);
    }
    catch (e) { toast(errText(e, 'Could not stop it.'), 'error'); }
  };

  return (
    <Modal title={guide ? `Set up ${guide === 'gmail' ? 'Gmail' : 'Outlook'}` : preset ? `Connect ${preset.name}` : 'Connect mail'} subtitle={guide ? (canSetUp ? 'A one-time setup for your whole workspace.' : 'Your administrator turns this on once.') : preset ? 'Signs in over secure IMAP and SMTP.' : 'Your mail stays private to you.'} onClose={onClose} size={guide ? undefined : 'sm'}
      footer={guide ? <button className="btn btn-ghost" onClick={() => setGuide(null)}>Back</button> : preset ? <><button className="btn btn-ghost" onClick={() => setPick(null)}>Back</button><button className="btn btn-primary" disabled={busy || !email || !password} onClick={() => void connectImap()}>{busy ? <Spinner /> : null} Connect</button></> : undefined}>
      {guide ? <SetupGuide kind={guide} canSetUp={canSetUp} /> : !preset ? (
        <div className="mb-providers">
          {accountsData?.company && !accountsData.imap.some(a => accountsData.company!.domains.some(d => a.email.endsWith('@' + d))) && <CompanyConnect accounts={accountsData} onConnected={() => { onConnected(); onClose(); }} />}
          <button className="mb-provider" onClick={() => gmailAvailable ? void reconnect('gmail') : setGuide('gmail')}>
            <span className="mb-logo gmail">G</span><span><b>Gmail</b><small>{gmailReady ? 'Connected' : !gmailAvailable ? (canSetUp ? 'Not set up yet: see how to turn it on' : 'Not set up yet: ask your administrator') : google?.connected ? 'Allow reading and sending' : 'Google account'}</small></span>
            {gmailReady ? <Icon name="checkCircle" size={16} /> : <Icon name="chevronR" size={16} />}
          </button>
          <button className="mb-provider" onClick={() => outlookAvailable ? void reconnect('outlook') : setGuide('outlook')}>
            <span className="mb-logo outlook">O</span><span><b>Outlook</b><small>{outlookReady ? 'Connected' : !outlookAvailable ? (canSetUp ? 'Not set up yet: see how to turn it on' : 'Not set up yet: ask your administrator') : microsoft?.connected ? 'Allow reading your inbox' : 'Microsoft 365, Outlook.com, Hotmail'}</small></span>
            {outlookReady ? <Icon name="checkCircle" size={16} /> : <Icon name="chevronR" size={16} />}
          </button>
          {presets.map(p => (
            <button key={p.id} className="mb-provider" onClick={() => { setPick(p.id); setEmail(''); }}>
              <span className={`mb-logo ${p.id === 'gmail' ? 'gmail' : p.id.startsWith('rediff') ? 'rediff' : 'other'}`}>{p.name[0]}</span><span><b>{p.name}</b><small>{p.id === 'gmail' ? 'No Google approval needed: sign in with an app password' : p.id.startsWith('rediff') ? 'Rediffmail account' : 'Mail account'}</small></span><Icon name="chevronR" size={16} />
            </button>
          ))}
          {accountsData?.canManageCompany && <CompanyMailSetup accounts={accountsData} onSaved={() => { onConnected(); onClose(); }} />}
          {(google?.connected || microsoft?.connected || imapAccounts.length > 0) && <div className="mb-connected">
            <h4>Connected</h4>
            {google?.connected && (google.inboxAccess || google.mailSendAccess) && <div><span>Gmail · {google.googleEmail}</span><button className="mb-link" onClick={() => void disconnectProvider('gmail')}>Stop mail</button></div>}
            {microsoft?.connected && (microsoft.inboxAccess || microsoft.mailSendAccess) && <div><span>Outlook · {microsoft.email}</span><button className="mb-link" onClick={() => void disconnectProvider('outlook')}>Stop mail</button></div>}
            {imapAccounts.map(a => <div key={a.id}><span>{a.name} · {a.email}</span><button className="mb-link" onClick={() => void remove(a.id, a.name)}>Disconnect</button></div>)}
          </div>}
        </div>
      ) : (
        <form className="mb-imap" onSubmit={e => { e.preventDefault(); void connectImap(); }}>
          <label>Email address<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={preset.domain ? `you@${preset.domain}` : 'you@yourcompany.com'} autoFocus autoComplete="username" /></label>
          <label>Password<PasswordInput value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></label>
          <p className="mb-note"><Icon name="info" size={13} /> {{
            gmail: <>Turn on 2-Step Verification, then create an app password at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a> and paste its 16 letters here.</>,
            rediff: <>In Rediffmail open <b>Settings › POP/IMAP access</b>, switch IMAP on, then use your normal Rediffmail password.</>,
            rediffpro: <>Use your normal Rediffmail Pro password. If it fails, ask your mail admin to allow <b>IMAP</b> for your account.</>,
            yahoo: <>In Yahoo open <b>Account security › Generate app password</b> and paste that password here (not your normal one).</>,
            zoho: <>In Zoho Mail open <b>Settings › Mail Accounts › IMAP Access</b> and switch it on; with 2-factor sign-in, use an app password.</>,
          }[preset.id] ?? 'Switch IMAP on in your mail settings; with two-step sign-in, use an app password.'}{' '}The password is stored encrypted and used only to sync your mail.</p>
        </form>
      )}
    </Modal>
  );
}

/** What an administrator does once so people can connect Gmail or Outlook here (server settings and the provider's app registration). */
function SetupGuide({ kind, canSetUp }: { kind: 'gmail' | 'outlook'; canSetUp: boolean }) {
  const callback = new URL(apiUrl('/integrations/microsoft/callback'), window.location.origin).href;
  if (!canSetUp) return (
    <div className="mb-guide">
      <p>{kind === 'gmail' ? 'Gmail' : 'Outlook'} reading has not been switched on for this installation yet. Ask your workspace owner or administrator to open <b>Mailbox › Connect mail › {kind === 'gmail' ? 'Gmail' : 'Outlook'}</b>: the steps are shown to them here.</p>
      <p className="muted">Meanwhile you can connect Rediffmail, Yahoo or Zoho with an app password.</p>
    </div>
  );
  return kind === 'gmail' ? (
    <ol className="mb-guide">
      <li><b>Google Cloud Console</b> › the project that holds your Google sign-in (the one already used for Calendar &amp; Meet) › <b>APIs &amp; Services › Library</b> › enable <b>Gmail API</b>.</li>
      <li><b>OAuth consent screen › Data access</b> › add the scopes <code>…/auth/gmail.readonly</code> and <code>…/auth/gmail.send</code>.</li>
      <li><b>Who may use it:</b>
        <ul>
          <li>Only accounts in your Google Workspace domain: set the audience to <b>Internal</b>. No Google review is needed.</li>
          <li>Personal <b>@gmail.com</b> accounts: keep it <b>External › Testing</b> and add each person under <b>Test users</b> (up to 100). They will see an “unverified app” notice and can continue. Opening it to everyone needs Google's verification of the Gmail scopes.</li>
        </ul></li>
      <li><b>Railway › API service › Variables</b>: set <code>GoogleCalendar__InboxEnabled</code> = <code>true</code> and <code>GoogleCalendar__MailEnabled</code> = <code>true</code>, then let it redeploy.</li>
      <li>Come back here and choose <b>Gmail</b>. Google asks once to allow reading and sending; the mail then appears in your inbox list.</li>
    </ol>
  ) : (
    <ol className="mb-guide">
      <li><b>Azure portal › Microsoft Entra ID › App registrations › New registration</b>. Supported accounts: <b>any organizational directory and personal Microsoft accounts</b> (so Outlook.com and Hotmail work too).</li>
      <li>Redirect URI (Web): <code>{callback}</code> (your API's public address).</li>
      <li><b>API permissions › Microsoft Graph › Delegated</b>: <code>User.Read</code>, <code>Mail.Read</code>, <code>Mail.Send</code>, <code>offline_access</code>. For a work tenant, choose <b>Grant admin consent</b>.</li>
      <li><b>Certificates &amp; secrets › New client secret</b>, and copy the value.</li>
      <li><b>Railway › API service › Variables</b>: <code>MicrosoftProductivity__Enabled</code> = <code>true</code>, <code>MicrosoftProductivity__InboxEnabled</code> = <code>true</code>, <code>MicrosoftProductivity__ClientId</code> (Application ID), <code>MicrosoftProductivity__ClientSecret</code>, <code>MicrosoftProductivity__RedirectUri</code> (the address above), <code>MicrosoftProductivity__AuthorityTenant</code> = <code>common</code>.</li>
      <li>After the redeploy, choose <b>Outlook</b> here and sign in.</li>
    </ol>
  );
}

/** For people on the company's own mail system: their address is known, so connecting is just the password. */
function CompanyConnect({ accounts, onConnected }: { accounts: MailAccounts; onConnected: () => void }) {
  const company = accounts.company!;
  const mine = accounts.myEmail && company.domains.some(d => accounts.myEmail!.toLowerCase().endsWith('@' + d)) ? accounts.myEmail : '';
  const [email, setEmail] = useState(mine ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const domainOk = company.domains.some(d => email.trim().toLowerCase().endsWith('@' + d));
  const connect = async () => {
    setBusy(true);
    try { await mailboxApi.connectImap({ provider: company.provider, email: email.trim(), password }); setPassword(''); toast('Your company mail is connected.'); onConnected(); }
    catch (e) { toast(errText(e, 'Your mailbox could not be connected.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <form className="mb-company" onSubmit={e => { e.preventDefault(); void connect(); }}>
      <div className="mb-company-head">
        <span className="ds-tile-ico" aria-hidden="true">{company.name[0]}</span>
        <span><b>Company mail</b><small>{company.name} · {company.domains.join(', ')} · servers already set up</small></span>
      </div>
      {!mine && <input type="email" className="input" value={email} onChange={e => setEmail(e.target.value)} placeholder={`you@${company.domains[0]}`} aria-label="Company email" autoComplete="username" />}
      {mine && <span className="mb-company-email">{mine}</span>}
      <label className="mb-company-label" htmlFor="mb-company-pass">Mail password</label>
      <PasswordInput id="mb-company-pass" value={password} onChange={e => setPassword(e.target.value)} placeholder="Same as webmail or Outlook" aria-label="Mail password" autoComplete="current-password" />
      <button className="btn btn-primary btn-block" disabled={busy || !password || !domainOk}>{busy && <Spinner />} Connect</button>
    </form>
  );
}

/** Owners and admins: set the company's mail servers once (like Outlook's account settings); everyone else connects with just their password. */
function CompanyMailSetup({ accounts, onSaved }: { accounts: MailAccounts; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-company-setup">
      <button type="button" className="mb-link" onClick={() => setOpen(true)}>
        <Icon name="building" size={14} /> {accounts.company ? `Company mail: ${accounts.company.name} (${accounts.company.domains.join(', ')})` : 'Set up company mail for everyone'}
      </button>
      {open && <CompanyMailDialog accounts={accounts} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onSaved(); }} />}
    </div>
  );
}

/** Ready-made POP servers for presets whose IMAP is often switched off (the way Outlook is set up in many companies). */
const POP_HOSTS: Record<string, string> = { rediffpro: 'pop.rediffmailpro.com', rediff: 'pop.rediffmail.com', gmail: 'pop.gmail.com', zoho: 'pop.zoho.com', yahoo: 'pop.mail.yahoo.com', outlook: 'outlook.office365.com' };

function CompanyMailDialog({ accounts, onClose, onSaved }: { accounts: MailAccounts; onClose: () => void; onSaved: () => void }) {
  const c = accounts.company;
  const [provider, setProvider] = useState(c?.provider ?? 'rediffpro');
  const [domains, setDomains] = useState(c?.domains.join(', ') ?? (accounts.myEmail?.split('@')[1] ?? ''));
  const [incoming, setIncoming] = useState<'imap' | 'pop'>(c?.incoming ?? 'imap');
  const [inHost, setInHost] = useState(c?.incomingHost ?? '');
  const [inPort, setInPort] = useState(c?.incomingPort ?? 993);
  const [smtpHost, setSmtpHost] = useState(c?.smtpHost ?? '');
  const [smtpPort, setSmtpPort] = useState(c?.smtpPort ?? 465);
  const [email, setEmail] = useState(accounts.myEmail ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [checks, setChecks] = useState<{ server: string; ok: boolean; detail: string }[] | null>(null);
  // Filling in from a preset, or switching IMAP/POP, sets the matching servers; anything can still be typed over.
  const fill = (id: string, proto: 'imap' | 'pop') => {
    const p = accounts.presets.find(x => x.id === id);
    if (!p || id === 'custom') return;
    setInHost(proto === 'pop' ? POP_HOSTS[id] ?? p.imapHost.replace(/^imap\./, 'pop.') : p.imapHost); setInPort(proto === 'pop' ? 995 : p.imapPort);
    setSmtpHost(p.smtpHost); setSmtpPort(p.smtpPort);
  };
  useEffect(() => { if (!c) fill(provider, incoming); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const input = (): CompanyMailInput => ({ provider, domains, incoming, incomingHost: inHost.trim(), incomingPort: inPort, smtpHost: smtpHost.trim(), smtpPort });
  const test = async () => {
    setBusy('test'); setChecks(null);
    try { const r = await mailboxApi.testCompany({ settings: input(), email: email.trim(), password }); setChecks(r.checks); }
    catch (e) { toast(errText(e, 'The test did not run.'), 'error'); } finally { setBusy(null); }
  };
  const save = async () => {
    setBusy('save');
    try { const r = await mailboxApi.saveCompany(input()); toast(r ? `Company mail saved: ${r.name}.` : 'Company mail switched off.'); onSaved(); }
    catch (e) { toast(errText(e, 'Could not save.'), 'error'); } finally { setBusy(null); }
  };
  return (
    <Modal title="Company mail" subtitle="Set the servers once. Everyone with an address on these domains connects with just their password." onClose={onClose} size="lg"
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void save()}>{busy === 'save' ? <Spinner /> : null} Save for everyone</button></>}>
      <div className="mbc">
        <div className="mbc-row">
          <label className="mbc-field"><span>Mail provider</span>
            <Select className="select" value={provider} onChange={e => { setProvider(e.target.value); fill(e.target.value, incoming); setChecks(null); }} aria-label="Mail provider">
              {accounts.presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
          <label className="mbc-field"><span>Company domains</span><input className="input" value={domains} onChange={e => setDomains(e.target.value)} placeholder="fivestargroup.in" /></label>
        </div>
        <fieldset className="mbc-group"><legend>Incoming mail</legend>
          <div className="seg mbc-seg" role="radiogroup" aria-label="Incoming protocol">
            {(['imap', 'pop'] as const).map(p => <button key={p} type="button" role="radio" aria-checked={incoming === p} className={incoming === p ? 'on' : ''}
              onClick={() => { setIncoming(p); fill(provider, p); setChecks(null); }}>{p === 'imap' ? 'IMAP (folders, read state)' : 'POP (inbox only, like Outlook POP)'}</button>)}
          </div>
          <div className="mbc-row">
            <label className="mbc-field grow"><span>Server</span><input className="input mono" value={inHost} onChange={e => setInHost(e.target.value)} placeholder={incoming === 'pop' ? 'pop.rediffmailpro.com' : 'imap.rediffmailpro.com'} /></label>
            <label className="mbc-field port"><span>Port</span><Select className="select" value={String(inPort)} onChange={e => setInPort(Number(e.target.value))} aria-label="Incoming port">
              {incoming === 'pop' ? <option value="995">995 · SSL/TLS</option> : <option value="993">993 · SSL/TLS</option>}</Select></label>
          </div>
        </fieldset>
        <fieldset className="mbc-group"><legend>Outgoing mail (SMTP)</legend>
          <div className="mbc-row">
            <label className="mbc-field grow"><span>Server</span><input className="input mono" value={smtpHost} onChange={e => setSmtpHost(e.target.value)} placeholder="smtp.rediffmailpro.com" /></label>
            <label className="mbc-field port"><span>Port</span><Select className="select" value={String(smtpPort)} onChange={e => setSmtpPort(Number(e.target.value))} aria-label="Outgoing port">
              <option value="465">465 · SSL/TLS</option><option value="587">587 · STARTTLS</option></Select></label>
          </div>
          <small className="mbc-note">Signs in with the same address and password as incoming mail.</small>
        </fieldset>
        <fieldset className="mbc-group"><legend>Test with your mailbox (optional)</legend>
          <div className="mbc-row">
            <label className="mbc-field grow"><span>Email</span><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" /></label>
            <label className="mbc-field grow"><span>Password</span><PasswordInput value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></label>
            <button type="button" className="btn mbc-test" disabled={!!busy || !email || !password} onClick={() => void test()}>{busy === 'test' ? <Spinner /> : <Icon name="checks" size={14} />} Test</button>
          </div>
          <small className="mbc-note">Used once for this test and never stored.</small>
          {checks && <ul className="mbc-checks">{checks.map(k => <li key={k.server} className={k.ok ? 'ok' : 'bad'}><Icon name={k.ok ? 'checkCircle' : 'xCircle'} size={15} /><b className="mono">{k.server}</b><span>{k.detail}</span></li>)}</ul>}
        </fieldset>
      </div>
    </Modal>
  );
}
