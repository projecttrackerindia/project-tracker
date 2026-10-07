import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { documentApi, orgApi, teamApi, workspaceApi } from '../../api/endpoints';
import type { DocAccess, DocAccessLevel, DocGrant, DocumentDetail, GrantPrincipal } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, ErrorState, Modal, PageLoader } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useIsPersonal, useModule, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { VISIBILITY } from './docUi';
import { AccessRequestRow, DecideAccessModal } from './DocumentInbox';
import type { AccessRequest } from '../../api/types';

const LEVELS: { value: DocAccessLevel; label: string; hint: string }[] = [
  { value: 'Viewer', label: 'Can read', hint: 'Opens and reads the document.' },
  { value: 'Editor', label: 'Can edit', hint: 'Also writes in it and publishes versions.' },
  { value: 'Manager', label: 'Can manage', hint: 'Also shares it with others.' },
];
const levelLabel = (l: DocAccessLevel) => LEVELS.find((x) => x.value === l)?.label ?? l;

function GrantRow({ g, canManage, onRemove }: { g: DocGrant; canManage: boolean; onRemove: () => void }) {
  const expired = g.expiresAt && new Date(g.expiresAt) < new Date();
  return (
    <li className={`grant${g.deny ? ' deny' : ''}${expired ? ' expired' : ''}`}>
      <Icon name={g.principalType === 'User' ? 'user' : g.principalType === 'Team' ? 'users' : 'org'} size={16} />
      <div className="grant-main">
        <b>{g.name}</b>
        <span className="muted">{g.principalType === 'Team' ? `Team${g.members !== null ? ` · ${g.members} ${g.members === 1 ? 'person' : 'people'}` : ''}` : g.principalType === 'JobRole' ? 'Job role' : 'Person'}</span>
      </div>
      <span className={`badge ${g.deny ? 'badge-danger' : 'badge-neutral'}`}>{g.deny ? 'Blocked' : levelLabel(g.level)}</span>
      {g.expiresAt && <span className={`muted grant-exp${expired ? ' over' : ''}`}>{expired ? 'Ended' : 'Until'} {formatDate(g.expiresAt)}</span>}
      {canManage && <button className="btn-icon danger" aria-label={`Remove ${g.name}`} onClick={onRemove}><Icon name="close" size={14} /></button>}
    </li>
  );
}

/** Who can open this document, why, and (for people who manage it) the places to add or take away access. */
export function AccessModal({ detail, onClose }: { detail: DocumentDetail; onClose: () => void }) {
  const wid = useWorkspaceId();
  const personal = useIsPersonal();
  const id = detail.item.id;
  const q = useWsQuery(['documents', id, 'access'], () => documentApi.access(id));
  const canSeeTeams = useModule('teams') > 0 && !personal;
  const members = useWsQuery(['members'], workspaceApi.members, { enabled: !!q.data?.canManage });
  const teams = useWsQuery(['teams'], teamApi.list, { enabled: !!q.data?.canManage && canSeeTeams });
  const org = useWsQuery(['org'], orgApi.get, { enabled: !!q.data?.canManage && !personal });

  const [kind, setKind] = useState<GrantPrincipal>('User');
  const [who, setWho] = useState('');
  const [level, setLevel] = useState<DocAccessLevel>('Viewer');
  const [block, setBlock] = useState(false);
  const [until, setUntil] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<AccessRequest | null>(null);
  const requests = useWsQuery(['documents', id, 'access-requests'], () => documentApi.accessRequests(id), { enabled: !!q.data?.canManage });
  const pending = (requests.data ?? []).filter((r) => r.status === 'Pending');

  const apply = (r: DocAccess) => { queryClient.setQueryData([wid, 'documents', id, 'access'], r); invalidateWorkspace(wid, 'documents'); };
  const add = useMutation({
    mutationFn: () => documentApi.grant(id, { principalType: kind, principalId: who, level, deny: block, expiresAt: until ? new Date(`${until}T23:59:59`).toISOString() : null }),
    onSuccess: (r) => { apply(r); setWho(''); setBlock(false); setUntil(''); toast(block ? 'Blocked.' : 'Shared.'); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not share.'),
  });
  const remove = useMutation({
    mutationFn: (gid: string) => documentApi.removeGrant(id, gid),
    onSuccess: (r) => { apply(r); toast('Removed.'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not remove.', 'error'),
  });

  const data = q.data;
  const people = useMemo(() => (data?.people ?? []).filter((p) => !search.trim() || `${p.name} ${p.reasons.join(' ')}`.toLowerCase().includes(search.trim().toLowerCase())), [data, search]);
  const options = kind === 'User' ? (members.data ?? []).filter((m) => m.userId !== data?.owner.id).map((m) => ({ id: m.userId, name: m.displayName }))
    : kind === 'Team' ? (teams.data ?? []).map((t) => ({ id: t.id, name: t.name })) : (org.data?.roles ?? []).filter((r) => !r.isDeleted).map((r) => ({ id: r.id, name: r.name }));

  return (
    <Modal title="Who can open this" subtitle={`${detail.item.key} · ${detail.item.title}`} size="lg" onClose={onClose} footer={<button className="btn btn-ghost" onClick={onClose}>Close</button>}>
      {q.isLoading ? <PageLoader /> : q.isError || !data ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <div className="acc">
          <div className="acc-base">
            <Icon name={VISIBILITY[data.visibility].icon} size={18} />
            <div><b>{VISIBILITY[data.visibility].label}</b><p>{data.visibilityText}. The owner is <b>{data.owner.name}</b>.</p></div>
          </div>

          {data.canManage && (
            <form className="acc-add" onSubmit={(e) => { e.preventDefault(); if (!who) { setError('Choose who to share with.'); return; } setError(null); add.mutate(); }}>
              <h4>Add access</h4>
              {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
              <div className="acc-row">
                <Select className="select" value={kind} onChange={(e) => { setKind(e.target.value as GrantPrincipal); setWho(''); }} aria-label="Share with a">
                  <option value="User">A person</option>{canSeeTeams && <option value="Team">A team</option>}{!personal && <option value="JobRole">A job role</option>}
                </Select>
                <Select className="select" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Who"><option value="">Choose…</option>{options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
                <Select className="select" value={level} onChange={(e) => setLevel(e.target.value as DocAccessLevel)} aria-label="What they can do" disabled={block}>{LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</Select>
                <button className="btn btn-primary" type="submit" disabled={add.isPending}>{block ? 'Block' : 'Share'}</button>
              </div>
              <p className="muted acc-hint">{block ? 'Blocked people, teams or roles cannot open this document, even if it is visible to them otherwise. Organization owners and admins are never blocked.' : LEVELS.find((l) => l.value === level)?.hint}</p>
              {data.advancedPermissions ? (
                <div className="acc-adv">
                  <label className="check-row small"><input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} /> Block instead of share</label>
                  <label className="acc-until">Ends on <input className="input" type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} /></label>
                </div>
              ) : <p className="muted acc-hint"><Icon name="lock" size={13} /><span>Blocking and end dates are on the <Link to="/settings/billing" onClick={onClose}>Business plan</Link>.</span></p>}
            </form>
          )}

          {data.canManage && pending.length > 0 && (
            <>
              <h4>Requests for access ({pending.length})</h4>
              <ul className="ar-list">{pending.map((r) => <AccessRequestRow key={r.id} r={r} showDoc={false} onDecide={() => setDeciding(r)} />)}</ul>
            </>
          )}

          <h4>Shared in addition ({data.grants.length})</h4>
          {data.grants.length === 0 ? <p className="muted">Not shared beyond who can open it by default.</p> : (
            <ul className="grants">{data.grants.map((g) => <GrantRow key={g.id} g={g} canManage={data.canManage} onRemove={() => remove.mutate(g.id)} />)}</ul>
          )}

          <div className="acc-people-head">
            <h4>People who can open it ({data.peopleTotal}{data.truncated ? '+' : ''})</h4>
            <input className="input" type="search" placeholder="Find a person or a reason…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find a person" />
          </div>
          <ul className="people">
            {people.map((p) => (
              <li key={p.userId}>
                <Avatar name={p.name} /><div className="people-main"><b>{p.name}</b><span className="muted">{p.role}</span></div>
                <div className="people-why">{p.reasons.map((r) => <span key={r} className="doc-tag">{r}</span>)}</div>
                <span className={`badge ${p.level === 'Viewer' ? 'badge-neutral' : p.level === 'Editor' ? 'badge-info' : 'badge-success'}`}>{levelLabel(p.level)}</span>
              </li>
            ))}
            {people.length === 0 && <li className="muted">No one matches.</li>}
          </ul>
        </div>
      )}
      {deciding && <DecideAccessModal request={deciding} onClose={() => setDeciding(null)} />}
    </Modal>
  );
}
