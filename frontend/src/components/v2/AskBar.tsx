import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { projectApi } from '../../api/endpoints';
import { Icon } from '../Icon';
import { PageLoader } from '../ui';
import { useWsQuery } from '../../lib/hooks';
import { useAi, useAssistant } from '../../features/ai/Assistant';
import { SidePanel } from './SidePanel';
import { openNew, pageContext, useAskPanel, useCopilot } from './state';
import { openPalette } from '../CommandPalette';
import { useIsMobile } from '../../lib/mobile';
import './v2.css';

const AiPage = lazy(() => import('../../features/ai/AiPage').then((m) => ({ default: m.AiPage })));

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
 * The toolbar at the top of the main area on wide screens (1100px and up): the Ask field (orb, "Ask or find anything", ⌘K) and + New on the
 * right. The field asks the assistant like the Ask bar; with the assistant off it opens the command palette (go to, find, create).
 */
export function Toolbar() {
  const ai = useAi();
  const { pathname, search } = useLocation();
  const showAsk = useAskPanel((s) => s.show);
  const field = useRef<HTMLFormElement>(null);
  /** The question opens the Ask panel, springing out of this field (the copilot panel stays for the floating bar and project pages). */
  const submit = (text: string) => {
    const where = pageContext(pathname, search);
    const r = field.current?.getBoundingClientRect();
    input.current?.blur();
    showAsk(text, where && where !== 'Home' ? where : null, r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null);
  };
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
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
  return (
    <div className="v2-tb" role="toolbar" aria-label="Ask and create">
      <span className="v2-tb-sp" />
      <form ref={field} className="v2-tb-ask" role="search" aria-label="Ask the assistant" onSubmit={(e) => { e.preventDefault(); const t = q.trim(); if (!t) return; setQ(''); submit(t); }}
        onMouseDown={(e) => { if (!ai) { e.preventDefault(); openPalette(); } }}>
        <span className="v2-orb" aria-hidden="true" />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask or find anything" aria-label="Ask or find anything" readOnly={!ai}
          onFocus={() => { if (!ai) { input.current?.blur(); openPalette(); } }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); input.current?.blur(); } }} />
        <kbd>⌘K</kbd>
      </form>
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
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const show = useCopilot((s) => s.show);
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
    <button type="button" className={`v2-ask corner${away ? ' away' : ''}`} onClick={() => show(projectName)} aria-label={`Ask about ${projectName ?? 'this project'}`}>
      <span className="v2-orb" aria-hidden="true" /><span>Ask about {projectName ?? 'this project'}</span>
    </button>
  );
  const where = pageContext(pathname, search);
  const ask = () => {
    const text = q.trim();
    if (!text) return;
    setQ('');
    show(null);
    // The copilot's conversation reads the question from the address's state, like every other "ask with a question in hand".
    nav(`${pathname}${search}`, { state: { ask: where && where !== 'Home' ? `${text}\n\n(I am looking at ${where}.)` : text, ts: Date.now() } });
  };
  return (
    <form className={`v2-ask${away ? ' away' : ''}`} role="search" aria-label="Ask the assistant" onSubmit={(e) => { e.preventDefault(); ask(); }}
      onClick={() => { if (away) input.current?.focus(); }}>
      <span className="v2-orb" aria-hidden="true" /><span className="v2-ask-pill" aria-hidden="true">Ask</span>
      <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask, find, or tell it what to do…" aria-label="Ask, find, or tell it what to do"
        onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); input.current?.blur(); } }} />
      <kbd>⌘K</kbd>
      <button type="submit" className="v2-ask-send" aria-label="Ask" disabled={!q.trim()}><Icon name="arrowUp" size={16} /></button>
    </form>
  );
}

/**
 * The copilot: the assistant's conversation in the right-hand panel, about a project or about the page it was asked from. Anything that asks
 * the assistant from elsewhere (the command palette, "AI summary" on the portfolio) opens it here too, with the question in hand.
 */
export function CopilotHost() {
  const { open, about, close, show } = useCopilot();
  const ai = useAi();
  const nav = useNavigate();
  const { pathname, search } = useLocation();
  const asked = useAssistant();
  const handledSummary = useRef(0);
  useEffect(() => {
    if (!asked.open) return;
    const summarise = asked.summary !== handledSummary.current;
    handledSummary.current = asked.summary;
    asked.close();
    const q = summarise ? 'Give me an executive summary of all active projects: what needs attention, what is going well and what I should do next.' : asked.question || undefined;
    show(null);
    if (q) nav(`${pathname}${search}`, { state: { ask: q, ts: Date.now() } });
  }, [asked, show, nav, pathname, search]);
  if (!open || !ai) return null;
  const suggestions = about
    ? [`What is at risk on ${about}?`, `Summarise ${about} this week`, `What is overdue on ${about}, and who owns it?`]
    : ['What needs me today?', 'What is overdue on my team?', 'Draft my week'];
  return (
    <SidePanel ai eyebrow="✦ Copilot" title={about ? `Ask about ${about}` : 'Ask'} onClose={close} width={520} flush>
      <div className="v2-copilot">
        <Suspense fallback={<PageLoader />}>
          <AiPage home={{
            actions: null,
            start: ({ ask, composer }) => (
              <div className="v2-copilot-start">
                <div className="v2-copilot-hints">{suggestions.map((s) => <button key={s} type="button" className="ds-chip suggest" onClick={() => ask(about ? `About project ${about}: ${s}` : s)}>{s}</button>)}</div>
                {composer}
              </div>
            ),
          }} />
        </Suspense>
      </div>
    </SidePanel>
  );
}
