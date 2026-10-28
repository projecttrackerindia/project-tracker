import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ApiError } from '../../api/client';
import { opsApi } from '../../api/endpoints';
import { askAi, aiWorkspaceApi, type AiAction, type AiKnowledgeSource } from '../../features/ai/aiApi';
import { Markdown } from '../../features/ai/Markdown';
import { useAi } from '../../features/ai/Assistant';
import { useWsQuery } from '../../lib/hooks';
import { useIsMobile } from '../../lib/mobile';
import { deviceZone } from '../../lib/zone';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { Icon } from '../Icon';
import { GrootAvatar, type GrootState } from './GrootAvatar';
import { DEFAULT_DAY, dayPart, greeting, grootCheckout, suggestionsFor, workingHours, type GrootSuggestion, type OrgDay } from './grootTime';
import { useGroot, type GrootTurn } from './store';
import './groot.css';

const WIDTH_KEY = 'pm_groot_width';
const readWidth = () => { try { const n = Number(localStorage.getItem(WIDTH_KEY)); return n >= 360 && n <= 760 ? n : 420; } catch { return 420; } };
const SOURCE_GLYPH: Record<string, string> = { project: '▤', task: '◎', ticket: '◎', work: '◎', issue: '◎', document: '◫', doc: '◫', page: '◫', meeting: '◫', time: '◷', chat: '✉', message: '✉' };
const KIND_LABEL: [RegExp, string][] = [
  [/reminder/, 'Reminder'], [/meeting|schedule/, 'Meeting'], [/ticket|work_task|operational/, 'Ticket'], [/project/, 'Project'],
  [/assign/, 'Assign'], [/date|reschedule|move/, 'Move date'], [/comment/, 'Comment'], [/message|chat|mail|reply|forward/, 'Message'],
  [/update|change|edit/, 'Update'], [/create|task|work/, 'Create'],
];
const kindLabel = (kind: string) => KIND_LABEL.find(([re]) => re.test(kind.toLowerCase()))?.[1] ?? 'Action';
const drafted = (kind: string) => /message|reply|mail|forward|comment|page|document/.test(kind.toLowerCase());
const newId = () => Math.random().toString(36).slice(2, 10);

/** The workspace's day: Operations business hours and zone when set, else the workspace zone and 9–6, Monday to Friday. */
function useOrgDay(): OrgDay {
  const wsZone = useAuth((s) => s.ctx?.current?.timeZone) ?? null;
  const ops = useWsQuery(['ops', 'settings'], opsApi.settings, { staleTime: 10 * 60_000, retry: false });
  const d = ops.data;
  return {
    zone: d?.timeZone || wsZone || deviceZone(),
    startMin: d?.dayStartMinutes ?? DEFAULT_DAY.startMin, endMin: d?.dayEndMinutes ?? DEFAULT_DAY.endMin,
    workDays: Array.isArray(d?.workDays) && d!.workDays.length ? d!.workDays.reduce((bits, n) => bits | (1 << (n - 1)), 0) : DEFAULT_DAY.workDays,
  };
}

/** Mounted once in the layout. */
export function GrootChatHost() {
  const open = useGroot((s) => s.open);
  const ai = useAi();
  return <AnimatePresence>{open && ai ? <GrootChat key="groot" /> : null}</AnimatePresence>;
}

/**
 * Groot's chat: a right-hand panel on wide screens (about 420px, drag the left edge to resize) and a full sheet on a phone. A real
 * conversation that streams; each answer shows the steps Groot took, its sources, and the changes it proposes as cards with Confirm and
 * Cancel. Confirming runs the change through the assistant's action runner as the signed-in person, so Groot can never do more than they
 * could in the app, and the organization's agent levels (Ask first, Auto, Suggest) decide what needs a confirmation at all.
 */
function GrootChat() {
  const { turns, context, about, conversationId, close, reset, update, setConversation, take } = useGroot();
  const pendingTs = useGroot((s) => s.pending?.ts ?? 0);
  const phone = useIsMobile();
  const still = useReducedMotion();
  const nav = useNavigate();
  const org = useAuth((s) => s.ctx?.current?.name) ?? 'your organization';
  const me = useAuth((s) => s.ctx?.user.displayName) ?? '';
  const day = useOrgDay();
  const [width, setWidth] = useState(readWidth);
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [flash, setFlash] = useState<GrootState | null>('greeting');
  const abort = useRef<AbortController | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const convRef = useRef(conversationId);
  convRef.current = conversationId;

  const now = new Date();
  const part = dayPart(now, day);
  const suggestions = useMemo(() => suggestionsFor(part, about), [part, about]);
  const live = turns[turns.length - 1];
  const streaming = !!live?.streaming;

  // Groot's face follows what is happening.
  const state: GrootState = acting ? 'working'
    : streaming ? (live.steps.some((s) => s.state === 'running') || (live.actions.length > 0 && !live.text) ? 'working' : 'thinking')
    : flash ?? (live?.error ? 'error' : focused && text.trim() ? 'listening' : 'idle');
  useEffect(() => { if (!flash) return; const t = window.setTimeout(() => setFlash(null), flash === 'greeting' ? 2800 : 1600); return () => window.clearTimeout(t); }, [flash]);

  const patch = (id: string, fn: (t: GrootTurn) => GrootTurn) => update((all) => all.map((t) => (t.id === id ? fn(t) : t)));

  const ask = (q: string) => {
    const question = q.trim();
    if (!question) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    const id = newId();
    const first = !convRef.current;
    update((all) => [...all, { id, q: question, text: '', message: null, actions: [], steps: [], plan: [], error: null, streaming: true }]);
    const where = first && (about || context) ? `\n\n(I am looking at ${about ? `the project ${about}` : context}.)` : '';
    askAi(convRef.current, { text: question + where, mode: 'auto', attachmentIds: [], timeZone: deviceZone() }, (e) => {
      if (e.name === 'started') setConversation(e.conversationId);
      else if (e.name === 'text') patch(id, (t) => ({ ...t, text: t.text + e.delta }));
      else if (e.name === 'tool') patch(id, (t) => ({ ...t, steps: t.steps.some((s) => s.id === e.id) ? t.steps.map((s) => (s.id === e.id ? { ...s, label: e.label || s.label, state: e.state } : s)) : [...t.steps, { id: e.id, label: e.label || e.tool, state: e.state }] }));
      else if (e.name === 'plan') patch(id, (t) => ({ ...t, plan: e.steps }));
      else if (e.name === 'action') patch(id, (t) => ({ ...t, actions: t.actions.some((a) => a.id === e.action.id) ? t.actions.map((a) => (a.id === e.action.id ? e.action : a)) : [...t.actions, e.action] }));
      else if (e.name === 'done') { patch(id, (t) => ({ ...t, message: e.message, text: e.message.content || t.text, actions: e.message.actions?.length ? e.message.actions : t.actions, streaming: false })); setFlash('success'); }
      else if (e.name === 'error') patch(id, (t) => ({ ...t, error: e.message, message: e.saved ?? t.message, text: e.saved?.content || t.text, actions: e.saved?.actions ?? t.actions, streaming: false }));
    }, ctl.signal)
      .then(() => patch(id, (t) => (t.streaming ? { ...t, streaming: false } : t)))
      .catch((err) => { if (!ctl.signal.aborted) patch(id, (t) => ({ ...t, streaming: false, error: err instanceof ApiError ? err.message : 'Groot could not be reached. Try again in a moment.' })); });
  };

  // A question handed over by the Ask field, the phone Ask bar, the command palette or a ✦ button.
  useEffect(() => { const q = take(); if (q) ask(q); }, [pendingTs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight, behavior: still ? 'auto' : 'smooth' }); }, [turns, still]);
  useEffect(() => { if (!phone) window.setTimeout(() => input.current?.focus({ preventScroll: true }), 60); }, [phone]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);
  // Desktop: the page makes room for the panel instead of being covered.
  useEffect(() => {
    if (phone) return;
    const root = document.documentElement;
    root.classList.add('groot-docked'); root.style.setProperty('--groot-w', `${width}px`);
    return () => { root.classList.remove('groot-docked'); root.style.removeProperty('--groot-w'); };
  }, [phone, width]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = width;
    const move = (ev: PointerEvent) => setWidth(Math.max(360, Math.min(760, w0 + (x0 - ev.clientX))));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setWidth((w) => { try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* private window */ } return w; }); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const pick = (s: GrootSuggestion) => {
    if (s.action === 'checkout' && grootCheckout('groot-chat')) { close(); return; }
    ask(s.prompt);
  };

  const decide = async (turn: GrootTurn, a: AiAction, yes: boolean) => {
    const messageId = turn.message?.id;
    if (!messageId) return;
    setActing(a.id);
    try {
      const r = yes ? await aiWorkspaceApi.confirm(messageId, a.id) : await aiWorkspaceApi.dismiss(messageId, a.id);
      patch(turn.id, (t) => ({ ...t, actions: t.actions.map((x) => (x.id === r.id ? r : x)) }));
      if (yes) { if (r.status === 'failed') { toast(r.error ?? `${a.title}: failed.`, 'error'); setFlash('error'); } else setFlash('success'); }
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Groot could not do that.', 'error'); setFlash('error'); }
    finally { setActing(null); }
  };

  const go = (to: string) => { if (phone) close(); nav(to); };
  const send = () => { const q = text.trim(); if (!q || streaming) return; setText(''); ask(q); };
  const status = state === 'thinking' ? 'Groot is thinking…' : state === 'working' ? 'Groot is working on it…' : state === 'error' ? 'Something went wrong' : `${org}'s assistant`;
  const firstName = me.split(' ')[0] || null;

  const panel = (
    <motion.aside className={`groot-chat${phone ? ' phone' : ''}`} role="dialog" aria-modal={phone ? true : undefined} aria-label="Groot"
      style={phone ? undefined : { width }} data-state={state} data-testid="groot-chat"
      initial={still ? { opacity: 0 } : phone ? { y: 40, opacity: 0 } : { x: 40, opacity: 0 }} animate={{ x: 0, y: 0, opacity: 1 }}
      exit={still ? { opacity: 0 } : phone ? { y: 40, opacity: 0 } : { x: 40, opacity: 0 }} transition={still ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 34 }}>
      {!phone && <div className="gc-resize" role="separator" aria-orientation="vertical" aria-label="Resize Groot" onPointerDown={startResize} />}
      {phone && <span className="gc-grab" aria-hidden="true" />}
      <header className="gc-head">
        <GrootAvatar state={state} size={34} />
        <div className="gc-title"><b>Groot</b><small aria-live="polite">{status}</small></div>
        {turns.length > 0 && <button type="button" className="gc-icon" title="New chat" aria-label="New chat" onClick={() => { abort.current?.abort(); reset(); setFlash('greeting'); }}><Icon name="plus" size={16} /></button>}
        <button type="button" className="gc-icon" title="All conversations" aria-label="All conversations" onClick={() => { close(); nav(conversationId ? `/?tab=assistant&c=${encodeURIComponent(conversationId)}` : '/?tab=assistant'); }}><Icon name="clock" size={16} /></button>
        <button type="button" className="gc-icon" aria-label="Close Groot" onClick={close}><Icon name="close" size={16} /></button>
      </header>

      <div className="gc-body" ref={body} aria-live="polite">
        {turns.length === 0 ? (
          <div className="gc-empty" data-part={part}>
            <GrootAvatar state={flash === 'greeting' ? 'greeting' : state} size={phone ? 96 : 112} />
            <h3>{greeting(part, now, day.zone, firstName)}</h3>
            <p>I'm Groot, {org}'s assistant. {about ? `Ask me anything about ${about}.` : 'Ask me anything, or tell me what to do.'}</p>
            <p className="gc-when">{part === 'off' ? 'Not a working day' : `Working hours ${workingHours(day)}`} · {day.zone}</p>
            <div className="gc-sugg" role="list" aria-label="Suggestions">
              {suggestions.map((s, i) => (
                <motion.button key={s.label} type="button" role="listitem" className="gc-chip" data-action={s.action}
                  initial={still ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: still ? 0 : 0.08 * i }} onClick={() => pick(s)}>
                  {s.label}
                </motion.button>
              ))}
            </div>
          </div>
        ) : turns.map((t) => (
          <Turn key={t.id} t={t} acting={acting} still={!!still} onDecide={(a, yes) => void decide(t, a, yes)} onAsk={ask} onGo={go} />
        ))}
      </div>

      <form className="gc-compose" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea ref={input} rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Groot…" aria-label="Ask Groot"
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        {streaming
          ? <button type="button" className="gc-send stop" aria-label="Stop" onClick={() => abort.current?.abort()}><span /></button>
          : <button type="submit" className="gc-send" aria-label="Send" disabled={!text.trim()}><Icon name="arrowUp" size={16} /></button>}
      </form>
    </motion.aside>
  );
  return createPortal(<>{phone && <div className="gc-scrim" onMouseDown={close} aria-hidden="true" />}{panel}</>, document.body);
}

function Turn({ t, acting, still, onDecide, onAsk, onGo }: {
  t: GrootTurn; acting: string | null; still: boolean; onDecide: (a: AiAction, yes: boolean) => void; onAsk: (q: string) => void; onGo: (to: string) => void;
}) {
  const sources: AiKnowledgeSource[] = t.message?.sources ?? [];
  const followUps = !t.streaming ? (t.message?.followUps ?? []).slice(0, 3) : [];
  const steps = t.steps.length ? t.steps : t.plan.map((p, i) => ({ id: `p${i}`, label: p.title, state: p.state === 'done' ? 'done' as const : p.state === 'failed' ? 'failed' as const : 'running' as const }));
  return (
    <div className="gc-turn">
      <div className="gc-me"><p>{t.q}</p></div>
      <div className="gc-groot">
        {steps.length > 0 && (
          <ol className="gc-steps" aria-label="What Groot did">
            {steps.map((s, i) => (
              <motion.li key={s.id} className={s.state} initial={still ? false : { opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: still ? 0 : i * 0.05 }}>
                <span className="gc-step-dot" aria-hidden="true" />{s.label}{s.state === 'running' ? '…' : ''}
              </motion.li>
            ))}
          </ol>
        )}
        {!t.text && t.streaming && <p className="gc-wait"><span /><span /><span /><span className="sr-only">Groot is thinking…</span></p>}
        {t.text && <div className="gc-md"><Markdown text={t.text} />{t.streaming && <span className="gc-cur" aria-hidden="true" />}</div>}
        {t.error && <p className="gc-err" role="alert">{t.error}</p>}
        {t.actions.map((a) => (
          <div key={a.id} className={`gc-card ${a.status}`} data-testid="groot-action">
            <div className="gc-card-head"><span className="gc-kind">{kindLabel(a.kind)}</span><small>{drafted(a.kind) ? 'Groot drafted this' : 'Groot suggests'}</small></div>
            <b>{a.title}</b>
            {a.summary && <p>{a.summary}</p>}
            {a.preview && <pre className="gc-preview">{a.preview}</pre>}
            {a.status === 'proposed' ? (
              <div className="gc-card-acts">
                <button type="button" className="gc-btn" disabled={acting === a.id || !t.message} onClick={() => onDecide(a, false)}>Cancel</button>
                <button type="button" className="gc-btn pri" disabled={acting === a.id || !t.message} onClick={() => onDecide(a, true)}>{acting === a.id ? 'Working…' : 'Confirm'}</button>
              </div>
            ) : (
              <div className="gc-card-done" role="status">
                {a.status === 'done' ? <>✓ Done{a.link && <button type="button" className="gc-link" onClick={() => onGo(a.link!)}>Open</button>}</>
                  : a.status === 'failed' ? <>Could not do it{a.error ? `: ${a.error}` : '.'}</> : a.status === 'dismissed' ? 'Cancelled' : a.status === 'undone' ? 'Undone' : 'Working…'}
              </div>
            )}
          </div>
        ))}
        {!t.streaming && sources.length > 0 && (
          <div className="gc-src"><span>Sources</span>
            {sources.slice(0, 6).map((s) => (
              <button key={`${s.kind}:${s.id}`} type="button" className="gc-s" title={s.title} onClick={() => onGo(s.link)}>
                {SOURCE_GLYPH[s.kind.toLowerCase()] ?? '▤'} {s.key && s.key !== s.title ? `${s.key} ${s.title}` : s.title}
              </button>
            ))}
          </div>
        )}
        {followUps.length > 0 && <div className="gc-follow">{followUps.map((f) => <button key={f} type="button" className="gc-chip sm" onClick={() => onAsk(f)}>{f}</button>)}</div>}
      </div>
    </div>
  );
}
