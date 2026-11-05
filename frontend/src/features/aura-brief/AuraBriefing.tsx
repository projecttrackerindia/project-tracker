import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { ApiError } from '../../api/client';
import { SiriOrb } from '../../components/aura/SiriOrb';
import { CalmCard, CalmDot, CalmGo, CalmLink, CalmSheet } from '../../components/calm';
import { Select } from '../../components/Select';
import { projectColor } from '../../lib/calm';
import { invalidateWorkspace, useCachedWsQuery } from '../../lib/hooks';
import { gentleSpring } from '../../lib/motion';
import { zonedParts } from '../../lib/zone';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { auraBriefApi, type AuraAction, type AuraAnswer, type AuraEvidence, type AuraItem, type AuraMeeting, type FridayDraft, type MeetingReview, type ReviewItem } from './auraBriefApi';
import './aura-briefing.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const hhmm = (iso: string) => { const p = zonedParts(new Date(iso)); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };
const dm = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : 'No date');
const dmTime = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');

type Sheet = { kind: 'review'; runId: string | null } | { kind: 'friday' } | { kind: 'ask'; question?: string; taskId?: string | null } | null;

/**
 * Aura's morning briefing, the hero of Today: "3 things need you today", each with its one action (Approve in place, Review, Open, Reassign,
 * Join), what is at risk and why, and today's meetings with the questions left open. Three sheets hang off it - the meeting review
 * (?aura=review&run=…, also where the "Minutes ready" notice lands), the Friday report (?aura=friday) and Ask anything (why is X late?).
 * Lazy-loaded from Today, so none of it is in the entry chunk. Without anything to do it renders `fallback` (Today's own hero); `quiet` (the
 * evening) keeps Today's own card and only the sheets.
 */
export default function AuraBriefing({ fallback, extra, quiet }: { fallback: ReactNode; extra?: ReactNode; quiet?: boolean }) {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const still = useReducedMotion();
  const [params, setParams] = useSearchParams();
  const q = useCachedWsQuery(['inbox', 'aura-briefing'], auraBriefApi.briefing, { staleTime: 30_000, retry: false });
  const [done, setDone] = useState<Record<string, string>>({});
  // An older server (or a mocked one) without the briefing answers with something else: Today's own hero stays.
  const b = q.data && Array.isArray(q.data.needsYou) && Array.isArray(q.data.atRisk) && Array.isArray(q.data.meetings) ? q.data : undefined;

  const fromUrl = params.get('aura');
  const sheet: Sheet = fromUrl === 'review' ? { kind: 'review', runId: params.get('run') }
    : fromUrl === 'friday' ? { kind: 'friday' }
    : fromUrl === 'ask' ? { kind: 'ask', question: params.get('q') ?? undefined, taskId: params.get('task') } : null;
  const open = useCallback((s: Sheet) => setParams((p) => {
    const n = new URLSearchParams(p);
    ['aura', 'run', 'q', 'task'].forEach((k) => n.delete(k));
    if (s?.kind === 'review') { n.set('aura', 'review'); if (s.runId) n.set('run', s.runId); }
    if (s?.kind === 'friday') n.set('aura', 'friday');
    if (s?.kind === 'ask') { n.set('aura', 'ask'); if (s.question) n.set('q', s.question); if (s.taskId) n.set('task', s.taskId); }
    return n;
  }), [setParams]);
  const close = useCallback(() => open(null), [open]);

  const act = async (item: AuraItem | AuraMeeting, a: AuraAction) => {
    if (a.verb === 'review') return open({ kind: 'review', runId: a.targetId });
    if (a.verb === 'join' && a.href) { window.open(a.href, '_blank', 'noopener'); return; }
    if (a.verb === 'approve' && a.endpoint) {
      setDone((d) => ({ ...d, [item.id]: '✓ Approved' }));   // optimistic: the row settles at once
      try { await auraBriefApi.act(a); window.setTimeout(() => void invalidateWorkspace(wid, 'inbox'), 900); void invalidateWorkspace(wid, 'approvals'); }
      catch (e) { setDone((d) => { const x = { ...d }; delete x[item.id]; return x; }); toast(errText(e, 'Could not approve it.'), 'error'); }
      return;
    }
    if (a.href) nav(a.href);
  };

  const needs = b?.needsYou ?? [];
  const sheets = (
    <>
      <ReviewSheet open={sheet?.kind === 'review'} runId={sheet?.kind === 'review' ? sheet.runId : null} onClose={close} />
      <FridaySheet open={sheet?.kind === 'friday'} onClose={close} />
      <AskSheet open={sheet?.kind === 'ask'} question={sheet?.kind === 'ask' ? sheet.question : undefined} taskId={sheet?.kind === 'ask' ? sheet.taskId ?? null : null} onClose={close}
        onAsk={(question) => open({ kind: 'ask', question })} />
    </>
  );
  if (quiet) return <>{fallback}{sheets}</>;
  if (!b || (needs.length === 0 && b.atRisk.length === 0 && !b.fridayReport))
    return <>{fallback}{b && <BriefFoot b={b} onAsk={(question) => open({ kind: 'ask', question })} />}{sheets}</>;

  return (
    <>
      <CalmCard variant="hero" className="ab-hero" aria-label="Aura briefing" data-testid="aura-briefing">
        <div className="ab-head">
          <SiriOrb className="calm-orb" />
          <span>Aura · your briefing{b.generatedAt ? ` · ${hhmm(b.generatedAt)}` : ''}</span>
        </div>
        <h2 className="ab-title">{b.headline}</h2>
        <p className="ab-line">{b.line}</p>
        {needs.length > 0 && (
          <ol className="ab-needs">
            {needs.map((n, i) => (
              <motion.li key={n.id} className={`ab-need${done[n.id] ? ' done' : ''}`} data-tone={n.tone}
                initial={still ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...gentleSpring, delay: still ? 0 : i * 0.04 }}>
                <span className="ab-n" aria-hidden="true">{i + 1}</span>
                <span className="ab-t">
                  <b>{n.title}</b>
                  <small>{n.projectName && <><CalmDot color={projectColor(n.projectId ?? n.id)} />{n.projectName} · </>}{n.why}</small>
                </span>
                {done[n.id] ? <span className="ab-ok" aria-live="polite">{done[n.id]}</span>
                  : i === 0 ? <CalmGo onClick={() => void act(n, n.action)}>{n.action.label}</CalmGo>
                  : <button type="button" className="ab-act" onClick={() => void act(n, n.action)}>{n.action.label}</button>}
              </motion.li>
            ))}
          </ol>
        )}
        {b.moreNeedsYou > 0 && <Link className="cp-lk ab-more" to="/approvals">{b.moreNeedsYou} more waiting ›</Link>}
        {b.fridayReport && (
          <button type="button" className="ab-friday" onClick={() => open({ kind: 'friday' })} data-testid="aura-friday-chip">
            <span>Your Friday report is drafted</span><b>Review ›</b>
          </button>
        )}
      </CalmCard>
      {extra}
      {b.atRisk.length > 0 && (
        <section className="ab-risk" aria-label="At risk">
          <h3>At risk <small>and why</small></h3>
          {b.atRisk.map((r) => (
            <div key={r.id} className="ab-risk-row" data-tone={r.tone}>
              <span className="ab-t"><b>{r.title}</b><small>{r.why}</small></span>
              <span className="ab-risk-acts">
                <button type="button" className="ab-act quiet" onClick={() => open({ kind: 'ask', taskId: r.id.replace(/^risk:/, ''), question: `Why is ${r.title.split(' ')[0]} late?` })}>Why?</button>
                <button type="button" className="ab-act" onClick={() => void act(r, r.action)}>{r.action.label}</button>
              </span>
            </div>
          ))}
        </section>
      )}
      <BriefFoot b={b} onAsk={(question) => open({ kind: 'ask', question })} onMeeting={(m) => void act(m, m.action)} />
      {sheets}
    </>
  );
}

/** Today's meetings with their open questions, and the Ask anything line. */
function BriefFoot({ b, onAsk, onMeeting }: { b: { meetings: AuraMeeting[] }; onAsk: (q: string) => void; onMeeting?: (m: AuraMeeting) => void }) {
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); const t = text.trim(); if (t) { onAsk(t); setText(''); } };
  return (
    <div className="ab-foot">
      {b.meetings.length > 0 && (
        <section className="ab-meets" aria-label="Your meetings today">
          {b.meetings.slice(0, 3).map((m) => (
            <div key={m.id} className="ab-meet">
              <span className="ab-time">{hhmm(m.start)}</span>
              <span className="ab-t">
                <b>{m.title}{m.projectName ? <span className="ab-proj"> · {m.projectName}</span> : null}</b>
                <small>{m.openQuestions.length ? `Open: ${m.openQuestions.join(' · ')}` : 'No open questions from last time.'}</small>
              </span>
              {onMeeting && <button type="button" className={`ab-act${m.action.verb === 'join' ? ' join' : ''}`} onClick={() => onMeeting(m)}>{m.action.label}</button>}
            </div>
          ))}
        </section>
      )}
      <form className="ab-ask" onSubmit={submit} role="search" aria-label="Ask Aura">
        <SiriOrb className="calm-orb" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask anything — why is a task late?" aria-label="Ask Aura anything" maxLength={500} />
        <button type="submit" disabled={!text.trim()} aria-label="Ask">Ask</button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------ Ask anything, with evidence

const EVIDENCE_LABEL: Record<AuraEvidence['kind'], string> = { task: 'Task', date: 'Date change', dependency: 'Waits on', activity: 'Activity', comment: 'Comment' };

function AskSheet({ open, question, taskId, onClose, onAsk }: { open: boolean; question?: string; taskId: string | null; onClose: () => void; onAsk: (q: string) => void }) {
  const [answer, setAnswer] = useState<AuraAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const asked = useRef('');
  useEffect(() => {
    if (!open) { asked.current = ''; return; }
    const key = `${question ?? ''}|${taskId ?? ''}`;
    if (!question && !taskId) { setAnswer(null); return; }
    if (asked.current === key) return;
    asked.current = key;
    setBusy(true); setAnswer(null);
    auraBriefApi.ask(question ?? '', taskId).then(setAnswer, (e) => toast(errText(e, 'Aura could not answer that.'), 'error')).finally(() => setBusy(false));
  }, [open, question, taskId]);
  return (
    <CalmSheet open={open} onClose={onClose} title="Ask Aura" sub="Answers come with the records they are built from." label="Ask Aura" width={560}>
      <div className="ab-sheet" data-testid="aura-ask-sheet">
        {question && <p className="ab-q">{question}</p>}
        {busy && <p className="ab-muted">Reading the history…</p>}
        {answer && (
          <>
            <p className="ab-answer" data-testid="aura-answer">{answer.answer}</p>
            {answer.evidence.length > 0 && (
              <>
                <h4 className="ab-h4">Based on</h4>
                <ul className="ab-evidence">
                  {answer.evidence.map((e, i) => (
                    <li key={i}>
                      <span className="ab-ev-k">{EVIDENCE_LABEL[e.kind] ?? e.kind}</span>
                      <span className="ab-t">{e.href ? <Link to={e.href} onClick={onClose}>{e.label}</Link> : <b>{e.label}</b>}{(e.detail || e.at) && <small>{[e.detail, dmTime(e.at)].filter(Boolean).join(' · ')}</small>}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {answer.suggestions.length > 0 && <div className="ab-sugs">{answer.suggestions.map((s) => <button key={s} type="button" onClick={() => onAsk(s)}>{s}</button>)}</div>}
          </>
        )}
        <form className="ab-ask in-sheet" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (t) { onAsk(t); setText(''); } }}>
          <SiriOrb className="calm-orb" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={answer ? 'Ask a follow-up' : 'Why is ABC-12 late?'} aria-label="Ask a question" maxLength={500} />
          <button type="submit" disabled={!text.trim()}>Ask</button>
        </form>
      </div>
    </CalmSheet>
  );
}

// ------------------------------------------------------------------------------------------------------------ after a meeting: review & approve

type Draft = { approve: boolean; title: string; assigneeId: string; dueDate: string };

function ReviewSheet({ open, runId, onClose }: { open: boolean; runId: string | null; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [r, setR] = useState<MeetingReview | null | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) { setR(undefined); setEditing(null); return; }
    (runId ? auraBriefApi.review(runId) : auraBriefApi.latestReview()).then((x) => {
      setR(x ?? null);
      setDrafts(Object.fromEntries((x?.items ?? []).map((i) => [i.id, { approve: true, title: i.title, assigneeId: i.owner?.id ?? '', dueDate: i.dueDate ?? '' }])));
    }, (e) => { setR(null); toast(errText(e, 'Could not open the review.'), 'error'); });
  }, [open, runId]);
  const waiting = useMemo(() => (r?.items ?? []).filter((i) => i.approvable), [r]);
  const chosen = waiting.filter((i) => drafts[i.id]?.approve).length;
  const set = (id: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  const approve = async () => {
    if (!r) return;
    setBusy(true);
    try {
      const items = waiting.map((i) => {
        const d = drafts[i.id];
        if (!d.approve) return { id: i.id, approve: false };
        const changed = d.title.trim() !== i.title || d.assigneeId !== (i.owner?.id ?? '') || d.dueDate !== (i.dueDate ?? '');
        return changed ? { id: i.id, approve: true, title: d.title.trim() || i.title, assigneeId: d.assigneeId || null, dueDate: d.dueDate || null } : { id: i.id, approve: true };
      });
      const res = await auraBriefApi.decide(r.runId, items, true);
      toast(res.created.length ? `Created ${res.created.join(', ')}` : `Approved ${res.approved}`);
      void invalidateWorkspace(wid, 'inbox'); void invalidateWorkspace(wid, 'work'); void invalidateWorkspace(wid, 'tasks');
      onClose();
    } catch (e) { toast(errText(e, 'Could not approve the minutes.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <CalmSheet open={open} onClose={onClose} label="Review and approve" width={620}
      title={r ? r.title : 'Review & approve'} sub={r ? `${r.projectName} · ${new Date(r.held).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}` : undefined}
      actions={r && waiting.length > 0 ? <CalmGo onClick={() => void approve()} disabled={busy}>{busy ? 'Approving…' : chosen === waiting.length ? 'Approve all' : `Approve ${chosen}`}</CalmGo> : undefined}>
      <div className="ab-sheet" data-testid="aura-review-sheet">
        {r === undefined && <p className="ab-muted">Opening the minutes…</p>}
        {r === null && <p className="ab-muted">Nothing from your meetings is waiting for you.</p>}
        {r && (
          <>
            {r.summary && <p className="ab-answer">{r.summary}</p>}
            {r.decisions.length > 0 && <><h4 className="ab-h4">Decisions</h4><ul className="ab-bul">{r.decisions.map((d) => <li key={d}>{d}</li>)}</ul></>}
            <h4 className="ab-h4">Action items <small>{waiting.length ? `${chosen} of ${waiting.length} will be created` : 'all decided'}</small></h4>
            <ul className="ab-items">
              {r.items.map((i) => <ReviewRow key={i.id} i={i} d={drafts[i.id]} people={r.people} editing={editing === i.id}
                onEdit={() => setEditing(editing === i.id ? null : i.id)} onChange={(p) => set(i.id, p)} />)}
            </ul>
            {r.questions.length > 0 && <><h4 className="ab-h4">Still open</h4><ul className="ab-bul">{r.questions.map((x) => <li key={x}>{x}</li>)}</ul></>}
            {waiting.length > 0 && <div className="ab-sheet-go"><CalmGo onClick={() => void approve()} disabled={busy}>{chosen === waiting.length ? 'Approve all' : `Approve ${chosen}`}</CalmGo><CalmLink onClick={onClose}>Later</CalmLink></div>}
          </>
        )}
      </div>
    </CalmSheet>
  );
}

function ReviewRow({ i, d, people, editing, onEdit, onChange }: { i: ReviewItem; d?: Draft; people: { id: string; name: string }[]; editing: boolean; onEdit: () => void; onChange: (p: Partial<Draft>) => void }) {
  if (!i.approvable || !d) return <li className="ab-item settled"><span className="ab-check on" aria-hidden="true">✓</span><span className="ab-t"><b>{i.appliedKey ? `${i.appliedKey} ` : ''}{i.title}</b><small>{i.status}</small></span></li>;
  const owner = people.find((p) => p.id === d.assigneeId)?.name ?? i.owner?.name ?? 'No owner';
  return (
    <li className={`ab-item${d.approve ? '' : ' off'}`}>
      <button type="button" className={`ab-check${d.approve ? ' on' : ''}`} aria-pressed={d.approve} aria-label={`${d.approve ? 'Leave out' : 'Include'}: ${d.title}`} onClick={() => onChange({ approve: !d.approve })}>{d.approve ? '✓' : ''}</button>
      <span className="ab-t">
        {editing ? <input className="ab-in" value={d.title} onChange={(e) => onChange({ title: e.target.value })} aria-label="Title" maxLength={200} /> : <b>{d.title}</b>}
        {editing ? (
          <span className="ab-edit">
            <Select value={d.assigneeId} onChange={(e) => onChange({ assigneeId: e.target.value })} aria-label="Owner">
              <option value="">No owner</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <input type="date" className="ab-in" value={d.dueDate} onChange={(e) => onChange({ dueDate: e.target.value })} aria-label="Due date" />
          </span>
        ) : <small>{owner} · {dm(d.dueDate || null)}{i.evidence ? ` · “${i.evidence}”` : ''}</small>}
      </span>
      <button type="button" className="ab-act quiet" onClick={onEdit}>{editing ? 'Done' : 'Edit'}</button>
    </li>
  );
}

// ------------------------------------------------------------------------------------------------------------ the Friday report

function FridaySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [d, setD] = useState<FridayDraft | null | undefined>(undefined);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) { setD(undefined); setEditing(null); return; }
    auraBriefApi.friday().then((x) => { setD(x); setTexts(Object.fromEntries(x.projects.map((p) => [p.projectId, p.text]))); setSkip(new Set()); },
      (e) => { setD(null); toast(errText(e, 'Could not draft the report.'), 'error'); });
  }, [open]);
  const chosen = (d?.projects ?? []).filter((p) => !skip.has(p.projectId));
  const send = async () => {
    setBusy(true);
    try {
      const res = await auraBriefApi.sendFriday(chosen.map((p) => ({ projectId: p.projectId, text: texts[p.projectId] ?? p.text })));
      if (res.failed.length) toast(`Sent ${res.sent}. Not sent: ${res.failed.join('; ')}`, 'error'); else toast(`Sent ${res.sent} report${res.sent === 1 ? '' : 's'}`);
      if (res.sent > 0) onClose();
    } catch (e) { toast(errText(e, 'Could not send the report.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <CalmSheet open={open} onClose={onClose} label="Friday report" width={680} title="Friday status report"
      sub={d ? `${d.headline} · ${dm(d.from)} – ${dm(d.to)}` : undefined}
      actions={d && chosen.length > 0 ? <CalmGo onClick={() => void send()} disabled={busy}>{busy ? 'Sending…' : `Send${chosen.length > 1 ? ` ${chosen.length}` : ''}`}</CalmGo> : undefined}>
      <div className="ab-sheet" data-testid="aura-friday-sheet">
        {d === undefined && <p className="ab-muted">Drafting from this week’s work…</p>}
        {d && d.projects.length === 0 && <p className="ab-muted">You own no active projects, so there is nothing to report.</p>}
        {d?.projects.map((p) => {
          const off = skip.has(p.projectId);
          return (
            <article key={p.projectId} className={`ab-rep${off ? ' off' : ''}`}>
              <header>
                <button type="button" className={`ab-check${off ? '' : ' on'}`} aria-pressed={!off} aria-label={`${off ? 'Include' : 'Leave out'} ${p.name}`}
                  onClick={() => setSkip((s) => { const n = new Set(s); if (n.has(p.projectId)) n.delete(p.projectId); else n.add(p.projectId); return n; })}>{off ? '' : '✓'}</button>
                <span className="ab-t"><b><CalmDot color={projectColor(p.projectId)} />{p.name}</b>
                  <small>{p.health} · {p.progress}% · {p.done} done · {p.slipped} slipped · {p.risks} at risk · to {p.chat ? 'project chat' : 'the team by e-mail'}</small></span>
                <button type="button" className="ab-act quiet" onClick={() => setEditing(editing === p.projectId ? null : p.projectId)}>{editing === p.projectId ? 'Preview' : 'Edit'}</button>
              </header>
              {editing === p.projectId
                ? <textarea className="ab-text" value={texts[p.projectId] ?? ''} onChange={(e) => setTexts((t) => ({ ...t, [p.projectId]: e.target.value }))} aria-label={`${p.name} report`} rows={12} />
                : <Preview text={texts[p.projectId] ?? p.text} />}
            </article>
          );
        })}
        {d && <p className="ab-muted small">Drafted every Friday at 16:00 your time · next {new Date(d.nextScheduledAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</p>}
      </div>
    </CalmSheet>
  );
}

/** The report's light markdown (bold, "- " lists) as text, every piece escaped by React. */
function Preview({ text }: { text: string }) {
  const bold = (s: string) => s.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));
  return (
    <div className="ab-prev">
      {text.split('\n').map((l, i) => (l.startsWith('- ') ? <p key={i} className="li">{bold(l.slice(2))}</p> : l.trim() ? <p key={i}>{bold(l)}</p> : <span key={i} className="gap" />))}
    </div>
  );
}
