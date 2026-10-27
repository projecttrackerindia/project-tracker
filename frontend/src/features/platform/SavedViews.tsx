import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { teamApi } from '../../api/endpoints';
import { savedViewApi, type SavedView, type ViewScope, type ViewSharing } from '../../api/platformApi';
import { Icon } from '../../components/Icon';
import { Field, Modal, Segmented, SubmitButton } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import './platform.css';

/** The same filters in any key order are the same view. */
export function sameConfig(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const norm = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '' && o[k] !== false).sort().map((k) => [k, o[k]]));
  return norm(a) === norm(b);
}

const SHARE_ICON: Record<ViewSharing, string> = { private: '', workspace: 'Shared with everyone', team: 'Shared with a team' };

/**
 * Saved views as chips above a list: tap one to apply its filters, sort and grouping; the chip of the view the list matches is lit. "Save
 * view" names the current choice and says who sees it - only me, everyone in the workspace, or one of my teams. Views other people share
 * show who saved them; only your own (or, for an admin, shared ones) can be removed here.
 */
export function SavedViewsBar({ scope, current, onApply, label = 'Views', only }: {
  scope: ViewScope; current: Record<string, unknown>; onApply: (config: Record<string, unknown>) => void; label?: string;
  /** Show only the views saved on this list (their config's `list`), when one scope covers several lists. */
  only?: string;
}) {
  const wid = useWorkspaceId();
  const role = useAuth((s) => s.ctx?.current?.role);
  const isAdmin = role === 'Owner' || role === 'Admin';
  const q = useWsQuery(['saved-views', scope], () => savedViewApi.list(scope), { staleTime: 60_000, retry: false });
  const [saving, setSaving] = useState(false);
  const views = useMemo(() => (q.data ?? []).filter((v) => !only || (v.config.list ?? only) === only), [q.data, only]);
  const active = useMemo(() => views.find((v) => sameConfig(v.config, current))?.id ?? null, [views, current]);

  const remove = async (v: SavedView) => {
    if (!(await confirmDialog({ title: `Remove “${v.name}”?`, message: v.sharing === 'private' ? 'Only you had this view.' : 'People it was shared with will no longer see it.', confirmText: 'Remove', danger: true }))) return;
    try { await savedViewApi.remove(v.id); toast('View removed.'); void invalidateWorkspace(wid, 'saved-views'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove the view.', 'error'); }
  };

  return (
    <div className="pv-views" role="toolbar" aria-label={label}>
      <span className="pv-views-l">{label}</span>
      <div className="pv-views-scroll">
        {views.map((v) => (
          <span key={v.id} className={`pv-chip${active === v.id ? ' on' : ''}`}>
            <button type="button" aria-pressed={active === v.id} onClick={() => onApply(v.config)}
              title={v.sharing === 'private' ? 'Only you' : `${SHARE_ICON[v.sharing]}${v.teamName ? ` (${v.teamName})` : ''} · saved by ${v.mine ? 'you' : v.ownerName}`}>
              {v.sharing !== 'private' && <Icon name="users" size={12} />}{v.name}
            </button>
            {(v.mine || (isAdmin && v.sharing !== 'private')) && (
              <button type="button" className="pv-chip-x" aria-label={`Remove view ${v.name}`} onClick={() => void remove(v)}><Icon name="close" size={11} /></button>
            )}
          </span>
        ))}
        <button type="button" className="pv-chip pv-chip-add" onClick={() => setSaving(true)} disabled={active !== null}
          title={active !== null ? 'This is already a saved view' : 'Save the current filters, sort and grouping'}>
          <Icon name="plus" size={12} />Save view
        </button>
      </div>
      {saving && <SaveViewModal scope={scope} config={current} onClose={() => setSaving(false)} />}
    </div>
  );
}

function SaveViewModal({ scope, config, onClose }: { scope: ViewScope; config: Record<string, unknown>; onClose: () => void }) {
  const wid = useWorkspaceId();
  const personal = useIsPersonal();
  const guest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const teams = useWsQuery(['teams'], teamApi.list, { enabled: !personal && !guest, staleTime: 5 * 60_000, retry: false });
  const [name, setName] = useState('');
  const [sharing, setSharing] = useState<ViewSharing>('private');
  const [teamId, setTeamId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = [{ id: 'private' as const, label: 'Only me' }, ...(!personal && !guest ? [{ id: 'workspace' as const, label: 'Everyone' }] : []),
    ...((teams.data?.length ?? 0) > 0 ? [{ id: 'team' as const, label: 'A team' }] : [])];

  const save = async () => {
    if (!name.trim()) { setError('Give the view a name.'); return; }
    if (sharing === 'team' && !teamId) { setError('Choose the team.'); return; }
    setBusy(true); setError(null);
    try {
      await savedViewApi.create({ scope, name: name.trim(), sharing, teamId: sharing === 'team' ? teamId : null, config });
      toast(sharing === 'private' ? 'View saved.' : 'View saved and shared.');
      void invalidateWorkspace(wid, 'saved-views');
      onClose();
    } catch (e) { setError(e instanceof ApiError ? (e.fieldError('name') ?? e.errors[0]?.message ?? e.message) : 'Could not save the view.'); }
    finally { setBusy(false); }
  };
  return (
    <Modal size="sm" title="Save view" subtitle="The filters, sort and grouping you have now, under a name." onClose={onClose} onSubmit={(e) => { e.preventDefault(); void save(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>Save view</SubmitButton></>}>
      <Field label="Name" error={error ?? undefined}>
        <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Critical this week" aria-label="View name" />
      </Field>
      {options.length > 1 && (
        <Field label="Who sees it">
          <Segmented label="Who sees it" value={sharing} onChange={setSharing} options={options} wide />
        </Field>
      )}
      {sharing === 'team' && (
        <Field label="Team">
          <select className="input" aria-label="Team" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">Choose a team…</option>
            {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      )}
    </Modal>
  );
}
