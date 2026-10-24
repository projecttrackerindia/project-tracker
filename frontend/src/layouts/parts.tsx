import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { workspaceApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { Field, Modal, SubmitButton } from '../components/ui';
import { useAuth } from '../stores/auth';
import { toast } from '../stores/ui';
import { Icon, type IconName } from '../components/Icon';

/** One line icon per kind of notification (no emoji in the interface), with the status tone its tile is drawn in. */
export const NOTIF_ICON: Record<string, { icon: IconName; tone: '' | 'success' | 'warning' | 'danger' | 'progress' | 'neutral' }> = {
  TaskAssigned: { icon: 'checkCircle', tone: '' }, Mention: { icon: 'message', tone: '' }, Comment: { icon: 'message', tone: 'neutral' },
  DueSoon: { icon: 'clock', tone: 'warning' }, Overdue: { icon: 'alert', tone: 'danger' }, Invitation: { icon: 'mail', tone: '' },
  Subscription: { icon: 'card', tone: 'neutral' }, Security: { icon: 'lock', tone: 'danger' }, Issue: { icon: 'bug', tone: 'danger' },
  Approval: { icon: 'check', tone: 'success' }, ServiceLevel: { icon: 'timer', tone: 'warning' }, Reminder: { icon: 'alarm', tone: 'warning' },
  Nudge: { icon: 'hand', tone: 'progress' }, Briefing: { icon: 'sun', tone: '' }, Meeting: { icon: 'video', tone: '' }, Support: { icon: 'info', tone: 'success' },
};
const BELL = { icon: 'bell' as IconName, tone: 'neutral' as const };
/** The icon tile for a notification of this kind. */
export function NotifIcon({ type, className = 'dp-ico' }: { type: string; className?: string }) {
  const k = NOTIF_ICON[type] ?? BELL;
  return <span className={`${className} ds-tile-ico ${k.tone}`} aria-hidden="true"><Icon name={k.icon} size={16} /></span>;
}

export function CreateOrganizationModal({ onClose }: { onClose: () => void }) {
  const switchWorkspace = useAuth((s) => s.switchWorkspace);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => workspaceApi.create({ name, description: description || undefined }),
    onSuccess: async (ws) => { await switchWorkspace(ws.id); toast(`Organization “${ws.name}” created.`); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? (e.fieldError('name') ?? e.message) : 'Could not create the organization.'),
  });
  return (
    <Modal title="Create organization" subtitle="A separate workspace for your team, with its own members, projects and plan." onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (name.trim().length < 2) { setError('Enter a name (at least 2 characters).'); return; } setError(null); m.mutate(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={m.isPending}>Create organization</SubmitButton></>}>
      {error && <div className="form-error">{error}</div>}
      <div className="form-grid">
        <Field label="Organization name" required full><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Qruize Technologies" maxLength={80} /></Field>
        <Field label="Description" full><textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this team work on?" maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

