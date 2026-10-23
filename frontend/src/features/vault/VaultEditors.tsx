import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { projectApi, teamApi, workspaceApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Field, Modal, Spinner } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { confirmDialog, toast } from '../../stores/ui';
import {
  ACCESS_HINT, ACCESS_LABEL, KIND_LABEL, TEMPLATES, vaultApi,
  type FieldInput, type FieldType, type ShareInput, type VaultAccess, type VaultClass, type VaultCollection, type VaultCollectionKind, type VaultItem, type VaultItemKind, type VaultPrincipal,
} from './api';
import { copySecret, generatePassphrase, generatePassword, looksLikeTotp, readExport, strength, STRENGTH_LABEL } from './secure';
import { keyring } from './e2ee/keyring';
import { SealedKeysPanel } from './SealedVault';
import * as sealed from './e2ee/sealed';
import { useStepUp } from './stepUpContext';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const KINDS: VaultItemKind[] = ['Login', 'ApiKey', 'Server', 'Database', 'Card', 'Note', 'Other'];
const ROTATE = [0, 30, 60, 90, 180, 365];
const keyOf = (label: string) => {
  const words = label.normalize('NFD').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const k = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('').replace(/^[0-9]+/, '');
  return (k || 'field').slice(0, 30);
};

// ------------------------------------------------------------------ strength meter and generator

export function StrengthMeter({ value }: { value: string }) {
  const s = value ? strength(value) : -1;
  return (
    <div className={`vlt-meter s${s}`} aria-live="polite">
      <div className="vlt-meter-bar" aria-hidden="true">{[0, 1, 2, 3].map((i) => <i key={i} className={s > i || (s === 0 && i === 0) ? 'on' : ''} />)}</div>
      <span>{s < 0 ? 'Type or generate a password' : STRENGTH_LABEL[s]}</span>
    </div>
  );
}

export function Generator({ onUse, clipboardSeconds }: { onUse?: (v: string) => void; clipboardSeconds: number }) {
  const [mode, setMode] = useState<'password' | 'passphrase'>('password');
  const [length, setLength] = useState(20);
  const [words, setWords] = useState(5);
  const [opts, setOpts] = useState({ upper: true, digits: true, symbols: true, avoidAmbiguous: true });
  const make = () => (mode === 'password' ? generatePassword({ length, ...opts }) : generatePassphrase(words));
  const [value, setValue] = useState(make);
  const again = (next?: Partial<{ mode: typeof mode; length: number; words: number }> & Partial<typeof opts>) => {
    const m = next?.mode ?? mode, l = next?.length ?? length, w = next?.words ?? words;
    const o = { upper: next?.upper ?? opts.upper, digits: next?.digits ?? opts.digits, symbols: next?.symbols ?? opts.symbols, avoidAmbiguous: next?.avoidAmbiguous ?? opts.avoidAmbiguous };
    setValue(m === 'password' ? generatePassword({ length: l, ...o }) : generatePassphrase(w));
  };
  return (
    <div className="vlt-gen">
      <div className="seg" role="radiogroup" aria-label="What to make">
        <button type="button" role="radio" aria-checked={mode === 'password'} onClick={() => { setMode('password'); again({ mode: 'password' }); }}>Password</button>
        <button type="button" role="radio" aria-checked={mode === 'passphrase'} onClick={() => { setMode('passphrase'); again({ mode: 'passphrase' }); }}>Passphrase</button>
      </div>
      <div className="vlt-gen-out">
        <code data-testid="generated">{value}</code>
        <button type="button" className="btn-icon" aria-label="Make another" onClick={() => again()}><Icon name="refresh" size={15} /></button>
      </div>
      <StrengthMeter value={value} />
      {mode === 'password' ? (
        <>
          <label className="vlt-range"><span>Length <b>{length}</b></span>
            <input type="range" min={8} max={64} value={length} onChange={(e) => { const l = Number(e.target.value); setLength(l); again({ length: l }); }} aria-label="Length" /></label>
          <div className="vlt-checks">
            {([['upper', 'A-Z'], ['digits', '0-9'], ['symbols', '!@#'], ['avoidAmbiguous', 'No look-alikes (l, 1, O, 0)']] as const).map(([k, label]) => (
              <label key={k}><input type="checkbox" checked={opts[k]} onChange={(e) => { setOpts({ ...opts, [k]: e.target.checked }); again({ [k]: e.target.checked }); }} /> {label}</label>
            ))}
          </div>
        </>
      ) : (
        <label className="vlt-range"><span>Words <b>{words}</b></span>
          <input type="range" min={3} max={10} value={words} onChange={(e) => { const w = Number(e.target.value); setWords(w); again({ words: w }); }} aria-label="Words" /></label>
      )}
      <div className="vlt-gen-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copySecret(value, clipboardSeconds).then((ok) => toast(ok ? `Copied. The clipboard clears in ${clipboardSeconds} seconds.` : 'The browser did not allow copying.', ok ? 'success' : 'error'))}><Icon name="copy" size={14} /> Copy</button>
        {onUse && <button type="button" className="btn btn-primary btn-sm" onClick={() => onUse(value)}>Use this</button>}
      </div>
      <p className="vlt-small muted">Made on this device from its secure random source; nothing is sent until you save.</p>
    </div>
  );
}

/**
 * A secret in the edit screen — the only place a value can be shown. It stays masked until asked for, hides itself again after the
 * workspace's reveal time, and as soon as the window loses focus or the tab is left. For a guarded item the current value is not in the page
 * at all until someone who can manage the item asks for it here (with any two-step check it needs); that is recorded.
 */
function SecretInput({ field, value, onChange, existing, clipboardSeconds, revealSeconds, onLoadCurrent, onShown }: {
  field: { key: string; label: string; type: FieldType }; value: string; onChange: (v: string) => void; existing: boolean; clipboardSeconds: number; revealSeconds: number;
  onLoadCurrent?: () => Promise<boolean>; onShown?: () => void;
}) {
  const [visible, setVisibleRaw] = useState(false);
  const [loading, setLoading] = useState(false);
  const told = useRef(false);
  const setVisible = useCallback((v: boolean) => {
    setVisibleRaw(v);
    if (v && onShown && !told.current) { told.current = true; onShown(); }
  }, [onShown]);
  useEffect(() => {
    if (!visible) return;
    const off = () => setVisibleRaw(false);
    const onHidden = () => { if (document.hidden) off(); };
    const t = window.setTimeout(off, Math.max(5, revealSeconds) * 1000);
    window.addEventListener('blur', off); document.addEventListener('visibilitychange', onHidden);
    return () => { window.clearTimeout(t); window.removeEventListener('blur', off); document.removeEventListener('visibilitychange', onHidden); };
  }, [visible, revealSeconds]);
  const [gen, setGen] = useState(false);
  const [check, setCheck] = useState<{ strength: number; breachCount: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const canLoad = existing && value === '' && !!onLoadCurrent;
  const placeholder = existing ? (canLoad ? 'Unchanged — type to replace it, or show the current value' : 'Unchanged — type to replace it') : field.type === 'totp' ? 'Setup key (JBSW Y3DP …) or otpauth:// address' : '';
  const multi = field.type === 'note' || field.type === 'key';
  const totpBad = field.type === 'totp' && !looksLikeTotp(value);
  const toggle = async () => {
    if (visible) { setVisibleRaw(false); return; }
    if (canLoad) {
      setLoading(true);
      try { if (await onLoadCurrent!()) setVisibleRaw(true); } finally { setLoading(false); }
      return;
    }
    setVisible(true);
  };
  const eye = (value !== '' || canLoad) && (
    <button type="button" className="btn-icon" aria-label={visible ? `Hide ${field.label}` : canLoad ? `Show the current ${field.label}` : `Show ${field.label}`} aria-pressed={visible} disabled={loading} onClick={() => void toggle()}>
      {loading ? <Spinner /> : <Icon name={visible ? 'eyeOff' : 'eye'} size={15} />}
    </button>
  );
  return (
    <div className={`field full vlt-secret-input${totpBad ? ' invalid' : ''}`} data-field={field.key}>
      <label htmlFor={`vf-${field.key}`}>{field.label}</label>
      {multi ? (
        <div className="vlt-input-row vlt-input-row-top">
          <textarea id={`vf-${field.key}`} className={`textarea vlt-mono${visible || !value ? '' : ' vlt-blur'}`} rows={field.type === 'key' ? 5 : 3} value={value} placeholder={placeholder}
            data-state={visible ? 'revealed' : 'masked'} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
          {eye}
        </div>
      ) : (
        <div className="vlt-input-row">
          <input id={`vf-${field.key}`} className="input vlt-mono" type={visible ? 'text' : 'password'} value={value} placeholder={placeholder}
            data-state={visible ? 'revealed' : 'masked'} autoComplete="new-password" spellCheck={false} data-lpignore="true" data-1p-ignore="true" onChange={(e) => { onChange(e.target.value); setCheck(null); }} />
          {eye}
          {field.type === 'password' && <button type="button" className="btn-icon" aria-label="Generate" aria-expanded={gen} onClick={() => setGen((g) => !g)}><Icon name="sparkle" size={15} /></button>}
        </div>
      )}
      {totpBad && <div className="field-error" role="alert">That is not a one-time-code setup key. Paste the key shown when you set up two-step sign-in (letters A-Z and 2-7), or the otpauth:// address.</div>}
      {field.type === 'password' && value && (
        <div className="vlt-pw-tools">
          <StrengthMeter value={value} />
          <button type="button" className="btn btn-ghost btn-xs" disabled={checking} onClick={async () => {
            setChecking(true);
            try { setCheck({ strength: strength(value), breachCount: await sealed.breachesFor(value) }); } catch (e) { toast(errText(e, 'Could not check it.'), 'error'); } finally { setChecking(false); }
          }}>{checking ? <Spinner /> : <Icon name="shield" size={13} />} Check breaches</button>
          {check && (check.breachCount > 0
            ? <span className="vlt-check bad" role="status">Seen {check.breachCount.toLocaleString()} times in public breaches — choose another.</span>
            : <span className="vlt-check ok" role="status">Not found in public breaches.</span>)}
        </div>
      )}
      {gen && <Generator clipboardSeconds={clipboardSeconds} onUse={(v) => { onChange(v); setGen(false); setVisibleRaw(false); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ item editor

interface Row { key: string; label: string; type: FieldType; secret: boolean; value: string; existing: boolean; custom: boolean; /** the stored value, once shown here */ orig?: string }

/** A sealed item being edited: its decrypted contents (from this page's memory) and where it lives. */
export interface SealedEdit { item: sealed.SealedItem; collection: VaultCollection }
const sealedOpen = (c: VaultCollection) => c.sealed && !!keyring.collectionKey(c.id, c.keyVersion);

export function ItemEditor({ existing, sealedEdit, collections, defaultCollection, clipboardSeconds, revealSeconds = 30, onClose, onSaved }: {
  existing: VaultItem | null; sealedEdit?: SealedEdit | null; collections: VaultCollection[]; defaultCollection: string | null; clipboardSeconds: number; revealSeconds?: number; onClose: () => void; onSaved: (id: string) => void;
}) {
  const step = useStepUp();
  // Sealed collections are offered when their key is open on this device; a guarded item cannot move into one (it is copied when sealing).
  const manageable = collections.filter((c) => c.myAccess === 'Manage' && !c.locked && !c.rekeyNeeded && (!c.sealed || (sealedOpen(c) && !existing)));
  const members = useWsQuery(['vault', 'members'], () => workspaceApi.members(), { staleTime: 300_000, retry: false });
  const sp = sealedEdit?.item.payload ?? null;
  const it = existing?.item ?? (sealedEdit && sp ? { kind: sealedEdit.item.row.kind, title: sp.title, url: sp.url, collectionId: sealedEdit.collection.id, tags: sp.tags, class: sp.class, useOnly: false,
    owner: null, expiresAt: sealedEdit.item.row.expiresAt } : undefined);
  const [kind, setKind] = useState<VaultItemKind>(it?.kind ?? 'Login');
  const [title, setTitle] = useState(it?.title ?? '');
  const [url, setUrl] = useState(it?.url ?? '');
  const [collectionId, setCollectionId] = useState(it?.collectionId ?? (manageable.find((c) => c.id === defaultCollection) ?? manageable[0])?.id ?? '');
  const [tags, setTags] = useState((it?.tags ?? []).join(', '));
  const [cls, setCls] = useState<VaultClass>(it?.class ?? 'Secret');
  const [useOnly, setUseOnly] = useState(it?.useOnly ?? false);
  const [owner, setOwner] = useState(it?.owner?.id ?? '');
  const [rotate, setRotate] = useState(existing?.rotateEveryDays ?? sealedEdit?.item.row.rotateEveryDays ?? 0);
  const [expires, setExpires] = useState(it?.expiresAt ? it.expiresAt.slice(0, 10) : '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const initialRows = (k: VaultItemKind): Row[] => sp
    ? sp.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, secret: f.secret, value: f.value ?? '', existing: false, custom: !TEMPLATES[sealedEdit!.item.row.kind].some((t) => t.key === f.key) }))
    : existing
    ? existing.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, secret: f.secret, value: f.secret ? '' : f.value ?? '', existing: f.secret, custom: !TEMPLATES[existing.item.kind].some((t) => t.key === f.key) }))
    : TEMPLATES[k].map((t) => ({ ...t, value: '', existing: false, custom: false }));
  const [rows, setRows] = useState<Row[]>(() => initialRows(kind));
  const [adding, setAdding] = useState<{ label: string; type: FieldType } | null>(null);
  const target = sealedEdit?.collection ?? collections.find((c) => c.id === collectionId);
  const changedSecret = sp ? rows.some((r) => r.secret && r.value !== (sp.fields.find((f) => f.key === r.key)?.value ?? '')) : rows.some((r) => r.secret && r.value !== (r.orig ?? ''));
  // A guarded item's current value comes to this screen only when asked for (recorded, with any two-step check it needs).
  const loadCurrent = (r: Row) => async () => {
    if (!existing) return false;
    try {
      const res = await step.run((t) => vaultApi.reveal(existing.item.id, r.key, false, t, true), existing.needsStepUp);
      if (!res) return false;
      setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, value: res.value, orig: res.value } : x)));
      return true;
    } catch (e) { toast(errText(e, 'Could not show it.'), 'error'); return false; }
  };
  const shownSealed = (r: Row) => () => { if (sealedEdit && sp?.fields.some((f) => f.key === r.key && f.value)) void vaultApi.sealedEvent(sealedEdit.item.row.id, 'revealed', `${r.label} (edit screen)`).catch(() => undefined); };

  const setRow = (key: string, value: string) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, value } : r)));
  const totpBad = rows.some((r) => r.type === 'totp' && !looksLikeTotp(r.value));

  const save = async () => {
    setError(null);
    if (!title.trim()) { setError('Name it, for example “AWS root account”.'); return; }
    if (!collectionId) { setError('Choose where to keep it.'); return; }
    if (totpBad) { setError('Fix the one-time-code key first.'); return; }
    const fields: FieldInput[] = rows.map((r) => r.secret
      ? ((r.value === '' || r.value === r.orig) && r.existing ? { key: r.key, label: r.label, type: r.type, secret: true, keep: true } : { key: r.key, label: r.label, type: r.type, secret: true, value: r.value || null })
      : { key: r.key, label: r.label, type: r.type, secret: false, value: r.value.trim() || null });
    const body = {
      collectionId, kind, title: title.trim(), url: url.trim() || null, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), class: cls, useOnly,
      ownerUserId: owner || null, rotateEveryDays: rotate || null, expiresAt: expires ? new Date(`${expires}T00:00:00Z`).toISOString() : null, fields,
      links: existing?.links ?? [], reason: existing && changedSecret ? reason.trim() || null : null,
    };
    setBusy(true);
    if (target?.sealed) {
      // Encrypted here with the collection key; the server gets ciphertext and the dates it reminds about.
      try {
        const payload: sealed.SealedPayload = { v: 1, title: body.title, url: body.url, tags: body.tags, class: cls, links: sp?.links ?? [],
          fields: rows.map((r) => ({ key: r.key, label: r.label, type: r.type, secret: r.secret, value: r.secret ? r.value || null : r.value.trim() || null })) };
        const res = await sealed.saveSealed(target, sealedEdit?.item.row ?? null, kind, payload,
          { expiresAt: body.expiresAt, rotateEveryDays: body.rotateEveryDays, valueChanged: !!sealedEdit && changedSecret, reason: sealedEdit && changedSecret ? reason.trim() || null : null });
        toast(sealedEdit ? 'Saved, end-to-end encrypted.' : 'Sealed: encrypted on this device before it was sent.');
        onSaved(res.id);
      } catch (e) { setError(errText(e, 'Could not save it.')); setBusy(false); }
      return;
    }
    try {
      const res = existing ? await vaultApi.update(existing.item.id, body) : await vaultApi.create(body);
      toast(existing ? 'Saved.' : 'Saved in the vault, encrypted.');
      onSaved(res.item.id);
    } catch (e) { setError(errText(e, 'Could not save it.')); setBusy(false); }
  };

  return (
    <Modal title={it ? `Edit “${it.title}”` : 'New vault item'} subtitle={target?.sealed ? 'Sealed: everything here is encrypted on this device; the server cannot read any of it.' : 'Secret fields are encrypted with this item’s own key before they are stored.'} size="lg" onClose={onClose} className="vlt-scope"
      onSubmit={(e) => { e.preventDefault(); void save(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy && <span className="spinner" />}Save</button></>}>
      <div className="form-grid vlt-form">
        {!existing && !sealedEdit && (
          <div className="field full">
            <label>Kind</label>
            <div className="vlt-kinds" role="radiogroup" aria-label="Kind">
              {KINDS.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''}
                  onClick={() => { setKind(k); setRows(initialRows(k)); }}>{KIND_LABEL[k]}</button>
              ))}
            </div>
          </div>
        )}
        <Field label="Name" required><input id="vi-title" className="input" value={title} maxLength={120} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="AWS root account" /></Field>
        <Field label="Kept in">
          <select className="input" value={collectionId} disabled={!!sealedEdit} onChange={(e) => setCollectionId(e.target.value)} aria-label="Collection">
            {(sealedEdit ? [sealedEdit.collection] : manageable).map((c) => <option key={c.id} value={c.id}>{`${c.kind === 'Personal' ? `${c.name} (only you)` : c.name}${c.sealed ? ' · sealed' : ''}`}</option>)}
          </select>
        </Field>
        {kind !== 'Note' && kind !== 'Card' && <Field label="Address" full><input className="input" value={url} maxLength={500} onChange={(e) => setUrl(e.target.value)} placeholder="https://console.aws.amazon.com" inputMode="url" /></Field>}
        {rows.map((r) => r.secret
          ? <SecretInput key={r.key} field={r} value={r.value} existing={r.existing} clipboardSeconds={clipboardSeconds} revealSeconds={revealSeconds}
              onLoadCurrent={existing?.canReveal && existing.canManage ? loadCurrent(r) : undefined} onShown={sealedEdit ? shownSealed(r) : undefined} onChange={(v) => setRow(r.key, v)} />
          : (
            <div key={r.key} className="field" data-field={r.key}>
              <label htmlFor={`vf-${r.key}`}>{r.label}</label>
              <input id={`vf-${r.key}`} className="input" value={r.value} maxLength={8000} autoComplete="off" spellCheck={false} onChange={(e) => setRow(r.key, e.target.value)} />
            </div>
          ))}
        <div className="field full">
          {adding ? (
            <div className="vlt-add-field">
              <input className="input" value={adding.label} maxLength={60} autoFocus placeholder="Field name, e.g. Recovery email" aria-label="New field name" onChange={(e) => setAdding({ ...adding, label: e.target.value })} />
              <select className="input" value={adding.type} aria-label="New field type" onChange={(e) => setAdding({ ...adding, type: e.target.value as FieldType })}>
                <option value="text">Text (not secret)</option><option value="password">Secret</option><option value="note">Secret note</option><option value="totp">One-time code</option>
              </select>
              <button type="button" className="btn btn-ghost btn-sm" disabled={!adding.label.trim()} onClick={() => {
                let key = keyOf(adding.label); let n = 2;
                while (rows.some((r) => r.key === key)) key = `${keyOf(adding.label).slice(0, 28)}${n++}`;
                setRows([...rows, { key, label: adding.label.trim(), type: adding.type, secret: adding.type !== 'text', value: '', existing: false, custom: true }]); setAdding(null);
              }}>Add</button>
              <button type="button" className="btn-icon" aria-label="Cancel" onClick={() => setAdding(null)}><Icon name="close" size={14} /></button>
            </div>
          ) : rows.length < 30 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding({ label: '', type: 'password' })}><Icon name="plus" size={14} /> Add a field</button>}
        </div>

        <fieldset className="field full vlt-protect">
          <legend>Protection</legend>
          <label><input type="radio" name="vcls" checked={cls === 'Secret'} onChange={() => setCls('Secret')} /> <b>Secret</b> <span className="muted">Copied by people with access (shown only here, to managers); every use is recorded.</span></label>
          <label><input type="radio" name="vcls" checked={cls === 'Confidential'} onChange={() => setCls('Confidential')} /> <b>Confidential</b> <span className="muted">Also needs a fresh two-step check every time.</span></label>
          {target?.sealed
            ? <p className="vlt-small muted"><Icon name="lock" size={12} /> Sealed collections have no use-only items: whoever holds the key can read the value. Use a guarded collection for that.</p>
            : <label className="vlt-useonly"><input type="checkbox" checked={useOnly} onChange={(e) => setUseOnly(e.target.checked)} /> <b>Use only</b> <span className="muted">Nobody sees the value; it can only be copied into a sign-in form.</span></label>}
          {target?.requireStepUp && <p className="vlt-small muted"><Icon name="shield" size={12} /> {target.name} asks for a two-step check on everything in it.</p>}
        </fieldset>

        <Field label="Owner" hint="Told before it expires and when it should be changed.">
          <select className="input" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner">
            <option value="">{existing ? 'Unchanged' : 'Me'}</option>
            {(members.data ?? []).filter((m) => m.role !== 'Guest').map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
          </select>
        </Field>
        <Field label="Change every" hint={target?.rotateEveryDays ? `The collection’s rule: every ${target.rotateEveryDays} days.` : undefined}>
          <select className="input" value={rotate} onChange={(e) => setRotate(Number(e.target.value))} aria-label="Change every">
            {ROTATE.map((d) => <option key={d} value={d}>{d === 0 ? (target?.rotateEveryDays ? 'As the collection says' : 'No rule') : `${d} days`}</option>)}
          </select>
        </Field>
        <Field label="Change by (date)" hint="Overrides the rule above."><input className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
        <Field label="Tags"><input className="input" value={tags} maxLength={300} onChange={(e) => setTags(e.target.value)} placeholder="production, aws" /></Field>
        {existing && changedSecret && <Field label="Why it changed (kept with the earlier value)" full><input className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Rotated after Lalit left" /></Field>}
        {error && <p className="form-error full" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ collections and access

export function CollectionEditor({ existing, canSeal, onClose, onSaved, onSeal }: {
  existing: VaultCollection | null; canSeal: boolean; onClose: () => void; onSaved: (id: string | null) => void; onSeal?: (c: VaultCollection) => void;
}) {
  const [sealedNew, setSealedNew] = useState(canSeal);
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [kind, setKind] = useState<VaultCollectionKind>(existing?.kind ?? 'Shared');
  const [projectId, setProjectId] = useState(existing?.projectId ?? '');
  const [teamId, setTeamId] = useState(existing?.teamId ?? '');
  const [requireStepUp, setRequireStepUp] = useState(existing?.requireStepUp ?? false);
  const [requireApproval, setRequireApproval] = useState(existing?.requireApproval ?? false);
  const [requestable, setRequestable] = useState(existing?.requestable ?? false);
  const [rotate, setRotate] = useState(existing?.rotateEveryDays ?? 0);
  const [share, setShare] = useState<VaultAccess>('View');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const projects = useWsQuery(['vault', 'projects'], () => projectApi.list({ pageSize: 100 }), { staleTime: 300_000, enabled: kind === 'Project' && !existing });
  const teams = useWsQuery(['vault', 'teams'], () => teamApi.list(), { staleTime: 300_000, enabled: kind === 'Team' && !existing });
  const personal = existing?.kind === 'Personal';
  const isSealed = existing ? existing.sealed : sealedNew;
  return (
    <Modal title={existing ? `Collection: ${existing.name}${existing.sealed ? ' (sealed)' : ''}` : 'New shared collection'} subtitle={existing ? undefined : 'A group of credentials with one access list.'} onClose={onClose} className="vlt-scope"
      onSubmit={async (e) => {
        e.preventDefault(); setError(null); setBusy(true);
        const body = { name: name.trim(), description: description.trim() || null, kind, projectId: kind === 'Project' ? projectId || null : null, teamId: kind === 'Team' ? teamId || null : null,
          requireStepUp, rotateEveryDays: rotate || null, shareWithMembers: !existing && kind !== 'Shared' ? (sealedNew && share === 'UseOnly' ? 'View' : share) : null, sealed: !existing && sealedNew,
          requireApproval: isSealed ? false : requireApproval, requestable: personal ? false : requestable };
        try {
          const c = existing ? await vaultApi.updateCollection(existing.id, body) : await vaultApi.createCollection(body);
          if (!existing && sealedNew) await sealed.firstKey(c.id);   // its key is made here and wrapped to me; the server never sees it
          toast(existing ? 'Saved.' : sealedNew ? 'Sealed collection made. People you add get its key from your browser.' : 'Collection made. Add people to it under Access.');
          onSaved(c.id);
        }
        catch (err) { setError(errText(err, 'Could not save it.')); setBusy(false); }
      }}
      footer={<>
        {existing && !existing.sealed && existing.myAccess === 'Manage' && onSeal && <button type="button" className="btn btn-ghost vlt-left" onClick={() => onSeal(existing)}><Icon name="lock" size={14} /> Seal it</button>}
        {existing && !personal && <button type="button" className="btn btn-ghost danger vlt-left" onClick={async () => {
          if (!(await confirmDialog({ title: 'Delete this collection?', message: 'Only an empty collection (including its bin) can be deleted.', confirmText: 'Delete' }))) return;
          try { await vaultApi.deleteCollection(existing.id); toast('Collection deleted.', 'warning'); onSaved(null); } catch (err) { setError(errText(err, 'Could not delete it.')); }
        }}>Delete</button>}
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !name.trim()}>{busy && <span className="spinner" />}Save</button>
      </>}>
      <div className="form-grid">
        <Field label="Name" required full><input className="input" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Payments servers" /></Field>
        <Field label="What it is for" full><input className="input" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="Production and UAT access for the payments team" /></Field>
        {!existing && (
          <div className="field full">
            <label>For</label>
            <div className="seg" role="radiogroup" aria-label="Who the collection is for">
              {(['Shared', 'Project', 'Team'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>{k === 'Shared' ? 'Chosen people' : k === 'Project' ? 'A project' : 'A team'}</button>)}
            </div>
          </div>
        )}
        {!existing && kind === 'Project' && <Field label="Project" required><select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project"><option value="">Choose…</option>{(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
        {!existing && kind === 'Team' && <Field label="Team" required><select className="input" value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Team"><option value="">Choose…</option>{(teams.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
        {!existing && kind !== 'Shared' && <Field label={kind === 'Project' ? 'Everyone in the project can' : 'Everyone in the team can'}><select className="input" value={share} onChange={(e) => setShare(e.target.value as VaultAccess)} aria-label="Member access">
          <option value="None">Nothing yet (I add people)</option>{!sealedNew && <option value="UseOnly">Use only</option>}<option value="View">View</option><option value="Manage">Manage</option></select></Field>}
        {!existing && (
          <div className="field full vlt-mode">
            <label>Protection</label>
            <div className="vlt-mode-cards" role="radiogroup" aria-label="Protection">
              <button type="button" role="radio" aria-checked={sealedNew} disabled={!canSeal} className={sealedNew ? 'on' : ''} onClick={() => setSealedNew(true)}>
                <Icon name="lock" size={18} /><b>Sealed</b><span>End-to-end encrypted on each member’s device. The server cannot read it. No use-only.</span>
              </button>
              <button type="button" role="radio" aria-checked={!sealedNew} className={!sealedNew ? 'on' : ''} onClick={() => setSealedNew(false)}>
                <Icon name="shield" size={18} /><b>Guarded</b><span>Encrypted on the server, which enforces use-only, two-step checks and one-time codes.</span>
              </button>
            </div>
            {!canSeal && <p className="vlt-small muted">Set up and unlock your vault keys (My keys) to make sealed collections.</p>}
          </div>
        )}
        {!personal && <label className="field full vlt-check-row"><input type="checkbox" checked={requireStepUp} onChange={(e) => setRequireStepUp(e.target.checked)} /> <span><b>Ask for a two-step check on everything here</b><br /><span className="muted">For production keys and other high-risk access.</span></span></label>}
        {!personal && (
          <label className="field full vlt-check-row"><input type="checkbox" checked={requireApproval && !isSealed} disabled={isSealed} onChange={(e) => setRequireApproval(e.target.checked)} />
            <span><b>Two-person rule</b><br /><span className="muted">{isSealed ? 'Needs a guarded collection: in a sealed one, whoever holds the key can read without asking.' : 'Every use needs someone else’s approval first, for a window that ends by itself. Managers included.'}</span></span></label>
        )}
        {!personal && (
          <label className="field full vlt-check-row"><input type="checkbox" checked={requestable} onChange={(e) => setRequestable(e.target.checked)} />
            <span><b>People may ask to join for a while</b><br /><span className="muted">Its name shows under Requests; a manager approves an hour, a day or a week, then the access ends by itself.</span></span></label>
        )}
        <Field label="New items are changed every"><select className="input" value={rotate} onChange={(e) => setRotate(Number(e.target.value))} aria-label="Rotation rule">{ROTATE.map((d) => <option key={d} value={d}>{d === 0 ? 'No rule' : `${d} days`}</option>)}</select></Field>
        {error && <p className="form-error full" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

interface ShareRow extends ShareInput { uid: string }
const newUid = () => Math.random().toString(36).slice(2, 10);

export function ShareEditor({ collection, meId, onClose, onSaved }: { collection: VaultCollection; meId: string | null; onClose: () => void; onSaved: () => void }) {
  const members = useWsQuery(['vault', 'members'], () => workspaceApi.members(), { staleTime: 300_000, retry: false });
  const teams = useWsQuery(['vault', 'teams'], () => teamApi.list(), { staleTime: 300_000, retry: false });
  const projects = useWsQuery(['vault', 'projects'], () => projectApi.list({ pageSize: 100 }), { staleTime: 300_000, retry: false });
  const [rows, setRows] = useState<ShareRow[]>(() => (collection.shares ?? []).map((s) => ({ uid: s.id, principalType: s.principalType, principalId: s.principalId, role: s.role, access: s.access, expiresAt: s.expiresAt })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (uid: string, patch: Partial<ShareRow>) => setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  const options = (t: VaultPrincipal) => t === 'User' ? (members.data ?? []).filter((m) => m.role !== 'Guest').map((m) => ({ id: m.userId, name: m.displayName }))
    : t === 'Team' ? (teams.data ?? []).map((x) => ({ id: x.id, name: x.name })) : t === 'Project' ? (projects.data?.items ?? []).map((p) => ({ id: p.id, name: p.name })) : [];
  const names = useMemo(() => new Map((collection.shares ?? []).map((s) => [s.principalId ?? s.role ?? '', s.name])), [collection.shares]);
  const managers = rows.filter((r) => r.access === 'Manage' && !r.expiresAt).length;
  return (
    <Modal title={`Access to ${collection.name}`} subtitle="Who can open it, and what they can do. People added are told; every use is recorded." size="lg" onClose={onClose} className="vlt-scope"
      onSubmit={async (e) => {
        e.preventDefault(); setError(null);
        if (rows.some((r) => r.principalType === 'Role' ? !r.role : !r.principalId)) { setError('Choose who each line is for.'); return; }
        setBusy(true);
        try {
          await vaultApi.saveShares(collection.id, rows.map(({ uid: _uid, ...r }) => ({ ...r, expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null })));
          toast('Access saved.'); onSaved();
        } catch (err) { setError(errText(err, 'Could not save it.')); setBusy(false); }
      }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || managers === 0}>{busy && <span className="spinner" />}Save access</button></>}>
      <div className="vlt-shares">
        {rows.map((r) => {
          const opts = options(r.principalType);
          const known = r.principalId && !opts.some((o) => o.id === r.principalId) ? [{ id: r.principalId, name: names.get(r.principalId) ?? 'Current choice' }] : [];
          return (
            <div key={r.uid} className="vlt-share-row" data-share={r.principalType}>
              <select className="input" aria-label="Who" value={r.principalType} onChange={(e) => set(r.uid, { principalType: e.target.value as VaultPrincipal, principalId: null, role: e.target.value === 'Role' ? 'Manager' : null })}>
                <option value="User">Person</option><option value="Team">Team</option><option value="Project">Project</option><option value="Role">Role and above</option>
              </select>
              {r.principalType === 'Role' ? (
                <select className="input" aria-label="Role" value={r.role ?? 'Manager'} onChange={(e) => set(r.uid, { role: e.target.value })}>
                  <option value="Member">Every member</option><option value="Manager">Managers and above</option><option value="Admin">Admins and the owner</option>
                </select>
              ) : (
                <select className="input" aria-label="Name" value={r.principalId ?? ''} onChange={(e) => set(r.uid, { principalId: e.target.value || null })}>
                  <option value="">Choose…</option>
                  {[...known, ...opts].map((o) => <option key={o.id} value={o.id}>{o.id === meId ? `${o.name} (you)` : o.name}</option>)}
                </select>
              )}
              <select className="input" aria-label="Access" value={r.access} title={ACCESS_HINT[r.access]} onChange={(e) => set(r.uid, { access: e.target.value as VaultAccess })}>
                {(collection.sealed ? ['View', 'Manage'] as const : ['UseOnly', 'View', 'Manage'] as const).map((a) => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
              </select>
              <input className="input" type="date" aria-label="Ends on" value={r.expiresAt ? r.expiresAt.slice(0, 10) : ''} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
                onChange={(e) => set(r.uid, { expiresAt: e.target.value ? `${e.target.value}T23:59:00Z` : null })} />
              <button type="button" className="btn-icon danger" aria-label="Remove" onClick={() => setRows(rows.filter((x) => x.uid !== r.uid))}><Icon name="close" size={14} /></button>
            </div>
          );
        })}
        <div className="vlt-share-add">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows([...rows, { uid: newUid(), principalType: 'User', principalId: null, access: 'View' }])}><Icon name="userPlus" size={14} /> Add a person</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows([...rows, { uid: newUid(), principalType: 'Team', principalId: null, access: 'View' }])}><Icon name="users" size={14} /> Add a team</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows([...rows, { uid: newUid(), principalType: 'Role', role: 'Manager', access: 'View' }])}><Icon name="shield" size={14} /> Add a role</button>
        </div>
        <ul className="vlt-access-legend">{(collection.sealed ? ['View', 'Manage'] as const : ['UseOnly', 'View', 'Manage'] as const).map((a) => <li key={a}><b>{ACCESS_LABEL[a]}</b> {ACCESS_HINT[a].toLowerCase()}</li>)}</ul>
        {collection.sealed && <SealedKeysPanel collection={collection} />}
        {members.error && <p className="vlt-small muted">The member list is not available to you; people already on the list stay.</p>}
        {managers === 0 && <p className="form-error" role="alert">Keep at least one person or group who manages it without an end date.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ import

export function ImportModal({ collections, defaultCollection, onClose, onDone }: { collections: VaultCollection[]; defaultCollection: string | null; onClose: () => void; onDone: (collectionId: string) => void }) {
  const manageable = collections.filter((c) => c.myAccess === 'Manage' && !c.locked && !c.rekeyNeeded && (!c.sealed || sealedOpen(c)));
  const [collectionId, setCollectionId] = useState((manageable.find((c) => c.id === defaultCollection) ?? manageable[0])?.id ?? '');
  const [parsed, setParsed] = useState<ReturnType<typeof readExport> | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const read = async (f: File) => {
    setError(null);
    if (f.size > 5 * 1024 * 1024) { setError('That file is too large for an export (5 MB at most).'); return; }
    const r = readExport(await f.text());
    if (r.rows.length === 0) { setError('No passwords were found. Export as CSV from your password manager or browser, then choose that file.'); return; }
    if (r.rows.length > 500) { setError(`That export has ${r.rows.length} items; import at most 500 at a time (split the file).`); return; }
    setParsed(r); setFileName(f.name);
  };
  return (
    <Modal title="Import passwords" subtitle="From Bitwarden, 1Password, LastPass, Chrome, Edge or Firefox (a CSV export)." onClose={() => { setParsed(null); onClose(); }} className="vlt-scope"
      onSubmit={async (e) => {
        e.preventDefault(); if (!parsed) return; setBusy(true); setError(null);
        try {
          const target = manageable.find((c) => c.id === collectionId);
          if (target?.sealed) {
            // Sealed: each row is encrypted here, one by one; the export never reaches the server readable.
            let n = 0;
            for (const r of parsed.rows) {
              const title = (r.title ?? (r.url ? r.url.replace(/^https?:\/\//, '').split('/')[0] : '') ?? '').slice(0, 120) || 'Imported item';
              await sealed.saveSealed(target, null, 'Login', { v: 1, title, url: r.url, tags: [], class: 'Secret', links: [], fields: [
                { key: 'username', label: 'User name', type: 'text', secret: false, value: r.username },
                { key: 'password', label: 'Password', type: 'password', secret: true, value: r.password },
                { key: 'totp', label: 'One-time code (2FA)', type: 'totp', secret: true, value: r.totp && looksLikeTotp(r.totp) ? r.totp : null },
                { key: 'note', label: 'Notes', type: 'note', secret: true, value: r.notes },
              ] }, { expiresAt: null, rotateEveryDays: null, valueChanged: false, reason: null });
              n++;
            }
            setParsed(null);
            toast(`Imported ${n}, sealed on this device. Now delete the export file.`, 'success');
            onDone(collectionId);
            return;
          }
          const r = await vaultApi.importRows(collectionId, parsed.rows);
          setParsed(null);
          toast(`Imported ${r.imported}${r.skipped ? `, skipped ${r.skipped}` : ''}${r.weak ? ` · ${r.weak} weak password${r.weak === 1 ? '' : 's'} to change` : ''}. Now delete the export file.`, 'success');
          onDone(collectionId);
        } catch (err) { setError(errText(err, 'Could not import.')); setBusy(false); }
      }}
      footer={<><button type="button" className="btn btn-ghost" onClick={() => { setParsed(null); onClose(); }}>Cancel</button><button className="btn btn-primary" disabled={busy || !parsed || !collectionId}>{busy && <span className="spinner" />}{parsed ? `Import ${parsed.rows.length}` : 'Import'}</button></>}>
      <div className="form-grid">
        <Field label="Into" full><select className="input" value={collectionId} onChange={(e) => setCollectionId(e.target.value)} aria-label="Collection">{manageable.map((c) => <option key={c.id} value={c.id}>{`${c.kind === 'Personal' ? `${c.name} (only you)` : c.name}${c.sealed ? ' · sealed' : ''}`}</option>)}</select></Field>
        <div className="field full">
          <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f); }} />
          <button type="button" className="vlt-drop" onClick={() => file.current?.click()}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void read(f); }}>
            <Icon name="upload" size={20} />
            <span>{fileName ? `${fileName}` : 'Choose or drop the CSV export'}</span>
          </button>
        </div>
        {parsed && (
          <div className="full vlt-import-preview" role="status">
            <p><b>{parsed.rows.length}</b> item{parsed.rows.length === 1 ? '' : 's'} found ({parsed.source}).</p>
            <ul>{parsed.rows.slice(0, 6).map((r, i) => <li key={i}>{r.title ?? r.url ?? 'Untitled'}{r.username ? <span className="muted"> · {r.username.replace(/^(.).*(@.*)$/, '$1***$2')}</span> : null}</li>)}</ul>
            {parsed.rows.length > 6 && <p className="muted">…and {parsed.rows.length - 6} more.</p>}
          </div>
        )}
        <p className="full vlt-small muted"><Icon name="lock" size={12} /> The file is read on this device; each item is encrypted on the server as it is saved. An export file holds your passwords in plain text — delete it (and empty the trash) afterwards.</p>
        {error && <p className="form-error full" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
