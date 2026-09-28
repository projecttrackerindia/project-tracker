import { useState } from 'react';
import { ApiError } from '../../api/client';
import { workApi } from '../../api/endpoints';
import type { WorkType } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useCan, useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

/**
 * Settings → Work types: the kinds of work (Bug Fix, Data Preparation, Production Support ...) a work task can have. The workspace's own list: add,
 * rename, describe, reorder and switch types off. A type that work tasks use cannot be deleted, only switched off (it stays on those tasks).
 */
export function WorkTypeSettings() {
  const wid = useWorkspaceId();
  const seeWork = useModule('work') > 0;
  const canManage = useCan('work.types.manage');
  const list = useWsQuery(['work', 'types', 'all'], () => workApi.types(true), { enabled: seeWork });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; description: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!seeWork) return null;

  const refresh = () => invalidateWorkspace(wid, 'work', 'types');
  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try { await fn(); refresh(); return true; } catch (e) { toast(errText(e, fallback), 'error'); return false; } finally { setBusy(false); }
  };
  const types = list.data ?? [];
  const move = (i: number, by: -1 | 1) => {
    const ids = types.map((t) => t.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    void run(() => workApi.reorderTypes(ids), 'Could not reorder the work types.');
  };
  const remove = async (t: WorkType) => {
    if (!(await confirmDialog({ title: `Delete “${t.name}”?`, message: 'It is not used by any work task, so nothing is lost.', confirmText: 'Delete', danger: true }))) return;
    await run(() => workApi.removeType(t.id), 'Could not delete the work type.');
  };
  const add = async () => {
    if (!name.trim()) return;
    if (await run(() => workApi.createType({ name: name.trim(), description: description.trim() || null }), 'Could not add the work type.')) { setName(''); setDescription(''); }
  };

  return (
    <div className="card mb-22">
      <div className="card-head"><div><h3>Work types</h3><p>The kinds of work a work task can have. Managed here so new types can be added without changing the application.</p></div></div>
      <div className="card-body">
        {list.isLoading ? <PageLoader /> : list.isError ? <ErrorState error={list.error} retry={() => void list.refetch()} /> : types.length === 0 ? <EmptyState icon="bolt" title="No work types" /> : (
          <ul className="pg-list" style={{ padding: 0 }}>
            {types.map((t, i) => (
              <li className={`pg-row ${t.isActive ? '' : 'inactive'}`} key={t.id}>
                <span className="pg-order">{i + 1}</span>
                {editing?.id === t.id ? (
                  <div className="pg-main" style={{ gap: 6 }}>
                    <input className="input" value={editing.name} maxLength={60} aria-label="Name" onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                    <input className="input" value={editing.description} maxLength={200} aria-label="Description" placeholder="Description (optional)" onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
                  </div>
                ) : (
                  <div className="pg-main"><b>{t.name}</b>{t.description && <span>{t.description}</span>}</div>
                )}
                <span className="pg-count" title="Work tasks of this type"><Icon name="bolt" size={14} /> <b>{t.taskCount}</b> task{t.taskCount === 1 ? '' : 's'}</span>
                {canManage && (
                  <div className="pg-actions">
                    {editing?.id === t.id ? (
                      <>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !editing.name.trim()} onClick={() => void run(async () => { await workApi.updateType(t.id, { name: editing.name.trim(), description: editing.description.trim() || null, isActive: t.isActive }); setEditing(null); }, 'Could not save the work type.')}>Save</button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="btn-icon" title="Move up" aria-label={`Move ${t.name} up`} disabled={i === 0 || busy} onClick={() => move(i, -1)}><Icon name="chevronL" size={15} style={{ transform: 'rotate(90deg)' }} /></button>
                        <button type="button" className="btn-icon" title="Move down" aria-label={`Move ${t.name} down`} disabled={i === types.length - 1 || busy} onClick={() => move(i, 1)}><Icon name="chevronR" size={15} style={{ transform: 'rotate(90deg)' }} /></button>
                        <button type="button" className={`switch ${t.isActive ? 'on' : ''}`} role="switch" aria-checked={t.isActive} aria-label={`${t.name} is active`} disabled={busy}
                          title={t.isActive ? 'Switch off: no longer offered for new work tasks' : 'Switch on'} onClick={() => void run(() => workApi.updateType(t.id, { name: t.name, description: t.description, isActive: !t.isActive }), 'Could not change the work type.')} />
                        <button type="button" className="btn-icon" title="Rename" aria-label={`Edit ${t.name}`} onClick={() => setEditing({ id: t.id, name: t.name, description: t.description ?? '' })}><Icon name="edit" /></button>
                        <button type="button" className="btn-icon danger" title={t.taskCount > 0 ? 'In use: switch it off instead' : 'Delete'} aria-label={`Delete ${t.name}`} disabled={t.taskCount > 0 || busy} onClick={() => void remove(t)}><Icon name="trash" /></button>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          <form className="row wrap" style={{ marginTop: 16, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <div className="field" style={{ flex: '1 1 200px' }}><label htmlFor="wt-name">New work type</label><input id="wt-name" className="input" value={name} maxLength={60} placeholder="e.g. Hotfix" onChange={(e) => setName(e.target.value)} /></div>
            <div className="field" style={{ flex: '2 1 260px' }}><label htmlFor="wt-desc">Description</label><input id="wt-desc" className="input" value={description} maxLength={200} placeholder="Optional" onChange={(e) => setDescription(e.target.value)} /></div>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}><Icon name="plus" /> Add</button>
          </form>
        ) : <p className="muted" style={{ marginTop: 14 }}>Only people who manage work types can change this list.</p>}
      </div>
    </div>
  );
}
