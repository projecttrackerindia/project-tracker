import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { projectApi } from '../../api/endpoints';
import { Icon } from '../Icon';
import { PageLoader } from '../ui';
import { useWsQuery } from '../../lib/hooks';
import { useAi, useAssistant } from '../../features/ai/Assistant';
import { SidePanel } from './SidePanel';
import { pageContext, useCopilot } from './state';
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
function useScrollingAway(): boolean {
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
      timer = window.setTimeout(() => setAway(false), 450);
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => { document.removeEventListener('scroll', onScroll, { capture: true }); window.clearTimeout(timer); };
  }, []);
  return away;
}

export function AskBar() {
  const away = useScrollingAway();
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
      if (!input.current || document.activeElement === input.current) return;
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
    <form className={`v2-ask${away ? ' away' : ''}`} role="search" aria-label="Ask the assistant" onSubmit={(e) => { e.preventDefault(); ask(); }}>
      <span className="v2-orb" aria-hidden="true" />
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
