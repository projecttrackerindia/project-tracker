import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { chatApi, insightApi } from '../../api/endpoints';
import type { SearchHit } from '../../api/types';
import { useWsQuery } from '../../lib/hooks';
import { haptic, useIsMobile } from '../../lib/mobile';
import { lockScroll } from '../../lib/scrollLock';
import { appZone } from '../../lib/zone';
import { useAi } from '../../features/ai/Assistant';
import { openGroot, useGroot } from '../groot/store';
import { DEFAULT_DAY, dayPart, suggestionsFor } from '../groot/grootTime';
import { searchHitLink } from '../paletteLink';
import { useAuraMood } from './mood';
import { SiriOrb } from './SiriOrb';
import { useAuraSearch } from './AuraSearch';
import { useVoice } from './useVoice';
import './auraSearch.css';

type SearchKind = 'all' | 'project' | 'task' | 'person' | 'message' | 'file' | 'note' | 'action';
const SEARCH_FILTERS: { id: SearchKind; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'project', label: 'Projects' }, { id: 'task', label: 'Tasks' }, { id: 'person', label: 'People' },
  { id: 'message', label: 'Messages' }, { id: 'file', label: 'Files' }, { id: 'note', label: 'Notes' }, { id: 'action', label: 'Action items' },
];
const KIND_OF: Record<string, SearchKind> = { project: 'project', task: 'task', issue: 'task', work: 'task', comment: 'task', member: 'person', team: 'person', file: 'file', page: 'note', action: 'action' };
const KIND_LABEL: Record<SearchKind, string> = { all: '', project: 'Project', task: 'Task', person: 'Person', message: 'Message', file: 'File', note: 'Note', action: 'Action item' };
const KIND_TONE: Record<SearchKind, string> = { all: '#8e8e93', project: '#f59e0b', task: '#0ea5e9', person: '#7c5cff', message: '#10b981', file: '#64748b', note: '#ec4899', action: '#ef4444' };

interface AuraResult { key: string; kind: SearchKind; title: string; sub: string | null; link: string }

/** Turns the global search and the chat search into one list (no deleted items: the server leaves them out; no private chats). */
function mergeResults(hits: SearchHit[], messages: { messageId: string; conversationId: string; conversationName: string; senderName: string | null; snippet: string }[]): AuraResult[] {
  const out: AuraResult[] = [];
  for (const h of hits) {
    const kind = KIND_OF[h.type];
    if (!kind) continue;   // labels and other settings stay in the command palette
    out.push({ key: `${h.type}:${h.id}`, kind, title: h.title, sub: h.subtitle, link: searchHitLink(h) });
  }
  for (const m of messages) out.push({ key: `msg:${m.messageId}`, kind: 'message', title: m.snippet, sub: [m.conversationName, m.senderName].filter(Boolean).join(' · '), link: `/messages/${m.conversationId}` });
  return out;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const Mic = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);
const Up = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
);

/**
 * Aura, invoked (Siri-style). The edge of the whole viewport glows in slowly turning colour, the page behind blurs and dims, and one pill
 * at the bottom, "Ask Aura or search…", with a gradient rim and a mic, takes everything: typing searches inline (projects, tasks, people,
 * messages, files, notes and action items, with filter chips) and Enter asks Aura, whose answer floats above the bar as a frosted card
 * (GrootChat in card mode) with one primary action. Suggestions sit just above the bar. Holding the mic listens (Web Speech API) with
 * the words live and a colour wave; release sends. Esc, a tap outside or a swipe down closes it with a fade. ↑/↓ move through results,
 * ⌥←/→ change the filter, Enter on an empty bar opens the Aura chat panel. Motion is transform and opacity only.
 */
export default function AuraSurface({ leaving }: { leaving: boolean }) {
  const { context, about, hide } = useAuraSearch();
  const ai = useAi();
  const phone = useIsMobile();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState<SearchKind>('all');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLFormElement>(null);
  const chipsRow = useRef<HTMLDivElement>(null);
  const setMood = useAuraMood((s) => s.set);
  const answering = useGroot((s) => s.open && s.card && s.turns.some((t) => t.streaming));

  const where = about ? null : context && context !== 'Home' ? context : null;
  const ask = (prompt: string) => {
    const text = prompt.trim(); if (!text) return;
    setQ(''); setDebounced('');
    useGroot.getState().show(text, where, about, true);
    input.current?.focus({ preventScroll: true });
  };
  const chat = () => { hide(); openGroot(null, where, about); };
  const voice = useVoice((said) => { if (ai) ask(said); else { setQ(said); input.current?.focus(); } });
  const listening = voice.state === 'listening';

  useEffect(() => { const t = window.setTimeout(() => setDebounced(q.trim()), 160); return () => window.clearTimeout(t); }, [q]);
  useEffect(() => { setMood('aura-search', listening ? 'listen' : answering ? 'think' : q ? 'listen' : null); return () => setMood('aura-search', null); }, [q, listening, answering, setMood]);
  useEffect(() => { const unlock = lockScroll('body'); window.setTimeout(() => input.current?.focus({ preventScroll: true }), 20); return unlock; }, []);
  // Closing puts the answer card away with the glow (the side panel, when that is what is open, stays).
  useEffect(() => { if (leaving) { voice.stop(false); const g = useGroot.getState(); if (g.open && g.card) g.close(); } }, [leaving]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { const g = useGroot.getState(); if (g.open && g.card) g.close(); }, []);
  // Esc closes from anywhere (stops listening first; the answer card goes with the surface).
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      const v = voiceRef.current;
      if (v.state === 'listening') { v.stop(false); return; }
      useAuraSearch.getState().hide();
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, []);

  const enabled = debounced.length >= 2 && !listening;
  const hits = useWsQuery(['aura-search', debounced], () => insightApi.search(debounced), { enabled, staleTime: 30_000, retry: false });
  const msgs = useWsQuery(['aura-search-chat', debounced], () => chatApi.search(debounced).catch(() => []), { enabled, staleTime: 30_000, retry: false });
  const thinking = (enabled && (hits.isFetching || msgs.isFetching)) || answering;
  const all = useMemo(() => enabled ? mergeResults(hits.data?.hits ?? [], msgs.data ?? []) : [], [enabled, hits.data, msgs.data]);
  const counts = useMemo(() => { const c: Partial<Record<SearchKind, number>> = {}; for (const r of all) c[r.kind] = (c[r.kind] ?? 0) + 1; return c; }, [all]);
  const results = (kind === 'all' ? all : all.filter((r) => r.kind === kind)).slice(0, kind === 'all' ? 8 : 30);
  const asks = useMemo(() => {
    const t = debounced;
    if (!ai || t.length < 2) return [];
    return [
      { label: `Ask Aura: "${t}"`, prompt: t },
      { label: `"What's blocking ${t} this week?"`, prompt: `What's blocking ${t} this week?` },
      { label: `"Why is ${t} late?"`, prompt: `Why is ${t} late?` },
    ];
  }, [ai, debounced]);
  const suggestions = useMemo(() => ai ? suggestionsFor(dayPart(new Date(), { ...DEFAULT_DAY, zone: appZone() }), about).filter((x) => !x.action).slice(0, 3) : [], [ai, about]);
  const total = results.length + asks.length;
  useEffect(() => { setSel(0); }, [debounced, kind]);
  useEffect(() => { list.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  // Typing (or talking) again while an answer is up: the results or the words take the stage, the answer steps aside.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('aura-finding', enabled || listening);
    return () => root.classList.remove('aura-finding');
  }, [enabled, listening]);

  // The answer card (GrootChat in card mode, portalled to the body) floats above the suggestions: its centre, width and gap, as variables.
  useLayoutEffect(() => {
    const el = bar.current; if (!el) return;
    const root = document.documentElement;
    const put = () => {
      const r = el.getBoundingClientRect();
      const top = chipsRow.current?.getBoundingClientRect().top ?? r.top;
      const h = window.innerHeight;
      root.style.setProperty('--aura-cap-x', `${r.left + r.width / 2}px`);
      root.style.setProperty('--aura-cap-w', `${phone ? r.width - 8 : Math.min(r.width - 40, 600)}px`);
      root.style.setProperty('--aura-cap-gap', `${Math.round(Math.max(h - top + 18, h * (phone ? 0.3 : 0.33)))}px`);
    };
    put();
    const ro = new ResizeObserver(put); ro.observe(el);
    window.addEventListener('resize', put);
    return () => { ro.disconnect(); window.removeEventListener('resize', put); ['--aura-cap-x', '--aura-cap-w', '--aura-cap-gap'].forEach((k) => root.style.removeProperty(k)); };
  }, [phone]);

  // Swipe down (a phone) closes.
  const swipe = useRef<{ y: number; id: number } | null>(null);
  const onDown = (e: React.PointerEvent) => { if (e.pointerType !== 'mouse') swipe.current = { y: e.clientY, id: e.pointerId }; };
  const onUp = (e: React.PointerEvent) => { const s = swipe.current; swipe.current = null; if (s && s.id === e.pointerId && e.clientY - s.y > 70) hide(); };

  // The mic: a hold talks (release sends); a tap starts listening until the stop button. No API or no permission: type instead.
  const held = useRef<number | null>(null);
  const micDown = (e: React.PointerEvent) => {
    e.preventDefault();
    haptic(8);
    if (!voice.start()) { input.current?.focus(); return; }
    held.current = Date.now();
  };
  const micUp = () => { const t = held.current; held.current = null; if (t && Date.now() - t > 450) voice.stop(true); };

  const go = (r: AuraResult) => { hide(); nav(r.link); };
  const activate = (i: number) => { if (i < results.length) go(results[i]); else if (asks[i - results.length]) ask(asks[i - results.length].prompt); else if (ai && q.trim()) ask(q.trim()); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(total - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!q.trim()) { if (ai) chat(); return; }
      // Typed faster than the search: Enter asks Aura with the words (or opens the one highlighted result once it is there).
      if (debounced !== q.trim() || total === 0) { if (ai) ask(q); return; }
      activate(sel);
    }
    else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const i = SEARCH_FILTERS.findIndex((f) => f.id === kind);
      setKind(SEARCH_FILTERS[(i + (e.key === 'ArrowRight' ? 1 : SEARCH_FILTERS.length - 1)) % SEARCH_FILTERS.length].id);
    }
  };
  const optId = (i: number) => `aura-s-opt-${i}`;
  const ringState = listening ? 'listening' : thinking ? 'thinking' : q ? 'listening' : 'idle';
  const note = voice.state === 'unsupported' ? 'Voice isn’t available in this browser. Type instead.' : voice.state === 'denied' ? 'Microphone is off for this site. Type instead.' : null;
  const placeholder = note ?? (ai ? `Ask Aura or search…${phone ? '' : ` ${isMac ? '⌘K' : 'Ctrl K'}`}` : 'Search everything');

  return createPortal(
    <div className={`aura-x${phone ? ' phone' : ''}`} data-leaving={leaving || undefined} data-testid="aura-search" data-voice={voice.state} onPointerDown={onDown} onPointerUp={onUp}>
      <div className="aura-x-scrim" onClick={hide} aria-hidden="true" />
      <div className="aura-x-glow" aria-hidden="true"><div className="aura-x-rim"><i /></div></div>
      <div className="aura-x-col" role="dialog" aria-modal="true" aria-label="Search and ask Aura" onKeyDown={onKey}>
        <div className="aura-x-stage" onClick={(e) => { if (e.target === e.currentTarget) hide(); }}>
          {listening ? (
            <div className="aura-x-heard" role="status" aria-live="polite" data-testid="aura-voice">
              {voice.transcript && <p className="aura-x-said">“{voice.transcript}…”</p>}
              <p className="aura-x-listen">Listening</p>
            </div>
          ) : enabled ? (
            <div className="aura-x-card aura-s-results">
              <div className="aura-s-chips" role="tablist" aria-label="Filter results">
                {SEARCH_FILTERS.filter((f) => f.id === 'all' || counts[f.id] || kind === f.id).map((f) => (
                  <button key={f.id} type="button" role="tab" aria-selected={kind === f.id} className={kind === f.id ? 'on' : ''} data-filter={f.id} onClick={() => { haptic(); setKind(f.id); input.current?.focus(); }}>
                    {f.label}{f.id !== 'all' && counts[f.id] ? <small>{counts[f.id]}</small> : null}
                  </button>
                ))}
              </div>
              <div className="aura-s-body" id="aura-s-list" role="listbox" ref={list}>
                <section>
                  <h4>Results</h4>
                  {results.length > 0 ? (
                    <ul className="aura-s-group">
                      {results.map((r, i) => (
                        <li key={r.key}><button type="button" id={optId(i)} role="option" aria-selected={sel === i} data-sel={sel === i} className="aura-s-row" data-kind={r.kind}
                          onMouseMove={() => setSel(i)} onClick={() => go(r)}>
                          <span className="aura-s-mark" style={{ background: KIND_TONE[r.kind] }} aria-hidden="true">{KIND_LABEL[r.kind][0]}</span>
                          <span className="aura-s-t"><b>{r.title}</b><small>{KIND_LABEL[r.kind]}{r.sub ? ` · ${r.sub}` : ''}</small></span>
                        </button></li>
                      ))}
                    </ul>
                  ) : <p className="aura-s-empty">{hits.isFetching || msgs.isFetching ? 'Searching…' : `Nothing matches "${debounced}"${kind !== 'all' ? ' in this filter' : ''}.`}</p>}
                </section>
                {asks.length > 0 && (
                  <section>
                    <h4>Ask Aura</h4>
                    <ul className="aura-s-group">
                      {asks.map((a, j) => { const i = results.length + j; return (
                        <li key={a.label}><button type="button" id={optId(i)} role="option" aria-selected={sel === i} data-sel={sel === i} className="aura-s-row ask" onMouseMove={() => setSel(i)} onClick={() => ask(a.prompt)}>
                          <SiriOrb size={20} state="idle" /><span className="aura-s-t"><b>{a.label}</b></span>
                        </button></li>
                      ); })}
                    </ul>
                  </section>
                )}
              </div>
            </div>
          ) : null}
        </div>
        <div className="aura-x-chips" ref={chipsRow} role="group" aria-label="Suggestions" onMouseDown={(e) => e.preventDefault()}>
          {!listening && !enabled && suggestions.map((s) => <button key={s.label} type="button" className="aura-x-chip" onClick={() => ask(s.prompt)}>{s.label}</button>)}
        </div>
        <form ref={bar} className={`aura-x-bar${listening ? ' listening' : ''}`} role="search" onSubmit={(e) => e.preventDefault()}>
          {ai ? <button type="button" className="aura-s-open" onClick={chat} aria-label="Open the Aura chat" title="Open the Aura chat"><SiriOrb size={24} state={ringState} /></button>
            : <span className="aura-s-open"><SiriOrb size={24} state={ringState} /></span>}
          {listening ? (
            <span className="aura-x-wave" data-beat={voice.beat % 2} aria-hidden="true"><i /><i /><i /><i /><i /></span>
          ) : (
            <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); if (note) voice.reset(); }} placeholder={placeholder} aria-label="Ask Aura or search"
              role="combobox" aria-expanded={total > 0} aria-controls="aura-s-list" aria-activedescendant={enabled && total ? optId(sel) : undefined}
              autoComplete="off" enterKeyHint={ai ? 'send' : 'search'} data-testid="aura-search-input" data-aura-input="" />
          )}
          {listening ? (
            <button type="button" className="aura-x-stop" aria-label="Stop and send" onClick={() => voice.stop(true)}><span /></button>
          ) : q.trim() && ai ? (
            <button type="button" className="aura-x-mic send" aria-label="Ask Aura" onClick={() => ask(q)}><Up /></button>
          ) : (
            <button type="button" className="aura-x-mic" aria-label="Hold to talk to Aura" title="Hold to talk" data-testid="aura-mic"
              onPointerDown={micDown} onPointerUp={micUp} onPointerLeave={micUp} onContextMenu={(e) => e.preventDefault()}
              onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!voice.start()) input.current?.focus(); } }}><Mic /></button>
          )}
        </form>
      </div>
    </div>,
    document.body,
  );
}
