import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { ApiError } from '../../api/client';
import { askAi, aiWorkspaceApi, type AiAction, type AiKnowledgeSource, type AiMessage } from '../../features/ai/aiApi';
import { Markdown } from '../../features/ai/Markdown';
import { deviceZone } from '../../lib/zone';
import { toast } from '../../stores/ui';
import { useAskPanel } from './state';
import './askPanel.css';

const ROW_DOTS = ['#ff9500', '#ff2d55', '#30b0c7', '#5856d6', '#28cd41', '#af52de', '#ff9f0a', '#0071e3'];
const SOURCE_GLYPH: Record<string, string> = { project: '▤', task: '◎', ticket: '◎', work: '◎', issue: '◎', document: '◫', doc: '◫', page: '◫', meeting: '◫', time: '◷', timesheet: '◷', chat: '💬', message: '💬', channel: '💬' };

interface Turn { q: string; text: string; message: AiMessage | null; error: string | null; streaming: boolean }

/** Splits an answer into its prose and its first Markdown table (header + rows), so the table can be drawn as the design's forecast table. */
function splitTable(text: string): { before: string; table: { head: string[]; rows: string[][] } | null; after: string } {
  const lines = text.split('\n');
  const start = lines.findIndex((l, i) => /^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? ''));
  if (start < 0) return { before: text, table: null, after: '' };
  let end = start + 2;
  while (end < lines.length && /^\s*\|.*\|?\s*$/.test(lines[end])) end++;
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  return { before: lines.slice(0, start).join('\n').trim(), table: { head: cells(lines[start]), rows: lines.slice(start + 2, end).map(cells).filter((r) => r.some(Boolean)) }, after: lines.slice(end).join('\n').trim() };
}

/** A late date in red (+10 days or more) or orange; other cells as written, **bold** kept. */
function Cell({ text, col, head }: { text: string; col: number; head: string }) {
  const bold = /^\*\*(.+)\*\*$/.exec(text)?.[1];
  const plain = bold ?? text;
  const slip = /\+\s?(\d+)\s?d\b/.exec(plain);
  if (/forecast|slip|late|eta/i.test(head) && slip) return <span className="ask-late" style={{ color: Number(slip[1]) >= 10 ? '#ff3b30' : '#ff9500' }}>{plain}</span>;
  if (col === 0) return <b>{plain}</b>;
  return bold ? <b>{bold}</b> : <>{plain}</>;
}

/**
 * Prose that fades in in word groups of four as it streams (the design's "drop and stream"); **bold** is kept. Once the answer is complete
 * and it holds more than paragraphs and bold (lists, headings, links, code), the assistant's own Markdown renderer takes over.
 */
function Streamed({ text, done }: { text: string; done: boolean }) {
  const rich = done && /(^|\n)\s*([-*•]\s|\d+\.\s|#{1,4}\s|>\s|```)|\[[^\]]+\]\(/.test(text);
  if (rich) return <Markdown text={text} />;
  const paras = text.split(/\n{2,}/).filter((p) => p.trim());
  let bold = false;
  return (
    <>
      {paras.map((p, pi) => {
        const words = p.replace(/\n/g, ' ').split(/(\s+)/).filter(Boolean);
        const groups: ReactNode[][] = [];
        let cur: ReactNode[] = [], count = 0;
        words.forEach((w, wi) => {
          if (/^\s+$/.test(w)) { cur.push(' '); return; }
          const parts = w.split('**');
          const nodes = parts.map((part, i) => {
            if (i > 0) bold = !bold;
            return part ? (bold ? <b key={`${wi}-${i}`}>{part}</b> : <Fragment key={`${wi}-${i}`}>{part}</Fragment>) : null;
          });
          cur.push(<Fragment key={wi}>{nodes}</Fragment>);
          if (++count === 4) { groups.push(cur); cur = []; count = 0; }
        });
        if (cur.length) groups.push(cur);
        return <p key={pi}>{groups.map((g, gi) => <span key={gi} className="ask-w">{g}</span>)}</p>;
      })}
    </>
  );
}

/**
 * Ask (⌘K, apple/s-ask): a Spotlight-style panel that springs out of the toolbar's Ask field. The query row with the orb; the answer streams
 * in word groups; a table when the answer has rows; the sources as chips; an action bar (open the page it is about, the assistant's
 * suggested next step and the actions it proposed); "Ask a follow-up". The whole conversation stays one click away ("Open in Assistant").
 */
export function AskPanelHost() {
  const open = useAskPanel((s) => s.open);
  return open ? <AskPanel /> : null;
}

function AskPanel() {
  const { question, context, from, close } = useAskPanel();
  const still = useReducedMotion();
  const nav = useNavigate();
  const [turn, setTurn] = useState<Turn>({ q: question, text: '', message: null, error: null, streaming: true });
  const [conv, setConv] = useState<string | null>(null);
  const [follow, setFollow] = useState('');
  const [acting, setActing] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const ask = (q: string, conversationId: string | null, withContext: boolean) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setTurn({ q, text: '', message: null, error: null, streaming: true });
    const text = withContext && context ? `${q}\n\n(I am looking at ${context}.)` : q;
    askAi(conversationId, { text, mode: 'auto', attachmentIds: [], timeZone: deviceZone() }, (e) => {
      if (e.name === 'started') setConv(e.conversationId);
      else if (e.name === 'text') setTurn((t) => ({ ...t, text: t.text + e.delta }));
      else if (e.name === 'done') setTurn((t) => ({ ...t, message: e.message, text: e.message.content || t.text, streaming: false }));
      else if (e.name === 'error') setTurn((t) => ({ ...t, error: e.message, text: e.saved?.content || t.text, message: e.saved ?? null, streaming: false }));
    }, ctl.signal)
      .then(() => setTurn((t) => (t.streaming ? { ...t, streaming: false } : t)))
      .catch((e) => { if (!ctl.signal.aborted) setTurn((t) => ({ ...t, streaming: false, error: e instanceof ApiError ? e.message : 'The assistant could not be reached.' })); });
  };
  useEffect(() => { ask(question, null, true); return () => abort.current?.abort(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  const { before, table, after } = useMemo(() => splitTable(turn.text), [turn.text]);
  const m = turn.message;
  const sources: AiKnowledgeSource[] = m?.sources ?? [];
  const toolChips = !sources.length ? (m?.tools ?? []).filter((t) => t.label).map((t) => ({ key: t.name, label: t.count != null ? `${t.label} · ${t.count}` : t.label })) : [];
  const projects = sources.filter((s) => s.kind === 'project').length + (table && /project/i.test(table.head[0] ?? '') ? table.rows.length : 0);
  const primary = projects >= 2 ? { label: 'Open Portfolio', to: '/work/projects?view=portfolio' } : sources[0] ? { label: `Open ${sources[0].key || sources[0].title}`, to: sources[0].link } : null;
  const next = m?.followUps?.[0] ?? null;
  const proposed: AiAction[] = (m?.actions ?? []).filter((a) => a.status === 'proposed').slice(0, 2);
  const done = !turn.streaming;
  const openFull = () => { close(); nav(conv ? `/?tab=assistant&c=${encodeURIComponent(conv)}` : '/?tab=assistant', conv ? undefined : { state: { ask: turn.q, ts: Date.now() } }); };
  const go = (to: string) => { close(); nav(to); };
  const confirm = async (a: AiAction) => {
    if (!m) return;
    setActing(a.id);
    try {
      const r = await aiWorkspaceApi.confirm(m.id, a.id);
      setTurn((t) => (t.message ? { ...t, message: { ...t.message, actions: t.message.actions.map((x) => (x.id === r.id ? r : x)) } } : t));
      toast(r.status === 'done' ? `${a.title}: done.` : r.error ?? `${a.title}: ${r.status}.`, r.status === 'failed' ? 'error' : 'success');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not do that.', 'error'); }
    finally { setActing(null); }
  };

  // Springs from the toolbar field's rectangle to the centred panel.
  const W = Math.min(760, window.innerWidth - 32);
  const left = (window.innerWidth - W) / 2;
  const initial = still || !from ? { opacity: 0 } : { opacity: 0.6, x: from.left - left, y: from.top - 62, scaleX: from.width / W, scaleY: from.height / 160 };

  return (
    <div className="ask-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <motion.div ref={panel} className="ask-p" role="dialog" aria-modal="true" aria-label="Ask" style={{ width: W, left, transformOrigin: '0 0' }}
        initial={initial} animate={{ opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1 }} transition={still ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 22 }}>
        <div className="ask-q">
          <span className={`ask-orb${turn.streaming ? ' live' : ''}`} aria-hidden="true" />
          <h2>{turn.q}</h2>
          <button type="button" className="ask-full" onClick={openFull}>Open in Assistant</button>
          <kbd>esc</kbd>
        </div>
        <div className="ask-a" aria-live="polite" aria-busy={turn.streaming}>
          {!turn.text && turn.streaming && <p className="ask-wait"><span className="ask-cur" /></p>}
          {before && <Streamed text={before} done={done} />}
          {turn.streaming && !table && turn.text && <span className="ask-cur" aria-hidden="true" />}
          {table && (
            <table className="ask-t">
              <thead><tr>{table.head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
              <tbody>
                {table.rows.map((r, ri) => (
                  <tr key={ri} style={{ animationDelay: `${ri * 80}ms` }}>
                    {table.head.map((h, ci) => <td key={ci} className={ci === table.head.length - 1 && table.head.length > 2 ? 'muted' : undefined}>
                      {ci === 0 && <span className="ask-dot" style={{ background: ROW_DOTS[ri % ROW_DOTS.length] }} />}<Cell text={r[ci] ?? ''} col={ci} head={h} />
                    </td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {after && <div className="ask-after"><Streamed text={after} done={done} /></div>}
          {turn.error && <p className="ask-err" role="alert">{turn.error}</p>}
          {done && (sources.length > 0 || toolChips.length > 0) && (
            <div className="ask-src">
              <span className="ask-sugg">Sources</span>
              {sources.slice(0, 6).map((s) => (
                <button key={`${s.kind}:${s.id}`} type="button" className="ask-s" onClick={() => go(s.link)} title={s.title}>
                  {SOURCE_GLYPH[s.kind.toLowerCase()] ?? '▤'} {s.key && s.key !== s.title ? `${s.key} ${s.title}` : s.title}
                </button>
              ))}
              {toolChips.slice(0, 6).map((t) => <span key={t.key} className="ask-s">▤ {t.label}</span>)}
            </div>
          )}
        </div>
        <div className={`ask-acts${done ? ' in' : ''}`}>
          {primary && <button type="button" className="ask-btn pri" onClick={() => go(primary.to)}>{primary.label}</button>}
          {next && <button type="button" className="ask-btn" onClick={() => ask(next, conv, false)}><span className="ask-orb sm" aria-hidden="true" />{next}</button>}
          {proposed.map((a) => <button key={a.id} type="button" className="ask-btn" disabled={acting === a.id} title={a.summary} onClick={() => void confirm(a)}>{a.title}</button>)}
          <span className="ask-sp" />
          <form className="ask-follow" onSubmit={(e) => { e.preventDefault(); const q = follow.trim(); if (!q) return; setFollow(''); ask(q, conv, false); }}>
            <input value={follow} onChange={(e) => setFollow(e.target.value)} placeholder="Ask a follow‑up · ↩" aria-label="Ask a follow-up" />
          </form>
        </div>
      </motion.div>
    </div>
  );
}
