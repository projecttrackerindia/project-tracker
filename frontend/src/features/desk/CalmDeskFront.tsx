import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { WorkItemDetail, WorkRow } from '../../api/workItemsApi';
import { AuraLine, CalmCard, CalmGo, CalmHero, CalmLink, CalmRow } from '../../components/calm';
import { Face } from '../../components/Face';
import { firstLine, leftLabel } from './deskPageLogic';
import './calm-desk.css';

const CH: Record<string, string> = { whatsapp: 'WhatsApp', email: 'Email', phone: 'Phone', webhook: 'Webhook', ai: 'AI employee', app: 'App', chat: 'Chat' };
const P: Record<string, string> = { Critical: 'P1', High: 'P2', Medium: 'P3', Low: 'P4' };
const dueText = (r: WorkRow, now: number) => {
  if (!r.slaDueAt) return '—';
  const ms = Date.parse(r.slaDueAt) - now;
  if (ms <= 0) return 'Breached';
  if (ms < 86400e3) { const m = Math.floor(ms / 60e3); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; }
  return new Date(r.slaDueAt).toLocaleDateString(undefined, { weekday: 'short' });
};

/**
 * The calm Desk front (shot 06): one sentence about who needs you, the first ticket as a hero card (Open & reply · Assign · Snooze),
 * the next ones as a "Then" strip, the SLA clock for today, and on the right the queue by SLA, channels today and who is on the desk.
 * The full workspace (queue, conversation, context) sits below, where "Open & reply" takes you.
 */
export function CalmDeskFront({ rows, detailOf, now, meId, onOpen, onAssign, onSnooze, busy }: {
  rows: WorkRow[]; detailOf: (id: string) => WorkItemDetail | undefined; now: number; meId: string | null;
  onOpen: (id: string) => void; onAssign: (r: WorkRow) => void; onSnooze: (r: WorkRow) => void; busy: boolean;
}) {
  const sorted = useMemo(() => [...rows].sort((a, b) => (a.slaDueAt ? Date.parse(a.slaDueAt) : Infinity) - (b.slaDueAt ? Date.parse(b.slaDueAt) : Infinity)), [rows]);
  const mine = sorted.filter((r) => !r.assignee || r.assignee.id === meId);
  const first = mine[0] ?? sorted[0] ?? null;
  const then = sorted.filter((r) => r.id !== first?.id).slice(0, 2);
  const d = first ? detailOf(first.id) : undefined;
  const who = (r: WorkRow) => detailOf(r.id)?.reporter?.name ?? r.projectName ?? r.key;
  const channels = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of sorted) { const ch = detailOf(r.id)?.channel ?? 'app'; c.set(ch, (c.get(ch) ?? 0) + 1); }
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [sorted, detailOf]);
  const maxCh = Math.max(1, ...channels.map(([, n]) => n));
  const agents = useMemo(() => {
    const m = new Map<string, { id: string; name: string; n: number }>();
    for (const r of sorted) if (r.assignee) { const a = m.get(r.assignee.id) ?? { id: r.assignee.id, name: r.assignee.name, n: 0 }; a.n++; m.set(a.id, a); }
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 4);
  }, [sorted]);
  // the SLA clock: 9:00 to 18:00 today, one band per ticket due today
  const day0 = new Date(now); day0.setHours(9, 0, 0, 0);
  const span = 9 * 3600e3;
  const pos = (t: number) => Math.min(100, Math.max(0, ((t - day0.getTime()) / span) * 100));
  const today = sorted.filter((r) => r.slaDueAt && Date.parse(r.slaDueAt) > day0.getTime() && Date.parse(r.slaDueAt) < day0.getTime() + span).slice(0, 4);
  const breached = sorted.filter((r) => r.slaDueAt && Date.parse(r.slaDueAt) <= now).length;
  const n = mine.length;

  if (!first) return (
    <section className="cd-front" aria-label="Desk summary">
      <div className="cd-left"><CalmHero title="The queue is clear." second="Nothing needs you right now." /></div>
    </section>
  );
  return (
    <section className="cd-front" aria-label="Desk summary" data-testid="desk-front">
      <div className="cd-left">
        <CalmHero title={`${n || sorted.length} ${(n || sorted.length) === 1 ? 'ticket needs' : 'tickets need'} you.`}
          second={first.slaDueAt ? `${who(first).split(' ')[0]} first. ${Date.parse(first.slaDueAt) > now ? `${leftLabel(first.slaDueAt, now)} left.` : 'SLA breached.'}` : `${who(first).split(' ')[0]} first.`} />
        <CalmCard variant="hero" className="cd-hero" aria-label="Up next">
          <div className="cd-eyebrow"><i className={first.slaDueAt && Date.parse(first.slaDueAt) - now < 3600e3 ? 'hot' : ''} />{[CH[d?.channel ?? 'app'] ?? d?.channel, who(first), first.slaDueAt ? `SLA ${dueText(first, now)}` : null].filter(Boolean).join(' · ')}</div>
          <h2>{first.title}</h2>
          {firstLine(d?.description, 220) && <p>{firstLine(d?.description, 220)}</p>}
          <div className="calm-hero-acts">
            <CalmGo onClick={() => onOpen(first.id)}>Open &amp; reply</CalmGo>
            {meId && first.assignee?.id !== meId && <CalmLink onClick={() => !busy && onAssign(first)}>Assign to me</CalmLink>}
            <CalmLink onClick={() => !busy && onSnooze(first)}>Snooze</CalmLink>
          </div>
        </CalmCard>
        {then.length > 0 && (
          <div className="cd-then">
            <span>Then</span>
            {then.map((r) => <button key={r.id} type="button" onClick={() => onOpen(r.id)}>{r.title}<small>{dueText(r, now)}</small></button>)}
            <button type="button" className="cd-more" onClick={() => onOpen(first.id)}>Queue · {sorted.length} ›</button>
          </div>
        )}
        {today.length > 0 && (
          <div className="cd-clock" aria-label="SLA clock today">
            <div className="cd-clock-h"><span>SLA clock today</span></div>
            <div className="cd-track">
              {today.map((r, i) => {
                const end = pos(Date.parse(r.slaDueAt!)), start = i === 0 ? pos(r.slaStartAt ? Date.parse(r.slaStartAt) : day0.getTime()) : pos(Date.parse(today[i - 1].slaDueAt!));
                return <i key={r.id} className={`t${i % 3}`} style={{ left: `${start}%`, width: `${Math.max(4, end - start)}%` }} title={r.title}>{i === 0 ? `${who(r).split(' ')[0]} · breaches ${new Date(r.slaDueAt!).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : who(r).split(' ')[0]}</i>;
              })}
              <b className="cd-now" style={{ left: `${pos(now)}%` }} aria-hidden="true" />
            </div>
            <div className="cd-hours" aria-hidden="true">{Array.from({ length: 10 }, (_, i) => <span key={i}>{9 + i}:00</span>)}</div>
          </div>
        )}
        <div className="cd-stats">
          <span>{breached} breached now</span><span>{sorted.length} open</span><span>{agents.length} on the desk</span>
        </div>
        {d?.channel === 'whatsapp' && <AuraLine text="Aura has a summary and a drafted reply on this ticket." action="Open it" onAction={() => onOpen(first.id)} />}
      </div>

      <aside className="cd-side">
        <CalmCard variant="list" title="Queue by SLA" aside={<button type="button" className="calm-link" onClick={() => onOpen(first.id)}>Queue ›</button>}>
          {sorted.slice(0, 4).map((r) => {
            const dd = detailOf(r.id);
            return <CalmRow key={r.id} onClick={() => onOpen(r.id)} chevron={false} lead={<Face name={who(r)} byName className="cd-face" />}
              title={<>{who(r)} · {r.title}<small>{[CH[dd?.channel ?? 'app'], P[r.priority]].filter(Boolean).join(' · ')}</small></>}
              right={dueText(r, now)} hot={!!r.slaDueAt && Date.parse(r.slaDueAt) - now < 3600e3} />;
          })}
        </CalmCard>
        <CalmCard title="Channels today">
          <div className="cd-ch">
            {channels.map(([ch, c]) => <div key={ch}><span>{CH[ch] ?? ch}</span><span className="calm-bar thin"><i style={{ width: `${(c / maxCh) * 100}%` }} /></span><b>{c}</b></div>)}
          </div>
        </CalmCard>
        {agents.length > 0 && (
          <CalmCard variant="list" title="On desk now">
            {agents.map((a) => <CalmRow key={a.id} lead={<Face userId={a.id} name={a.name} className="cd-face" />} title={<>{a.name}<small>{a.id === meId ? 'You · ' : ''}{a.n} open</small></>} />)}
          </CalmCard>
        )}
        <Link className="calm-link cd-int" to="/desk/integrations">Integrations ›</Link>
      </aside>
    </section>
  );
}
