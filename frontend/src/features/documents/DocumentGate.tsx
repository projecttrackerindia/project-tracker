import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import type { DocAccessLevel } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { ErrorState, Field, PageLoader, SubmitButton } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';

const DAYS = [{ v: '7', t: '7 days' }, { v: '30', t: '30 days' }, { v: '90', t: '90 days' }, { v: '', t: 'No end date' }];

/** Shown instead of a document the person cannot open, when it exists: its number, its title (unless private) and who to ask. */
export function DocumentGate({ id, original }: { id: string; original: unknown }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['documents', id, 'gate'], () => documentApi.gate(id), { retry: false });
  const [level, setLevel] = useState<DocAccessLevel>('Viewer');
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('30');
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () => documentApi.requestAccess(id, { level, reason: reason.trim(), durationDays: days ? Number(days) : null }),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); toast('Request sent.'); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not send the request.'),
  });
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={original ?? q.error} retry={() => q.refetch()} />;
  const g = q.data;
  return (
    <div className="gate">
      <div className="gate-card">
        <span className="gate-ico"><Icon name="lock" size={22} /></span>
        <h1>You do not have access to this document</h1>
        <p className="gate-doc"><span className="doc-key">{g.key}</span>{g.title ? <b>{g.title}</b> : <b>A private document</b>}</p>
        <p className="muted">{g.ownerName ? <>Owned by <b>{g.ownerName}</b>{g.teamName ? <> · {g.teamName}</> : null}.</> : null} You can ask the people who manage it.</p>

        {g.pending ? (
          <div className="gate-pending"><Icon name="clock" size={16} /><div><b>Request sent {timeAgo(g.pending.createdAt)}</b><p>“{g.pending.reason}” · you will be told when someone answers.</p></div></div>
        ) : (
          <form className="gate-form" onSubmit={(e) => { e.preventDefault(); if (reason.trim().length < 3) { setError('Say why you need access.'); return; } setError(null); send.mutate(); }}>
            {g.last?.status === 'Rejected' && <div className="doc-alert info"><Icon name="info" size={16} /><div>Your last request was declined{g.last.decisionNote ? `: “${g.last.decisionNote}”` : '.'}</div></div>}
            {g.last?.status === 'Approved' && <div className="doc-alert info"><Icon name="info" size={16} /><div>Your access has ended. You can ask again.</div></div>}
            {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
            <Field label="Why do you need it?" required><textarea className="textarea" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. I join the payments project next week" /></Field>
            <div className="ar-grid">
              <Field label="You want to"><Select className="select" value={level} onChange={(e) => setLevel(e.target.value as DocAccessLevel)} aria-label="Access level"><option value="Viewer">Read it</option><option value="Editor">Edit it</option></Select></Field>
              <Field label="For"><Select className="select" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Duration">{DAYS.map((d) => <option key={d.v} value={d.v}>{d.t}</option>)}</Select></Field>
            </div>
            <SubmitButton busy={send.isPending}>Request access</SubmitButton>
          </form>
        )}
        <p className="gate-back"><Link to="/documents">Back to documents</Link></p>
      </div>
    </div>
  );
}
