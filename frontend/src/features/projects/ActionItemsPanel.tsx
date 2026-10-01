import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError } from '../../api/client';
import { actionItemApi, projectApi } from '../../api/endpoints';
import type { ActionItem, ActionItemStatus, Priority } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, EmptyState, ErrorState, Field, PageLoader, PriorityBadge, Spinner } from '../../components/ui';
import { formatDate, formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useCan, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { NotesToActionsButton } from '../ai/Assistant';

const SLIDE_MS = 260;
const STATUS_LABEL: Record<ActionItemStatus, string> = { Open: 'Open', InProgress: 'In progress', Completed: 'Completed' };
const PRIORITIES: Priority[] = ['Critical', 'High', 'Medium', 'Low'];
type View = 'open' | 'done' | 'all';
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

interface Draft { title: string; details: string; assigneeId: string; dueDate: string; priority: Priority; status: ActionItemStatus }
const EMPTY: Draft = { title: '', details: '', assigneeId: '', dueDate: '', priority: 'Medium', status: 'Open' };
const draftOf = (i: ActionItem): Draft => ({ title: i.title, details: i.details ?? '', assigneeId: i.assignee?.id ?? '', dueDate: i.dueDate ?? '', priority: i.priority, status: i.status });

/**
 * The action items of one project in a panel that slides in from the right: add, edit, delete, tick off, assign, set a due date and a priority.
 * The page behind stays visible; only the list scrolls. Esc (or the Close button) closes it - Esc first closes a form that is open.
 */
export function ActionItemsPanel({ open, projectId, projectName, onClose }: { open: boolean; projectId: string; projectName: string; onClose: () => void }) {
  const [shown, setShown] = useState(open);        // stays mounted while the panel slides out
  const [entered, setEntered] = useState(false);
  const opener = useRef<HTMLElement | null>(null);   // the button that opened it: keyboard focus goes back there

  useEffect(() => {
    if (open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setShown(true);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));   // one frame off-screen first, so it slides in
      return () => cancelAnimationFrame(raf);
    }
    opener.current?.focus();
    opener.current = null;
    setEntered(false);
    const t = window.setTimeout(() => setShown(false), SLIDE_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!shown) return null;
  return (
    <div className={`ai-root ${entered ? 'open' : ''}`}>
      <div className="ai-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="ai-panel" role="dialog" aria-label={`Action items of ${projectName}`}>
        <PanelBody projectId={projectId} projectName={projectName} onClose={onClose} />
      </aside>
    </div>
  );
}

function PanelBody({ projectId, projectName, onClose }: { projectId: string; projectName: string; onClose: () => void }) {
  const q = useWsQuery(['action-items', projectId], () => actionItemApi.list(projectId));
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  const items = q.data ?? [];
  const openCount = items.filter((i) => i.status !== 'Completed').length;

  return (
    <>
      <header className="ai-head">
        <div>
          <h2>Action items</h2>
          <p title={projectName}>{projectName}</p>
        </div>
        <div className="ai-head-actions">
          <span className="ai-tally" aria-live="polite"><b>{openCount}</b> open · {items.length - openCount} done</span>
          <button ref={closeRef} type="button" className="btn btn-ghost btn-sm ai-close" onClick={onClose} aria-label="Close action items" title="Close (Esc)"><Icon name="close" size={14} /> Close</button>
        </div>
      </header>
      <ActionItemsList projectId={projectId} />
    </>
  );
}

/** The project's Actions tab: the same list as the Portfolio side panel, on the project page itself. */
export function ActionItemsTab({ projectId, highlightId }: { projectId: string; highlightId?: string | null }) {
  const q = useWsQuery(['action-items', projectId], () => actionItemApi.list(projectId));
  const items = q.data ?? [];
  const openCount = items.filter((i) => i.status !== 'Completed').length;
  return (
    <div className="card ai-card">
      <div className="card-head">
        <div><h3>Action items</h3><p>Follow-ups agreed for this project: who does what, and by when. {items.length > 0 && <>{openCount} open · {items.length - openCount} done</>}</p></div>
        <NotesToActionsButton projectId={projectId} />
      </div>
      <ActionItemsList projectId={projectId} highlightId={highlightId} />
    </div>
  );
}

function ActionItemsList({ projectId, highlightId }: { projectId: string; highlightId?: string | null }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['action-items', projectId], () => actionItemApi.list(projectId));
  const project = useWsQuery(['project', projectId], () => projectApi.get(projectId));
  const highlighted = q.data?.find((i) => i.id === highlightId);
  const [view, setView] = useState<View>(highlighted?.status === 'Completed' ? 'all' : 'open');
  const [adding, setAdding] = useState(false);
  const permCreate = useCan('tasks.create');

  const items = useMemo(() => q.data ?? [], [q.data]);
  const shown = items.filter((i) => view === 'all' || (view === 'open' ? i.status !== 'Completed' : i.status === 'Completed'));
  const archived = project.data?.project.status === 'Archived';
  const canAdd = permCreate && !archived;   // guests and view-only roles can read the list but not add to it
  // Who an item can be given to: the people on the project (guests never get work).
  const people = useMemo(() => (project.data?.members ?? []).filter((m) => m.role !== 'Guest').map((m) => ({ id: m.userId, name: m.name })), [project.data]);

  const refresh = () => invalidateWorkspace(wid, 'action-items', projectId);

  return (
    <>
      <div className="ai-toolbar">
        <div className="seg" role="group" aria-label="Show action items">
          {([['open', 'Open'], ['done', 'Completed'], ['all', 'All']] as const).map(([id, label]) => (
            <button key={id} type="button" className={view === id ? 'active' : ''} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>
          ))}
        </div>
        {canAdd && <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}><Icon name="plus" size={14} /> Add action item</button>}
      </div>

      <div className="ai-list" role="list">
        {adding && canAdd && <ItemForm key="new" people={people} projectId={projectId} onDone={() => { setAdding(false); void refresh(); }} onCancel={() => setAdding(false)} />}
        {q.isLoading && <PageLoader />}
        {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
        {q.data && shown.length === 0 && !adding && (
          <EmptyState icon={view === 'done' ? 'inbox' : 'checkCircle'}
            title={items.length === 0 ? 'No action items yet' : view === 'open' ? 'Nothing left to do' : view === 'done' ? 'Nothing completed yet' : 'No action items'}
            text={items.length === 0 ? (archived ? 'This project is archived.' : canAdd ? 'Add follow-ups for this project: who does what, and by when.' : 'Nothing has been added for this project yet.') : view === 'open' ? 'Every action item is completed.' : undefined}
            action={items.length === 0 && canAdd ? <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" /> Add action item</button> : undefined} />
        )}
        {shown.map((i) => <ItemRow key={i.id} item={i} people={people} projectId={projectId} highlight={i.id === highlightId} onChanged={() => void refresh()} />)}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ one action item
function ItemRow({ item, people, projectId, highlight, onChanged }: { item: ActionItem; people: { id: string; name: string }[]; projectId: string; highlight?: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(!!highlight);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (highlight) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [highlight]);
  const [busy, setBusy] = useState(false);
  const done = item.status === 'Completed';

  const toggle = async () => {
    setBusy(true);
    try { await actionItemApi.setStatus(projectId, item.id, done ? 'Open' : 'Completed'); toast(done ? 'Action item reopened.' : 'Action item completed.'); onChanged(); }
    catch (e) { toast(errText(e, 'Could not change the action item.'), 'error'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Delete action item?', message: `“${item.title}” will be deleted.`, confirmText: 'Delete' }))) return;
    try { await actionItemApi.remove(projectId, item.id); toast('Action item deleted.', 'warning'); onChanged(); }
    catch (e) { toast(errText(e, 'Could not delete the action item.'), 'error'); }
  };

  if (editing) return <ItemForm item={item} people={people} projectId={projectId} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} onDelete={item.can.delete ? remove : undefined} />;

  return (
    <article ref={ref} className={`ai-item ${done ? 'done' : ''} ${item.isOverdue ? 'late' : ''} ${highlight ? 'highlight' : ''}`} role="listitem">
      <button type="button" className="ai-check" role="checkbox" aria-checked={done} disabled={!item.can.complete || busy} onClick={() => void toggle()}
        aria-label={done ? `Reopen “${item.title}”` : `Mark “${item.title}” completed`} title={item.can.complete ? (done ? 'Reopen' : 'Mark completed') : 'You cannot change this action item'}>
        {busy ? <Spinner /> : done ? <Icon name="tick" size={14} /> : null}
      </button>
      <div className="ai-main">
        <button type="button" className="ai-title" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>{item.key && <span className="task-key" style={{ marginRight: 6 }}>{item.key}</span>}{item.title}</button>
        <div className="ai-meta">
          <span className="ai-who" title={item.assignee ? `Assigned to ${item.assignee.name}` : 'Not assigned'}>
            {item.assignee ? <><Avatar name={item.assignee.name} size="sm" />{item.assignee.name}</> : <em>Unassigned</em>}
          </span>
          {item.dueDate && <span className={`ai-due ${item.isOverdue ? 'late' : ''}`} title={item.isOverdue ? 'Overdue' : 'Due date'}><Icon name="calendar" size={12} /> {formatDate(item.dueDate)}{item.isOverdue ? ' · overdue' : ''}</span>}
          <PriorityBadge priority={item.priority} />
          <span className={`ai-status ${item.status}`}>{STATUS_LABEL[item.status]}</span>
        </div>
        {item.details && <p className={`ai-details ${expanded ? 'full' : ''}`}>{item.details}</p>}
        {expanded && (
          <p className="ai-trail">
            Added{item.createdBy ? ` by ${item.createdBy.name}` : ''} on {formatDateTime(item.createdAt)}
            {done && item.completedAt && <> · Completed{item.completedBy ? ` by ${item.completedBy.name}` : ''} on {formatDateTime(item.completedAt)}</>}
          </p>
        )}
      </div>
      <div className="ai-actions">
        {item.can.edit && <button type="button" className="btn-icon" title="Edit" aria-label={`Edit “${item.title}”`} onClick={() => setEditing(true)}><Icon name="edit" size={15} /></button>}
        {item.can.delete && <button type="button" className="btn-icon danger" title="Delete" aria-label={`Delete “${item.title}”`} onClick={() => void remove()}><Icon name="trash" size={15} /></button>}
      </div>
    </article>
  );
}

// ------------------------------------------------------------------ the add / edit form
function ItemForm({ item, people, projectId, onDone, onCancel, onDelete }: {
  item?: ActionItem; people: { id: string; name: string }[]; projectId: string; onDone: () => void; onCancel: () => void; onDelete?: () => void;
}) {
  const [d, setD] = useState<Draft>(() => (item ? draftOf(item) : EMPTY));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setD((p) => ({ ...p, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };
  // The current assignee stays choosable even if they have since left the project.
  const choices = item?.assignee && !people.some((p) => p.id === item.assignee!.id) ? [...people, { id: item.assignee.id, name: item.assignee.name }] : people;

  const submit = async () => {
    if (!d.title.trim()) { setErrors({ title: 'Give the action item a short title.' }); return; }
    setBusy(true);
    const body = { title: d.title.trim(), details: d.details.trim() || null, assigneeId: d.assigneeId || null, dueDate: d.dueDate || null, priority: d.priority };
    try {
      if (item) await actionItemApi.update(projectId, item.id, { ...body, status: d.status });
      else await actionItemApi.create(projectId, body);
      toast(item ? 'Action item updated.' : 'Action item added.');
      onDone();
    } catch (e) {
      const fe: Record<string, string> = {};
      if (e instanceof ApiError) e.errors.forEach((x) => { if (x.field) fe[x.field] = x.message; });
      if (Object.keys(fe).length) setErrors(fe); else toast(errText(e, 'Could not save the action item.'), 'error');
    } finally { setBusy(false); }
  };

  const onKey = (e: KeyboardEvent<HTMLFormElement>) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };   // Esc closes the form first, not the panel

  return (
    <form className="ai-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} onKeyDown={onKey} aria-label={item ? 'Edit action item' : 'New action item'}>
      <Field label="What needs to be done" required error={errors.title}>
        <input className="input" autoFocus value={d.title} maxLength={200} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Get the client's sign-off on the design" />
      </Field>
      <Field label="Details" error={errors.details}>
        <textarea className="textarea" rows={3} value={d.details} maxLength={2000} onChange={(e) => set('details', e.target.value)} placeholder="Context, links, what done looks like…" />
      </Field>
      <div className="ai-form-grid">
        <Field label="Assigned to" error={errors.assigneeId}>
          <Select className="select" value={d.assigneeId} onChange={(e) => set('assigneeId', e.target.value)} aria-label="Assigned to">
            <option value="">Unassigned</option>{choices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Due date"><input className="input" type="date" value={d.dueDate} onChange={(e) => set('dueDate', e.target.value)} /></Field>
        <Field label="Priority">
          <Select className="select" value={d.priority} onChange={(e) => set('priority', e.target.value as Priority)} aria-label="Priority">{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
        </Field>
        {item && (
          <Field label="Status">
            <Select className="select" value={d.status} onChange={(e) => set('status', e.target.value as ActionItemStatus)} aria-label="Status">
              {(Object.keys(STATUS_LABEL) as ActionItemStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </Select>
          </Field>
        )}
      </div>
      <div className="ai-form-foot">
        {onDelete && <button type="button" className="btn btn-danger btn-sm" style={{ marginRight: 'auto' }} onClick={onDelete}><Icon name="trash" size={14} /> Delete</button>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? <Spinner /> : item ? 'Save changes' : 'Add'}</button>
      </div>
    </form>
  );
}
