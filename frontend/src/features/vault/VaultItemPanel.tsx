import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { ErrorState, Spinner } from '../../components/ui';
import { formatBytes, formatDate, formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { ACTION_LABEL, HEALTH_LABEL, KIND_ICON, KIND_LABEL, vaultApi, type VaultField, type VaultItem, type VaultPolicy, type VaultTotp } from './api';
import { copySecret, strength, STRENGTH_LABEL } from './secure';
import { useStepUp } from './stepUpContext';

const MASK = '••••••••••••';
interface Shown { value: string; seconds: number }

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/**
 * One item. Secret fields arrive masked; a value is fetched only when asked for, one field at a time, kept in this component's memory (never
 * in the query cache), hidden again after the workspace's reveal time, when the tab is left, or when the vault locks.
 */
export function VaultItemPanel({ id, policy, lockEpoch, binned = false, onEdit, onClose, onChanged }: {
  id: string; policy: VaultPolicy; lockEpoch: number; binned?: boolean; onEdit: (item: VaultItem) => void; onClose: () => void; onChanged: () => void;
}) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['vault', 'item', id], () => vaultApi.item(id), { staleTime: 0 });
  const step = useStepUp();
  const [shown, setShown] = useState<Record<string, Shown>>({});
  const timers = useRef<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<'details' | 'files' | 'history' | 'activity'>('details');

  const hide = useCallback((key: string) => {
    window.clearTimeout(timers.current[key]); delete timers.current[key];
    setShown((s) => { if (!(key in s)) return s; const n = { ...s }; delete n[key]; return n; });
  }, []);
  const hideAll = useCallback(() => { Object.values(timers.current).forEach((t) => window.clearTimeout(t)); timers.current = {}; setShown({}); }, []);
  useEffect(() => {
    const onHidden = () => { if (document.hidden) hideAll(); };
    document.addEventListener('visibilitychange', onHidden); window.addEventListener('pagehide', hideAll);
    return () => { document.removeEventListener('visibilitychange', onHidden); window.removeEventListener('pagehide', hideAll); hideAll(); };
  }, [hideAll]);
  useEffect(() => { hideAll(); setTab('details'); }, [id, lockEpoch, hideAll]);

  const d = q.data;
  if (q.isLoading) return <div className="vlt-panel vlt-panel-loading"><Spinner /></div>;
  if (q.error || !d) return <div className="vlt-panel"><ErrorState error={q.error} retry={() => q.refetch()} /></div>;
  const it = d.item;

  const show = async (f: VaultField) => {
    setBusy(`show:${f.key}`);
    try {
      const res = await step.run((t) => vaultApi.reveal(id, f.key, false, t), d.needsStepUp);
      if (!res) return;
      window.clearTimeout(timers.current[f.key]);
      setShown((s) => ({ ...s, [f.key]: { value: res.value, seconds: res.revealSeconds } }));
      timers.current[f.key] = window.setTimeout(() => hide(f.key), res.revealSeconds * 1000);
    } catch (e) { toast(errText(e, 'Could not reveal it.'), 'error'); }
    finally { setBusy(null); }
  };
  const copy = async (f: VaultField) => {
    setBusy(`copy:${f.key}`);
    try {
      const res = await step.run((t) => vaultApi.reveal(id, f.key, true, t), d.needsStepUp);
      if (!res) return;
      const ok = await copySecret(res.value, res.clipboardSeconds);
      toast(ok ? `${f.label} copied. The clipboard clears in ${res.clipboardSeconds} seconds.` : 'The browser did not allow copying.', ok ? 'success' : 'error');
    } catch (e) { toast(errText(e, 'Could not copy it.'), 'error'); }
    finally { setBusy(null); }
  };

  const health = it.health;
  return (
    <section className="vlt-panel" aria-label={it.title} data-item={it.title}>
      <header className="vlt-panel-head">
        <button className="btn-icon vlt-back" aria-label="Back to the list" onClick={onClose}><Icon name="arrowLeft" /></button>
        <span className={`vlt-kind-icon kind-${it.kind.toLowerCase()}`} aria-hidden="true"><Icon name={KIND_ICON[it.kind]} size={18} /></span>
        <div className="vlt-panel-title">
          <h2>{it.title}</h2>
          <p className="muted">{KIND_LABEL[it.kind]} · {it.collectionName}{it.usernameHint ? ` · ${it.usernameHint}` : ''}</p>
        </div>
        <div className="vlt-panel-actions">
          {d.canManage && !binned && <button className="btn btn-ghost btn-sm" onClick={() => onEdit(d)}><Icon name="edit" size={15} /> Edit</button>}
          <button className="btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
        </div>
      </header>

      <div className="vlt-badges">
        {it.class === 'Confidential' && <span className="badge badge-warning" title="Every reveal or copy needs a fresh two-step check"><Icon name="shield" size={12} /> Confidential</span>}
        {d.needsStepUp && it.class !== 'Confidential' && <span className="badge badge-warning"><Icon name="shield" size={12} /> Two-step check</span>}
        {it.useOnly && <span className="badge badge-info" title="Can be copied into a sign-in form, never shown">Use only</span>}
        {it.myAccess !== 'Manage' && <span className="badge badge-neutral">Your access: {it.myAccess === 'UseOnly' ? 'use only' : it.myAccess.toLowerCase()}</span>}
        {it.tags.map((t) => <span key={t} className="chip">{t}</span>)}
      </div>

      {health.length > 0 && (
        <div className="vlt-health-callout" role="note">
          <Icon name="alert" size={16} />
          <div>
            <b>{health.map((h) => HEALTH_LABEL[h]).join(' · ')}</b>
            {it.rotationReason && <p>{it.rotationReason}. Change it at the source, then save the new value here.</p>}
            {!it.rotationReason && it.breached && <p>This password appears in public breach lists. Change it everywhere it is used.</p>}
            {!it.rotationReason && !it.breached && it.expired && <p>It was due to be changed {it.expiresAt ? formatDate(it.expiresAt) : ''}.</p>}
          </div>
        </div>
      )}

      <div className="vlt-tabs" role="tablist" aria-label="Item sections">
        {(['details', 'files', ...(d.canManage ? ['history', 'activity'] as const : [])] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'details' ? 'Details' : t === 'files' ? `Files${d.attachments.length ? ` (${d.attachments.length})` : ''}` : t === 'history' ? `Earlier values${d.versions.length ? ` (${d.versions.length})` : ''}` : 'Activity'}
          </button>
        ))}
      </div>

      {tab === 'details' && (
        <div className="vlt-fields">
          {it.url && (
            <div className="vlt-field">
              <span className="vlt-field-label">Address</span>
              <div className="vlt-field-row">
                <a className="vlt-field-value vlt-link" href={/^https?:\/\//i.test(it.url) ? it.url : `https://${it.url}`} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">{it.url}</a>
                <button className="btn-icon" aria-label="Copy the address" onClick={() => navigator.clipboard?.writeText(it.url!).then(() => toast('Address copied.'))}><Icon name="copy" size={15} /></button>
              </div>
            </div>
          )}
          {d.fields.filter((f) => !f.secret ? !!f.value : true).map((f) => f.type === 'totp'
            ? <TotpField key={f.key} itemId={id} label={f.label} needsStepUp={d.needsStepUp} lockEpoch={lockEpoch} policy={policy} />
            : (
              <div key={f.key} className="vlt-field" data-field={f.key}>
                <span className="vlt-field-label">{f.label}</span>
                {!f.secret ? (
                  <div className="vlt-field-row">
                    <span className="vlt-field-value">{f.value}</span>
                    <button className="btn-icon" aria-label={`Copy ${f.label}`} onClick={() => navigator.clipboard?.writeText(f.value ?? '').then(() => toast(`${f.label} copied.`))}><Icon name="copy" size={15} /></button>
                  </div>
                ) : (
                  <>
                    <div className="vlt-field-row">
                      {shown[f.key]
                        ? (f.type === 'note' || f.type === 'key'
                          ? <pre className="vlt-field-value vlt-secret open" data-state="revealed">{shown[f.key].value}</pre>
                          : <code className="vlt-field-value vlt-secret open" data-state="revealed" aria-live="polite">{shown[f.key].value}</code>)
                        : <code className="vlt-field-value vlt-secret" data-state="masked">{MASK}</code>}
                      {shown[f.key]
                        ? <button className="btn-icon" aria-label={`Hide ${f.label}`} onClick={() => hide(f.key)}><Icon name="eyeOff" size={15} /></button>
                        : d.canReveal && !binned && <button className="btn-icon" aria-label={`Reveal ${f.label}`} disabled={busy !== null} onClick={() => void show(f)}>{busy === `show:${f.key}` ? <Spinner /> : <Icon name="eye" size={15} />}</button>}
                      {d.canCopy && !binned && <button className="btn-icon" aria-label={`Copy ${f.label}`} disabled={busy !== null} onClick={() => void copy(f)}>{busy === `copy:${f.key}` ? <Spinner /> : <Icon name="copy" size={15} />}</button>}
                    </div>
                    {shown[f.key] && <div className="vlt-timer" role="timer" aria-label={`Hides in ${shown[f.key].seconds} seconds`}><i style={{ animationDuration: `${shown[f.key].seconds}s` }} /></div>}
                    {f.type === 'password' && shown[f.key] && <p className="vlt-small muted">Strength: {STRENGTH_LABEL[strength(shown[f.key].value)]}</p>}
                  </>
                )}
              </div>
            ))}
          {!d.canReveal && d.canCopy && <p className="vlt-small muted"><Icon name="lock" size={13} /> You can copy these values into a sign-in form but not see them.</p>}
          <dl className="vlt-meta">
            {it.owner && <><dt>Owner</dt><dd>{it.owner.name}</dd></>}
            <dt>Strength</dt><dd>{it.strength === null ? '—' : STRENGTH_LABEL[it.strength]}</dd>
            {it.expiresAt && <><dt>Change by</dt><dd className={it.expired ? 'danger' : ''}>{formatDate(it.expiresAt)}</dd></>}
            {d.rotateEveryDays && <><dt>Change every</dt><dd>{d.rotateEveryDays} days</dd></>}
            <dt>Value changed</dt><dd>{it.valueChangedAt ? timeAgo(it.valueChangedAt) : '—'}</dd>
            <dt>Last used</dt><dd>{it.lastUsedAt ? timeAgo(it.lastUsedAt) : 'Never'}</dd>
            <dt>Added</dt><dd>{formatDate(d.createdAt)}{d.createdBy ? ` by ${d.createdBy.name}` : ''}</dd>
          </dl>
          {d.links.length > 0 && <div className="vlt-links"><span className="vlt-field-label">Used by</span>{d.links.map((l) => <span key={l.kind + l.id} className="chip">{l.label}</span>)}</div>}
          {d.canManage && binned && (
            <div className="vlt-danger-zone">
              <p className="muted vlt-small">In the bin: destroyed 30 days after it was deleted, with its earlier values and files.</p>
              <button className="btn btn-primary btn-sm" onClick={async () => {
                try { await vaultApi.restore(id); toast('Restored.'); onChanged(); onClose(); } catch (e) { toast(errText(e, 'Could not restore it.'), 'error'); }
              }}><Icon name="undo" size={14} /> Restore</button>
            </div>
          )}
          {d.canManage && !binned && (
            <div className="vlt-danger-zone">
              <button className="btn btn-ghost btn-sm danger" onClick={async () => {
                if (!(await confirmDialog({ title: 'Move to the bin?', message: `“${it.title}” can be restored for 30 days, then it is destroyed with its earlier values and files.`, confirmText: 'Move to bin' }))) return;
                try { await vaultApi.remove(id); toast('Moved to the bin.', 'warning', { label: 'Undo', onClick: () => { void vaultApi.restore(id).then(() => invalidateWorkspace(wid, 'vault')); } }); onChanged(); onClose(); }
                catch (e) { toast(errText(e, 'Could not delete it.'), 'error'); }
              }}><Icon name="trash" size={14} /> Move to bin</button>
            </div>
          )}
        </div>
      )}
      {tab === 'files' && <FilesTab item={d} onChanged={() => void q.refetch()} />}
      {tab === 'history' && d.canManage && <HistoryTab item={d} lockEpoch={lockEpoch} />}
      {tab === 'activity' && d.canManage && <ActivityTab id={id} />}
    </section>
  );
}

/** The current code, computed on the server (the seed never comes to the page), refreshed as each one runs out while the tab is visible. */
function TotpField({ itemId, label, needsStepUp, lockEpoch, policy }: { itemId: string; label: string; needsStepUp: boolean; lockEpoch: number; policy: VaultPolicy }) {
  const step = useStepUp();
  const [code, setCode] = useState<(VaultTotp & { at: number }) | null>(null);
  const [left, setLeft] = useState(0);
  const refreshes = useRef(0);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await step.run((t) => vaultApi.totp(itemId, t), needsStepUp);
      if (res) { setCode({ ...res, at: Date.now() }); setLeft(res.secondsLeft); }
    } catch (e) { toast(errText(e, 'Could not get the code.'), 'error'); setCode(null); }
    finally { setBusy(false); }
  }, [itemId, needsStepUp, step]);
  useEffect(() => { setCode(null); refreshes.current = 0; }, [itemId, lockEpoch]);
  useEffect(() => {
    if (!code) return;
    const t = window.setInterval(() => {
      const l = code.secondsLeft - Math.floor((Date.now() - code.at) / 1000);
      setLeft(Math.max(0, l));
      if (l <= 0) {
        window.clearInterval(t);
        // A few fresh codes while someone is signing in; after that they ask again (each code is recorded).
        if (!document.hidden && refreshes.current < 4) { refreshes.current++; void load(); } else setCode(null);
      }
    }, 250);
    return () => window.clearInterval(t);
  }, [code, load]);
  const pretty = code ? (code.code.length === 6 ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : code.code) : '';
  return (
    <div className="vlt-field" data-field="totp">
      <span className="vlt-field-label">{label}</span>
      <div className="vlt-field-row">
        {code ? (
          <>
            <code className="vlt-field-value vlt-totp" aria-live="polite" data-state="revealed">{pretty}</code>
            <span className="vlt-ring" style={{ ['--p' as string]: String(left / code.period) }} aria-label={`${left} seconds left`}><b>{left}</b></span>
            <button className="btn-icon" aria-label="Copy the code" onClick={() => void copySecret(code.code, Math.min(policy.clipboardSeconds, 30)).then((ok) => toast(ok ? 'Code copied.' : 'The browser did not allow copying.', ok ? 'success' : 'error'))}><Icon name="copy" size={15} /></button>
          </>
        ) : (
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { refreshes.current = 0; void load(); }}>{busy ? <Spinner /> : <Icon name="timer" size={15} />} Show code</button>
        )}
      </div>
    </div>
  );
}

function FilesTab({ item, onChanged }: { item: VaultItem; onChanged: () => void }) {
  const step = useStepUp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const canDownload = item.canReveal;
  return (
    <div className="vlt-files">
      {item.attachments.length === 0 ? <p className="muted">No files. Keep a key file, a certificate or a recovery sheet here (up to 2 MB each, encrypted).</p> : (
        <ul>
          {item.attachments.map((a) => (
            <li key={a.id}>
              <Icon name="paperclip" size={15} />
              <span className="vlt-file-name">{a.fileName}</span>
              <span className="muted">{formatBytes(a.sizeBytes)} · {timeAgo(a.at)}</span>
              {canDownload && <button className="btn-icon" aria-label={`Download ${a.fileName}`} onClick={async () => {
                try { await step.run((t) => vaultApi.download(a.id, a.fileName, t), item.needsStepUp); } catch (e) { toast(errText(e, 'Could not download it.'), 'error'); }
              }}><Icon name="download" size={15} /></button>}
              {item.canManage && <button className="btn-icon danger" aria-label={`Remove ${a.fileName}`} onClick={async () => {
                if (!(await confirmDialog({ title: 'Remove this file?', message: `“${a.fileName}” is destroyed.`, confirmText: 'Remove' }))) return;
                try { await vaultApi.removeAttachment(a.id); onChanged(); } catch (e) { toast(errText(e, 'Could not remove it.'), 'error'); }
              }}><Icon name="close" size={14} /></button>}
            </li>
          ))}
        </ul>
      )}
      {!canDownload && item.attachments.length > 0 && <p className="vlt-small muted">Files of a use-only item cannot be downloaded.</p>}
      {item.canManage && (
        <>
          <input ref={input} type="file" hidden onChange={async (e) => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (!f) return;
            if (f.size > 2 * 1024 * 1024) { toast('A file kept in the vault can be up to 2 MB.', 'error'); return; }
            setBusy(true);
            try { await vaultApi.upload(item.item.id, f); toast('File added, encrypted.'); onChanged(); } catch (err) { toast(errText(err, 'Could not add the file.'), 'error'); }
            finally { setBusy(false); }
          }} />
          <button className="btn btn-ghost btn-sm" disabled={busy || item.attachments.length >= 5} onClick={() => input.current?.click()}>{busy ? <Spinner /> : <Icon name="upload" size={15} />} Add a file</button>
        </>
      )}
    </div>
  );
}

function HistoryTab({ item, lockEpoch }: { item: VaultItem; lockEpoch: number }) {
  const step = useStepUp();
  const secretFields = item.fields.filter((f) => f.secret && f.type !== 'totp');
  const [field, setField] = useState(secretFields.find((f) => f.key === 'password')?.key ?? secretFields[0]?.key ?? '');
  const [shown, setShown] = useState<{ version: string; value: string } | null>(null);
  useEffect(() => setShown(null), [lockEpoch, item.item.id]);
  useEffect(() => {
    if (!shown) return;
    const t = window.setTimeout(() => setShown(null), 15_000);
    return () => window.clearTimeout(t);
  }, [shown]);
  if (item.versions.length === 0) return <p className="muted vlt-pad">No earlier values yet. When a secret changes, the old value is kept here (encrypted) for the last ten changes.</p>;
  return (
    <div className="vlt-history">
      {secretFields.length > 1 && (
        <label className="field vlt-inline-field"><span>Field</span>
          <select className="input" value={field} onChange={(e) => { setField(e.target.value); setShown(null); }}>{secretFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
        </label>
      )}
      <ul>
        {item.versions.map((v) => (
          <li key={v.id}>
            <div><b>{formatDateTime(v.at)}</b> <span className="muted">{v.by ? `by ${v.by.name}` : ''}{v.reason ? ` · ${v.reason}` : ''}</span></div>
            {shown?.version === v.id ? <code className="vlt-secret open">{shown.value}</code> : (
              <button className="btn btn-ghost btn-sm" onClick={async () => {
                try {
                  const res = await step.run((t) => vaultApi.revealVersion(item.item.id, v.id, field, t), true);
                  if (res) setShown({ version: v.id, value: res.value });
                } catch (e) { toast(errText(e, 'Could not reveal it.'), 'error'); }
              }}><Icon name="eye" size={14} /> Reveal</button>
            )}
          </li>
        ))}
      </ul>
      <p className="vlt-small muted">Reading an earlier value always needs a fresh two-step check and is recorded.</p>
    </div>
  );
}

function ActivityTab({ id }: { id: string }) {
  const q = useWsQuery(['vault', 'activity', id], () => vaultApi.activity(id), { staleTime: 0 });
  if (q.isLoading) return <div className="vlt-pad"><Spinner /></div>;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const rows = q.data ?? [];
  if (rows.length === 0) return <p className="muted vlt-pad">Nothing recorded yet.</p>;
  return (
    <ol className="vlt-activity">
      {rows.map((r, i) => (
        <li key={i} className={r.action === 'vault.reveal_denied' || r.action === 'vault.unusual_activity' ? 'warn' : ''}>
          <span className="vlt-activity-what"><b>{r.by?.name ?? 'Someone'}</b> {(ACTION_LABEL[r.action] ?? r.action.replace('vault.', '').replace(/_/g, ' ')).toLowerCase()}{r.field ? ` · ${r.field}` : ''}</span>
          <span className="muted">{formatDateTime(r.at)}{r.ipAddress ? ` · ${r.ipAddress}` : ''}</span>
        </li>
      ))}
    </ol>
  );
}
