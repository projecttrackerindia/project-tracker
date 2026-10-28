import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { chatApi, statusApi } from '../../api/endpoints';
import type { WeeklyItem, WeeklySent } from '../../api/endpoints';
import { ErrorState, PageLoader } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { toast } from '../../stores/ui';
import { useAi } from '../ai/Assistant';
import { Initials } from './projectParts';
import { useMailData, useMailLocal } from '../mail/useMail';
import type { MailRow } from '../mail/useMail';
import './weeklyReport.css';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso?: string | null) => { if (!iso) return ''; const [, m, d] = iso.slice(0, 10).split('-').map(Number); return `${d} ${MON[m - 1]}`; };
const range = (from: string, to: string) => from.slice(5, 7) === to.slice(5, 7) ? `${Number(from.slice(8, 10))} – ${day(to)}` : `${day(from)} – ${day(to)}`;
const ago = (iso?: string | null) => {
  if (!iso) return 'just now';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const isoWeek = (iso: string) => {
  const d = new Date(iso); const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const n = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - n);
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
};
const tone = (h?: string | null) => h === 'On track' ? 'ok' : h === 'At risk' ? 'warn' : h === 'Late' ? 'bad' : 'neutral';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

type Channel = 'mail' | 'chat' | 'pdf';
const CHAT = 'chat';

/** One report line: its words, who owns it, and a chip that opens what it came from (a task, a commit, the timeline). */
function Item({ it, owner }: { it: WeeklyItem; owner?: boolean }) {
  const chip = it.source && it.link
    ? it.external ? <a className="wrp-src" href={it.link} target="_blank" rel="noreferrer">{it.source}</a> : <Link className="wrp-src" to={it.link}>{it.source}</Link>
    : it.source ? <span className="wrp-src">{it.source}</span> : null;
  return <li>{it.text}{owner ? <b> Owner: {it.owner ?? 'unassigned'}.</b> : it.owner ? <span className="wrp-who"> · {it.owner}</span> : null}{chip}</li>;
}

function Section({ title, kind, items, empty, owner }: { title: string; kind: string; items: WeeklyItem[]; empty: string; owner?: boolean }) {
  return (
    <section className={`wrp-sec ${kind}`} aria-label={title}>
      <h4><i aria-hidden="true" />{title}</h4>
      {items.length === 0 ? <p className="wrp-none">{empty}</p> : <ul>{items.map((it, i) => <Item key={i} it={it} owner={owner} />)}</ul>}
    </section>
  );
}

/**
 * A project's weekly status report as a page (design s-report): what it was written from, the health and a one-line verdict, four
 * numbers, then What moved / What slipped and why / Risks / Next week with every line linking to its source. On the side: who gets it
 * and how (Mail, Messages, PDF), Approve & send, the Friday reminder, tone rewrites, and the last four reports sent.
 */
export function WeeklyReportPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const ai = useAi();
  const q = useWsQuery(['project', id, 'weekly'], () => statusApi.weekly(id), { staleTime: 0, retry: false });
  const d = q.data;
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<null | 'send' | 'shorten' | 'formal' | 'schedule'>(null);
  const [to, setTo] = useState<string[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (!d) return;
    setText(d.text);
    setTo((t) => t.length ? t : d.canSend ? [CHAT] : []);
    setChannels((c) => c.length ? c : d.canSend ? ['chat'] : ['mail']);
  }, [d]);

  const people = useMemo(() => new Map((d?.people ?? []).map((p) => [p.id, p.name])), [d]);
  const mail = useProjectMail(id, d?.from ?? null);
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (!d) return <PageLoader />;

  const toggle = (c: Channel) => setChannels((cs) => cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]);
  const recipients = to.filter((x) => x !== CHAT);
  const edited = text.trim() !== d.text.trim();
  const canGo = channels.length > 0 && text.trim().length > 0 && busy === null
    && (!channels.includes('chat') || (d.canSend && to.includes(CHAT)))
    && (!channels.includes('mail') || recipients.length > 0);
  const why = channels.length === 0 ? 'Choose Mail, Messages or PDF'
    : channels.includes('chat') && !d.canSend ? 'Open the project chat once to send reports there'
    : channels.includes('chat') && !to.includes(CHAT) ? 'Add the project chat to send it in Messages'
    : channels.includes('mail') && recipients.length === 0 ? 'Add a person to mail it to' : undefined;

  const send = async () => {
    const chat = channels.includes('chat'), mail = channels.includes('mail'), pdf = channels.includes('pdf');
    setBusy('send');
    try {
      if (chat || mail) {
        await statusApi.sendWeekly(id, text, { chat, mail, pdf, recipients: mail ? recipients : [] });
        toast(`Sent${chat ? ' to the project chat' : ''}${chat && mail ? ' and' : ''}${mail ? ` to ${plural(recipients.length, 'person')}`.replace('persons', 'people') : ''}.`, 'success');
        void q.refetch();
      }
      if (pdf) window.setTimeout(() => window.print(), 50);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not send it.', 'error'); } finally { setBusy(null); }
  };
  const rewrite = async (action: 'shorten' | 'formal') => {
    setBusy(action);
    try { const r = await chatApi.transform(text, action); setText(r.text); setEditing(true); toast(action === 'shorten' ? 'Shorter. Check it before sending.' : 'Rewritten for executives. Check it before sending.', 'info'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'The assistant could not rewrite it.', 'error'); } finally { setBusy(null); }
  };
  const schedule = async () => {
    setBusy('schedule');
    try {
      if (d.schedule) { await statusApi.unscheduleWeekly(id); toast('Friday reminder stopped.'); }
      else { await statusApi.scheduleWeekly(id, zone()); toast('Every Friday at 5 PM you get a reminder to approve this report.', 'success'); }
      void q.refetch();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not change the reminder.', 'error'); } finally { setBusy(null); }
  };

  const s = d.sources;
  const fd = d.forecastDays;
  const history: WeeklySent[] = [...(d.history ?? [])].reverse();
  const addable = [...(d.canSend && !to.includes(CHAT) ? [{ id: CHAT, name: 'Project chat' }] : []), ...(d.people ?? []).filter((p) => !to.includes(p.id))];
  const approve = (cls = '') => (
    <button type="button" className={`btn btn-primary wrp-approve ${cls}`} disabled={!canGo} title={why} onClick={() => void send()}>
      {busy === 'send' ? 'Sending…' : 'Approve & send'}
    </button>
  );

  return (
    <div className="wrp">
      <div className="wrp-top">
        <button type="button" className="wrp-back" onClick={() => nav(`/work/projects/${id}`)}>‹ {d.projectName}</button>
        <span className="wrp-sp" />
        {approve('wrp-approve-top')}
      </div>
      <header className="wrp-head">
        <div>
          <div className="wrp-eyebrow">Weekly status · {range(d.from, d.to)}</div>
          <h1 className="wrp-h1">Week {d.week ?? isoWeek(d.to)} report</h1>
        </div>
        <div className="wrp-sourceline"><span className="wrp-orb" aria-hidden="true" />
          Written from {s ? `${plural(s.updates, 'update')}, ${plural(s.meetings, 'meeting')}${mail.count ? `, ${plural(mail.count, 'mail')}` : ''} and ${plural(s.commits, 'commit')}` : 'the project'} · {ago(d.writtenAt)}
        </div>
      </header>

      <div className="wrp-wrap">
        <article className="wrp-doc" aria-label="Report">
          <div className="wrp-verdict">
            <span className={`wrp-pill ${tone(d.health)}`}>● {d.health}</span>
            <span className="wrp-line">{d.verdict || `${d.progress ?? 0}% done.`}</span>
          </div>
          <div className="wrp-kpi">
            <div><b>{d.moved}</b><span>Items done</span></div>
            <div><b className={d.slipped ? 'bad' : ''}>{d.slipped}</b><span>Slipped</span></div>
            <div><b className={(d.scopeChange ?? 0) > 15 ? 'warn' : ''}>{(d.scopeChange ?? 0) > 0 ? '+' : ''}{d.scopeChange ?? 0}%</b><span>Scope change · {d.progress ?? 0}% done</span></div>
            <div><b className={fd && fd > 0 ? 'warn' : 'ok'}>{fd == null ? '—' : fd > 0 ? `+${fd}d` : 'On plan'}</b><span>Forecast vs plan{d.forecastDate ? ` · ${day(d.forecastDate)}` : ''}</span></div>
          </div>
          {editing ? (
            <div className="wrp-edit">
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={18} maxLength={8000} aria-label="Report text" />
              <div className="wrp-edit-bar">
                <span>{edited ? 'Edited — this text is what gets sent.' : 'This text is what gets sent.'}</span>
                {edited && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setText(d.text)}>Undo changes</button>}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Done</button>
              </div>
            </div>
          ) : (
            <>
              {edited && <p className="wrp-note">You edited the wording. <button type="button" className="wrp-link" onClick={() => setEditing(true)}>See the text that will be sent</button></p>}
              <Section title="What moved" kind="moved" items={d.movedItems ?? []} empty="Nothing was finished this week." />
              <Section title="What slipped, and why" kind="slipped" items={d.slippedItems ?? []} empty="No dates moved." />
              <Section title="Risks" kind="risks" items={d.riskItems ?? []} empty="None that the plan shows." owner />
              <Section title="Next week" kind="next" items={d.nextItems ?? []} empty="Nothing is due." />
            </>
          )}
        </article>

        <aside className="wrp-side">
          <div className="wrp-card">
            <h3>Send to stakeholders</h3>
            <ul className="wrp-to">
              {to.map((r) => (
                <li key={r}>
                  {r === CHAT ? <span className="pa-av wrp-chatav" aria-hidden="true">#</span> : <Initials name={people.get(r)} userId={r} />}
                  <span className="wrp-to-name">{r === CHAT ? 'Project chat · Messages' : people.get(r) ?? 'Someone'}</span>
                  <button type="button" className="wrp-x" aria-label={`Remove ${r === CHAT ? 'project chat' : people.get(r)}`} onClick={() => setTo(to.filter((x) => x !== r))}>×</button>
                </li>
              ))}
              <li>
                {adding ? (
                  <select autoFocus className="wrp-add-select" aria-label="Add person or channel" value="" onBlur={() => setAdding(false)}
                    onChange={(e) => { const v = e.target.value; if (v) { setTo([...to, v]); if (v !== CHAT && !channels.includes('mail')) setChannels([...channels, 'mail']); } setAdding(false); }}>
                    <option value="">Choose…</option>
                    {addable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                ) : <button type="button" className="wrp-add" disabled={addable.length === 0} onClick={() => setAdding(true)}>＋ Add person or channel</button>}
              </li>
            </ul>
            <div className="wrp-seg" role="group" aria-label="Send by">
              {(['mail', 'chat', 'pdf'] as Channel[]).map((c) => (
                <button key={c} type="button" aria-pressed={channels.includes(c)} className={channels.includes(c) ? 'on' : ''} onClick={() => toggle(c)}>
                  {c === 'mail' ? 'Mail' : c === 'chat' ? 'Messages' : 'PDF'}
                </button>
              ))}
            </div>
            {approve('wrp-approve-side')}
            {why && <p className="wrp-why">{why}.</p>}
            <button type="button" className={`wrp-sched ${d.schedule ? 'on' : ''}`} aria-pressed={!!d.schedule} disabled={busy === 'schedule'} onClick={() => void schedule()}>
              <span className="wrp-dot" aria-hidden="true" />Every Friday 5 PM · you approve first{d.schedule ? ' · on' : ''}
            </button>
          </div>

          {mail.threads.length > 0 && (
            <div className="wrp-card" data-testid="report-mail">
              <h3>From mail</h3>
              <ul className="wrp-mail">
                {mail.threads.map((t) => (
                  <li key={t.key}><span className="wrp-mail-s">{t.subject || '(no subject)'}</span><Link className="wrp-src" to="/mail" title={`${t.count} message${t.count === 1 ? '' : 's'} this week, linked to this project in Mail`}>Mail · {t.who}</Link></li>
                ))}
              </ul>
              <p className="wrp-none">Threads linked to this project in Mail. Cite them in the text if they explain a line.</p>
            </div>
          )}

          <div className="wrp-card wrp-ai">
            <p><span className="wrp-orb" aria-hidden="true" />{ai ? 'Tone is neutral and every line comes from the project. Want it shorter, or framed for executives?' : 'Read it through, edit any line, then approve.'}</p>
            <div className="wrp-ai-row">
              {ai && <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void rewrite('shorten')}>{busy === 'shorten' ? 'Shortening…' : 'Shorter'}</button>}
              {ai && <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void rewrite('formal')}>{busy === 'formal' ? 'Rewriting…' : 'For execs'}</button>}
              <button type="button" className="btn btn-sm" onClick={() => setEditing(!editing)}>{editing ? 'Report view' : 'Edit'}</button>
            </div>
          </div>

          <div className="wrp-card">
            <h3>Last 4 weeks</h3>
            {history.length === 0 ? <p className="wrp-none">No report sent yet. Approve this one to start the history.</p> : (
              <div className="wrp-weeks">
                {history.map((h) => (
                  <span key={h.sentAt} className={`wrp-pill sm ${tone(h.health)}`} title={`Sent ${new Date(h.sentAt).toLocaleString()}${h.by ? ` by ${h.by}` : ''} · ${h.health ?? ''} · ${h.done} done, ${h.slipped} slipped · ${h.channels.join(', ')}`}>
                    W{isoWeek(h.sentAt)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}


/** "Ruth Varma <ruth@…>" → "Ruth". */
const firstName = (from: string) => (from.replace(/<.*>/, '').replace(/["']/g, '').trim() || from.split('@')[0]).split(/\s+/)[0];

/**
 * Mail as a source: threads the person linked to this project in Mail (kept with their mail settings in this browser), with the messages of
 * the report's week. Mail is only read when at least one thread is linked.
 */
function useProjectMail(projectId: string, from: string | null) {
  const [local] = useMailLocal();
  const keys = useMemo(() => Object.entries(local.projects ?? {}).filter(([, pid]) => pid === projectId).map(([k]) => k), [local.projects, projectId]);
  const data = useMailData({ sent: true, enabled: keys.length > 0 });
  return useMemo(() => {
    if (!keys.length) return { count: 0, threads: [] as { key: string; subject: string; who: string; count: number }[] };
    const linked = data.rows.filter((r) => keys.includes(r.key));
    const threadIds = new Set(linked.map((r) => `${r.account}|${r.threadId}`));
    const inWeek = (r: MailRow) => !from || !r.date || r.date.slice(0, 10) >= from;
    const rows = data.rows.filter((r) => threadIds.has(`${r.account}|${r.threadId}`) && inWeek(r));
    const groups = new Map<string, MailRow[]>();
    for (const r of rows) { const k = `${r.account}|${r.threadId}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
    const threads = [...groups.entries()].map(([key, rs]) => ({ key, subject: rs[0].subject.replace(/^(re|fwd?):\s*/i, ''), who: firstName(rs[rs.length - 1].from), count: rs.length })).slice(0, 6);
    return { count: rows.length, threads };
  }, [keys, data.rows, from]);
}
