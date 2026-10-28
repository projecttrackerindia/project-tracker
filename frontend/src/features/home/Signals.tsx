import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { chatApi, insightApi } from '../../api/endpoints';
import type { SignalCard, SignalGroup, TodaySignals } from '../../api/types';
import { Face } from '../../components/Face';
import { Term } from '../../components/Term';
import { useCachedWsQuery } from '../../lib/hooks';
import { toast } from '../../stores/ui';
import './signals.css';

/** Today's team & portfolio signals (GET /today/signals), shared by the desk Today and the phone's. */
export function useTodaySignals() {
  return useCachedWsQuery<TodaySignals>(['today', 'signals'], insightApi.todaySignals, { staleTime: 60_000, retry: false });
}

const GLYPH: Record<SignalGroup['kind'], string> = { risk: '▲', team: '◷', docs: '✎', sla: '!' };

/** "4 projects at risk · 2 team items overdue": the line Needs you shows when nothing is personal but signals exist. */
export function signalsLine(s?: TodaySignals | null): string | null {
  if (!s?.groups?.length || !s.total) return null;
  return s.groups.map((g) => `${g.count} ${g.label}`).join(' · ');
}

/** The one action of a card. "Ask" opens a chat with the person and copies a suggested message to paste. */
function useAct() {
  const nav = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (c: SignalCard) => {
    const a = c.action;
    if (a.verb === 'ask' && a.userId) {
      setBusy(c.id);
      try {
        const conv = await chatApi.openDirect(a.userId);
        let copied = false;
        if (a.message) { try { await navigator.clipboard.writeText(a.message); copied = true; } catch { /* clipboard blocked: the chat still opens */ } }
        nav(`/messages/${conv.id}`);
        toast(copied ? 'Chat opened. A suggested message is copied: paste it to send.' : 'Chat opened.');
      } catch { toast('Could not open the chat.', 'error'); }
      finally { setBusy(null); }
      return;
    }
    if (a.href) nav(a.href);
  };
  return { act, busy };
}

/**
 * "Team & portfolio signals": projects at risk (with the reason), the team's overdue work, docs out of date and Desk SLA breaches. Each card has
 * its owner and ONE next action; the group's count opens the filtered list. Nothing here is the person's own action (that is Needs you).
 */
export function SignalsSection({ compact = false }: { compact?: boolean }) {
  const q = useTodaySignals();
  const { act, busy } = useAct();
  const data = q.data;
  // An older server (or a reply without groups) shows nothing rather than breaking Today.
  if (q.isLoading || q.isError || !data?.groups?.length || !data.total) return null;
  return (
    <section className={`hm-card sg ${compact ? 'sg-compact' : ''}`} aria-label="Team and portfolio signals" data-testid="signals">
      <div className="sg-head">
        <h2 className="hm-h3">Team &amp; portfolio signals</h2>
        <span className="hm-faint">Not yours to do — yours to watch</span>
      </div>
      <div className="sg-groups">
        {data.groups.map((g) => (
          <div key={g.kind} className={`sg-group k-${g.kind}`}>
            <Link to={g.href} className="sg-count" data-testid={`signal-count-${g.kind}`}>
              <b>{g.count}</b> {g.kind === 'risk' ? <Term k="at risk" focusable={false}>{g.label}</Term> : g.kind === 'team' ? <Term k="overdue" focusable={false}>{g.label}</Term> : g.label} ›
            </Link>
            <ul className="sg-cards">
              {g.items.map((c) => (
                <li key={c.id} className={`sg-card t-${c.tone}`} data-testid="signal-card">
                  <span className={`sg-glyph k-${g.kind}`} aria-hidden="true">{GLYPH[g.kind]}</span>
                  <div className="sg-main">
                    {c.href ? <Link to={c.href} className="sg-title" title={c.title}>{c.title}</Link> : <span className="sg-title" title={c.title}>{c.title}</span>}
                    <span className="sg-reason" title={c.reason}>{c.reason}</span>
                    {c.owner && <span className="sg-owner"><Face userId={c.owner.id} name={c.owner.name} className="sg-av" />{c.owner.name}</span>}
                  </div>
                  <button type="button" className={`hm-pill sg-act ${c.action.verb === 'assign' ? 'blue' : ''}`} disabled={busy === c.id} onClick={() => void act(c)}>
                    {c.action.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
