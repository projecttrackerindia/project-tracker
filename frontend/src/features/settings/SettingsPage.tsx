import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { authApi, meApi, workspaceApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Badge, Field, Modal, PageHead, PageLoader, SubmitButton } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast, useUi } from '../../stores/ui';
import { PasswordChecklist, passwordProblem, usePasswordPolicy } from '../auth/passwordPolicy';
import { NotificationSettings } from './NotificationSettings';
import { TwoStepRow } from './TwoStep';
import { PrivacyRow } from './Privacy';
import { PrioritySettings } from './PrioritySettings';
import { CustomFieldSettings } from './CustomFieldSettings';
import { WorkTypeSettings } from './WorkTypeSettings';
import { ApiKeySettings } from './ApiKeySettings';
import { WebhookSettings } from './WebhookSettings';
import { Select } from '../../components/Select';

const TIME_ZONES = ['Asia/Kolkata', 'UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];

function browserOf(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

export function SettingsPage() {
  const ctx = useAuth((s) => s.ctx)!;
  const reload = useAuth((s) => s.reloadContext);
  const logout = useAuth((s) => s.logout);
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const { theme, toggleTheme } = useUi();
  const personal = useIsPersonal();
  const canOrg = useCan('org.manage');
  const [name, setName] = useState(ctx.user.displayName);
  const [tz, setTz] = useState(ctx.user.timeZone);
  const [wsName, setWsName] = useState(ctx.current?.name ?? '');
  const [wsDesc, setWsDesc] = useState(ctx.current?.description ?? '');
  const [pwOpen, setPwOpen] = useState(false);
  const sessions = useWsQuery(['sessions'], meApi.sessions);

  const profile = useMutation({
    mutationFn: () => meApi.updateProfile({ displayName: name.trim(), timeZone: tz }),
    onSuccess: async () => { toast('Profile saved.'); await reload(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not save your profile.', 'error'),
  });
  const workspace = useMutation({
    mutationFn: () => workspaceApi.update({ name: wsName.trim(), description: wsDesc.trim() || undefined }),
    onSuccess: async () => { toast('Workspace updated.'); await reload(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not update the workspace.', 'error'),
  });

  return (
    <>
      <PageHead title="Settings" sub="Your profile, appearance, security and workspace preferences" />

      <div className="card mb-22">
        <div className="card-head"><h3>Profile</h3></div>
        <div className="card-body">
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (name.trim()) profile.mutate(); }}>
            <Field label="Full name" required><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
            <Field label="Email" hint={ctx.user.emailVerified ? 'Verified' : 'Not verified'}><input className="input" value={ctx.user.email} disabled /></Field>
            <Field label="Time zone" hint="Used to display dates and times."><Select className="select" value={tz} onChange={(e) => setTz(e.target.value)}>{[...new Set([tz, ...TIME_ZONES])].map((z) => <option key={z}>{z}</option>)}</Select></Field>
            <div className="full"><SubmitButton busy={profile.isPending}>Save profile</SubmitButton></div>
          </form>
        </div>
      </div>

      <div className="card mb-22">
        <div className="card-head"><h3>Appearance</h3></div>
        <div className="card-body"><div className="setting-row">
          <div className="setting-info"><h4>Dark mode</h4><p>Switch between light and dark themes. Your preference is remembered on this device.</p></div>
          <button className={`switch ${theme === 'dark' ? 'on' : ''}`} onClick={toggleTheme} role="switch" aria-checked={theme === 'dark'} aria-label="Toggle dark mode" />
        </div></div>
      </div>

      {ctx.current && !ctx.user.isPlatformAdmin && (
        <div className="card mb-22">
          <div className="card-head"><div><h3>Workspace</h3><p>{ctx.current.type === 'Personal' ? 'Your personal workspace' : 'Organization settings'} · your role: {ctx.current.role}</p></div></div>
          <div className="card-body">
            <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (wsName.trim().length >= 2) workspace.mutate(); }}>
              <Field label="Workspace name"><input className="input" value={wsName} onChange={(e) => setWsName(e.target.value)} disabled={!canOrg} maxLength={80} /></Field>
              <Field label="Plan"><div className="row" style={{ height: 38 }}><Badge tone="purple">{ctx.current.plan.name}</Badge><button type="button" className="link" onClick={() => nav('/billing')}>Manage billing</button></div></Field>
              <Field label="Description" full><textarea className="textarea" value={wsDesc} onChange={(e) => setWsDesc(e.target.value)} disabled={!canOrg} maxLength={500} /></Field>
              {canOrg && <div className="full"><SubmitButton busy={workspace.isPending}>Save workspace</SubmitButton></div>}
            </form>
            {personal && <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>Want to collaborate? Use the workspace menu in the top bar to create an organization.</p>}
          </div>
        </div>
      )}

      <PrioritySettings />
      <WorkTypeSettings />

      <CustomFieldSettings />

      <ApiKeySettings />

      <WebhookSettings />

      <NotificationSettings />

      <div className="card mb-22">
        <div className="card-head"><h3>Security</h3></div>
        <div className="card-body">
          <div className="setting-row">
            <div className="setting-info"><h4>Password</h4><p>Changing your password signs you out of your other devices.</p></div>
            <button className="btn btn-ghost" onClick={() => setPwOpen(true)}><Icon name="lock" /> Change password</button>
          </div>
          <TwoStepRow />
          <PrivacyRow />
          <div className="setting-row" style={{ alignItems: 'flex-start' }}>
            <div className="setting-info" style={{ flex: 1 }}>
              <h4>Active sessions</h4><p>Devices currently signed in to your account.</p>
              {sessions.isLoading ? <PageLoader /> : (
                <div className="member-list" style={{ marginTop: 12 }}>
                  {sessions.data?.map((s) => (
                    <div className="member-item" key={s.id}>
                      <Icon name="monitor" />
                      <div className="member-main"><div className="member-name">{browserOf(s.userAgent)} {s.isCurrent && <Badge tone="success">This device</Badge>}</div><div className="member-role">{s.ipAddress ?? 'Unknown IP'} · active {timeAgo(s.lastSeenAt)}</div></div>
                      {!s.isCurrent && <button className="btn btn-ghost btn-sm" onClick={async () => { await meApi.revokeSession(s.id); toast('Session signed out.', 'warning'); invalidateWorkspace(wid); }}>Sign out</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info"><h4>Sign out everywhere</h4><p>End every session on every device, including this one.</p></div>
            <button className="btn btn-danger" onClick={async () => { if (await confirmDialog({ title: 'Sign out everywhere?', confirmText: 'Sign out everywhere', message: 'You will need to sign in again on all your devices.' })) { await authApi.logoutAll(); await logout(); } }}><Icon name="logout" /> Sign out everywhere</button>
          </div>
        </div>
      </div>

      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
    </>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const policy = usePasswordPolicy();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => meApi.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => { toast('Password changed. Other devices were signed out.'); onClose(); },
    onError: (e) => {
      const fe: Record<string, string> = {};
      if (e instanceof ApiError) e.errors.forEach((x) => { fe[x.field ?? 'newPassword'] = x.message; });
      setErrors(Object.keys(fe).length ? fe : { newPassword: 'Could not change the password.' });
    },
  });
  return (
    <Modal size="sm" title="Change password" onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        const er: Record<string, string> = {};
        if (!current) er.currentPassword = 'Enter your current password.';
        const problem = passwordProblem(policy, next);
        if (problem) er.newPassword = problem;
        setErrors(er);
        if (!Object.keys(er).length) save.mutate();
      }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>Update password</SubmitButton></>}>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="Current password" error={errors.currentPassword}><input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" error={errors.newPassword}><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <PasswordChecklist policy={policy} password={next} showHistory />
      </div>
    </Modal>
  );
}
