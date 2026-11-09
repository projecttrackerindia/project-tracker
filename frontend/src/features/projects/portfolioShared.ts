import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { QueryClient } from '@tanstack/react-query';
import { queryClient } from '../../stores/auth';
import type { PlanSheet, PortfolioFilter, PortfolioTimeline, SheetChange, SheetRow } from './portfolioApi';
import { COLOURS, colourOf, type Colour, type TabPrefs } from './planSheetTabs';
import { matchesAll, statusKey, type QueryCtx, type StatusKey, type Tok, type TokKind } from './planSheetQuery';
import { dayNum } from './planSheet';

/**
 * What every Portfolio tab shares, kept in one place so the tabs cannot drift apart:
 * - the query keys (one family, `portfolio`, with the filter normalised so two tabs asking for the same thing share one cache entry);
 * - the filter in the address: the server filter (owner, group, health, from, to), the command field's tokens (?f=), the colour filter (?pc=), the
 *   project folder tab (?pt=) and the sheet layout (?layout=), so switching tabs keeps them;
 * - one project colour for each project (the Plan sheet tab colours);
 * - refreshing every tab after a write, and patching the cached copies at once.
 */

export type PortfolioMode = 'overview' | 'actions' | 'board' | 'timeline' | 'sheet' | 'capacity' | 'present';
export const MODE_LABEL: Record<PortfolioMode, string> = { overview: 'Overview', actions: 'Action items', sheet: 'Plan sheet', timeline: 'Timeline', capacity: 'Load', board: 'Board', present: 'Present' };
/** The calm order (design #portfolio): Overview · Action items · Plan sheet · Timeline · Capacity · Board · Present. */
export const MODES: PortfolioMode[] = ['overview', 'actions', 'sheet', 'timeline', 'capacity', 'board', 'present'];
export type SheetLayout = 'sheet' | 'split' | 'timeline';

/** The filter without empty values, keys in one order: the same filter always makes the same key. */
export function normFilter(f: PortfolioFilter): PortfolioFilter {
  const out: PortfolioFilter = {};
  for (const k of ['teamId', 'ownerId', 'groupId', 'health', 'dueFrom', 'dueTo'] as const) { const v = f[k]; if (v) out[k] = v; }
  return out;
}

/** One key family for the whole Portfolio: every tab's data starts with 'portfolio' (Capacity's plan with 'capacity'). */
export const portfolioKeys = {
  all: ['portfolio'] as const,
  board: (f: PortfolioFilter) => ['portfolio', 'board', normFilter(f)] as unknown[],
  timeline: (f: PortfolioFilter) => ['portfolio', 'timeline', normFilter(f)] as unknown[],
  sheet: (f: PortfolioFilter) => ['portfolio', 'sheet', normFilter(f)] as unknown[],
  capacity: (scope: string) => ['capacity', 'plan', scope] as unknown[],
};

// ------------------------------------------------------------------------------------------------ tokens in the address

const KINDS: TokKind[] = ['owner', 'status', 'due', 'project', 'text'];
/** ?f=owner~<id>~<label>|status~late~Late — only %, ~ and | inside a value are escaped (the address encodes the rest). */
const esc = (x: string) => x.replace(/%/g, '%25').replace(/~/g, '%7E').replace(/\|/g, '%7C');
export function encodeToks(toks: Tok[]): string {
  return toks.map((t) => [t.kind, t.value, t.label].map(esc).join('~')).join('|');
}
export function decodeToks(s: string | null): Tok[] {
  if (!s) return [];
  const out: Tok[] = [];
  for (const part of s.split('|')) {
    const [k, v, l] = part.split('~').map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    if (KINDS.includes(k as TokKind) && v) out.push({ kind: k as TokKind, value: v, label: l || v });
  }
  return out;
}

export interface PortfolioUrlState {
  mode: PortfolioMode; filter: PortfolioFilter; toks: Tok[]; colours: Colour[]; tab: string | null; layout: SheetLayout;
  setMode: (m: PortfolioMode) => void; setFilter: (f: PortfolioFilter) => void; setToks: (t: Tok[]) => void; setColours: (c: Colour[]) => void;
  setTab: (t: string | null) => void; setLayout: (l: SheetLayout) => void;
}

/** The Portfolio's whole filter state, read from and written to the address. */
export function usePortfolioUrl(teamId: string | null | undefined): PortfolioUrlState {
  const [params, setParams] = useSearchParams();
  const v = params.get('mode') ?? params.get('view');
  const mode: PortfolioMode = (MODES as string[]).includes(v ?? '') ? (v as PortfolioMode) : 'overview';
  const owner = params.get('owner'), group = params.get('group'), health = params.get('health'), from = params.get('from'), to = params.get('to');
  const filter = useMemo(() => normFilter({ teamId, ownerId: owner, groupId: group, health, dueFrom: from, dueTo: to }), [teamId, owner, group, health, from, to]);
  const fRaw = params.get('f'), pcRaw = params.get('pc') ?? '';
  // A change shows at once (the address catches up a moment later, in a transition); the address wins as soon as it has it.
  const [pending, setPending] = useState<{ toks?: Tok[]; colours?: Colour[] }>({});
  useEffect(() => setPending((p) => (p.toks ? { ...p, toks: undefined } : p)), [fRaw]);
  useEffect(() => setPending((p) => (p.colours ? { ...p, colours: undefined } : p)), [pcRaw]);
  const fromUrl = useMemo(() => decodeToks(fRaw), [fRaw]);
  const coloursUrl = useMemo(() => pcRaw.split(',').filter((c): c is Colour => (COLOURS as readonly string[]).includes(c)), [pcRaw]);
  const toks = pending.toks ?? fromUrl;
  const colours = pending.colours ?? coloursUrl;
  const tab = params.get('pt');
  const l = params.get('layout');
  const layout: SheetLayout = l === 'split' || l === 'timeline' ? l : 'sheet';
  // Every setter reads the address as it is now, so two updates in one event do not undo each other.
  const patch = useCallback((fn: (n: URLSearchParams) => void, push = false) => {
    setParams((cur) => { const n = new URLSearchParams(cur); fn(n); return n; }, { replace: !push });
  }, [setParams]);
  const set = (n: URLSearchParams, k: string, val: string | null | undefined) => { if (val) n.set(k, val); else n.delete(k); };
  return {
    mode, filter, toks, colours, tab, layout,
    setMode: useCallback((m: PortfolioMode) => patch((n) => { n.set('view', 'portfolio'); if (m === 'overview') n.delete('mode'); else n.set('mode', m); }), [patch]),
    setFilter: useCallback((f: PortfolioFilter) => patch((n) => { set(n, 'owner', f.ownerId); set(n, 'group', f.groupId); set(n, 'health', f.health); set(n, 'from', f.dueFrom); set(n, 'to', f.dueTo); }), [patch]),
    setToks: useCallback((t: Tok[]) => { setPending((p) => ({ ...p, toks: t })); patch((n) => set(n, 'f', encodeToks(t))); }, [patch]),
    setColours: useCallback((c: Colour[]) => { setPending((p) => ({ ...p, colours: c })); patch((n) => set(n, 'pc', c.join(','))); }, [patch]),
    setTab: useCallback((t: string | null) => patch((n) => set(n, 'pt', t), true), [patch]),
    setLayout: useCallback((x: SheetLayout) => patch((n) => set(n, 'layout', x === 'sheet' ? null : x)), [patch]),
  };
}

// ------------------------------------------------------------------------------------------------ one colour per project

/** Projects in the sheet's order: the order the Plan sheet tabs cycle their colours in. */
export const sheetProjects = (sheet: PlanSheet | undefined): SheetRow[] => (sheet?.rows ?? []).filter((r) => r.kind === 'project');
const hashColour = (id: string): Colour => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLOURS[h % COLOURS.length]; };
/** A project's colour, the same on every tab: the person's chosen tab colour, else its place in the Plan sheet's order (as the tabs show it). */
export function projectColour(prefs: TabPrefs, projects: SheetRow[], id: string): Colour {
  if (prefs.colors[id] || projects.some((p) => p.id === id)) return colourOf(prefs, projects, id);
  return hashColour(id);
}

// ------------------------------------------------------------------------------------------------ the filter, applied to projects

const HEALTH_STATUS: Record<string, StatusKey> = { Delayed: 'late', AtRisk: 'risk', OnTrack: 'prog', Completed: 'done', OnHold: 'todo', NotStarted: 'todo' };
export interface ProjectLike { id: string; name: string; key: string; ownerId?: string | null; owner?: string | null; health?: string | null; due?: string | null }

/**
 * Whether a project passes the command field on the project tabs (Board, Timeline, Present): a project token is that project; an owner token is a
 * project its lead is, or one where the person owns work on the sheet; status reads the project's health; a date token its due date; text its name or
 * key. A project also passes when any of its tasks pass every token (so "late this week" keeps the projects with late work this week).
 */
export function projectPasses(p: ProjectLike, toks: Tok[], c: QueryCtx, work: SheetRow[]): boolean {
  if (!toks.length) return true;
  const asRow = { kind: 'project', id: p.id, projectId: p.id, key: p.key, title: p.name, ownerId: p.ownerId ?? null, owner: p.owner ?? null, due: p.due ?? null, notes: null,
    late: p.health === 'Delayed', atRisk: p.health === 'AtRisk', category: p.health === 'Completed' ? 'Done' : 'Active', slipDays: 0 } as unknown as SheetRow;
  const own = toks.every((t) => {
    if (t.kind === 'status') {
      const k = HEALTH_STATUS[p.health ?? ''] ?? statusKey(asRow);
      return t.value === 'lateorrisk' ? k === 'late' || k === 'risk' : t.value === 'open' ? k !== 'done' : k === t.value;
    }
    return matchesAll(asRow, [t], c);
  });
  if (own) return true;
  const mine = work.filter((r) => r.projectId === p.id);
  return mine.some((r) => matchesAll(r, toks, c)) && toks.filter((t) => t.kind === 'project').every((t) => t.value === p.id);
}

// ------------------------------------------------------------------------------------------------ live sync between tabs

/**
 * After any Portfolio write: refetch what is on screen and mark every other tab's data stale, so the next tab shows the change without a reload.
 * The whole `portfolio` family (sheet, board, timeline), capacity, and the project lists outside the Portfolio.
 */
export function refreshPortfolio(wid: string | null | undefined, qc: QueryClient = queryClient) {
  if (!wid) return Promise.resolve();
  return Promise.all(['portfolio', 'capacity', 'projects', 'project'].map((k) => qc.invalidateQueries({ queryKey: [wid, k] }))).then(() => undefined);
}

/**
 * Patch every cached copy at once (optimistic): the sheet's rows in every filter, and on the Timeline/Board the project rows whose dates or owner
 * changed. The refresh that follows replaces them with the server's own roll-up.
 */
export function patchPortfolio(wid: string | null | undefined, changes: SheetChange[], patched: (r: SheetRow, c: SheetChange) => Partial<SheetRow>, qc: QueryClient = queryClient) {
  if (!wid || !changes.length) return;
  const by = new Map(changes.map((c) => [c.id, c]));
  for (const [key, data] of qc.getQueriesData<PlanSheet>({ queryKey: [wid, 'portfolio', 'sheet'] })) {
    if (!data?.rows) continue;
    qc.setQueryData(key, { ...data, rows: data.rows.map((r) => { const c = by.get(r.id); return c ? { ...r, ...patched(r, c) } : r; }) });
  }
  for (const [key, data] of qc.getQueriesData<PortfolioTimeline>({ queryKey: [wid, 'portfolio', 'timeline'] })) {
    if (!data?.projects) continue;
    qc.setQueryData(key, { ...data, projects: data.projects.map((p) => {
      const c = by.get(p.id); if (!c) return p;
      return { ...p, ...(c.dueDate ? { due: c.dueDate } : {}), ...(c.startDate ? { start: c.startDate } : {}), ...(c.title ? { name: c.title } : {}) };
    }) });
  }
}

/** Days from today to a due date (negative: past). */
export const daysTo = (iso: string | null | undefined, today: string) => (iso ? dayNum(iso) - dayNum(today) : null);
