import { useNavigate } from 'react-router-dom';
import { checklistApi } from '../../api/endpoints';
import { historyApi } from '../../api/platformApi';
import { useWsQuery } from '../../lib/hooks';
import { toast } from '../../stores/ui';
import type { SheetRow } from './portfolioApi';
import { ago, dm } from './planSheet';
import { slipDays, statusKey } from './planSheetQuery';
import { Av, NoteText, Owner, Progress, Status } from './planSheetParts';

export type EditCol = 'owner' | 'dates' | 'status' | 'progress' | 'notes';
export interface LinkedMeeting { title: string; nextAt: string | null; cadence: string | null }

const meetingWhen = (iso: string | null) => iso ? `${new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · ${new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}` : '';
const VERB: Record<string, string> = { 'Due date': 'moved due', Due: 'moved due', 'Start date': 'moved start', Status: 'set status', Assignee: 'gave it', Owner: 'gave it', Title: 'renamed it', Description: 'changed the note' };

/**
 * The right-hand panel for one task: its fields (each opens the same editor as the cell), the note with mentions and links, the checklist (tick to
 * update progress), the meeting it is reviewed in, and the latest changes from its field history.
 */
export function Inspector({ h, r, rows, project, today, meeting, onEdit, onClose, onChanged }: {
  h: number; r: SheetRow; rows: SheetRow[]; project: SheetRow | undefined; today: string; meeting: LinkedMeeting | null;
  onEdit: (col: EditCol, anchor: HTMLElement) => void; onClose: () => void; onChanged: () => void;
}) {
  const nav = useNavigate();
  const work = r.kind === 'task' || r.kind === 'subtask';
  const list = useWsQuery(['checklist', r.id], () => checklistApi.get(r.id), { enabled: work, staleTime: 20_000, retry: false });
  const hist = useWsQuery(['history', 'work-item', r.id], () => historyApi.workItem(r.id), { enabled: work, staleTime: 20_000, retry: false });
  const deps = rows.filter((x) => r.dependsOn.includes(x.key));
  const blocks = rows.filter((x) => x.dependsOn.includes(r.key));
  const k = statusKey(r);
  const slip = slipDays(r, today);
  const field = (col: EditCol, label: string, node: React.ReactNode) => (
    <><span className="k">{label}</span>{r.canEdit ? <button type="button" aria-label={`Change ${label.toLowerCase()}`} onClick={(e) => onEdit(col, e.currentTarget)}>{node}</button> : <span>{node}</span>}</>
  );
  const toggle = async (itemId: string, isDone: boolean) => {
    try { await checklistApi.update(r.id, itemId, { isDone }); await list.refetch(); onChanged(); } catch { toast('The checklist could not be updated.', 'error'); }
  };
  const items = list.data?.items ?? [];
  const recent = (hist.data ?? []).slice(0, 3);
  return (
    <aside className="ps3-insp" style={{ maxHeight: h }} aria-label={`${r.key} details`}>
      <div className="ps3-insp-h"><span className="ps3-key">{r.key}</span><span className="ps3-dim" style={{ fontSize: 12 }}>{project?.title}</span><span className="ps3-sp" />
        <button type="button" aria-label="Open the task" title="Open the task" onClick={() => nav(`/work?item=${encodeURIComponent(r.id)}`)}>⤢</button>
        <button type="button" aria-label="Close details" onClick={onClose}>✕</button></div>
      <div className="ps3-insp-t">{r.title}</div>
      <div className="ps3-field">
        {field('status', 'Status', <Status r={r} />)}
        {field('owner', 'Owner', <Owner id={r.ownerId} name={r.owner} />)}
        {field('dates', 'Dates', <span className="ps3-num">{r.start ? `${dm(r.start)} → ` : ''}{dm(r.due) || 'No due date'}{slip > 0 && <span className={`ps3-slip ${k === 'late' ? 'late' : 'risk'}`}>+{slip}d</span>}</span>)}
        {field('progress', 'Progress', <Progress value={r.progress} k={k} />)}
        <span className="k">Depends on</span><span>{deps.length ? deps.map((d, i) => <span key={d.id}>{i > 0 && ', '}{d.key} <span className="ps3-dim">· {statusKey(d) === 'done' ? 'done' : d.status.toLowerCase()}</span></span>) : <span className="ps3-dim">—</span>}</span>
        <span className="k">Blocks</span><span>{blocks.length ? blocks.map((d, i) => <span key={d.id}>{i > 0 && ', '}{d.key} <span className="ps3-dim">· {d.title.split(/\s+/).slice(0, 2).join(' ').toLowerCase()}</span></span>) : <span className="ps3-dim">—</span>}</span>
      </div>
      <div className="ps3-sec"><h4>Notes</h4>
        <button type="button" className="ps3-note" style={{ display: 'block', border: 0, background: 'none', padding: 0, textAlign: 'left', cursor: r.canEdit ? 'text' : 'default', color: 'var(--p-ink)', lineHeight: 1.5, WebkitLineClamp: 'unset', width: '100%' }}
          disabled={!r.canEdit} onClick={(e) => onEdit('notes', e.currentTarget)}>{r.notes ? <NoteText text={r.notes} /> : <span className="ps3-dim">Add a note… @ to mention</span>}</button></div>
      {work && <div className="ps3-sec"><h4>Checklist{items.length ? ` · ${items.filter((x) => x.isDone).length} of ${items.length}` : ''}</h4>
        {list.isLoading ? <span className="ps3-dim">Loading…</span> : items.length === 0 ? <span className="ps3-dim">No checklist yet</span>
          : items.map((x) => <button key={x.id} type="button" role="checkbox" aria-checked={x.isDone} className={`ps3-check ${x.isDone ? 'done' : ''}`} disabled={!r.canEdit} onClick={() => void toggle(x.id, !x.isDone)}>
            <span className="d">{x.isDone ? '●' : '○'}</span><span>{x.title}</span></button>)}</div>}
      <div className="ps3-sec"><h4>Meeting</h4>
        {meeting ? <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><span><span style={{ color: 'var(--p-purple)' }}>◆</span> {meeting.title}</span><span className="ps3-dim">{meetingWhen(meeting.nextAt)}</span></div>
          : <span className="ps3-dim">No upcoming project meeting</span>}</div>
      {work && <div className="ps3-sec"><h4>Activity</h4>
        {recent.length === 0 ? <span className="ps3-dim">{hist.isLoading ? 'Loading…' : 'No changes yet'}</span> : recent.map((h) => (
          <div key={h.id} style={{ display: 'flex', gap: 9, fontSize: 12.5, marginBottom: 6 }}><Av id={h.actor?.id} name={h.actor?.name} />
            <span><b style={{ fontWeight: 500 }}>{h.actor?.name?.split(' ')[0] ?? 'Someone'}</b> {VERB[h.field] ?? `changed ${h.field.toLowerCase()}`}{' '}
              {h.from || h.to ? <>{short(h.from)} → {short(h.to)}</> : null} <span className="ps3-dim">· {ago(h.at).toLowerCase()}</span></span></div>
        ))}</div>}
    </aside>
  );
}
const short = (v: string | null) => { if (!v) return '—'; const m = /^(\d{4}-\d{2}-\d{2})/.exec(v); return m ? dm(m[1]) : v.length > 24 ? `${v.slice(0, 22)}…` : v; };
