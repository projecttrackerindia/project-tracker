import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { insightApi, projectApi } from '../../api/endpoints';
import { Icon } from '../Icon';
import { useWsQuery } from '../../lib/hooks';
import { useAi, useAssistant } from '../../features/ai/Assistant';
import { GrootAvatar } from '../groot/GrootAvatar';
import { openGroot } from '../groot/store';
import { openNew, pageContext, useCopilot } from './state';
import { openPalette, searchHitLink } from '../CommandPalette';
import { useIsMobile } from '../../lib/mobile';
import { NotificationBell } from '../../features/notifications/centre/NotificationCentre';
import { AttendancePill } from '../../features/attendance/AttendancePill';
import './v2.css';

/** The project page's id, when the page is one project (its Ask bar becomes "Ask about <project>"). */
const projectIdOf = (pathname: string) => /^\/work\/projects\/([0-9a-f-]{8,})/i.exec(pathname)?.[1] ?? null;

/**
 * The Ask bar: a floating glass pill at the bottom centre of every page (⌘K / Ctrl K puts the cursor in it). A question goes to the assistant
 * with where the person is, and the answer opens in the copilot panel on the right, so the page stays in view. On a project page it is a
 * small pill at the bottom right, "Ask about <project>", that opens the copilot about that project.
 */
/**
 * True while the person scrolls down through a page, so the floating bar steps aside instead of covering the rows they are reading; it
 * comes back the moment they stop (450 ms) or scroll up. Listens on capture so page-level scroll containers count too.
 */
function useScrollingAway(sticky = false): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const last = new WeakMap<EventTarget, number>();
    let timer: number | undefined;
    const onScroll = (e: Event) => {
      const t = e.target === document ? document.scrollingElement : (e.target as Element | null);
      if (!t) return;
      const y = (t as Element).scrollTop;
      const prev = last.get(t) ?? y;
      last.set(t, y);
      if (y > prev + 4) setAway(true); else if (y < prev - 4) setAway(false);
      window.clearTimeout(timer);
      if (y <= 8) setAway(false);
      if (!sticky) timer = window.setTimeout(() => setAway(false), 450);
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => { document.removeEventListener('scroll', onScroll, { capture: true }); window.clearTimeout(timer); };
  }, [sticky]);
  return away;
}

/**
 * The toolbar at the top of the main area on wide screens (1100px and up): the Ask field (Groot, "Ask Groot or find anything", ⌘K) and
 * + New on the right. Typing shows quick-find results under the field (go straight to a project, task or page); Enter, or the first row,
 * asks Groot, whose chat opens on the right. With the assistant off the field opens the command palette (go to, find, create).
 */
export function Toolbar() {
  const ai = useAi();
  const { pathname, search } = useLocation();
  const nav = useNavigate();
  const field = useRef<HTMLFormElement>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [debounced, setDebounced] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = window.setTimeout(() => setDebounced(q.trim()), 200); return () => window.clearTimeout(t); }, [q]);
  const hits = useWsQuery(['quick-find', debounced], () => insightApi.search(debounced), { enabled: ai && debounced.length >= 2, staleTime: 30_000, retry: false });
  const found = (debounced.length >= 2 ? hits.data?.hits ?? [] : []).slice(0, 6);
  const asking = (text: string) => {
    const where = pageContext(pathname, search);
    input.current?.blur(); setOpen(false); setQ('');
    openGroot(text, where && where !== 'Home' ? where : null);
  };
  const choose = (i: number) => {
    const t = q.trim();
    if (i === 0) { if (t) asking(t); else { setOpen(false); openGroot(); } return; }
    const h = found[i - 1];
    if (!h) return;
    setOpen(false); setQ(''); input.current?.blur(); nav(searchHitLink(h));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k' || e.shiftKey || e.altKey) return;
      if (!ai || !input.current || input.current.offsetParent === null || document.activeElement === input.current) return;
      e.preventDefault(); e.stopImmediatePropagation();
      input.current.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ai]);
  const showPop = ai && open && q.trim().length > 0;
  return (
    <div className="v2-tb" role="toolbar" aria-label="Ask and create">
      <span className="v2-tb-sp" />
      <form ref={field} className="v2-tb-ask" role="search" aria-label="Ask Groot" style={{ position: 'relative' }} onSubmit={(e) => { e.preventDefault(); choose(sel); }}
        onMouseDown={(e) => { if (!ai) { e.preventDefault(); openPalette(); } }}>
        <button type="button" className="v2-tb-groot" aria-label="Open Groot" title="Open Groot" onClick={() => { if (ai) openGroot(); }}><GrootAvatar size={22} state={q.trim() ? 'listening' : 'idle'} /></button>
        <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); setSel(0); }} placeholder="Ask Groot or find anything" aria-label="Ask Groot or find anything" readOnly={!ai}
          role="combobox" aria-expanded={showPop} aria-controls="groot-quick-find" aria-autocomplete="list"
          onFocus={() => { if (!ai) { input.current?.blur(); openPalette(); } else setOpen(true); }}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setQ(''); setOpen(false); input.current?.blur(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(found.length, s + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
          }} />
        <kbd>⌘K</kbd>
        {showPop && (
          <div className="gq-pop" id="groot-quick-find" role="listbox" aria-label="Quick find" onMouseDown={(e) => e.preventDefault()}>
            <button type="button" role="option" aria-selected={sel === 0} className="gq-row" onClick={() => choose(0)}>
              <GrootAvatar size={18} /><span>Ask Groot: “{q.trim()}”</span><small>↵</small>
            </button>
            {found.length > 0 && <div className="gq-head">Go to</div>}
            {found.map((h, i) => (
              <button key={`${h.type}:${h.id}`} type="button" role="option" aria-selected={sel === i + 1} className="gq-row" onClick={() => choose(i + 1)}>
                <Icon name="search" size={14} /><span>{h.title}</span>{h.subtitle && <small>{h.subtitle}</small>}
              </button>
            ))}
          </div>
        )}
      </form>
      <NotificationBell />
      <AttendancePill />
      <button type="button" className="v2-tb-new" title="New (N)" onClick={() => openNew()}><Icon name="plus" size={14} /> New</button>
    </div>
  );
}

export function AskBar() {
  // On a phone the bar folds into a pill while scrolling down and stays folded until a scroll up or a tap (useIsMobile: the phone shell).
  const phone = useIsMobile();
  const away = useScrollingAway(phone);
  const ai = useAi();
  const { pathname, search } = useLocation();
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const projectId = projectIdOf(pathname);
  const project = useWsQuery(['project', projectId], () => projectApi.get(projectId!), { enabled: ai && !!projectId, staleTime: 60_000 });
  const projectName = project.data?.project.name ?? null;

  // ⌘K / Ctrl K: into the Ask bar. Pressed again from inside it, the command palette opens as before (go to, create, settings).
  useEffect(() => {
    if (!ai) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k' || e.shiftKey || e.altKey) return;
      // Hidden (the wide layout shows the toolbar's field instead): the toolbar takes ⌘K.
      if (!input.current || input.current.offsetParent === null || document.activeElement === input.current) return;
      e.preventDefault(); e.stopImmediatePropagation();
      input.current.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ai, projectId]);

  if (!ai) return null;
  if (projectId) return (
    <button type="button" className={`v2-ask corner${away ? ' away' : ''}`} onClick={() => openGroot(null, null, projectName)} aria-label={`Ask Groot about ${projectName ?? 'this project'}`}>
      <GrootAvatar size={22} /><span>Ask Groot about {projectName ?? 'this project'}</span>
    </button>
  );
  const where = pageContext(pathname, search);
  const ask = () => {
    const text = q.trim();
    if (!text) return;
    setQ('');
    input.current?.blur();
    openGroot(text, where && where !== 'Home' ? where : null);
  };
  return (
    <form className={`v2-ask${away ? ' away' : ''}`} role="search" aria-label="Ask Groot" onSubmit={(e) => { e.preventDefault(); ask(); }}
      onClick={() => { if (away) input.current?.focus(); }}>
      <GrootAvatar size={24} state={q.trim() ? 'listening' : 'idle'} /><span className="v2-ask-pill" aria-hidden="true">Groot</span>
      <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask Groot…" aria-label="Ask Groot"
        onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); input.current?.blur(); } }} />
      <kbd>⌘K</kbd>
      <button type="submit" className="v2-ask-send" aria-label="Ask Groot" disabled={!q.trim()}><Icon name="arrowUp" size={16} /></button>
    </form>
  );
}

/**
 * The copilot is Groot now: anything that opens "the copilot" (a work item's "Ask Groot", a project's pill) or asks the assistant with a
 * question in hand (the command palette, "AI summary" on the portfolio) opens the Groot chat with it.
 */
export function CopilotHost() {
  const { open, about, close } = useCopilot();
  const asked = useAssistant();
  const handledSummary = useRef(0);
  useEffect(() => {
    if (!open) return;
    close();
    openGroot(null, null, about);
  }, [open, about, close]);
  useEffect(() => {
    if (!asked.open) return;
    const summarise = asked.summary !== handledSummary.current;
    handledSummary.current = asked.summary;
    asked.close();
    openGroot(summarise ? 'Give me an executive summary of all active projects: what needs attention, what is going well and what I should do next.' : asked.question || null);
  }, [asked]);
  return null;
}
