import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import type { SecretClass, SecretItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const MASK = '••••••••••••';

interface Shown { value: string; until: number; seconds: number }

/**
 * Secrets kept with a document. The value is never in the page until someone with the permission reveals it; it hides again by itself after the time the
 * organization chose (and at once when the tab is left or the page is closed). Every reveal is recorded on the server.
 */
export function DocumentSecrets({ documentId, canEdit }: { documentId: string; canEdit: boolean }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['documents', documentId, 'secrets'], () => documentApi.secrets(documentId));
  const [shown, setShown] = useState<Record<string, Shown>>({});
  const timers = useRef<Record<string, number>>({});
  const token = useRef<{ value: string; until: number } | null>(null);
  const [editing, setEditing] = useState<SecretItem | 'new' | null>(null);
  const [stepFor, setStepFor] = useState<SecretItem | null>(null);
  const refresh = () => invalidateWorkspace(wid, 'documents');

  const hide = useCallback((id: string) => {
    window.clearTimeout(timers.current[id]); delete timers.current[id];
    setShown((s) => { if (!(id in s)) return s; const n = { ...s }; delete n[id]; return n; });
  }, []);
  const hideAll = useCallback(() => { Object.values(timers.current).forEach((t) => window.clearTimeout(t)); timers.current = {}; setShown({}); }, []);
  useEffect(() => {
    const onHidden = () => { if (document.hidden) hideAll(); };
    document.addEventListener('visibilitychange', onHidden); window.addEventListener('pagehide', hideAll);
    return () => { document.removeEventListener('visibilitychange', onHidden); window.removeEventListener('pagehide', hideAll); hideAll(); };
  }, [hideAll]);

  const reveal = useMutation({
    mutationFn: async ({ item, step }: { item: SecretItem; step?: string }) => ({ item, res: await documentApi.reveal(documentId, item.id, step) }),
    onSuccess: ({ item, res }) => {
      window.clearTimeout(timers.current[item.id]);
      const ms = res.revealSeconds * 1000;
      setShown((s) => ({ ...s, [item.id]: { value: res.value, until: Date.now() + ms, seconds: res.revealSeconds } }));
      timers.current[item.id] = window.setTimeout(() => hide(item.id), ms);
    },
    onError: (e, { item }) => {
      if (e instanceof ApiError && e.code === 'STEP_UP_REQUIRED') { token.current = null; setStepFor(item); return; }
      toast(e instanceof ApiError ? e.message : 'Could not reveal the value.', 'error');
    },
  });
  const start = (item: SecretItem) => {
    if (item.class === 'Confidential') {
      if (token.current && token.current.until > Date.now()) reveal.mutate({ item, step: token.current.value }); else setStepFor(item);
    } else reveal.mutate({ item });
  };

  const d = q.data;
  const items = d?.items ?? [];
  return (
    <div className="card doc-side-card">
      <div className="card-head">
        <div><h3>Secrets</h3><p>Keys and passwords, kept encrypted and hidden.</p></div>
        {canEdit && <button className="btn btn-ghost btn-sm" onClick={() => setEditing('new')}><Icon name="plus" size={15} /> Add</button>}
      </div>
      <div className="card-body">
        {q.isLoading ? <p className="muted">Loading…</p> : items.length === 0 ? <p className="muted">{canEdit ? 'Nothing stored. Add a key or password instead of writing it in the text.' : 'No secrets.'}</p> : (
          <ul className="doc-secrets">
            {items.map((it) => {
              const s = shown[it.id];
              return (
                <li key={it.id} data-secret={it.label}>
                  <div className="doc-secret-head">
                    <Icon name={it.class === 'Confidential' ? 'shield' : 'key'} size={15} />
                    <b>{it.label}</b>
                    {it.class === 'Confidential' && <span className="badge badge-warning" title="Needs a fresh two-step check to reveal">Confidential</span>}
                  </div>
                  {it.note && <p className="doc-secret-note">{it.note}</p>}
                  <div className="doc-secret-row">
                    <code className={`doc-secret-value${s ? ' open' : ''}`} aria-live="polite" data-state={s ? 'revealed' : 'masked'}>{s ? s.value : MASK}</code>
                    {s ? (
                      <>
                        <button className="btn-icon" aria-label={`Copy ${it.label}`} onClick={() => navigator.clipboard?.writeText(s.value).then(() => toast('Copied. It is cleared from the screen shortly.'), () => toast('Could not copy.', 'error'))}><Icon name="copy" size={15} /></button>
                        <button className="btn-icon" aria-label={`Hide ${it.label}`} onClick={() => hide(it.id)}><Icon name="eyeOff" size={15} /></button>
                      </>
                    ) : d?.canReveal ? (
                      <button className="btn btn-ghost btn-sm" aria-label={`Reveal ${it.label}`} disabled={reveal.isPending} onClick={() => start(it)}><Icon name="eye" size={15} /> Reveal</button>
                    ) : <span className="muted doc-secret-lock" title="Ask an administrator for the permission to reveal secrets"><Icon name="lock" size={14} /></span>}
                    {canEdit && !s && <>
                      <button className="btn-icon" aria-label={`Edit ${it.label}`} onClick={() => setEditing(it)}><Icon name="edit" size={14} /></button>
                      <button className="btn-icon danger" aria-label={`Remove ${it.label}`} onClick={async () => {
                        if (!(await confirmDialog({ title: 'Remove this secret?', message: `“${it.label}” is deleted for good. Anyone relying on it will no longer find it here.`, confirmText: 'Remove' }))) return;
                        try { await documentApi.removeSecret(documentId, it.id); refresh(); toast('Secret removed.', 'warning'); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove it.', 'error'); }
                      }}><Icon name="close" size={14} /></button></>}
                  </div>
                  {s && <div className="doc-secret-timer" role="timer" aria-label={`Hides in ${s.seconds} seconds`}><i style={{ animationDuration: `${s.seconds}s` }} /></div>}
                  <p className="doc-secret-meta muted">{it.valueChangedAt ? `Changed ${timeAgo(it.valueChangedAt)}` : `Added ${timeAgo(it.createdAt)}`}{it.by ? ` · ${it.by.displayName}` : ''}</p>
                </li>
              );
            })}
          </ul>
        )}
        {d && items.length > 0 && <p className="doc-secret-foot muted">Each reveal is recorded with who and from where. Revealed values hide again after {d.revealSeconds} seconds.</p>}
      </div>
      {editing && <SecretModal documentId={documentId} existing={editing === 'new' ? null : editing} confidentialAllowed={d?.confidentialAllowed ?? false} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {stepFor && <StepUpModal onClose={() => setStepFor(null)} onDone={(t) => { token.current = { value: t.token, until: Date.parse(t.expiresAt) - 5000 }; const it = stepFor; setStepFor(null); reveal.mutate({ item: it, step: t.token }); }} />}
    </div>
  );
}

function SecretModal({ documentId, existing, confidentialAllowed, onClose, onSaved }: { documentId: string; existing: SecretItem | null; confidentialAllowed: boolean; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(existing?.label ?? '');
  const [value, setValue] = useState('');
  const [note, setNote] = useState(existing?.note ?? '');
  const [cls, setCls] = useState<SecretClass>(existing?.class ?? 'Secret');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => documentApi.saveSecret(documentId, existing?.id ?? null, { label, value: value || undefined, note: note || undefined, class: cls }),
    onSuccess: () => { toast(existing ? 'Secret saved.' : 'Secret added.'); onSaved(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  return (
    <Modal title={existing ? 'Edit secret' : 'Add a secret'} subtitle="The value is encrypted and cannot be read back except by a reveal." onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !label.trim() || (!existing && !value)}>{save.isPending && <span className="spinner" />}Save</button></>}>
      <div className="form-grid">
        <label className="field"><span>Name</span><input value={label} maxLength={80} autoFocus onChange={(e) => setLabel(e.target.value)} placeholder="Production API key" /></label>
        <label className="field"><span>{existing ? 'New value (leave empty to keep the current one)' : 'Value'}</span><input type="password" autoComplete="new-password" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} /></label>
        <label className="field"><span>Note (shown to everyone who opens the document)</span><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Payments gateway, rotates every 90 days" /></label>
        <fieldset className="field doc-secret-class"><legend>Protection</legend>
          <label><input type="radio" name="cls" checked={cls === 'Secret'} onChange={() => setCls('Secret')} /> <b>Secret</b> <span className="muted">Hidden; revealed by people with the permission.</span></label>
          <label className={confidentialAllowed ? '' : 'off'}><input type="radio" name="cls" disabled={!confidentialAllowed} checked={cls === 'Confidential'} onChange={() => setCls('Confidential')} /> <b>Confidential</b> <span className="muted">{confidentialAllowed ? 'Also needs a fresh two-step check at every reveal.' : 'Business plan.'}</span></label>
        </fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

function StepUpModal({ onClose, onDone }: { onClose: () => void; onDone: (t: { token: string; expiresAt: string }) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: () => documentApi.stepUp(code.trim()),
    onSuccess: onDone,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not check the code.'),
  });
  return (
    <Modal title="Confirm it is you" subtitle="This value is confidential. Enter the code from your authenticator app (or a recovery code)." size="sm" onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); setError(null); check.mutate(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={check.isPending || code.trim().length < 6}>{check.isPending && <span className="spinner" />}Confirm</button></>}>
      <label className="field"><span>Code</span><input value={code} inputMode="numeric" autoComplete="one-time-code" autoFocus onChange={(e) => setCode(e.target.value)} placeholder="123 456" aria-label="Two-step code" /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Modal>
  );
}
