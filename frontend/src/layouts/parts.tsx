import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { workspaceApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { Field, Modal, SubmitButton } from '../components/ui';
import { useAuth } from '../stores/auth';
import { toast } from '../stores/ui';

export const NOTIF_ICON: Record<string, string> = {
  TaskAssigned: '📌', Mention: '💬', Comment: '🗨️', DueSoon: '⏰', Overdue: '⚠️', Invitation: '✉️', Subscription: '💳', Security: '🔒', Issue: '🐞', Approval: '✅', ServiceLevel: '⏱️',
  Reminder: '⏰', Nudge: '👋', Briefing: '☀️', Meeting: '📹',
};

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

