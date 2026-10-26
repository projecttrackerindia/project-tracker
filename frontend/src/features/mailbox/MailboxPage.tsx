import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/ui';
import { initials } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { displayName, mailboxApi } from './mailboxApi';
import type { MailFolder, MailMessage } from './mailboxApi';
import './mailbox.css';
import { MAILBOX_RETURN_KEY, KIND_COLOR, errText, shortDate, useMailAccounts, reconnect, CompanyConnect, ComposeModal, ConnectModal, Reader } from './MailParts';
import type { Row } from './MailParts';
export { MAILBOX_RETURN_KEY };

export function MailboxPage() {
  const wid = useWorkspaceId();
  const uid = useAuth(s => s.ctx?.user.id);
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { google, ms, imap, accounts, loading: loadingAccounts } = useMailAccounts();
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

  const readable = accounts.filter(a => a.canRead);
  const shown = scope === 'all' ? readable : readable.filter(a => a.key === scope);

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

/* ---------------- reading pane ---------------- */
