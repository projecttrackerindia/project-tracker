import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { projectApi } from '../../api/endpoints';
import { Icon, type IconName } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Spinner } from '../../components/ui';
import { openNew } from '../../components/v2/state';
import { formatDateTime, initials } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { openReminderComposer } from '../reminders/store';
import { ToolbarSlot } from '../talk/ToolbarSlot';
import { ForwardModal, KIND_COLOR, ReplyBox, TaskSuggestion, errText, shortDate, type Account } from '../mailbox/MailParts';
import { addressOf, displayName, mailboxApi, type MailMessage } from '../mailbox/mailboxApi';
import { Composer, type ComposeInit } from './Composer';
import { TAG_LABEL, daysSince, describeSearch, matchesSearch, parseSearch, serverQuery, type MailSearch } from './mailSmart';
import { useMailData, useMailLocal, type MailRow } from './useMail';
import './mail.css';

type Box = 'inbox' | 'needs' | 'waiting' | 'snoozed' | 'sent' | 'drafts' | 'archive';
const BOXES: { id: Box; label: string; icon: IconName }[] = [
  { id: 'inbox', label: 'Inbox', icon: 'inbox' }, { id: 'needs', label: 'Needs reply', icon: 'undo' }, { id: 'waiting', label: 'Waiting on others', icon: 'clock' },
  { id: 'snoozed', label: 'Snoozed', icon: 'alarm' }, { id: 'sent', label: 'Sent', icon: 'send' }, { id: 'drafts', label: 'Drafts', icon: 'edit' }, { id: 'archive', label: 'Archive', icon: 'download' },
];
const BOX_IDS = new Set<string>(BOXES.map((b) => b.id));

/**
 * Mail (Apple Mail layout, apple/s-talk language): mailboxes, accounts and smart project folders on the left; the message list with tags and
 * priority in the middle; the conversation on the right with the assistant on top (summary, actions, replies in three tones, task / ticket /
 * reminder, link to a project, follow-up nudge). Accounts are connected in Settings › Integrations › Mail.
 */
export function MailPage() {
  const wid = useWorkspaceId();
  const uid = useAuth((s) => s.ctx?.user.id);
  const [params, setParams] = useSearchParams();
  const box = (params.get('box') ?? 'inbox') as string;
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState<MailSearch | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeInit | null>(null);
  const data = useMailData({ sent: true, q: query ? serverQuery(query) : '' });
  const [local, update] = useMailLocal();
  const agentOpts = useWsQuery(['mailbox', 'agent-options'], mailboxApi.agentOptions, { staleTime: 300_000 });
  const agent = !!agentOpts.data?.available;
  const projects = useWsQuery(['projects', 'health'], () => projectApi.list({ pageSize: 100 }), { staleTime: 60_000, retry: false });

  useEffect(() => {
    if (params.get('compose') !== '1') return;
    setCompose({ to: params.get('to') ?? undefined, subject: params.get('subject') ?? undefined });
    const n = new URLSearchParams(params); n.delete('compose'); n.delete('to'); n.delete('subject'); setParams(n, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Back from Google or Microsoft after connecting from here.
  useEffect(() => {
    const g = params.get('google'), m = params.get('microsoft');
    if (!g && !m) return;
    const outcome = g ?? m;
    toast(outcome === 'connected' ? `${g ? 'Gmail' : 'Outlook'} connected. Your mail is syncing.` : outcome === 'declined' ? 'The connection was cancelled.' : 'The mail account could not be connected. Try again.', outcome === 'connected' ? 'success' : 'info');
    void invalidateWorkspace(wid, 'account');
    const n = new URLSearchParams(params); n.delete('google'); n.delete('microsoft'); setParams(n, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const now = Date.now();
  const isSnoozed = (r: MailRow) => !!local.snoozed[r.key] && Date.parse(local.snoozed[r.key]) > now;
  const isArchived = (r: MailRow) => local.archived.includes(r.key);
  const live = data.rows.filter((r) => !isArchived(r) && !isSnoozed(r));
  const inbox = live.filter((r) => r.folder === 'inbox');
  // Waiting on others: my last word in a conversation, a day or more ago, with nothing back since.
  const waiting = useMemo(() => {
    const lastIn = new Map<string, number>();
    for (const r of data.rows) if (r.folder === 'inbox' && r.date) lastIn.set(`${r.account}|${r.threadId}`, Math.max(lastIn.get(`${r.account}|${r.threadId}`) ?? 0, Date.parse(r.date)));
    const seen = new Set<string>();
    return live.filter((r) => {
      if (r.folder !== 'sent' || !r.date) return false;
      const k = `${r.account}|${r.threadId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return (lastIn.get(k) ?? 0) < Date.parse(r.date) && daysSince(r.date, now) >= 1;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.rows, local]);
  const projectList = (projects.data?.items ?? []).filter((p) => p.status !== 'Archived' && p.status !== 'Cancelled');
  const inProject = (r: MailRow, p: { id: string; name: string; key: string }) => {
    if (local.projects[r.key] === p.id) return true;
    const hay = `${r.subject} ${r.snippet}`.toLowerCase();
    return (p.name.length >= 4 && hay.includes(p.name.toLowerCase())) || (p.key.length >= 3 && new RegExp(`\\b${p.key.toLowerCase()}\\b`).test(hay));
  };
  const smart = projectList.map((p) => ({ p, rows: live.filter((r) => inProject(r, p)) })).filter((x) => x.rows.length > 0).slice(0, 6);

  const accountKey = box.startsWith('account:') ? box.slice(8) : null;
  const projectId = box.startsWith('project:') ? box.slice(8) : null;
  const list: MailRow[] = query ? data.rows.filter((r) => !isArchived(r) && matchesSearch(r, query))
    : box === 'needs' ? inbox.filter((r) => r.tags.includes('needs-reply'))
    : box === 'waiting' ? waiting
    : box === 'snoozed' ? data.rows.filter(isSnoozed)
    : box === 'sent' ? live.filter((r) => r.folder === 'sent')
    : box === 'archive' ? data.rows.filter(isArchived)
    : accountKey ? inbox.filter((r) => r.account === accountKey)
    : projectId ? smart.find((x) => x.p.id === projectId)?.rows ?? []
    : inbox;
  const counts: Partial<Record<Box, number>> = {
    inbox: inbox.filter((r) => r.unread).length, needs: inbox.filter((r) => r.tags.includes('needs-reply')).length, waiting: waiting.length,
    snoozed: data.rows.filter(isSnoozed).length, drafts: local.drafts.length + local.scheduled.length,
  };
  const row = data.rows.find((r) => r.key === selected) ?? null;
  const account = row ? data.accounts.find((a) => a.key === row.account) ?? null : null;
  const sendable = data.accounts.filter((a) => a.canSend);
  const choose = (b: string) => { setSelected(null); setQuery(null); setSearch(''); const n = new URLSearchParams(params); if (b === 'inbox') n.delete('box'); else n.set('box', b); setParams(n, { replace: true }); };
  const refresh = () => { void invalidateWorkspace(wid, 'mailbox'); };
  const archive = (r: MailRow, on = true) => { update((m) => ({ ...m, archived: on ? [...m.archived.filter((k) => k !== r.key), r.key] : m.archived.filter((k) => k !== r.key) })); if (on && selected === r.key) setSelected(null); toast(on ? 'Archived.' : 'Moved back to the inbox.'); };
  const snooze = (r: MailRow, until: Date | null) => {
    update((m) => { const s = { ...m.snoozed }; if (until) s[r.key] = until.toISOString(); else delete s[r.key]; return { ...m, snoozed: s }; });
    if (until && selected === r.key) setSelected(null);
    toast(until ? `Snoozed until ${until.toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : 'Unsnoozed.');
  };
  const nudges = waiting.filter((r) => daysSince(r.date, now) >= 3).slice(0, 2);

  if (!data.loading && data.accounts.length === 0) {
    return (
      <div className="ml-hero" key={`${wid}-${uid}`} data-testid="mail-hero">
        <ToolbarSlot title={<span className="tb-big" aria-hidden="true">Mail</span>} />
        <span className="ml-hero-ico" aria-hidden="true"><Icon name="mail" size={28} /></span>
        <h1>Your mail, with an assistant built in.</h1>
        <p>Summaries of every thread, replies in your tone, and mail that turns into tasks, tickets and reminders. Read live from your provider, never shared with the workspace.</p>
        <Link className="btn btn-primary" to="/settings/integrations/mail" data-testid="mail-connect">Connect mail in Settings › Integrations</Link>
        <small>Gmail, Outlook, Rediffmail and your company mail server.</small>
      </div>
    );
  }

  return (
    <div className={`ml-shell${row ? ' is-open' : ''}`} key={`${wid}-${uid}`} data-testid="mail">
      <h1 className="sr-only">Mail</h1>
      <ToolbarSlot title={<span className="tb-big" aria-hidden="true">Mail</span>} />

      <aside className="ml-side" aria-label="Mail folders and accounts">
        <button type="button" className="btn btn-primary ml-new" onClick={() => setCompose({})} disabled={sendable.length === 0} data-testid="ml-new"><Icon name="edit" size={15} /> New message</button>
        <nav className="ml-boxes" aria-label="Mailboxes">
          {BOXES.map((b) => (
            <button key={b.id} type="button" className={`ml-box${box === b.id && !query ? ' on' : ''}`} aria-current={box === b.id && !query ? 'page' : undefined} onClick={() => choose(b.id)}>
              <Icon name={b.icon} size={15} /><span>{b.label}</span>{!!counts[b.id] && <em>{counts[b.id]}</em>}
            </button>
          ))}
        </nav>
        <p className="ml-side-h">Accounts</p>
        <nav className="ml-boxes" aria-label="Accounts">
          {data.accounts.map((a) => (
            <button key={a.key} type="button" className={`ml-box${box === `account:${a.key}` ? ' on' : ''}`} onClick={() => choose(`account:${a.key}`)} title={a.email}>
              <span className="ml-acct" style={{ background: KIND_COLOR[a.kind] }} aria-hidden="true">{a.label[0]}</span><span>{a.label}</span>
              {!a.canRead && <Icon name="lock" size={12} />}
            </button>
          ))}
          <Link className="ml-box ml-manage" to="/settings/integrations/mail"><Icon name="settings" size={15} /><span>Manage accounts</span></Link>
        </nav>
        {smart.length > 0 && <>
          <p className="ml-side-h">Smart folders</p>
          <nav className="ml-boxes" aria-label="Smart folders by project">
            {smart.map(({ p, rows }) => (
              <button key={p.id} type="button" className={`ml-box${box === `project:${p.id}` ? ' on' : ''}`} onClick={() => choose(`project:${p.id}`)}>
                <Icon name="folder" size={15} /><span>{p.name}</span><em>{rows.length}</em>
              </button>
            ))}
          </nav>
        </>}
      </aside>

      <section className="ml-list" aria-label="Messages">
        <form className="ml-search" role="search" onSubmit={(e) => { e.preventDefault(); setSelected(null); setQuery(search.trim() ? parseSearch(search) : null); }}>
          <Icon name="search" size={14} />
          <input value={search} onChange={(e) => { setSearch(e.target.value); if (!e.target.value) setQuery(null); }} placeholder="Search — “from SBI about bulk payments last week”" aria-label="Search mail" />
          <button type="button" className="ml-icon" onClick={refresh} title="Sync now" aria-label="Sync now"><Icon name="refresh" size={14} /></button>
          <button type="button" className="ml-icon ml-compose-sm" onClick={() => setCompose({})} disabled={sendable.length === 0} title="New message" aria-label="New message"><Icon name="edit" size={14} /></button>
        </form>
        {query && (
          <div className="ml-understood" data-testid="ml-understood"><span>Showing</span>{describeSearch(query).map((t) => <span key={t} className="ml-pill">{t}</span>)}
            <button type="button" className="link-btn" onClick={() => { setQuery(null); setSearch(''); }}>Clear</button></div>
        )}
        <div className="ml-boxchips" role="group" aria-label="Mailbox">
          {BOXES.map((b) => <button key={b.id} type="button" className={`ds-chip${box === b.id && !query ? ' on' : ''}`} aria-pressed={box === b.id && !query} onClick={() => choose(b.id)}>{b.label}{counts[b.id] ? ` ${counts[b.id]}` : ''}</button>)}
          <Link className="ds-chip" to="/settings/integrations/mail">Accounts</Link>
        </div>
        <header className="ml-list-h">
          <b>{query ? 'Search' : BOX_IDS.has(box) ? BOXES.find((b) => b.id === box)!.label : accountKey ? data.accounts.find((a) => a.key === accountKey)?.label ?? 'Account' : smart.find((x) => x.p.id === projectId)?.p.name ?? 'Inbox'}</b>
          <small>{box === 'drafts' && !query ? `${local.drafts.length + local.scheduled.length}` : `${list.length} message${list.length === 1 ? '' : 's'}`}</small>
        </header>
        {data.errors.map(({ account: a, error }) => <div key={a.key} className="ml-banner" role="alert"><Icon name="alert" size={13} /> {a.label}: {errText(error, 'Could not sync this mailbox.')}</div>)}
        {!query && box === 'inbox' && nudges.map((r) => (
          <div key={r.key} className="ml-nudge" data-testid="ml-nudge"><span className="ml-orb" aria-hidden="true" />
            <span>No reply from <b>{displayName(r.to).split(',')[0]}</b> in {daysSince(r.date, now)} days — remind?</span>
            <button type="button" className="btn btn-sm" onClick={() => setSelected(r.key)}>Open</button></div>
        ))}
        <div className="ml-rows">
          {box === 'drafts' && !query ? <DraftList local={local} onOpen={(d) => setCompose({ ...d, draftId: d.id })} onCancel={(id) => update((m) => ({ ...m, scheduled: m.scheduled.filter((s) => s.id !== id) }))} />
            : data.loading && list.length === 0 ? <div className="ml-center"><Spinner /></div>
            : list.length === 0 ? <div className="ml-empty"><Icon name="checkCircle" size={22} /><p>{query ? 'No mail matches.' : box === 'needs' ? 'Nothing is waiting for your reply.' : box === 'waiting' ? 'Nobody owes you a reply.' : 'Nothing here.'}</p></div>
            : list.map((r, i) => (
              <button key={r.key} type="button" className={`ml-row${r.unread ? ' unread' : ''}${selected === r.key ? ' on' : ''}`} style={{ ['--i' as string]: Math.min(i, 14) }}
                onClick={() => setSelected(r.key)} aria-current={selected === r.key ? 'true' : undefined} data-testid="ml-row">
                {r.unread && <span className="ml-dot" aria-label="Unread" />}
                <span className="ml-row-top">
                  <b>{r.folder === 'sent' ? `To: ${displayName(r.to)}` : displayName(r.from) || '(unknown)'}</b>
                  {r.priority === 'high' && <span className="ml-prio" title="High priority" aria-label="High priority">!</span>}
                  {r.hasAttachments && <Icon name="paperclip" size={12} />}
                  <time>{shortDate(r.date)}</time>
                </span>
                <span className="ml-row-subject">{r.subject || '(no subject)'}</span>
                {r.snippet && <span className="ml-row-prev">{r.snippet}</span>}
                <span className="ml-row-tags">
                  {r.tags.filter((t) => t !== 'fyi' || r.tags.length === 1).slice(0, 3).map((t) => <span key={t} className={`ml-tag t-${t}`}>{TAG_LABEL[t]}</span>)}
                  {data.accounts.length > 1 && <span className="ml-tag t-acct" style={{ color: KIND_COLOR[r.kind] }}>{r.accountLabel}</span>}
                </span>
              </button>
            ))}
        </div>
      </section>

      <section className="ml-reader" aria-label="Reading pane">
        {row && account ? (
          <MailReader key={row.key} row={row} account={account} agent={agent} projects={projectList}
            linkedProject={local.projects[row.key] ?? null} archived={isArchived(row)} snoozed={isSnoozed(row)}
            onLink={(pid) => update((m) => { const p = { ...m.projects }; if (pid) p[row.key] = pid; else delete p[row.key]; return { ...m, projects: p }; })}
            onArchive={(on) => archive(row, on)} onSnooze={(d) => snooze(row, d)} onBack={() => setSelected(null)} onSent={refresh}
            onCompose={(c) => setCompose({ ...c, account: row.account })} />
        ) : (
          <div className="ml-reader-empty"><Icon name="mail" size={34} /><p>Select a message to read it.</p>
            {agent && <small><span className="ml-orb" aria-hidden="true" /> The assistant summarises each conversation, finds the action items and drafts replies.</small>}</div>
        )}
      </section>

      {compose && <Composer accounts={sendable} init={compose} agent={agent} update={update} onClose={() => setCompose(null)} onSent={refresh} />}
    </div>
  );
}

function DraftList({ local, onOpen, onCancel }: { local: ReturnType<typeof useMailLocal>[0]; onOpen: (d: ReturnType<typeof useMailLocal>[0]['drafts'][number]) => void; onCancel: (id: string) => void }) {
  if (local.drafts.length === 0 && local.scheduled.length === 0) return <div className="ml-empty"><Icon name="edit" size={22} /><p>No drafts. Closing a message you started keeps it here.</p></div>;
  return <>
    {local.scheduled.map((s) => (
      <div key={s.id} className="ml-row ml-draft">
        <span className="ml-row-top"><b>To: {s.to || '(nobody yet)'}</b><time><Icon name="clock" size={11} /> {new Date(s.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</time></span>
        <span className="ml-row-subject">{s.subject || '(no subject)'}</span>
        <span className="ml-row-tags"><span className="ml-tag t-sched">Scheduled</span><button type="button" className="link-btn" onClick={() => onCancel(s.id)}>Cancel</button></span>
      </div>
    ))}
    {local.drafts.map((d) => (
      <button key={d.id} type="button" className="ml-row ml-draft" onClick={() => onOpen(d)}>
        <span className="ml-row-top"><b>To: {d.to || '(nobody yet)'}</b><time>{shortDate(d.savedAt)}</time></span>
        <span className="ml-row-subject">{d.subject || '(no subject)'}</span>
        <span className="ml-row-prev">{d.body.slice(0, 160)}</span>
      </button>
    ))}
  </>;
}

const later = (h: number, addDays = 0) => { const d = new Date(); d.setDate(d.getDate() + addDays); d.setHours(h, 0, 0, 0); return d; };
const SNOOZE: { label: string; at: () => Date }[] = [
  { label: 'Later today', at: () => { const d = new Date(Date.now() + 3 * 3_600_000); d.setMinutes(0, 0, 0); return d; } },
  { label: 'Tomorrow morning', at: () => later(9, 1) },
  { label: 'Next week', at: () => { const d = later(9); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d; } },
];
const TONES = ['Concise', 'Warm', 'Formal'];

/** The conversation, with the assistant panel on top. */
function MailReader({ row, account, agent, projects, linkedProject, archived, snoozed, onLink, onArchive, onSnooze, onBack, onSent, onCompose }: {
  row: MailRow; account: Account; agent: boolean; projects: { id: string; name: string }[]; linkedProject: string | null; archived: boolean; snoozed: boolean;
  onLink: (projectId: string | null) => void; onArchive: (on: boolean) => void; onSnooze: (d: Date | null) => void; onBack: () => void; onSent: () => void; onCompose: (c: ComposeInit) => void;
}) {
  const wid = useWorkspaceId();
  const t = useWsQuery(['mailbox', 'thread', account.key, row.folder, row.id], () => mailboxApi.thread(account.key, row.folder, row.id), { staleTime: 300_000, retry: 1 });
  const assist = useWsQuery(['mailbox', 'assist', account.key, row.folder, row.id], () => mailboxApi.assist({ account: account.key, folder: row.folder, messageId: row.id }),
    { enabled: agent && account.canRead, staleTime: Infinity, retry: false });
  const [reply, setReply] = useState<null | { all: boolean; body: string }>(null);
  const [forwarding, setForwarding] = useState<MailMessage | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const thread = t.data;
  const last = thread?.messages[thread.messages.length - 1];
  useEffect(() => { if (last) setOpen(new Set([last.id])); }, [thread?.threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  const subject = last?.subject || row.subject || '(no subject)';
  const lastFromMe = !!last && addressOf(last.from).toLowerCase() === account.email.toLowerCase();
  const quiet = last ? daysSince(last.date) : 0;
  const other = last ? displayName(lastFromMe ? last.to : last.from).split(',')[0] : '';
  const a = assist.data;
  const workText = `${subject}${a?.summary ? ` — ${a.summary}` : ''}`;

  return (
    <div className="ml-read" data-testid="ml-reader">
      <header className="ml-read-h">
        <button type="button" className="ml-icon ml-back" onClick={onBack} aria-label="Back to messages"><Icon name="arrowLeft" size={17} /></button>
        <h2>{subject}</h2>
        <div className="ml-read-tools">
          <button type="button" className="ml-icon" disabled={!account.canSend || !last} onClick={() => setReply({ all: false, body: '' })} title="Reply" aria-label="Reply"><Icon name="undo" size={15} /></button>
          <button type="button" className="ml-icon" disabled={!account.canSend || !last} onClick={() => setReply({ all: true, body: '' })} title="Reply all" aria-label="Reply all"><Icon name="users" size={15} /></button>
          <button type="button" className="ml-icon" disabled={!account.canSend || !last} onClick={() => last && setForwarding(last)} title="Forward" aria-label="Forward"><Icon name="arrowRight" size={15} /></button>
          <button type="button" className="ml-icon" onClick={() => onArchive(!archived)} title={archived ? 'Move to inbox' : 'Archive'} aria-label={archived ? 'Move to inbox' : 'Archive'}><Icon name={archived ? 'inbox' : 'download'} size={15} /></button>
          <span className="ml-pop-wrap">
            <button type="button" className="ml-icon" onClick={() => (snoozed ? onSnooze(null) : setSnoozeOpen((v) => !v))} title={snoozed ? 'Unsnooze' : 'Snooze'} aria-label={snoozed ? 'Unsnooze' : 'Snooze'} aria-expanded={snoozeOpen}><Icon name="alarm" size={15} /></button>
            {snoozeOpen && <span className="ml-pop" role="menu">{SNOOZE.map((s) => <button key={s.label} type="button" role="menuitem" onClick={() => { setSnoozeOpen(false); onSnooze(s.at()); }}>{s.label}</button>)}</span>}
          </span>
        </div>
      </header>
      <div className="ml-read-body">
        <section className="ml-ai" aria-label="Assistant" data-testid="ml-ai">
          {agent && (assist.isLoading ? <p className="ml-ai-line"><span className="ml-orb spin" aria-hidden="true" /> Reading the conversation…</p>
            : assist.isError ? <p className="ml-ai-line muted"><span className="ml-orb" aria-hidden="true" /> {errText(assist.error, 'No summary right now.')} <button type="button" className="link-btn" onClick={() => void assist.refetch()}>Try again</button></p>
            : a && <>
              <p className="ml-ai-line" data-testid="ml-summary"><span className="ml-orb" aria-hidden="true" /><span>{a.summary}</span>
                {a.urgency === 'high' && <span className="ml-tag t-escalation">Urgent</span>}</p>
              {a.actionItems.length > 0 && <ul className="ml-ai-actions" aria-label="Action items">{a.actionItems.slice(0, 4).map((x, i) => <li key={i} className="ml-fade" style={{ ['--i' as string]: i }}>{x}</li>)}</ul>}
              {a.replies.length > 0 && account.canSend && (
                <div className="ml-ai-replies" role="group" aria-label="Suggested replies">
                  {a.replies.slice(0, 3).map((r, i) => <button key={i} type="button" className="ml-chip ml-fade" style={{ ['--i' as string]: i }} title={r.body} onClick={() => setReply({ all: false, body: r.body })}>
                    <small>{TONES[i] ?? 'Reply'}</small>{r.label}</button>)}
                </div>
              )}
            </>)}
          <div className="ml-ai-do">
            <button type="button" className="btn btn-sm" onClick={() => openNew('task', workText)}><Icon name="checkCircle" size={13} /> Create task</button>
            <button type="button" className="btn btn-sm" onClick={() => openNew('ticket', workText)}><Icon name="target" size={13} /> Ticket</button>
            <button type="button" className="btn btn-sm" onClick={() => openReminderComposer({ text: `Follow up: ${subject}` })}><Icon name="bell" size={13} /> Reminder</button>
            <Select className="select ml-link" aria-label="Link to project" value={linkedProject ?? ''} onChange={(e) => { onLink(e.target.value || null); if (e.target.value) toast('Linked. It shows in the project’s smart folder.'); }}>
              <option value="">Link to project…</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
          {a && a.tasks.length > 0 && <div className="ml-ai-tasks">{a.tasks.slice(0, 3).map((s, i) => <TaskSuggestion key={i} s={s} wid={wid} />)}</div>}
          {lastFromMe && quiet >= 3 && (
            <div className="ml-nudge in" data-testid="ml-followup"><span className="ml-orb" aria-hidden="true" />
              <span>No reply from <b>{other}</b> in {quiet} days — remind?</span>
              <button type="button" className="btn btn-sm" onClick={() => openReminderComposer({ text: `Chase ${other}: ${subject}` })}>Remind me</button>
              {account.canSend && <button type="button" className="btn btn-sm btn-primary" onClick={() => setReply({ all: false, body: `Hi ${other.split(' ')[0]},\n\nJust following up on the mail below. Could you share an update when you get a moment?\n\nThanks,` })}>Nudge now</button>}
            </div>
          )}
        </section>

        {t.isLoading ? <div className="ml-center"><Spinner /></div>
          : t.isError || !thread ? <div className="ml-reader-empty"><Icon name="alert" size={26} /><p>{errText(t.error, 'This message could not be opened.')}</p><button type="button" className="btn" onClick={() => void t.refetch()}>Try again</button></div>
          : <>
            {thread.truncated && <p className="mb-note"><Icon name="info" size={13} /> Older messages in this conversation are not shown.</p>}
            {thread.messages.map((m) => {
              const expanded = open.has(m.id);
              return (
                <article key={m.id} className={`ml-msg${expanded ? ' open' : ''}`}>
                  <button type="button" className="ml-msg-h" aria-expanded={expanded} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}>
                    <span className="ml-av" aria-hidden="true">{initials(displayName(m.from))}</span>
                    <span className="ml-msg-from"><b>{displayName(m.from)}</b>
                      <small>{expanded ? `To: ${m.to}${m.cc ? ` · Cc: ${m.cc}` : ''}` : (m.body ?? '').slice(0, 120)}</small></span>
                    <time>{m.date ? formatDateTime(m.date) : ''}</time>
                  </button>
                  {expanded && <div className="ml-msg-body">{m.body}
                    {m.bodyTruncated && <p className="mb-note">This message is longer than shown here. Open it in your mail app to see all of it.</p>}
                    {m.hasAttachments && <p className="mb-note"><Icon name="paperclip" size={13} /> Has attachments. Forward it to send them on, or open it in your mail app to download.</p>}</div>}
                </article>
              );
            })}
            {reply && last && <ReplyBox account={account} folder={row.folder} message={last} all={reply.all} initial={reply.body} agent={agent} onCancel={() => setReply(null)} onSent={() => { setReply(null); onSent(); }} />}
            {!reply && account.canSend && last && (
              <div className="mb-quick">
                <button type="button" onClick={() => setReply({ all: false, body: '' })}><Icon name="undo" size={14} /> Reply</button>
                <button type="button" onClick={() => setReply({ all: true, body: '' })}><Icon name="users" size={14} /> Reply all</button>
                <button type="button" onClick={() => setForwarding(last)}><Icon name="arrowRight" size={14} /> Forward</button>
                <button type="button" onClick={() => onCompose({ to: addressOf(last.from), subject: `Re: ${subject.replace(/^re:\s*/i, '')}` })}><Icon name="edit" size={14} /> New to sender</button>
              </div>
            )}
          </>}
      </div>
      {forwarding && <ForwardModal account={account} folder={row.folder} message={forwarding} onClose={() => setForwarding(null)} onSent={onSent} />}
    </div>
  );
}
