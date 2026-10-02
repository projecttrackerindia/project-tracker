import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { ApiError, get, post, put } from '../../api/client';
import { actionItemApi } from '../../api/endpoints';
import type { Priority, WorkItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, Modal, PageLoader, PriorityBadge } from '../../components/ui';
import { formatDate, formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { WorkItemRow, fromWorkItem, workItemLink } from '../workitems/workItems';
import { openReminderComposer } from '../reminders/store';

// ------------------------------------------------------------------ API
export interface AiStatus { enabled: boolean; configured: boolean; entitled: boolean; allowedHere: boolean; model: string | null; provider: string | null; backup: string | null }
interface AiSummary { summary: string; generatedAt: string }
interface AiRisk { risk: 'low' | 'medium' | 'high'; score: number; headline: string; reasons: string[]; actions: string[]; generatedAt: string }
interface AiSearch { interpretation: string; items: WorkItem[] }
export interface AiTriage { workTypeId: string | null; workType: string | null; priority: Priority | null; assigneeId: string | null; assignee: string | null; reason: string }
interface AiActionItem { title: string; assigneeId: string | null; assignee: string | null; dueDate: string | null }

export const aiApi = {
  status: () => get<AiStatus>('/ai/status'),
  setAllowed: (allowed: boolean) => put<AiStatus>('/ai/status', { allowed }),
  portfolio: () => post<AiSummary>('/ai/portfolio-summary'),
  risk: (projectId: string) => post<AiRisk>(`/ai/projects/${projectId}/risk`),
  search: (query: string) => post<AiSearch>('/ai/search', { query }),
  triage: (title: string, description: string | null) => post<AiTriage>('/ai/triage', { title, description }),
  notes: (projectId: string, notes: string) => post<{ items: AiActionItem[] }>(`/ai/projects/${projectId}/action-items`, { notes }),
};

const useAiStatus = () => useWsQuery(['ai', 'status'], aiApi.status, { staleTime: 5 * 60_000, retry: false }).data;

/** Whether the assistant can be used here (configured, in the plan, switched on for the workspace). */
export function useAi() {
  return useAiStatus()?.enabled ?? false;
}

/** The model people are told about: "Claude", or the backup's provider when it runs the assistant on its own. */
const poweredBy = (s?: AiStatus) => (!s?.provider || s.provider === 'Claude (Anthropic)' ? 'Claude' : s.provider);
/** Where what people ask can go, for the privacy notes - including the backup, which answers when Claude cannot. */
const sentTo = (s?: AiStatus) => `${s?.provider ?? 'Claude (Anthropic)'}${s?.backup ? `, or to ${s.backup} when Claude is unavailable` : ''}`;

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

/** The assistant panel, opened from anywhere (the command palette, the top bar). */
export const useAssistant = create<{ open: boolean; question: string; summary: number; ask: (q?: string) => void; summarise: () => void; close: () => void }>((set) => ({
  open: false, question: '', summary: 0,
  ask: (q = '') => set({ open: true, question: q }),
  /** Opens the panel straight on a portfolio summary. */
  summarise: () => set((s) => ({ open: true, question: '', summary: s.summary + 1 })),
  close: () => set({ open: false }),
}));

/** Portfolio → "AI summary". */
export function PortfolioSummaryButton() {
  const enabled = useAi();
  const summarise = useAssistant((s) => s.summarise);
  if (!enabled) return null;
  return <button type="button" className="btn btn-ghost asst-ghost" onClick={summarise}><Sparkle size={15} /> AI summary</button>;
}

/** Minimal Markdown for the model's summaries: ## headings, - bullets and **bold**. */
export function Prose({ text }: { text: string }) {
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => part.startsWith('**') && part.endsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>);
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { blocks.push(<ul key={`l${blocks.length}`}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>); list = []; } };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^[-*•]\s+/.test(line)) { list.push(line.replace(/^[-*•]\s+/, '')); continue; }
    flush();
    if (!line) continue;
    if (line.startsWith('#')) blocks.push(<h4 key={blocks.length}>{inline(line.replace(/^#+\s*/, ''))}</h4>);
    else blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="asst-prose">{blocks}</div>;
}

function Sparkle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="asst-sparkle">
      <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5z" fill="currentColor" />
      <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" fill="currentColor" opacity=".7" />
    </svg>
  );
}
export { Sparkle };

function Thinking({ label }: { label: string }) {
  return <div className="asst-thinking"><span className="asst-orb" /><span>{label}</span></div>;
}

/** Top-bar button that opens the assistant (shown only when it can be used). */
export function AssistantButton() {
  const enabled = useAi();
  const ask = useAssistant((s) => s.ask);
  if (!enabled) return null;
  return <button type="button" className="asst-top-btn" onClick={() => ask()} title="Ask the AI assistant (Ctrl K, then type)"><Sparkle size={15} /><span>Ask AI</span></button>;
}

/** The slide-over assistant: ask for work in plain words, or get a portfolio summary. */
export function AssistantPanel() {
  const { open, question, summary: summaryAsked, close } = useAssistant();
  const status = useAiStatus();
  const enabled = status?.enabled ?? false;
  const nav = useNavigate();
  const [q, setQ] = useState(question);
  const [busy, setBusy] = useState<'search' | 'summary' | null>(null);
  const [result, setResult] = useState<AiSearch | null>(null);
  const [summary, setSummary] = useState<AiSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const asked = useRef('');

  const search = async (text: string) => {
    if (text.trim().length < 3) return;
    if (/^(remind|reminder|remember|don'?t forget)\b/i.test(text.trim())) { close(); openReminderComposer({ text: text.trim() }); return; }
    setBusy('search'); setError(null); setSummary(null);
    try { setResult(await aiApi.search(text.trim())); } catch (e) { setError(errText(e, 'The assistant could not answer.')); } finally { setBusy(null); }
  };
  useEffect(() => {
    if (!open) return;
    setQ(question); setTimeout(() => input.current?.focus(), 50);
    if (question && question !== asked.current) { asked.current = question; void search(question); }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, question]);
  useEffect(() => {
    if (open && summaryAsked > 0) void portfolio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryAsked]);
  if (!open || !enabled) return null;

  async function portfolio() {
    setBusy('summary'); setError(null); setResult(null);
    try { setSummary(await aiApi.portfolio()); } catch (e) { setError(errText(e, 'The assistant could not answer.')); } finally { setBusy(null); }
  }
  const examples = ['Overdue work assigned to me', 'High priority bugs raised this week', 'What is due next Friday?', 'Unassigned operational work'];

  return (
    <div className="asst-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <aside className="asst-panel" role="dialog" aria-label="AI assistant">
        <header className="asst-head">
          <div className="asst-title"><span className="asst-badge"><Sparkle size={16} /></span><div><b>Assistant</b><span>Powered by {poweredBy(status)}</span></div></div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={close}><Icon name="close" /></button>
        </header>
        <form className="asst-ask" onSubmit={(e) => { e.preventDefault(); void search(q); }}>
          <input ref={input} className="input" value={q} maxLength={300} placeholder="Ask for work in plain words…" onChange={(e) => setQ(e.target.value)} aria-label="Ask the assistant" />
          <button type="submit" className="btn btn-primary" disabled={!!busy || q.trim().length < 3}><Icon name="send" size={14} /></button>
        </form>
        <div className="asst-body">
          {!result && !summary && !busy && !error && (
            <>
              <div className="asst-section-title">Try</div>
              <div className="asst-chips">{examples.map((x) => <button key={x} type="button" className="asst-chip" onClick={() => { setQ(x); void search(x); }}>{x}</button>)}</div>
              <div className="asst-section-title">Or</div>
              <button type="button" className="asst-action" onClick={() => void portfolio()}><Sparkle size={14} /><span><b>Summarise the portfolio</b><i>What needs attention across your projects, and what is going well</i></span></button>
            </>
          )}
          {busy && <Thinking label={busy === 'search' ? 'Looking through the work you can see…' : 'Reading your portfolio…'} />}
          {error && <div className="form-error" role="alert">{error}</div>}
          {result && !busy && (
            <>
              <div className="asst-understood"><Sparkle size={13} /> {result.interpretation}</div>
              {result.items.length === 0 ? <EmptyState icon="search" title="Nothing matches" /> : (
                <div className="wi-list">{result.items.map((i) => <WorkItemRow key={`${i.kind}:${i.id}`} item={fromWorkItem(i)} onOpen={() => { close(); nav(workItemLink(i)); }} />)}</div>
              )}
            </>
          )}
          {summary && !busy && (
            <>
              <Prose text={summary.summary} />
              <div className="asst-foot-note">Generated {formatDateTime(summary.generatedAt)} from the projects you can see. Check before sharing.</div>
            </>
          )}
        </div>
        <footer className="asst-privacy"><Icon name="lock" size={12} /> To answer, only what you can already see is sent to {sentTo(status)}. Your workspace can switch this off.</footer>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ contextual features

/** Project → "Delay risk": the assistant reads the project's dates, progress and slippage and says how likely it is to be late. */
export function RiskButton({ projectId }: { projectId: string }) {
  const enabled = useAi();
  const [open, setOpen] = useState(false);
  const [risk, setRisk] = useState<AiRisk | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!enabled) return null;
  const run = async () => {
    setOpen(true); setRisk(null); setError(null);
    try { setRisk(await aiApi.risk(projectId)); } catch (e) { setError(errText(e, 'The assistant could not answer.')); }
  };
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm asst-ghost" onClick={() => void run()} title="Ask the assistant how likely this project is to be late"><Sparkle size={14} /> Delay risk</button>
      {open && (
        <Modal title="Delay risk" subtitle="Read from the project's dates, progress, slipped tasks and blockers." onClose={() => setOpen(false)}
          footer={<button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>Close</button>}>
          {error ? <div className="form-error" role="alert">{error}</div> : !risk ? <Thinking label="Assessing the project…" /> : (
            <div className="asst-risk">
              <div className={`asst-risk-gauge ${risk.risk}`} style={{ ['--p' as string]: risk.score }}><b>{risk.score}</b><span>{risk.risk} risk</span></div>
              <div className="asst-risk-main">
                <h4>{risk.headline}</h4>
                {risk.reasons.length > 0 && <><div className="asst-section-title">Why</div><ul>{risk.reasons.map((r) => <li key={r}>{r}</li>)}</ul></>}
                {risk.actions.length > 0 && <><div className="asst-section-title">What to do</div><ul className="asst-todo">{risk.actions.map((r) => <li key={r}><Icon name="arrowRight" size={13} />{r}</li>)}</ul></>}
                <div className="asst-foot-note">Generated {formatDateTime(risk.generatedAt)}. A planning aid - check it against what you know.</div>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

/** Action items → "From meeting notes": paste notes, review what the assistant found, create the ones you keep. */
export function NotesToActionsButton({ projectId }: { projectId: string }) {
  const enabled = useAi();
  const wid = useWorkspaceId();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<(AiActionItem & { keep: boolean })[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!enabled) return null;
  const extract = async () => {
    setBusy(true); setError(null);
    try { setItems((await aiApi.notes(projectId, notes)).items.map((i) => ({ ...i, keep: true }))); }
    catch (e) { setError(errText(e, 'The assistant could not read the notes.')); } finally { setBusy(false); }
  };
  const createAll = async () => {
    const chosen = (items ?? []).filter((i) => i.keep);
    setBusy(true);
    let made = 0;
    try {
      for (const i of chosen) { await actionItemApi.create(projectId, { title: i.title, assigneeId: i.assigneeId, dueDate: i.dueDate }); made++; }
      toast(`Created ${made} action item${made === 1 ? '' : 's'}.`);
      void invalidateWorkspace(wid, 'project', projectId); void invalidateWorkspace(wid, 'action-items');
      setOpen(false); setItems(null); setNotes('');
    } catch (e) { toast(errText(e, `Created ${made}; the rest could not be created.`), 'error'); } finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm asst-ghost" onClick={() => setOpen(true)}><Sparkle size={14} /> From meeting notes</button>
      {open && (
        <Modal size="lg" title="Action items from meeting notes" subtitle="The assistant finds the commitments; you choose which to create." onClose={() => setOpen(false)}
          footer={items ? <><button type="button" className="btn btn-ghost" onClick={() => setItems(null)}>Back to the notes</button>
            <button type="button" className="btn btn-primary" disabled={busy || !items.some((i) => i.keep)} onClick={() => void createAll()}>Create {items.filter((i) => i.keep).length}</button></>
            : <><button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy || notes.trim().length < 20} onClick={() => void extract()}><Sparkle size={14} /> Find action items</button></>}>
          {error && <div className="form-error" role="alert">{error}</div>}
          {busy && !items ? <Thinking label="Reading the notes…" /> : items ? (
            items.length === 0 ? <EmptyState icon="flag" title="No commitments found" text="Nothing in the notes reads like someone agreeing to do something." /> : (
              <div className="asst-proposals">
                {items.map((i, n) => (
                  <label key={n} className={`asst-proposal ${i.keep ? '' : 'off'}`}>
                    <input type="checkbox" checked={i.keep} onChange={(e) => setItems(items.map((x, k) => (k === n ? { ...x, keep: e.target.checked } : x)))} />
                    <span><b>{i.title}</b><i>{i.assignee ?? 'Unassigned'}{i.dueDate ? ` · due ${formatDate(i.dueDate)}` : ''}</i></span>
                  </label>
                ))}
              </div>
            )
          ) : (
            <textarea className="textarea" rows={12} value={notes} maxLength={20000} autoFocus placeholder="Paste the meeting notes or transcript…" onChange={(e) => setNotes(e.target.value)} />
          )}
        </Modal>
      )}
    </>
  );
}

/** New work task → "Suggest": work type, priority and a person, from the title and description. */
export function TriageButton({ title, description, onApply }: { title: string; description: string; onApply: (t: AiTriage) => void }) {
  const enabled = useAi();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<AiTriage | null>(null);
  if (!enabled) return null;
  const run = async () => {
    setBusy(true);
    try { const t = await aiApi.triage(title, description || null); setLast(t); onApply(t); toast('Suggestion applied. Change anything you like before saving.'); }
    catch (e) { toast(errText(e, 'The assistant could not suggest anything.'), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="asst-triage">
      <button type="button" className="btn btn-ghost btn-sm asst-ghost" disabled={busy || title.trim().length < 3} onClick={() => void run()}>
        {busy ? <span className="asst-orb small" /> : <Sparkle size={14} />} Suggest type, priority and person
      </button>
      {last && <span className="asst-triage-why" title={last.reason}>{last.workType ?? '—'} · {last.priority ? <PriorityBadge priority={last.priority} /> : '—'} · {last.assignee ?? 'no one in particular'}</span>}
    </div>
  );
}

/** Settings → General (Owners/Admins): switch the assistant on or off for the whole workspace. */
export function AiWorkspaceSwitch() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['ai', 'status'], aiApi.status, { staleTime: 60_000, retry: false });
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <PageLoader />;
  const s = q.data;
  if (!s?.configured) return null;
  const toggle = async () => {
    setBusy(true);
    try { await aiApi.setAllowed(!s.allowedHere); void invalidateWorkspace(wid, 'ai'); toast(s.allowedHere ? 'The assistant is off for this workspace.' : 'The assistant is on.'); }
    catch (e) { toast(errText(e, 'Could not change it.'), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ marginTop: 18 }}><div className="card-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
    <div className="setting-row">
      <div className="setting-info"><h4><Sparkle size={14} /> AI assistant</h4>
        <p>{s.entitled ? `Plain-language search, portfolio summaries, delay risk, triage suggestions and action items from meeting notes, powered by ${poweredBy(s)}. Only what each person can already see is sent to ${sentTo(s)}.` : 'Comes with the Business plan.'}</p></div>
      <button type="button" className={`switch ${s.allowedHere ? 'on' : ''}`} role="switch" aria-checked={s.allowedHere} aria-label="AI assistant" disabled={busy || !s.entitled} onClick={() => void toggle()} />
    </div>
    </div></div>
  );
}
