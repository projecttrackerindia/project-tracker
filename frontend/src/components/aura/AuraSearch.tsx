import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { chatApi, insightApi } from '../../api/endpoints';
import type { SearchHit } from '../../api/types';
import { useWsQuery } from '../../lib/hooks';
import { haptic, useIsMobile } from '../../lib/mobile';
import { lockScroll } from '../../lib/scrollLock';
import { appZone } from '../../lib/zone';
import { useAi } from '../../features/ai/Assistant';
import { openGroot } from '../groot/store';
import { DEFAULT_DAY, dayPart, suggestionsFor } from '../groot/grootTime';
import { searchHitLink } from '../paletteLink';
import { useAuraMood } from './mood';
import { SiriOrb } from './SiriOrb';
import './auraSearch.css';

/** Open state of the Aura search sheet (the header orb, the phone orb and ⌘K / Ctrl K). */
export const useAuraSearch = create<{ open: boolean; context: string | null; about: string | null; show: (where?: { context: string | null; about: string | null } | null) => void; hide: () => void }>((set) => ({
  open: false, context: null, about: null,
  show: (where) => set({ open: true, context: where?.context ?? null, about: where?.about ?? null }),
  hide: () => set({ open: false }),
}));
export const toggleAuraSearch = (where?: { context: string | null; about: string | null } | null) => {
  const s = useAuraSearch.getState();
  if (s.open) s.hide(); else s.show(where);
};

export type SearchKind = 'all' | 'project' | 'task' | 'person' | 'message' | 'file' | 'note' | 'action';
export const SEARCH_FILTERS: { id: SearchKind; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'project', label: 'Projects' }, { id: 'task', label: 'Tasks' }, { id: 'person', label: 'People' },
  { id: 'message', label: 'Messages' }, { id: 'file', label: 'Files' }, { id: 'note', label: 'Notes' }, { id: 'action', label: 'Action items' },
];
const KIND_OF: Record<string, SearchKind> = { project: 'project', task: 'task', issue: 'task', work: 'task', comment: 'task', member: 'person', team: 'person', file: 'file', page: 'note', action: 'action' };
const KIND_LABEL: Record<SearchKind, string> = { all: '', project: 'Project', task: 'Task', person: 'Person', message: 'Message', file: 'File', note: 'Note', action: 'Action item' };
const KIND_TONE: Record<SearchKind, string> = { all: '#8e8e93', project: '#f59e0b', task: '#0ea5e9', person: '#7c5cff', message: '#10b981', file: '#64748b', note: '#ec4899', action: '#ef4444' };

export interface AuraResult { key: string; kind: SearchKind; title: string; sub: string | null; link: string }

/** Turns the global search and the chat search into one list (no deleted items: the server leaves them out; no private chats). */
export function mergeResults(hits: SearchHit[], messages: { messageId: string; conversationId: string; conversationName: string; senderName: string | null; snippet: string }[]): AuraResult[] {
  const out: AuraResult[] = [];
  for (const h of hits) {
    const kind = KIND_OF[h.type];
    if (!kind) continue;   // labels and other settings stay in the command palette
    out.push({ key: `${h.type}:${h.id}`, kind, title: h.title, sub: h.subtitle, link: searchHitLink(h) });
  }
  for (const m of messages) out.push({ key: `msg:${m.messageId}`, kind: 'message', title: m.snippet, sub: [m.conversationName, m.senderName].filter(Boolean).join(' · '), link: `/messages/${m.conversationId}` });
  return out;
}

/**
 * Aura is search: one sheet with the field, then Results (projects, tasks, people, messages, files, notes and action items, with filter
 * chips) and "Ask Aura" suggestions under them. ↑/↓ move through both lists, Enter opens a result or asks Aura, ←/→ with ⌥ change the
 * filter, Esc closes. A top sheet on a phone, a centred panel on desktop. Mounted once in the shell.
 */
export function AuraSearchHost() {
  const open = useAuraSearch((s) => s.open);
  return open ? <AuraSearchSheet /> : null;
}

function AuraSearchSheet() {
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
  const setMood = useAuraMood((s) => s.set);
  useEffect(() => { const t = window.setTimeout(() => setDebounced(q.trim()), 160); return () => window.clearTimeout(t); }, [q]);
  useEffect(() => { setMood('aura-search', q ? 'listen' : null); return () => setMood('aura-search', null); }, [q, setMood]);
  useEffect(() => { const unlock = lockScroll('body'); window.setTimeout(() => input.current?.focus({ preventScroll: true }), 20); return unlock; }, []);
  // Esc closes even before the field has the focus.
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof Node && e.target.parentElement?.closest('.aura-s'))) { e.preventDefault(); hide(); } };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [hide]);
  const enabled = debounced.length >= 2;
  const hits = useWsQuery(['aura-search', debounced], () => insightApi.search(debounced), { enabled, staleTime: 30_000, retry: false });
  const msgs = useWsQuery(['aura-search-chat', debounced], () => chatApi.search(debounced).catch(() => []), { enabled, staleTime: 30_000, retry: false });
  const thinking = enabled && (hits.isFetching || msgs.isFetching);
  const all = useMemo(() => enabled ? mergeResults(hits.data?.hits ?? [], msgs.data ?? []) : [], [enabled, hits.data, msgs.data]);
  const counts = useMemo(() => { const c: Partial<Record<SearchKind, number>> = {}; for (const r of all) c[r.kind] = (c[r.kind] ?? 0) + 1; return c; }, [all]);
  const results = (kind === 'all' ? all : all.filter((r) => r.kind === kind)).slice(0, kind === 'all' ? 12 : 30);
  const asks = useMemo(() => {
    if (!ai) return [];
    const t = q.trim();
    if (t.length >= 2) return [
      { label: `"What's blocking ${t} this week?"`, prompt: `What's blocking ${t} this week?` },
      { label: `"Summarise everything about ${t}"`, prompt: `Summarise everything about ${t}` },
      { label: `Ask Aura: "${t}"`, prompt: t },
    ];
    return suggestionsFor(dayPart(new Date(), { ...DEFAULT_DAY, zone: appZone() }), about).filter((x) => !x.action).slice(0, 3).map((x) => ({ label: x.label, prompt: x.prompt }));
  }, [ai, q, about]);
  const total = results.length + asks.length;
  useEffect(() => { setSel(0); }, [debounced, kind]);
  useEffect(() => { list.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const go = (r: AuraResult) => { hide(); nav(r.link); };
  const ask = (prompt: string) => { hide(); openGroot(prompt, about ? null : context && context !== 'Home' ? context : null, about); };
  const chat = () => { hide(); openGroot(null, about ? null : context && context !== 'Home' ? context : null, about); };
  const activate = (i: number) => { if (i < results.length) go(results[i]); else if (asks[i - results.length]) ask(asks[i - results.length].prompt); else if (ai && q.trim()) ask(q.trim()); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); hide(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(total - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (ai && !q.trim()) chat(); else activate(sel); }
    else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const i = SEARCH_FILTERS.findIndex((f) => f.id === kind);
      setKind(SEARCH_FILTERS[(i + (e.key === 'ArrowRight' ? 1 : SEARCH_FILTERS.length - 1)) % SEARCH_FILTERS.length].id);
    }
  };
  const optId = (i: number) => `aura-s-opt-${i}`;
  return createPortal(
    <div className={`aura-s-root${phone ? ' phone' : ''}`} data-testid="aura-search">
      <div className="aura-s-scrim" onClick={hide} />
      <div className="aura-s" role="dialog" aria-modal="true" aria-label="Search and ask Aura" onKeyDown={onKey}>
        <div className="aura-s-field">
          {ai ? <button type="button" className="aura-s-open" onClick={chat} aria-label="Open the Aura chat" title="Open the Aura chat"><SiriOrb size={26} state={thinking ? 'thinking' : q ? 'listening' : 'idle'} /></button>
            : <SiriOrb size={26} state={thinking ? 'thinking' : q ? 'listening' : 'idle'} />}
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={ai ? 'Search or ask Aura' : 'Search everything'} aria-label="Search or ask Aura"
            role="combobox" aria-expanded={total > 0} aria-controls="aura-s-list" aria-activedescendant={total ? optId(sel) : undefined} autoComplete="off" enterKeyHint="search" data-testid="aura-search-input" />
          {phone ? <button type="button" className="aura-s-cancel" onClick={hide}>Cancel</button> : <kbd className="aura-s-kbd">esc</kbd>}
        </div>
        {enabled && (
          <div className="aura-s-chips" role="tablist" aria-label="Filter results">
            {SEARCH_FILTERS.filter((f) => f.id === 'all' || counts[f.id] || kind === f.id).map((f) => (
              <button key={f.id} type="button" role="tab" aria-selected={kind === f.id} className={kind === f.id ? 'on' : ''} data-filter={f.id} onClick={() => { haptic(); setKind(f.id); input.current?.focus(); }}>
                {f.label}{f.id !== 'all' && counts[f.id] ? <small>{counts[f.id]}</small> : null}
              </button>
            ))}
          </div>
        )}
        <div className="aura-s-body" id="aura-s-list" role="listbox" ref={list}>
          {enabled && (
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
              ) : <p className="aura-s-empty">{thinking ? 'Searching…' : `Nothing matches "${debounced}"${kind !== 'all' ? ' in this filter' : ''}.`}</p>}
            </section>
          )}
          {asks.length > 0 && (
            <section>
              <h4>Ask Aura</h4>
              <ul className="aura-s-group">
                {asks.map((a, j) => { const i = results.length + j; return (
                  <li key={a.label}><button type="button" id={optId(i)} role="option" aria-selected={sel === i} data-sel={sel === i} className="aura-s-row ask" onMouseMove={() => setSel(i)} onClick={() => ask(a.prompt)}>
                    <SiriOrb size={22} state="idle" /><span className="aura-s-t"><b>{a.label}</b></span>
                  </button></li>
                ); })}
              </ul>
            </section>
          )}
          {!enabled && !asks.length && <p className="aura-s-empty">Type two letters to search projects, tasks, people, messages, files, notes and action items.</p>}
        </div>
        {!phone && <div className="aura-s-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>⌥</kbd><kbd>←</kbd><kbd>→</kbd> filter</span><span><kbd>⌘⇧K</kbd> commands</span></div>}
      </div>
    </div>,
    document.body,
  );
}
