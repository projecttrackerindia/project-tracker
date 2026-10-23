import { useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, Modal, Spinner } from '../../components/ui';
import { useVaultRequests } from './requestsData';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import {
  activeGrant, COLLECTION_MINUTES, durationLabel, REVEAL_MINUTES, vaultApi, type VaultAccess, type VaultDecoy, type VaultRequest, type VaultRequestable,
} from './api';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const STATUS_LABEL: Record<VaultRequest['status'], string> = { Pending: 'Waiting', Approved: 'Approved', Denied: 'Refused', Cancelled: 'Withdrawn', Expired: 'Lapsed' };

/**
 * Asking for access: a use window for one item under the two-person rule, or time on a collection someone may ask to join. The person who
 * decides reads the reason; the window ends by itself.
 */
/** Asks for a new value (it leaked, someone left, it is shared too widely): the owner and the people who manage it are told. */
export function RequestRotationModal({ item, onClose, onDone }: { item: { id: string; title: string }; onClose: () => void; onDone?: () => void }) {
  const wid = useWorkspaceId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Ask for a new value for “${item.title}”`} subtitle="Its owner and the people who manage it are told; it shows as “to change” until someone saves a new value." size="sm"
      onClose={onClose} className="vlt-scope"
      onSubmit={async (e) => {
        e.preventDefault(); setError(null); setBusy(true);
        try {
          await vaultApi.requestRotation(item.id, reason.trim());
          toast('Asked. It shows as “to change” until someone saves a new value.');
          void invalidateWorkspace(wid, 'vault');
          onDone?.(); onClose();
        } catch (err) { setError(errText(err, 'Could not ask.')); setBusy(false); }
      }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || reason.trim().length < 10}>{busy && <span className="spinner" />}Ask for a new value</button></>}>
      <div className="vlt-req-form">
        <label className="field"><span>Why (they read this)</span>
          <textarea className="textarea" rows={3} value={reason} maxLength={500} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="It was pasted into a support ticket by mistake" /></label>
        <p className="vlt-small muted"><Icon name="shield" size={12} /> Recorded in the audit trail.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

export function RequestAccessModal({ target, onClose, onDone }: {
  target: { kind: 'item'; id: string; title: string } | { kind: 'collection'; collection: VaultRequestable };
  onClose: () => void; onDone?: (r: VaultRequest) => void;
}) {
  const wid = useWorkspaceId();
  const item = target.kind === 'item';
  const sealed = !item && target.collection.sealed;
  const [minutes, setMinutes] = useState<number>(item ? 30 : 240);
  const [access, setAccess] = useState<VaultAccess>(sealed ? 'View' : 'UseOnly');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = item ? `“${target.title}”` : target.collection.name;
  return (
    <Modal title={`Ask for ${name}`} subtitle={item ? 'Someone else approves each use window (the two-person rule).' : 'Whoever manages it decides; the access ends by itself.'} size="sm"
      onClose={onClose} className="vlt-scope"
      onSubmit={async (e) => {
        e.preventDefault(); setError(null); setBusy(true);
        try {
          const r = item ? await vaultApi.requestReveal(target.id, reason.trim(), minutes) : await vaultApi.requestCollection(target.collection.id, reason.trim(), minutes, access);
          toast(r.status === 'Pending' ? 'Asked. You are told when someone decides.' : 'Already decided — see Requests.');
          void invalidateWorkspace(wid, 'vault');
          onDone?.(r); onClose();
        } catch (err) { setError(errText(err, 'Could not ask.')); setBusy(false); }
      }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || reason.trim().length < 10}>{busy && <span className="spinner" />}Ask</button></>}>
      <div className="vlt-req-form">
        <div className="field"><span className="vlt-field-label">For how long</span>
          <div className="seg" role="radiogroup" aria-label="For how long">
            {(item ? REVEAL_MINUTES : COLLECTION_MINUTES).map((m) => <button key={m} type="button" role="radio" aria-checked={minutes === m} onClick={() => setMinutes(m)}>{durationLabel(m)}</button>)}
          </div>
        </div>
        {!item && (
          <div className="field"><span className="vlt-field-label">Access</span>
            <div className="seg" role="radiogroup" aria-label="Access">
              {!sealed && <button type="button" role="radio" aria-checked={access === 'UseOnly'} onClick={() => setAccess('UseOnly')}>Use only</button>}
              <button type="button" role="radio" aria-checked={access === 'View'} onClick={() => setAccess('View')}>View</button>
            </div>
          </div>
        )}
        <label className="field"><span>Why (they read this before deciding)</span>
          <textarea className="textarea" rows={3} value={reason} maxLength={500} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="Rotating the payment gateway keys during tonight's change window" /></label>
        <p className="vlt-small muted"><Icon name="shield" size={12} /> Recorded in the audit trail with the decision.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

/** Requests: what waits for my decision, what I asked for, and collections I may ask to join. */
export function RequestsView() {
  const wid = useWorkspaceId();
  const q = useVaultRequests();
  const requestable = useWsQuery(['vault', 'requestable'], vaultApi.requestable, { staleTime: 60_000 });
  const [asking, setAsking] = useState<VaultRequestable | null>(null);
  const [deciding, setDeciding] = useState<{ r: VaultRequest; approve: boolean } | null>(null);
  if (q.isLoading) return <div className="vlt-pad"><Spinner /></div>;
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const { mine, toDecide } = q.data;
  const refresh = () => { void q.refetch(); void invalidateWorkspace(wid, 'vault'); };
  return (
    <div className="vlt-requests" data-testid="requests">
      <section className="card">
        <div className="card-head"><div><h3>Waiting for you{toDecide.length ? ` (${toDecide.length})` : ''}</h3><p>Approve only what you expected. The requester cannot approve their own.</p></div></div>
        <div className="card-body">
          {toDecide.length === 0 ? <p className="muted">Nothing waiting.</p> : (
            <ul className="vlt-req-list">{toDecide.map((r) => (
              <li key={r.id} data-request={r.id}>
                <RequestLine r={r} who />
                <div className="vlt-req-actions">
                  <button className="btn btn-ghost btn-sm danger" onClick={() => setDeciding({ r, approve: false })}>Refuse</button>
                  <button className="btn btn-primary btn-sm" onClick={() => setDeciding({ r, approve: true })}><Icon name="check" size={14} /> Approve {durationLabel(r.minutes)}</button>
                </div>
              </li>
            ))}</ul>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><div><h3>Asked by you</h3><p>Access ends by itself; give it back early when you are done.</p></div></div>
        <div className="card-body">
          {mine.length === 0 ? <p className="muted">You have not asked for anything.</p> : (
            <ul className="vlt-req-list">{mine.map((r) => (
              <li key={r.id} data-request={r.id}>
                <RequestLine r={r} />
                {(r.status === 'Pending' || activeGrant(r)) && (
                  <div className="vlt-req-actions">
                    <button className="btn btn-ghost btn-sm" onClick={async () => {
                      try { await vaultApi.cancelRequest(r.id); toast(r.status === 'Pending' ? 'Withdrawn.' : 'Given back.'); refresh(); } catch (e) { toast(errText(e, 'Could not do that.'), 'error'); }
                    }}>{r.status === 'Pending' ? 'Withdraw' : 'Give back now'}</button>
                  </div>
                )}
              </li>
            ))}</ul>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><div><h3>Ask to join a collection</h3><p>Collections whose managers let people ask for time on them.</p></div></div>
        <div className="card-body">
          {requestable.isLoading ? <Spinner /> : (requestable.data ?? []).length === 0
            ? <EmptyState icon="key" title="Nothing to ask for" text="When a collection's managers allow requests, it appears here." />
            : (
              <ul className="vlt-req-list">{(requestable.data ?? []).map((c) => (
                <li key={c.id}>
                  <span className="vlt-req-main"><b>{c.name}</b>{c.sealed && <span className="vlt-e2ee-tag"><Icon name="lock" size={11} /> sealed</span>}{c.description && <span className="muted">{c.description}</span>}</span>
                  <div className="vlt-req-actions"><button className="btn btn-ghost btn-sm" onClick={() => setAsking(c)}>Ask for access</button></div>
                </li>
              ))}</ul>
            )}
        </div>
      </section>
      {asking && <RequestAccessModal target={{ kind: 'collection', collection: asking }} onClose={() => setAsking(null)} onDone={refresh} />}
      {deciding && <DecideModal r={deciding.r} approve={deciding.approve} onClose={() => setDeciding(null)} onDone={refresh} />}
    </div>
  );
}

function RequestLine({ r, who = false }: { r: VaultRequest; who?: boolean }) {
  const what = r.kind === 'Reveal' ? `“${r.itemTitle ?? 'an item'}” in ${r.collectionName}` : `${r.access === 'UseOnly' ? 'use-only' : 'view'} access to ${r.collectionName}`;
  const live = activeGrant(r);
  return (
    <span className="vlt-req-main">
      <span><b>{who ? r.requester.name : 'You'}</b> asked for {what} · {durationLabel(r.minutes)}</span>
      <span className="vlt-req-reason">“{r.reason}”</span>
      <span className="muted vlt-small">
        <span className={`vlt-req-status s-${live ? 'live' : r.status.toLowerCase()}`}>{live ? `Approved until ${formatDateTime(r.grantedUntil!)}` : STATUS_LABEL[r.status]}</span>
        {' · '}{timeAgo(r.createdAt)}{r.decidedBy ? ` · by ${r.decidedBy.name}` : ''}{r.decisionNote ? ` — “${r.decisionNote}”` : ''}
      </span>
    </span>
  );
}

function DecideModal({ r, approve, onClose, onDone }: { r: VaultRequest; approve: boolean; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={approve ? `Approve ${r.requester.name}?` : `Refuse ${r.requester.name}?`} size="sm" onClose={onClose} className="vlt-scope"
      subtitle={approve ? `${r.kind === 'Reveal' ? `“${r.itemTitle}”` : r.collectionName} for ${durationLabel(r.minutes)}, from now.` : 'They are told, with your note.'}
      onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { await (approve ? vaultApi.approve(r.id, note.trim() || null) : vaultApi.deny(r.id, note.trim() || null)); toast(approve ? 'Approved. It ends by itself.' : 'Refused.'); onDone(); onClose(); }
        catch (err) { setError(errText(err, 'Could not decide.')); setBusy(false); }
      }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className={`btn ${approve ? 'btn-primary' : 'btn-danger'}`} disabled={busy}>{busy && <span className="spinner" />}{approve ? 'Approve' : 'Refuse'}</button></>}>
      <p className="vlt-req-reason">“{r.reason}”</p>
      <label className="field"><span>Note to {r.requester.name} (optional)</span>
        <input className="input" value={note} maxLength={300} autoFocus onChange={(e) => setNote(e.target.value)} placeholder={approve ? 'Go ahead — rotate it after' : 'Use the staging key instead'} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Modal>
  );
}

/** For vault admins: the decoy credentials and how often each was touched. Nobody else can tell a decoy from a real item. */
export function DecoysCard() {
  const q = useWsQuery(['vault', 'decoys'], vaultApi.decoys, { staleTime: 30_000 });
  const wid = useWorkspaceId();
  return (
    <section className="card" data-testid="decoys">
      <div className="card-head"><div><h3>Decoy credentials</h3><p>Items that look real but nobody has a reason to use. Touching one alerts the admins at once. Mark an item as a decoy from its page.</p></div></div>
      <div className="card-body">
        {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (q.data ?? []).length === 0 ? <p className="muted">No decoys yet.</p> : (
          <ul className="vlt-req-list">{(q.data ?? []).map((d: VaultDecoy) => (
            <li key={d.itemId}>
              <span className="vlt-req-main"><b>{d.title}</b><span className="muted">{d.collectionName}</span></span>
              <span className={d.triggered ? 'vlt-req-status s-denied' : 'muted vlt-small'}>{d.triggered ? `Touched ${d.triggered}× · last ${timeAgo(d.lastTriggeredAt!)}` : 'Never touched'}</span>
              <div className="vlt-req-actions"><button className="btn btn-ghost btn-xs" onClick={async () => {
                try { await vaultApi.setDecoy(d.itemId, false); toast('No longer a decoy.'); void invalidateWorkspace(wid, 'vault'); } catch (e) { toast(errText(e, 'Could not change it.'), 'error'); }
              }}>Stop being a decoy</button></div>
            </li>
          ))}</ul>
        )}
      </div>
    </section>
  );
}
