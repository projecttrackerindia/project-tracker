import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { orgApi, workspaceApi } from '../../api/endpoints';
import type { Member, Role } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, EmptyState, ErrorState, Field, Modal, PageHead, PageLoader, RoleBadge, SubmitButton, Tabs } from '../../components/ui';
import { PERMISSION_LABELS, ROLES, formatDate, limitLabel, timeAgo } from '../../lib/format';
import { PasswordChecklist, generatePassword, passwordProblem, usePasswordPolicy } from '../auth/passwordPolicy';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { Select } from '../../components/Select';

const RANK: Record<Role, number> = { Guest: 1, Member: 2, Manager: 3, Admin: 4, Owner: 5 };
type Tab = 'members' | 'invitations' | 'roles';

export function MembersPage() {
  const me = useAuth((s) => s.ctx!);
  const canInvite = useCan('members.invite');
  const canCreate = useCan('members.manage');
  const canOrg = useCan('org.manage');
  const [tab, setTab] = useState<Tab>('members');
  const [inviting, setInviting] = useState(false);
  const [creating, setCreating] = useState(false);
  const members = useWsQuery(['members'], workspaceApi.members);
  const limit = useEntitlement('MAX_MEMBERS');
  const tabs = [{ id: 'members' as Tab, label: 'Members', icon: 'users' as const },
    ...(canInvite ? [{ id: 'invitations' as Tab, label: 'Invitations', icon: 'mail' as const }] : []),
    ...(canOrg ? [{ id: 'roles' as Tab, label: 'Roles & permissions', icon: 'shield' as const }] : [])];

  return (
    <>
      <PageHead title="Members" sub={members.data ? `${members.data.length} of ${limitLabel(limit)} member${limit === 1 ? '' : 's'} in ${me.current?.name}` : ' '}>
        {canCreate && <button className="btn btn-ghost" onClick={() => setCreating(true)}><Icon name="userPlus" /> Create user</button>}
        {canInvite && <button className="btn btn-primary" onClick={() => setInviting(true)}><Icon name="plus" /> Invite member</button>}
      </PageHead>
      <div style={{ marginBottom: 18 }}><Tabs value={tab} onChange={setTab} tabs={tabs} /></div>
      {tab === 'members' && <MembersTable />}
      {tab === 'invitations' && <Invitations onInvite={() => setInviting(true)} />}
      {tab === 'roles' && <RolesMatrix />}
      {inviting && <InviteModal onClose={() => setInviting(false)} />}
      {creating && <CreateUserModal onClose={() => setCreating(false)} onInviteInstead={() => { setCreating(false); setInviting(true); }} />}
    </>
  );
}

function MembersTable() {
  const wid = useWorkspaceId();
  const meId = useAuth((s) => s.ctx!.user.id);
  const myRole = useAuth((s) => s.ctx!.current!.role);
  const canManage = useCan('members.manage');
  const q = useWsQuery(['members'], workspaceApi.members);

  const setRole = async (m: Member, role: string) => {
    try { await workspaceApi.setRole(m.userId, role); toast(`${m.displayName} is now ${role}.`); invalidateWorkspace(wid); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not change the role.', 'error'); invalidateWorkspace(wid, 'members'); }
  };
  const remove = async (m: Member) => {
    const leaving = m.userId === meId;
    if (!(await confirmDialog({ title: leaving ? 'Leave workspace?' : 'Remove member?', confirmText: leaving ? 'Leave' : 'Remove',
      message: leaving ? 'You will lose access to this workspace.' : `${m.displayName} will lose access to this workspace and its projects.` }))) return;
    try {
      await workspaceApi.removeMember(m.userId);
      toast(leaving ? 'You left the workspace.' : 'Member removed.', 'warning');
      if (leaving) location.assign('/'); else invalidateWorkspace(wid);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove the member.', 'error'); }
  };

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <div className="card">
      <div className="table-wrap"><table>
        <thead><tr><th>Member</th><th>Role</th><th>Job role</th><th>Joined</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
        <tbody>
          {q.data.map((m) => {
            const editable = canManage && m.role !== 'Owner' && m.userId !== meId && (myRole === 'Owner' || RANK[m.role] < RANK[myRole]);
            const options = ROLES.filter((r) => r !== 'Owner' && (myRole === 'Owner' || RANK[r] < RANK[myRole]));
            return (
              <tr key={m.userId}>
                <td><div className="row"><Avatar name={m.displayName} size="lg" /><div><div className="td-title">{m.displayName}{m.userId === meId && <span className="muted" style={{ fontWeight: 500 }}> (you)</span>}</div><div className="td-sub">{m.email}</div></div></div></td>
                <td>{editable
                  ? <Select className="select" style={{ width: 130, height: 32 }} value={m.role} onChange={(e) => setRole(m, e.target.value)} aria-label={`Role for ${m.displayName}`}>{options.map((r) => <option key={r}>{r}</option>)}</Select>
                  : <RoleBadge role={m.role} />}</td>
                <td className="cell-muted">{m.jobRole ?? <span title="Not placed on the organization chart yet">—</span>}</td>
                <td className="cell-muted">{formatDate(m.joinedAt)}</td>
                <td><div className="td-actions">
                  {m.userId === meId && m.role !== 'Owner' && <button className="btn btn-ghost btn-sm" onClick={() => remove(m)}>Leave</button>}
                  {editable && <button className="btn-icon danger" title="Remove" aria-label={`Remove ${m.displayName}`} onClick={() => remove(m)}><Icon name="trash" /></button>}
                </div></td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </div>
  );
}

function Invitations({ onInvite }: { onInvite: () => void }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['invitations'], workspaceApi.invitations);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data.length) return <div className="card"><div className="card-body"><EmptyState icon="mail" title="No pending invitations" text="Invite people by email. They can join with the role you choose." action={<button className="btn btn-primary" onClick={onInvite}><Icon name="plus" /> Invite member</button>} /></div></div>;
  return (
    <div className="card"><div className="table-wrap"><table>
      <thead><tr><th>Email</th><th>Role</th><th>Job role</th><th>Invited by</th><th>Sent</th><th>Expires</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
      <tbody>{q.data.map((i) => (
        <tr key={i.id}>
          <td className="td-title">{i.email}</td><td><RoleBadge role={i.role} /></td><td className="cell-muted">{i.jobRole ? <>{i.jobRole}{i.reportsTo && <span className="td-sub"> reports to {i.reportsTo}</span>}</> : '—'}</td><td className="cell-muted">{i.invitedBy ?? '—'}</td><td className="cell-muted">{timeAgo(i.createdAt)}</td><td className="cell-muted">{formatDate(i.expiresAt)}</td>
          <td><div className="td-actions"><button className="btn btn-ghost btn-sm" onClick={async () => {
            try { await workspaceApi.revokeInvitation(i.id); toast('Invitation revoked.', 'warning'); invalidateWorkspace(wid); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not revoke.', 'error'); }
          }}>Revoke</button></div></td>
        </tr>
      ))}</tbody>
    </table></div></div>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const wid = useWorkspaceId();
  const myRole = useAuth((s) => s.ctx!.current!.role);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('Member');
  const [jobRole, setJobRole] = useState('');
  const [boss, setBoss] = useState('');
  const canPlace = useCan('org.structure');
  const chart = useWsQuery(['org'], orgApi.get, { enabled: canPlace });
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const roles = ROLES.filter((r) => r !== 'Owner' && (myRole === 'Owner' || RANK[r] < RANK[myRole]));

  const send = useMutation({
    mutationFn: () => workspaceApi.invite({ email: email.trim(), role, orgRoleId: jobRole || null, reportsToUserId: boss || null }),
    onSuccess: () => { toast(`Invitation sent to ${email.trim()}.`); invalidateWorkspace(wid); onClose(); },
    onError: (e) => { setLimitHit(e instanceof ApiError && e.code === 'PLAN_LIMIT_REACHED'); setError(e instanceof ApiError ? (e.fieldError('email') ?? e.message) : 'Could not send the invitation.'); },
  });
  return (
    <Modal size="sm" title="Invite a member" subtitle="They'll receive an email with a link to join." onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError('Enter a valid email address.'); return; } setError(null); send.mutate(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={send.isPending}>Send invitation</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error} {limitHit && <Link className="link" to="/billing" onClick={onClose}>View plans</Link>}</div>}
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="Email address" required><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></Field>
        <Field label="Role" hint="Guests only see projects they are added to."><Select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>{roles.map((r) => <option key={r}>{r}</option>)}</Select></Field>
        {canPlace && (chart.data?.roles.some((r) => !r.isDeleted) ?? false) && <>
          <Field label="Job role" hint="Places them on the organization chart. The role's access settings apply from their first sign-in."><Select className="select" value={jobRole} onChange={(e) => setJobRole(e.target.value)}>
            <option value="">— Not placed yet —</option>{chart.data!.roles.filter((r) => !r.isDeleted).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select></Field>
          <Field label="Reports to"><Select className="select" value={boss} onChange={(e) => setBoss(e.target.value)}>
            <option value="">— Nobody —</option>{chart.data!.people.map((p) => <option key={p.userId} value={p.userId}>{p.displayName}</option>)}
          </Select></Field>
        </>}
      </div>
    </Modal>
  );
}

/**
 * Creates the account directly, for people who should not have to go through an email link. The administrator chooses (or
 * generates) the first password and hands it over; it is shown once, and the person must replace it at their first sign-in.
 */
function CreateUserModal({ onClose, onInviteInstead }: { onClose: () => void; onInviteInstead: () => void }) {
  const wid = useWorkspaceId();
  const myRole = useAuth((s) => s.ctx!.current!.role);
  const policy = usePasswordPolicy();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('Member');
  const [jobRole, setJobRole] = useState('');
  const [boss, setBoss] = useState('');
  const [password, setPassword] = useState(() => generatePassword(undefined));
  const [show, setShow] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [exists, setExists] = useState(false);
  const [created, setCreated] = useState<{ name: string; email: string; role: Role; password: string } | null>(null);
  const canPlace = useCan('org.structure');
  const chart = useWsQuery(['org'], orgApi.get, { enabled: canPlace });
  const roles = ROLES.filter((r) => r !== 'Owner' && (myRole === 'Owner' || RANK[r] < RANK[myRole]));

  const save = useMutation({
    mutationFn: () => workspaceApi.createMember({ email: email.trim(), displayName: name.trim(), role, password, orgRoleId: jobRole || null, reportsToUserId: boss || null }),
    onSuccess: () => { setCreated({ name: name.trim(), email: email.trim(), role, password }); invalidateWorkspace(wid); },
    onError: (e) => {
      setExists(e instanceof ApiError && e.code === 'ACCOUNT_EXISTS');
      const fe: Record<string, string> = {};
      if (e instanceof ApiError) e.errors.forEach((x) => { fe[x.field ?? 'form'] = x.message; });
      setErrors(Object.keys(fe).length ? fe : { form: 'Could not create the user.' });
    },
  });

  if (created) return <CreatedCredentials {...created} onDone={onClose} />;
  return (
    <Modal size="sm" title="Create a user" subtitle="Adds the person straight away, without an email invitation." onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        const er: Record<string, string> = {};
        if (!name.trim()) er.displayName = 'Enter the person\'s name.';
        if (!/^\S+@\S+\.\S+$/.test(email.trim())) er.email = 'Enter a valid email address.';
        const problem = passwordProblem(policy, password);
        if (problem) er.password = problem;
        setErrors(er); setExists(false);
        if (!Object.keys(er).length) save.mutate();
      }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>Create user</SubmitButton></>}>
      {errors.form && (
        <div className="form-error" role="alert">
          {errors.form}{' '}
          {exists && <button type="button" className="link" onClick={onInviteInstead}>Send an invitation instead</button>}
          {errors.form.includes('plan') && <Link className="link" to="/billing" onClick={onClose}>View plans</Link>}
        </div>
      )}
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="Full name" required error={errors.displayName}><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus /></Field>
        <Field label="Email address" required error={errors.email}><input className="input" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></Field>
        <Field label="Role" hint="Guests only see projects they are added to."><Select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>{roles.map((r) => <option key={r}>{r}</option>)}</Select></Field>
        {canPlace && (chart.data?.roles.some((r) => !r.isDeleted) ?? false) && <>
          <Field label="Job role" hint="Places them on the organization chart."><Select className="select" value={jobRole} onChange={(e) => setJobRole(e.target.value)}>
            <option value="">— Not placed yet —</option>{chart.data!.roles.filter((r) => !r.isDeleted).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select></Field>
          <Field label="Reports to"><Select className="select" value={boss} onChange={(e) => setBoss(e.target.value)}>
            <option value="">— Nobody —</option>{chart.data!.people.map((p) => <option key={p.userId} value={p.userId}>{p.displayName}</option>)}
          </Select></Field>
        </>}
        <Field label="Temporary password" required error={errors.password} hint="They will be asked to choose their own password the first time they sign in.">
          <div className="row" style={{ gap: 6 }}>
            <input className="input" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} type={show ? 'text' : 'password'} autoComplete="new-password"
              value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Temporary password" />
            <button type="button" className="btn-icon" title={show ? 'Hide' : 'Show'} aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((v) => !v)}><Icon name={show ? 'eyeOff' : 'eye'} /></button>
            <button type="button" className="btn-icon" title="Generate a new password" aria-label="Generate a new password" onClick={() => { setPassword(generatePassword(policy)); setShow(true); }}><Icon name="refresh" /></button>
          </div>
        </Field>
        <PasswordChecklist policy={policy} password={password} />
      </div>
    </Modal>
  );
}

/** Shown once, right after creating someone: the password is not stored in readable form anywhere, so this is the only chance to copy it. */
function CreatedCredentials({ name, email, role, password, onDone }: { name: string; email: string; role: Role; password: string; onDone: () => void }) {
  const url = `${window.location.origin}/login`;
  const details = `Sign in: ${url}\nEmail: ${email}\nTemporary password: ${password}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(details); toast('Sign-in details copied.'); }
    catch { toast('Could not copy. Select the details and copy them by hand.', 'warning'); }
  };
  return (
    <Modal size="sm" title="User created" subtitle={`${name} can sign in now as ${role}.`} onClose={onDone}
      footer={<><button type="button" className="btn btn-ghost" onClick={() => void copy()}><Icon name="copy" /> Copy details</button><button type="button" className="btn btn-primary" onClick={onDone}>Done</button></>}>
      <div className="form-warn" style={{ marginTop: 0 }}><Icon name="alert" size={14} /> Copy the password now and share it privately. It is shown only once and cannot be looked up later.</div>
      <dl className="cred-box">
        <div><dt>Sign in</dt><dd>{url}</dd></div>
        <div><dt>Email</dt><dd>{email}</dd></div>
        <div><dt>Temporary password</dt><dd className="cred-secret">{password}</dd></div>
      </dl>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>They were also sent an email letting them know an account was created (without the password). At first sign-in they must choose their own password before doing anything else.</p>
    </Modal>
  );
}

function RolesMatrix() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['permissions'], workspaceApi.permissions);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const m = q.data;

  const toggle = async (role: Role, permission: string, allowed: boolean) => {
    try { await workspaceApi.setPermission({ role, permission, allowed }); invalidateWorkspace(wid); toast('Permission updated.'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not update the permission.', 'error'); }
  };

  return (
    <div className="card">
      <div className="card-head"><div><h3>Roles & permissions</h3><p>Capabilities granted to each role. Owners always have full access.</p></div></div>
      {!m.canEdit && <div className="card-body" style={{ paddingBottom: 0 }}><div className="form-warn">Editing role permissions is part of the Business plan. <Link className="link" to="/billing">View plans</Link></div></div>}
      <div className="table-wrap"><table className="matrix" style={{ minWidth: 560 }}>
        <thead><tr><th>Capability</th>{m.roles.map((r) => <th key={r}>{r}</th>)}</tr></thead>
        <tbody>{m.permissions.map((p) => (
          <tr key={p}>
            <td className="td-title">{PERMISSION_LABELS[p] ?? p}<div className="td-sub">{p}</div></td>
            {m.roles.map((r) => {
              const on = m.matrix[r]?.[p] ?? false;
              const locked = r === 'Owner' || m.locked.includes(p) || !m.canEdit;
              return <td key={r}><button className={`perm-toggle ${on ? 'on' : ''}`} disabled={locked} aria-label={`${r}: ${PERMISSION_LABELS[p] ?? p}`} aria-pressed={on} onClick={() => toggle(r, p, !on)}><Icon name="tick" /></button></td>;
            })}
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}
