import { Select } from '../../components/Select';
import { useMemo, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { ErrorState } from '../../components/ui';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { matchesAll } from './planSheetQuery';
import { portfolioApi, type SheetRow, type SheetStatus } from './portfolioApi';
import { PortfolioSkeleton, usePortfolio, useShellLine } from './PortfolioShell';
import { patchPortfolio, refreshPortfolio } from './portfolioShared';

/**
 * Portfolio › Board (design shot 16-portfolio-board): every project's tasks in four columns — To do, In progress, Review, Done — as calm cards with
 * the project dot, its name and the due day. Drag a card to another column (or pick the column on a phone): the move is optimistic, the card
 * shows "✓ Saved", and the change reaches every tab through the shared Portfolio cache. A card's column is its status's category; Review is a
 * status whose name says review. Dropping on a column picks that project's own status of that kind.
 */
type Col = 'todo' | 'prog' | 'review' | 'done';
const COLS: { id: Col; label: string }[] = [{ id: 'todo', label: 'To do' }, { id: 'prog', label: 'In progress' }, { id: 'review', label: 'Review' }, { id: 'done', label: 'Done' }];
const CAP = 40;
const isReview = (name: string) => /review|qa|verify/i.test(name);
const colOf = (r: SheetRow): Col | null => r.category === 'Cancelled' ? null : r.category === 'Done' ? 'done' : isReview(r.status) ? 'review' : r.category === 'Todo' ? 'todo' : 'prog';
const statusFor = (col: Col, list: SheetStatus[]) => col === 'review' ? list.find((s) => s.category !== 'Done' && isReview(s.name))
  : col === 'done' ? list.find((s) => s.category === 'Done')
  : col === 'todo' ? list.find((s) => s.category === 'Todo' && !isReview(s.name))
  : list.find((s) => s.category !== 'Todo' && s.category !== 'Done' && s.category !== 'Cancelled' && !isReview(s.name));
const DAY = 86_400_000;
const dn = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY);
const when = (iso: string | null, today: string) => {
  if (!iso) return 'No date';
  const d = dn(iso) - dn(today);
  if (d === 0) return 'Today';
  if (d > 0 && d < 7) return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short' });
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).replace(/(\d+) (\w+)/, '$2 $1');
};

export function PortfolioTaskBoard() {
  const { sheet, work, projects, active, url, colourOf, qctx, today, phone, tabPrefs } = usePortfolio();
  const colours = url.colours;
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<Col | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const statusesBy = useMemo(() => {
    const m = new Map<string, SheetStatus[]>();
    for (const s of sheet.data?.statuses ?? []) m.set(s.projectId, [...(m.get(s.projectId) ?? []), s]);
    return m;
  }, [sheet.data]);
  const name = (pid: string) => { const p = projects.find((x) => x.id === pid); return (tabPrefs.names[pid] || p?.title || '').split(/\s+/)[0]; };
  const cols = useMemo(() => {
    const m: Record<Col, SheetRow[]> = { todo: [], prog: [], review: [], done: [] };
    // Tasks, not their phases: a task that carries sub-items is a phase header on the Plan sheet, not a card.
    const parents = new Set(work.map((x) => x.parentId).filter(Boolean));
    for (const r of work) {
      if (r.kind === 'meeting' || parents.has(r.id)) continue;
      if (colours.length && !colours.includes(colourOf(r.projectId))) continue;
      if (active.length && !matchesAll(r, active, qctx)) continue;
      const c = colOf(r); if (c) m[c].push(r);
    }
    m.done.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    for (const k of ['todo', 'prog', 'review'] as Col[]) m[k].sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9'));
    return m;
  }, [work, colours, colourOf, active, qctx]);
  const late = [...cols.todo, ...cols.prog, ...cols.review].filter((r) => r.late).length;
  useShellLine(`${cols.review.length} in review, ${late} late.`);

  const move = async (r: SheetRow, to: Col) => {
    if (colOf(r) === to) return;
    const st = statusFor(to, statusesBy.get(r.projectId) ?? []);
    if (!st) { toast(`${name(r.projectId)} has no “${COLS.find((c) => c.id === to)!.label}” status. Add one in the project’s settings.`, 'info'); return; }
    if (!r.canEdit) { toast('You can’t change this task.', 'info'); return; }
    const change = { id: r.id, version: r.version, statusId: st.id };
    patchPortfolio(wid, [change], () => ({ statusId: st.id, status: st.name, category: st.category }));
    try {
      const res = await portfolioApi.sheetBulk([change]);
      const row = res.rows[0];
      if (row && !row.ok) throw new Error(row.error ?? 'Not saved');
      setSaved(r.id); window.setTimeout(() => setSaved((x) => (x === r.id ? null : x)), 1600);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'The move could not be saved.', 'error');
    } finally { void refreshPortfolio(wid); }
  };
  const byId = (id: string | null) => (id ? work.find((r) => r.id === id) : undefined);

  if (sheet.isLoading) return <PortfolioSkeleton label="Loading the board" />;
  if (sheet.isError) return <ErrorState error={sheet.error} retry={() => void sheet.refetch()} />;
  return (
    <section className={`pfb ${drag ? 'dragging' : ''}`} aria-label="Board">
      {COLS.map((c) => (
        <div key={c.id} className={`pfb-col ${over === c.id ? 'over' : ''}`} role="list" aria-label={c.label}
          onDragOver={(e: DragEvent) => { if (drag) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== c.id) setOver(c.id); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
          onDrop={(e) => { e.preventDefault(); const r = byId(drag); setDrag(null); setOver(null); if (r) void move(r, c.id); }}>
          <h3 className="pfb-h">{c.label}<span>{cols[c.id].length}</span></h3>
          <div className="pfb-cards">
            {cols[c.id].slice(0, CAP).map((r) => (
              <div key={r.id} role="listitem" className={`pfb-card pc-${colourOf(r.projectId)} ${drag === r.id ? 'lift' : ''}`} draggable={!phone && r.canEdit}
                onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); setDrag(r.id); }}
                onDragEnd={() => { setDrag(null); setOver(null); }}>
                <button type="button" className="pfb-t" onClick={() => nav(`/work/projects/${r.projectId}?tab=work&task=${r.id}`)}>{r.title}</button>
                <div className="pfb-m"><i aria-hidden="true" />{name(r.projectId)} · <span className={r.late && c.id !== 'done' ? 'late' : ''}>{when(r.due, today)}</span>
                  {saved === r.id && <span className="pfb-saved" role="status">✓ Saved</span>}</div>
                {phone && r.canEdit && (
                  <label className="pfb-move"><span className="sr-only">Move {r.title} to</span>
                    <Select value={c.id} onChange={(e) => void move(r, e.target.value as Col)}>{COLS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
                  </label>
                )}
              </div>
            ))}
            {cols[c.id].length > CAP && <p className="pfb-more">+{cols[c.id].length - CAP} more on the plan sheet</p>}
            {cols[c.id].length === 0 && <p className="pfb-more">Nothing here</p>}
          </div>
        </div>
      ))}
    </section>
  );
}
