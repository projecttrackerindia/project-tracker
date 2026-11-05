import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { SiriOrb } from '../aura/SiriOrb';
import { useLocation, useNavigate } from 'react-router-dom';
import { insightApi, projectApi } from '../../api/endpoints';
import { Icon, type IconName } from '../Icon';
import { useWsQuery } from '../../lib/hooks';
import { useAi, useAssistant } from '../../features/ai/Assistant';
import { AuraOrb } from '../aura/AuraOrb';
import { toggleAuraSearch, useAuraSearch } from '../aura/AuraSearch';
import { dismissAura, invokeAura, openGroot, useAuraInvoke, useGroot } from '../groot/store';
import { useAuraMood } from '../aura/mood';
import { AURA_FRAME_MS, AURA_MOODS, auraReduced } from '../aura/auraEngine';
import { DEFAULT_DAY, dayPart, suggestionsFor } from '../groot/grootTime';
import { appZone } from '../../lib/zone';
import { openScheduleFromWords } from '../../features/meet/openFromWords';
import { openNew, pageContext, useCopilot, useNewSheet, type NewType } from './state';
import { openPalette, searchHitLink } from '../paletteLink';
import { haptic, useIsMobile } from '../../lib/mobile';
import { NotificationBell } from '../../features/notifications/centre/NotificationCentre';
import { AttendanceCapsule } from '../../features/attendance/AttendanceCapsule';
import { AvatarMenu } from './Rail';
import './v2.css';

/** The project page's id, when the page is one project (the capsule then asks about that project). */
const projectIdOf = (pathname: string) => /^\/work\/projects\/([0-9a-f-]{8,})/i.exec(pathname)?.[1] ?? null;

/**
 * The calm header, top right of the main area (769px and up): the check-in pill, the notification bell (its badge and popover, grouped Today
 * and Earlier, with Mark all read and settings), the Aura orb and the avatar menu. A page's own control can still portal in on the left.
 */
export function Toolbar() {
  // How wide the controls on the right are, so a page's crumb row on the same line keeps clear of them (--shell-head-w).
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current; if (!el) return;
    const root = document.documentElement;
    const put = () => {
      const kids = [...el.children].filter((c) => !c.classList.contains('v2-tb-sp') && !c.classList.contains('v2-tb-title')) as HTMLElement[];
      if (!kids.length) return;
      const left = Math.min(...kids.map((k) => k.getBoundingClientRect().left));
      root.style.setProperty('--shell-head-w', `${Math.ceil(el.getBoundingClientRect().right - left + 4)}px`);
    };
    put();
    const ro = new ResizeObserver(put); ro.observe(el); [...el.children].forEach((c) => ro.observe(c));
    const mo = new MutationObserver(() => { [...el.children].forEach((c) => ro.observe(c)); put(); }); mo.observe(el, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); root.style.removeProperty('--shell-head-w'); };
  }, []);
  return (
    <div ref={bar} className="v2-tb shell-head" role="toolbar" aria-label="Your day">
      <span className="v2-tb-sp" />
      <AttendanceCapsule ring />
      <AuraOrbButton />
      <NotificationBell />
      <AvatarMenu />
    </div>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const AURA_KEY = isMac ? '⌘K' : 'Ctrl K';

/** Opens or closes the Aura panel (the floating chat; a bottom sheet on a phone), about the page it was opened on. */
export function toggleAura(where?: { context: string | null; about: string | null } | null) {
  const g = useGroot.getState();
  if (g.open && !g.card) { g.close(); return; }
  dismissAura();
  openGroot(null, where?.about ? null : where?.context && where.context !== 'Home' ? where.context : null, where?.about ?? null);
}
/** Where the person is, for Aura: the page ("Work › Tickets"), or the project when the page is one project (its name, from the page's cache). */
function useWhere() {
  const { pathname, search } = useLocation();
  const ai = useAi();
  const projectId = projectIdOf(pathname);
  const project = useWsQuery(['project', projectId], () => projectApi.get(projectId!), { enabled: ai && !!projectId, staleTime: 60_000 });
  return { context: pageContext(pathname, search), about: projectId ? project.data?.project.name ?? null : null };
}

/** The Aura orb in the header: a click (or ⌘K) opens the floating Aura panel, which grows from it. */
export function AuraOrbButton() {
  const ai = useAi();
  const open = useAuraSearch((s) => s.open);
  const where = useWhere();
  void ai;
  return (
    <button type="button" className={`shell-hb shell-orb${open ? ' on' : ''}`} data-aura-entry="" aria-label={`Aura (${AURA_KEY})`} title={`Aura ${AURA_KEY}`} aria-expanded={open}
      onClick={() => { haptic(); toggleAuraSearch(where); }}>
      <SiriOrb state={open ? 'listening' : undefined} />
    </button>
  );
}

/** ⌘K / Ctrl K toggles the Aura panel (⌘⇧K, or ⌘K with the assistant off, is the command palette). Mounted once in the layout. */
export function AuraKeys() {
  const ai = useAi();
  const here = useWhere();
  const where = useRef(here);
  where.current = here;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k' || e.altKey) return;
      if (e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); openPalette(); return; }
      e.preventDefault(); e.stopImmediatePropagation();
      // The Aura panel open: ⌘K puts it away; otherwise it toggles Aura search.
      const g = useGroot.getState();
      if (g.open && !g.card) { g.close(); return; }
      toggleAuraSearch(where.current);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ai]);
  return null;
}

/** Aura in the phone's top bar: the orb opens the Aura bottom sheet. */
export function AuraPhoneOrb() {
  const ai = useAi();
  const open = useAuraSearch((s) => s.open);
  const where = useWhere();
  void ai;
  return (
    <button type="button" className={`m-icon m-aura-orb${open ? ' on' : ''}`} data-aura-entry="" aria-label="Aura" aria-expanded={open}
      onClick={() => { haptic(); toggleAuraSearch(where); }}>
      <SiriOrb size={26} state={open ? 'listening' : undefined} />
    </button>
  );
}

/** @deprecated The "Aura ⌘K" hint was replaced by the header orb (AuraOrbButton); kept as an alias for old imports. */
export const AuraHint = AuraOrbButton;

/**
 * The Siri-style edge glow while Aura is invoked: a soft band of the mood's colours around the viewport, drifting at no more than 30 fps
 * (still under Reduce Motion). It only lights the edge and never takes a pointer, so nothing on the page is covered.
 */
function AuraEdgeGlow({ soft }: { soft: boolean }) {
  const mood = useAuraMood((s) => s.mood);
  const el = useRef<HTMLDivElement>(null);
  const pal = AURA_MOODS[mood].pal;
  useEffect(() => {
    if (auraReduced()) return;
    let raf = 0, last = 0, a = 210;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < AURA_FRAME_MS || document.hidden) return;
      a = (a + (now - (last || now)) * 0.03) % 360; last = now;
      el.current?.style.setProperty('--glow-a', `${a.toFixed(1)}deg`);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div ref={el} className={`aura-glow${soft ? ' soft' : ''}`} aria-hidden="true" data-testid="aura-glow" data-mood={mood}
      style={{ '--g1': pal[0], '--g2': pal[1], '--g3': pal[2], '--g4': pal[3] } as CSSProperties} />
  );
}

/** What + New used to make, as chips under the capsule: each opens the same create flow (with the words typed so far); More… has the rest. */
export const AURA_CHIPS: { id: string; label: string; icon: IconName; type: NewType | null }[] = [
  { id: 'task', label: 'Create a task', icon: 'checkCircle', type: 'task' },
  { id: 'time', label: 'Log time', icon: 'timer', type: 'time' },
  { id: 'meeting', label: 'Schedule a meeting', icon: 'calendar', type: 'meeting' },
  { id: 'ticket', label: 'Raise a ticket', icon: 'target', type: 'ticket' },
  { id: 'doc', label: 'Write a doc', icon: 'note', type: 'doc' },
  { id: 'more', label: 'More…', icon: 'grid', type: null },
];

/**
 * Aura, invoked: nothing of it is on screen at rest. ⌘K / Ctrl K (pressed again inside it: the command palette), the "Aura ⌘K" hint or the
 * phone's orb bring up the edge glow and a floating glass capsule (the orb, one field, send) with suggestions and the create chips under
 * it (above the keyboard on a phone). Typing shows quick-find results; Enter asks Aura and the answer card rises above the capsule, with
 * the plan → confirm → undo of any change it proposes. Esc or a click outside puts it away. With the assistant off, Enter opens the
 * command palette and the chips still create.
 */
export function AskBar() {
  const phone = useIsMobile();
  const ai = useAi();
  const open = useAuraInvoke((s) => s.open);
  const chatOpen = useGroot((s) => s.open);
  const cardOpen = useGroot((s) => s.open && s.card);
  const creating = useNewSheet((s) => s.open);
  const { pathname, search } = useLocation();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(-1);
  const [debounced, setDebounced] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const projectId = projectIdOf(pathname);
  const project = useWsQuery(['project', projectId], () => projectApi.get(projectId!), { enabled: ai && !!projectId, staleTime: 60_000 });
  const projectName = project.data?.project.name ?? null;
  const shown = open || cardOpen;
  useEffect(() => { const t = window.setTimeout(() => setDebounced(q.trim()), 200); return () => window.clearTimeout(t); }, [q]);
  const hits = useWsQuery(['quick-find', debounced], () => insightApi.search(debounced), { enabled: ai && shown && debounced.length >= 2, staleTime: 30_000, retry: false });
  const found = (shown && debounced.length >= 2 ? hits.data?.hits ?? [] : []).slice(0, 5);
  const suggestions = useMemo(() => suggestionsFor(dayPart(new Date(), { ...DEFAULT_DAY, zone: appZone() }), projectName).filter((x) => !x.action), [projectName]);

  // ⌘K / Ctrl K invokes Aura. Pressed again from inside the capsule, the command palette opens as before (go to, create, settings).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k' || e.shiftKey || e.altKey) return;
      if (!ai) return;
      // Already invoked (even before the capsule has rendered): this press is for the palette, and Aura steps aside for it.
      if (useAuraInvoke.getState().open) { dismissAura(); return; }
      e.preventDefault(); e.stopImmediatePropagation();
      invokeAura();
      window.setTimeout(() => input.current?.focus({ preventScroll: true }), 0);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ai]);
  // The answer card (portalled to the body) rises from the capsule wherever it sits: its centre, width and top, as root variables.
  const capsule = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const el = capsule.current; if (!shown || !el) return;
    const root = document.documentElement;
    const put = () => {
      const r = el.getBoundingClientRect();
      root.style.setProperty('--aura-cap-x', `${r.left + r.width / 2}px`);
      root.style.setProperty('--aura-cap-w', `${Math.max(r.width, Math.min(620, window.innerWidth - 24))}px`);
      root.style.setProperty('--aura-cap-gap', `${window.innerHeight - r.top + 10}px`);
    };
    put();
    const ro = new ResizeObserver(put); ro.observe(el);
    const vv = window.visualViewport;
    window.addEventListener('resize', put); vv?.addEventListener('resize', put);
    const mo = new MutationObserver(put); mo.observe(root, { attributes: true, attributeFilter: ['class'] });
    const wrapEl = wrap.current; wrapEl?.addEventListener('animationend', put);
    return () => { ro.disconnect(); mo.disconnect(); wrapEl?.removeEventListener('animationend', put); window.removeEventListener('resize', put); vv?.removeEventListener('resize', put); ['--aura-cap-x', '--aura-cap-w', '--aura-cap-gap'].forEach((k) => root.style.removeProperty(k)); };
  }, [shown, cardOpen, phone]);
  // A request handed back to change (the answer card's Edit) lands in the field.
  const draft = useAuraInvoke((s) => s.draft);
  useEffect(() => { if (draft == null) return; const d = useAuraInvoke.getState().takeDraft(); if (d != null) { setQ(d); window.setTimeout(() => input.current?.focus({ preventScroll: true }), 0); } }, [draft]);
  // Invoked: the cursor goes into the capsule. The side panel or the create sheet taking over puts the capsule away.
  useEffect(() => { if (open) window.setTimeout(() => input.current?.focus({ preventScroll: true }), 30); }, [open]);
  useEffect(() => { if ((chatOpen && !cardOpen) || creating) useAuraInvoke.getState().hide(); }, [chatOpen, cardOpen, creating]);
  useEffect(() => { dismissAura(); }, [pathname]);
  // Esc or a click outside (the capsule, the answer card, the entry points) dismisses.
  useEffect(() => {
    if (!shown) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || !t.isConnected || t.closest('.aura-siri, .groot-chat.card, [data-aura-entry], .toast-root, .confirm-root, [role="alertdialog"]')) return;
      dismissAura(); setQ('');
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { dismissAura(); setQ(''); input.current?.blur(); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey); };
  }, [shown]);

  const where = pageContext(pathname, search);
  const ask = (said?: string) => {
    const text = (said ?? q).trim();
    if (!text) return;
    setQ(''); setSel(-1);
    useGroot.getState().show(text, projectId ? null : where && where !== 'Home' ? where : null, projectId ? projectName : null, true);
    input.current?.focus({ preventScroll: true });
  };
  const create = (type: NewType | null) => {
    const text = q.trim();
    setQ(''); dismissAura();
    // A meeting opens the one schedule sheet straight away, with the sentence read into its fields.
    if (type === 'meeting') { openScheduleFromWords(text); return; }
    openNew(type, text);
  };
  const go = (i: number) => { const h = found[i]; if (!h) return; setQ(''); dismissAura(); nav(searchHitLink(h)); };
  if (!shown) return null;
  const placeholder = !ai ? 'Find or create anything' : projectId ? `Ask Aura about ${projectName ?? 'this project'}` : 'Ask Aura or tell it what to do';
  const chips = !cardOpen && (
    <div className="aura-under" onMouseDown={(e) => e.preventDefault()}>
      {/* One quiet row: what to ask while the field is empty, then what to make of the words typed (what + New used to make). */}
      {ai && q.trim().length === 0 ? (
        <div className="aura-chips aura-sugg" role="group" aria-label="Suggestions">
          {suggestions.map((x) => (
            <button key={x.label} type="button" className="aura-chip" data-sugg="" onClick={() => ask(x.prompt)}><span className="aura-spark" aria-hidden="true">✦</span>{x.label}</button>
          ))}
          <button type="button" className="aura-chip" data-chip="more" onClick={() => create(null)}><Icon name="plus" size={13} />Create…</button>
        </div>
      ) : <div className="aura-chips" role="group" aria-label="Create">
        {AURA_CHIPS.map((c) => (
          <button key={c.id} type="button" className="aura-chip" data-chip={c.id} onClick={() => create(c.type)}>
            <Icon name={c.icon} size={13} />{c.label}
          </button>
        ))}
      </div>}
    </div>
  );
  return (
    <>
      <AuraEdgeGlow soft={cardOpen} />
      <div ref={wrap} className={`aura-siri aura-dock-wrap focused${cardOpen ? ' answering' : ''}`} data-testid="aura-dock">
        {found.length > 0 && (
          <div className="gq-pop aura-find" id="aura-quick-find" role="listbox" aria-label="Quick find" onMouseDown={(e) => e.preventDefault()}>
            <div className="gq-head">Go to</div>
            {found.map((h, i) => (
              <button key={`${h.type}:${h.id}`} type="button" role="option" aria-selected={sel === i} className="gq-row" onClick={() => go(i)}>
                <Icon name="search" size={14} /><span>{h.title}</span>{h.subtitle && <small>{h.subtitle}</small>}
              </button>
            ))}
          </div>
        )}
        {phone && chips}
        <form ref={capsule} className="v2-ask aura-dock aura-capsule" role="search" aria-label="Ask Aura"
          onSubmit={(e) => { e.preventDefault(); if (sel >= 0 && found[sel]) go(sel); else if (ai) ask(); else { setQ(''); dismissAura(); openPalette(); } }}>
          <button type="button" className="aura-dock-orb" aria-label="Open Aura" title="Open Aura in the side panel" onMouseDown={(e) => e.preventDefault()}
            onClick={() => { dismissAura(); if (!ai) openPalette(); else if (projectId) openGroot(null, null, projectName); else openGroot(null, where && where !== 'Home' ? where : null); }}>
            <AuraOrb size={phone ? 30 : 32} label={null} />
          </button>
          <input ref={input} value={q} placeholder={placeholder} aria-label={placeholder} data-aura-input="" autoComplete="off" enterKeyHint="send"
            role="combobox" aria-expanded={found.length > 0} aria-controls="aura-quick-find" aria-autocomplete="list"
            onChange={(e) => { setQ(e.target.value); setSel(-1); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && found.length) { e.preventDefault(); setSel((s) => Math.min(found.length - 1, s + 1)); }
              else if (e.key === 'ArrowUp' && found.length) { e.preventDefault(); setSel((s) => Math.max(-1, s - 1)); }
            }} />
          <button type="submit" className="v2-ask-send" aria-label="Send to Aura"><Icon name="arrowUp" size={16} /></button>
        </form>
        {!phone && chips}
      </div>
    </>
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
