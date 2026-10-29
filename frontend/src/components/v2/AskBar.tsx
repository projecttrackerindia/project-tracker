import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { insightApi, projectApi } from '../../api/endpoints';
import { Icon, type IconName } from '../Icon';
import { useWsQuery } from '../../lib/hooks';
import { useAi, useAssistant } from '../../features/ai/Assistant';
import { AuraOrb } from '../aura/AuraOrb';
import { openGroot, useGroot } from '../groot/store';
import { openNew, pageContext, useCopilot, useNewSheet, type NewType } from './state';
import { openPalette, searchHitLink } from '../CommandPalette';
import { useIsMobile } from '../../lib/mobile';
import { NotificationBell } from '../../features/notifications/centre/NotificationCentre';
import { AttendanceCapsule } from '../../features/attendance/AttendanceCapsule';
import './v2.css';

/** The project page's id, when the page is one project (the dock then asks about that project). */
const projectIdOf = (pathname: string) => /^\/work\/projects\/([0-9a-f-]{8,})/i.exec(pathname)?.[1] ?? null;

/**
 * True while the person scrolls down through a page, so the dock steps aside instead of covering the rows they are reading; it comes back
 * when they scroll up (and, unless `sticky`, the moment they stop for 450 ms). Listens on capture so page-level scroll containers count too.
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
 * The toolbar at the top of the main area on wide screens (1100px and up): one quiet line. No Ask field and no + New any more (Aura's dock
 * at the bottom of every page does both): a page's own control portalled in on the left, the check-in capsule and the bell on the right.
 */
export function Toolbar() {
  return (
    <div className="v2-tb" role="toolbar" aria-label="Your day">
      <span className="v2-tb-sp" />
      <AttendanceCapsule />
      <NotificationBell />
    </div>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** What + New used to make, as chips above the dock: each opens the same create flow (with the words typed so far); More… has the rest. */
export const AURA_CHIPS: { id: string; label: string; icon: IconName; type: NewType | null }[] = [
  { id: 'task', label: 'Create a task', icon: 'checkCircle', type: 'task' },
  { id: 'time', label: 'Log time', icon: 'timer', type: 'time' },
  { id: 'meeting', label: 'Schedule a meeting', icon: 'calendar', type: 'meeting' },
  { id: 'ticket', label: 'Raise a ticket', icon: 'target', type: 'ticket' },
  { id: 'doc', label: 'Write a doc', icon: 'note', type: 'doc' },
  { id: 'more', label: 'More…', icon: 'grid', type: null },
];

/**
 * Aura's dock: a glass pill at the bottom centre of every page, the orb and one field ("Ask Aura or tell it what to do"; ⌘K / Ctrl K puts
 * the cursor in it, pressed again it opens the command palette). Focused, chips above it make anything + New made (a task, time, a
 * meeting, a ticket, a doc, and More… for the rest); typing shows quick-find results; Enter asks Aura, whose chat opens on the right (a
 * full sheet on a phone). On a project page it asks about that project. On a phone it sits above the tab bar and steps aside while the
 * page scrolls down. With the assistant off, Enter opens the command palette (find, go to) and the chips still create.
 */
export function AskBar() {
  const phone = useIsMobile();
  const away = useScrollingAway(phone);
  const ai = useAi();
  const chatOpen = useGroot((s) => s.open);
  const creating = useNewSheet((s) => s.open);   // the create sheet covers the page: the dock waits behind nothing
  const { pathname, search } = useLocation();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState(-1);
  const [debounced, setDebounced] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const projectId = projectIdOf(pathname);
  const project = useWsQuery(['project', projectId], () => projectApi.get(projectId!), { enabled: ai && !!projectId, staleTime: 60_000 });
  const projectName = project.data?.project.name ?? null;
  useEffect(() => { const t = window.setTimeout(() => setDebounced(q.trim()), 200); return () => window.clearTimeout(t); }, [q]);
  const hits = useWsQuery(['quick-find', debounced], () => insightApi.search(debounced), { enabled: ai && focused && debounced.length >= 2, staleTime: 30_000, retry: false });
  const found = (focused && debounced.length >= 2 ? hits.data?.hits ?? [] : []).slice(0, 5);

  // ⌘K / Ctrl K: into the dock. Pressed again from inside it, the command palette opens as before (go to, create, settings).
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
  const where = pageContext(pathname, search);
  const ask = () => {
    const text = q.trim();
    setQ(''); input.current?.blur();
    if (projectId) openGroot(text || null, null, projectName);
    else openGroot(text || null, where && where !== 'Home' ? where : null);
  };
  const create = (type: NewType | null) => {
    const text = q.trim();
    setQ(''); input.current?.blur();
    openNew(type, text);
  };
  const go = (i: number) => { const h = found[i]; if (!h) return; setQ(''); input.current?.blur(); nav(searchHitLink(h)); };
  const placeholder = !ai ? 'Find or create anything' : projectId ? `Ask Aura about ${projectName ?? 'this project'}` : 'Ask Aura or tell it what to do';
  return (
    <div className={`aura-dock-wrap${away ? ' away' : ''}${focused ? ' focused' : ''}${chatOpen || creating ? ' chat-open' : ''}`} data-testid="aura-dock">
      {focused && (
        <div className="aura-above" onMouseDown={(e) => e.preventDefault()}>
          {found.length > 0 && (
            <div className="gq-pop aura-find" id="aura-quick-find" role="listbox" aria-label="Quick find">
              <div className="gq-head">Go to</div>
              {found.map((h, i) => (
                <button key={`${h.type}:${h.id}`} type="button" role="option" aria-selected={sel === i} className="gq-row" onClick={() => go(i)}>
                  <Icon name="search" size={14} /><span>{h.title}</span>{h.subtitle && <small>{h.subtitle}</small>}
                </button>
              ))}
            </div>
          )}
          <div className="aura-chips" role="group" aria-label="Create">
            {AURA_CHIPS.map((c) => (
              <button key={c.id} type="button" className="aura-chip" data-chip={c.id} onClick={() => create(c.type)}>
                <Icon name={c.icon} size={13} />{c.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <form className={`v2-ask aura-dock${away ? ' away' : ''}`} role="search" aria-label="Ask Aura"
        onSubmit={(e) => { e.preventDefault(); if (sel >= 0 && found[sel]) go(sel); else if (ai) ask(); else { input.current?.blur(); setQ(''); openPalette(); } }}
        onClick={() => { if (away) input.current?.focus(); }}>
        <button type="button" className="aura-dock-orb" aria-label="Open Aura" title="Open Aura" onMouseDown={(e) => e.preventDefault()}
          onClick={() => { if (!ai) openPalette(); else if (projectId) openGroot(null, null, projectName); else openGroot(null, where && where !== 'Home' ? where : null); }}>
          <AuraOrb size={phone ? 34 : 40} label={null} />
        </button>
        <input ref={input} value={q} placeholder={placeholder} aria-label={placeholder} data-aura-input="" autoComplete="off" enterKeyHint="send"
          role="combobox" aria-expanded={found.length > 0} aria-controls="aura-quick-find" aria-autocomplete="list"
          onChange={(e) => { setQ(e.target.value); setSel(-1); }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setQ(''); input.current?.blur(); }
            else if (e.key === 'ArrowDown' && found.length) { e.preventDefault(); setSel((s) => Math.min(found.length - 1, s + 1)); }
            else if (e.key === 'ArrowUp' && found.length) { e.preventDefault(); setSel((s) => Math.max(-1, s - 1)); }
          }} />
        <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        <button type="submit" className="v2-ask-send" aria-label="Send to Aura"><Icon name="arrowUp" size={16} /></button>
      </form>
    </div>
  );
}

/**
 * The copilot is Aura now: anything that opens "the copilot" (a work item's "Ask Aura", a project's pill) or asks the assistant with a
 * question in hand (the command palette, "AI summary" on the portfolio) opens the Aura chat with it.
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
