import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { insightApi } from '../api/endpoints';
import type { SearchHit } from '../api/types';
import { Icon, type IconName } from './Icon';
import { useMainNav } from '../layouts/navigation';
import { useWorkspaceSections } from '../features/settings/sections';
import { Sparkle, useAi, useAssistant } from '../features/ai/Assistant';
import { useAuth, useCan, useModule } from '../stores/auth';
import { openReminderComposer } from '../features/reminders/store';
import { useUi } from '../stores/ui';

/** Where a search hit opens. Shared with the search box in the top bar. */
export function searchHitLink(h: Pick<SearchHit, 'type' | 'id' | 'projectId' | 'taskId'>): string {
  switch (h.type) {
    case 'file': return h.taskId ? `/projects/${h.projectId}?task=${h.taskId}` : `/projects/${h.projectId}?tab=files`;
    case 'task': case 'comment': return `/projects/${h.projectId}?task=${h.taskId}`;
    case 'issue': return `/projects/${h.projectId}?tab=issues&issue=${h.id}`;
    case 'action': return `/projects/${h.projectId}?tab=actions&action=${h.id}`;
    case 'work': return `/operations?task=${h.id}`;
    case 'project': return `/projects/${h.id}`;
    case 'team': return '/people/teams';
    case 'member': return '/people';
    case 'label': return '/settings/labels';
    default: return '/projects';
  }
}
const HIT_ICON: Record<string, IconName> = { task: 'check', issue: 'bug', action: 'flag', work: 'bolt', project: 'folder', team: 'users', member: 'user', comment: 'message', file: 'paperclip', label: 'tag' };

interface Command { id: string; group: string; label: string; hint?: string; icon: IconName | 'ai'; keywords?: string; run: () => void }

/** How well a command matches what was typed: every word must appear; earlier and word-start matches rank higher. 0 = no match. */
function score(c: Command, q: string): number {
  if (!q) return 1;
  const hay = `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase();
  let total = 0;
  for (const word of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const i = hay.indexOf(word);
    if (i < 0) return 0;
    total += (i === 0 ? 30 : /\s/.test(hay[i - 1] ?? ' ') ? 20 : 5) - Math.min(i, 20) / 4;
  }
  return total;
}

const RECENT_KEY = 'pm_palette_recent';
const readRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; } };
const remember = (id: string) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, 5))); } catch { /* storage unavailable */ } };

/** Opens the palette from anywhere (a top-bar button, a shortcut hint). */
export const openPalette = () => window.dispatchEvent(new Event('pm:palette'));

/**
 * Ctrl K / ⌘ K: go anywhere, create something, change a setting or search everything from the keyboard. With the AI assistant on, a
 * question can be handed to it as well.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const groups = useMainNav();
  const settings = useWorkspaceSections();
  const ctx = useAuth((s) => s.ctx);
  const ai = useAi();
  const ask = useAssistant((s) => s.ask);
  const { toggleTheme, toggleSidebar, theme } = useUi();
  const permProject = useCan('projects.create'), modProjects = useModule('projects');
  const permWork = useCan('work.create'), modWork = useModule('work');
  const canProject = permProject && modProjects >= 2;
  const canWork = permWork && modWork >= 2;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('pm:palette', onOpen);
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('pm:palette', onOpen); };
  }, []);
  useEffect(() => { if (open) { setQ(''); setActive(0); setTimeout(() => input.current?.focus(), 20); } }, [open]);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 220); return () => clearTimeout(t); }, [q]);

  const search = useQuery({ queryKey: ['palette-search', ctx?.current?.id, debounced], queryFn: () => insightApi.search(debounced), enabled: open && debounced.length >= 2 && !ctx?.user.isPlatformAdmin });

  const close = () => setOpen(false);
  const go = (to: string) => () => { close(); nav(to); };

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    for (const g of groups) for (const i of g.items.filter((x) => x.show !== false)) list.push({ id: `nav:${i.to}`, group: 'Go to', label: i.label, hint: g.title, icon: i.icon, run: go(i.to) });
    for (const s of settings) list.push({ id: `set:${s.to}`, group: 'Settings', label: s.label, hint: s.group, icon: s.icon ?? 'settings', keywords: 'settings workspace', run: go(s.to) });
    if (ctx && !ctx.user.isPlatformAdmin) {
      list.push({ id: 'acc:profile', group: 'Settings', label: 'My profile', icon: 'user', keywords: 'account', run: go('/account') });
      list.push({ id: 'acc:notifications', group: 'Settings', label: 'My notifications', icon: 'bell', keywords: 'account email push desktop', run: go('/account/notifications') });
      list.push({ id: 'acc:mobile', group: 'Settings', label: 'Mobile app & phone sign-in', icon: 'bell', keywords: 'android install push phone approve login', run: go('/account/mobile') });
      list.push({ id: 'acc:security', group: 'Settings', label: 'Sign-in & security', icon: 'lock', keywords: 'account password two-step mfa', run: go('/account/security') });
    }
    if (canProject) list.push({ id: 'new:project', group: 'Create', label: 'New project', icon: 'folder', keywords: 'create add', run: go('/projects?new=1') });
    if (canWork) list.push({ id: 'new:work', group: 'Create', label: 'New work task', icon: 'bolt', keywords: 'create add operational ticket bug', run: go('/operations?new=1') });
    if (ctx && !ctx.user.isPlatformAdmin) list.push({ id: 'new:reminder', group: 'Create', label: 'New reminder', icon: 'alarm', keywords: 'create add remind me alarm later', run: () => { close(); openReminderComposer(); } });
    list.push({ id: 'ui:theme', group: 'Preferences', label: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', icon: theme === 'dark' ? 'sun' : 'moon', keywords: 'theme dark light', run: () => { close(); toggleTheme(); } });
    list.push({ id: 'ui:sidebar', group: 'Preferences', label: 'Collapse or expand the sidebar', icon: 'menu', keywords: 'sidebar menu', run: () => { close(); toggleSidebar(); } });
    list.push({ id: 'help:security', group: 'Help', label: 'How we keep your data safe', icon: 'shield', keywords: 'security privacy', run: () => { close(); window.location.assign('/security/'); } });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, settings, ctx, canProject, canWork, theme]);

  const visible = useMemo(() => {
    const query = q.trim();
    const recent = readRecent();
    const ranked = commands.map((c) => ({ c, s: score(c, query) + (query ? 0 : recent.includes(c.id) ? 100 - recent.indexOf(c.id) : 0) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.c);
    const shown: Command[] = query ? ranked.slice(0, 12) : [
      ...ranked.filter((c) => recent.includes(c.id)).map((c) => ({ ...c, group: 'Recent' })),
      ...ranked.filter((c) => !recent.includes(c.id) && (c.group === 'Create' || c.group === 'Go to')).slice(0, 9),
    ];
    const hits: Command[] = (search.data?.hits ?? []).slice(0, 8).map((h) => ({
      id: `hit:${h.type}:${h.id}`, group: 'Search results', label: h.title, hint: h.subtitle ?? undefined, icon: HIT_ICON[h.type] ?? 'search', run: go(searchHitLink(h)),
    }));
    const askAi: Command[] = ai && query.length >= 3 ? [{ id: 'ai:ask', group: 'Assistant', label: `Ask the assistant: “${query}”`, icon: 'ai', run: () => { close(); ask(query); } }] : [];
    // "remind me to call Priya tomorrow" is a reminder, not a search.
    const remind: Command[] = /^(remind|reminder|remember|don'?t forget)\b/i.test(query) && ctx && !ctx.user.isPlatformAdmin
      ? [{ id: 'new:reminder-typed', group: 'Create', label: `Set a reminder: “${query}”`, icon: 'alarm', run: () => { close(); openReminderComposer({ text: query }); } }] : [];
    // A command that matches what was typed wins; asking the assistant is the fallback at the end.
    return [...remind, ...shown, ...hits, ...askAi];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands, q, search.data, ai]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  if (!open) return null;

  const runAt = (i: number) => { const c = visible[i]; if (!c) return; remember(c.id); c.run(); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(visible.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); runAt(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  let lastGroup = '';
  return (
    <div className="cmdk-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="cmdk" role="dialog" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="cmdk-input">
          <Icon name="search" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={ai ? 'Go to, create, search… or ask the assistant' : 'Go to, create, search…'}
            aria-label="Command" aria-controls="cmdk-list" aria-activedescendant={visible[active] ? `cmdk-${active}` : undefined} />
          <kbd>Esc</kbd>
        </div>
        <div className="cmdk-list" id="cmdk-list" role="listbox" ref={list}>
          {visible.length === 0 ? <div className="cmdk-empty">{search.isFetching ? 'Searching…' : `Nothing matches “${q}”`}</div> : visible.map((c, i) => {
            const header = c.group !== lastGroup ? <div className="cmdk-group" key={`g:${c.group}`}>{c.group}</div> : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header}
                <button type="button" id={`cmdk-${i}`} role="option" aria-selected={i === active} data-index={i} className={`cmdk-item ${i === active ? 'active' : ''} ${c.icon === 'ai' ? 'asst' : ''}`}
                  onMouseMove={() => setActive(i)} onClick={() => runAt(i)}>
                  <span className="cmdk-ico">{c.icon === 'ai' ? <Sparkle size={15} /> : <Icon name={c.icon} size={15} />}</span>
                  <span className="cmdk-label">{c.label}</span>
                  {c.hint && <span className="cmdk-hint">{c.hint}</span>}
                  {i === active && <Icon name="arrowRight" size={13} />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl</kbd><kbd>K</kbd> close</span></div>
      </div>
    </div>
  );
}
