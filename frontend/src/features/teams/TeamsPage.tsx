import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { teamApi, workspaceApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Avatar, EmptyState, ErrorState, Field, Modal, PageHead, PageLoader, SubmitButton } from '../../components/ui';
import { limitLabel } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useCan, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { Select } from '../../components/Select';

export function TeamsPage() {
  const canManage = useCan('teams.manage');
  const limit = useEntitlement('MAX_TEAMS');
  const [modal, setModal] = useState<{ id?: string; creating?: boolean } | null>(null);
  const q = useWsQuery(['teams'], teamApi.list);

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <>
      <PageHead title="Teams" sub={`${q.data.length} of ${limitLabel(limit)} team${limit === 1 ? '' : 's'} used`}>
        {canManage && <button className="btn btn-primary" onClick={() => setModal({ creating: true })}><Icon name="plus" /> New Team</button>}
      </PageHead>
      {q.data.length === 0 ? (
        <div className="card"><div className="card-body"><EmptyState icon="users" title="No teams yet" text="Group members into teams to assign projects and see workload."
          action={canManage ? <button className="btn btn-primary" onClick={() => setModal({ creating: true })}><Icon name="plus" /> New Team</button> : undefined} /></div></div>
      ) : (
        <div className="project-grid">
          {q.data.map((t) => (
            <div key={t.id} className="project-card" role="button" tabIndex={0} onClick={() => setModal({ id: t.id })} onKeyDown={(e) => { if (e.key === 'Enter') setModal({ id: t.id }); }}>
              <div className="pc-head"><div><div className="pc-name">{t.name}</div><div className="pc-code">{t.memberCount} member{t.memberCount === 1 ? '' : 's'}</div></div><span className="ws-avatar" style={{ width: 34, height: 34 }}><Icon name="users" size={16} /></span></div>
              {t.description && <div className="pc-desc">{t.description}</div>}
              <div className="pc-stats" style={{ gridTemplateColumns: 'repeat(2,1fr)' }}>
                <div className="pc-stat"><b>{t.memberCount}</b><span>Members</span></div><div className="pc-stat"><b>{t.projectCount}</b><span>Projects</span></div>
              </div>
              <div className="pc-foot"><span className="row" style={{ gap: 6 }}>{t.lead ? <><Avatar name={t.lead.name} size="sm" />Lead: {t.lead.name}</> : 'No team lead'}</span></div>
            </div>
          ))}
        </div>
      )}
      {modal?.creating && <TeamFormModal onClose={() => setModal(null)} />}
      {modal?.id && <TeamDetailModal id={modal.id} canManage={canManage} onClose={() => setModal(null)} />}
    </>
  );
}

function TeamFormModal({ team, onClose }: { team?: { id: string; name: string; description: string | null; parentTeamId?: string | null }; onClose: () => void }) {
  const wid = useWorkspaceId();
  const all = useWsQuery(['teams'], teamApi.list);
  const [parentId, setParentId] = useState(team?.parentTeamId ?? '');
  // A department is a top-level team; a team that has teams under it cannot itself be placed inside another.
  const departments = (all.data ?? []).filter((t) => t.id !== team?.id && !t.parentTeamId);
  const hasChildren = !!team && (all.data ?? []).some((t) => t.parentTeamId === team.id);
  const [name, setName] = useState(team?.name ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => team ? teamApi.update(team.id, { name: name.trim(), description: description.trim() || undefined, parentTeamId: parentId || null }) : teamApi.create({ parentTeamId: parentId || null, name: name.trim(), description: description.trim() || undefined }),
    onSuccess: () => { toast(team ? 'Team updated.' : 'Team created.'); invalidateWorkspace(wid); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save the team.'),
  });
  return (
    <Modal size="sm" title={team ? 'Edit team' : 'New team'} onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (!name.trim()) { setError('Enter a team name.'); return; } setError(null); save.mutate(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>{team ? 'Save' : 'Create team'}</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="Team name" required><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Development" /></Field>
        <Field label="Description"><textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></Field>
        {departments.length > 0 && !hasChildren && (
          <Field label="Department" hint="Optional. Groups this team under a larger team.">
            <Select className="select" value={parentId} onChange={(e) => setParentId(e.target.value)} aria-label="Department"><option value="">None (top level)</option>{departments.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function TeamDetailModal({ id, canManage, onClose }: { id: string; canManage: boolean; onClose: () => void }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['team', id], () => teamApi.get(id));
  const members = useWsQuery(['members'], workspaceApi.members);
  const [pick, setPick] = useState('');
  const [editing, setEditing] = useState(false);
  const refresh = () => invalidateWorkspace(wid);

  if (q.isLoading) return <Modal title="Team" onClose={onClose}><PageLoader /></Modal>;
  if (q.isError || !q.data) return <Modal title="Team" onClose={onClose}><ErrorState error={q.error} /></Modal>;
  const { team, members: list } = q.data;
  const available = members.data?.filter((m) => !list.some((x) => x.userId === m.userId)) ?? [];
  if (editing) return <TeamFormModal team={team} onClose={() => setEditing(false)} />;

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast(ok); refresh(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Something went wrong.', 'error'); }
  };

  return (
    <Modal size="lg" title={team.name} subtitle={team.description ?? `${list.length} members · ${team.projectCount} projects`} onClose={onClose}
      footer={<>
        {canManage && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={async () => {
          if (await confirmDialog({ title: 'Delete team?', message: `Delete “${team.name}”? Its projects keep existing but lose the team link.` })) { await run(() => teamApi.remove(id), 'Team deleted.'); onClose(); }
        }}><Icon name="trash" /> Delete</button>}
        {canManage && <button className="btn btn-ghost" onClick={() => setEditing(true)}><Icon name="edit" /> Edit</button>}
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
      </>}>
      {canManage && available.length > 0 && (
        <div className="row" style={{ marginBottom: 16 }}>
          <Select className="select" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add a member"><option value="">Add a member…</option>{available.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select>
          <button className="btn btn-primary" disabled={!pick} onClick={() => run(async () => { await teamApi.addMember(id, { userId: pick, isLead: false }); setPick(''); }, 'Member added.')}><Icon name="plus" /> Add</button>
        </div>
      )}
      {list.length === 0 ? <p className="muted">This team has no members yet.</p> : (
        <div className="member-list">
          {list.map((m) => (
            <div className="member-item" key={m.userId}>
              <Avatar name={m.name} size="lg" />
              <div className="member-main"><div className="member-name">{m.name} {m.isLead && <span className="badge badge-purple" style={{ marginLeft: 6 }}>Lead</span>}</div><div className="member-role">{m.email}</div></div>
              <div className="member-role" style={{ textAlign: 'right' }}>{m.openTasks} open task{m.openTasks === 1 ? '' : 's'}</div>
              {canManage && <>
                <button className="btn btn-ghost btn-sm" onClick={() => run(() => teamApi.addMember(id, { userId: m.userId, isLead: !m.isLead }))}>{m.isLead ? 'Remove lead' : 'Make lead'}</button>
                <button className="btn-icon danger" aria-label={`Remove ${m.name}`} onClick={() => run(() => teamApi.removeMember(id, m.userId), 'Member removed.')}><Icon name="close" /></button>
              </>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
