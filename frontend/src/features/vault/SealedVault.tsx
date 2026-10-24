import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { ErrorState, Modal, Spinner } from '../../components/ui';
import { formatBytes, formatDate, formatDateTime, timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { saveFile } from '../../lib/native';
import { confirmDialog, toast } from '../../stores/ui';
import { ACTION_LABEL, HEALTH_LABEL, KIND_LABEL, vaultApi, type DeviceLink, type VaultCollection, type VaultKeysMe, type VaultPolicy } from './api';
import { linkCode, totpNow } from './e2ee/crypto';
import { keyring, pins, useKeyring } from './e2ee/keyring';
import { prfSupported } from './e2ee/passkey';
import * as sealed from './e2ee/sealed';
import { copySecret, strength, STRENGTH_LABEL } from './secure';
import { useStepUp } from './stepUpContext';
import { AskCircle, CircleCard } from './RecoveryCircle';
import { SendLinkModal } from './VaultLinks';
import { BrandTile } from './brand';
import { ItemHead } from './VaultChrome';
import { PlainValue } from './PlainValue';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof sealed.SealedError || e instanceof Error ? e.message || fallback : fallback);
import type { Me } from './sealedData';

// ------------------------------------------------------------------ setting up keys

export function SetupKeys({ tenant, me, onDone, reset }: { tenant: string; me: Me; onDone: () => void; reset?: { stepUp: string } }) {
  const [usePasskey, setUsePasskey] = useState(prfSupported());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kit, setKit] = useState<{ recoveryKey: string; passkeyNote: string | null; fingerprint: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState('');
  if (kit) return (
    <div className="vlt-setup vlt-kit" data-testid="recovery-kit">
      <div className="vlt-setup-glyph ok" aria-hidden="true"><Icon name="shield" size={26} /></div>
      <h3>Your recovery key</h3>
      <p className="muted">It opens your sealed vault if you lose your passkeys. Nobody else has it — not your admins, not us. Keep it offline: printed, or in another password manager.</p>
      <code className="vlt-recovery" aria-label="Recovery key">{kit.recoveryKey}</code>
      <div className="vlt-kit-actions">
        <button className="btn btn-ghost btn-sm" onClick={() => void copySecret(kit.recoveryKey, 60).then((ok) => toast(ok ? 'Copied. The clipboard clears in a minute.' : 'The browser did not allow copying.', ok ? 'success' : 'error'))}><Icon name="copy" size={14} /> Copy</button>
        <button className="btn btn-ghost btn-sm" onClick={() => void saveFile(new Blob([recoveryKit(kit.recoveryKey, kit.fingerprint, me)], { type: 'text/plain' }), 'projecttracker-vault-recovery-kit.txt')}><Icon name="download" size={14} /> Download the kit</button>
      </div>
      {kit.passkeyNote && <p className="vlt-small vlt-warn">{kit.passkeyNote} You can add a passkey later under My keys.</p>}
      <label className="vlt-check-row"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> <span>I have saved it somewhere safe and offline.</span></label>
      <label className="field"><span>Type its last four characters to confirm</span><input className="input vlt-mono" value={confirm} maxLength={4} onChange={(e) => setConfirm(e.target.value.toUpperCase())} aria-label="Last four characters" /></label>
      <button className="btn btn-primary" disabled={!saved || confirm !== kit.recoveryKey.slice(-4)} onClick={onDone}>Done — open my vault</button>
    </div>
  );
  return (
    <div className="vlt-setup">
      <div className="vlt-setup-glyph" aria-hidden="true"><Icon name="lock" size={26} /></div>
      <h3>{reset ? 'Make new vault keys' : 'Set up your sealed vault'}</h3>
      <ul className="vlt-setup-points">
        <li><Icon name="shield" size={15} /><span><b>End-to-end encrypted.</b> Secrets are encrypted on this device. The server, the database and our cloud only ever hold scrambled data.</span></li>
        <li><Icon name="key" size={15} /><span><b>Unlocked with a passkey.</b> Your fingerprint, face or device PIN — nothing to type, nothing to phish.</span></li>
        <li><Icon name="sparkle" size={15} /><span><b>Post-quantum.</b> Keys are shared with X25519 and ML-KEM-768 together, so data taken today stays safe from future quantum computers.</span></li>
      </ul>
      <label className={`vlt-check-row${prfSupported() ? '' : ' off'}`}><input type="checkbox" checked={usePasskey} disabled={!prfSupported()} onChange={(e) => setUsePasskey(e.target.checked)} />
        <span><b>Use a passkey on this device</b><br /><span className="muted">{prfSupported() ? 'You will be asked for your fingerprint, face or PIN.' : 'This browser cannot; you can use the recovery key and link this device to another one.'}</span></span></label>
      {reset && <p className="vlt-small vlt-warn">New keys cut you off from every sealed collection until someone who manages it shares it with you again. Personal sealed collections opened only with your old keys cannot be opened again.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn btn-primary" disabled={busy} onClick={async () => {
        setBusy(true); setError(null);
        try {
          const r = await sealed.setUpKeys(tenant, me, { passkey: usePasskey, reset: !!reset, stepUp: reset?.stepUp });
          setKit({ recoveryKey: r.recoveryKey, passkeyNote: r.passkeyNote, fingerprint: r.keys.identity?.fingerprint ?? '' });
        } catch (e) { setError(errText(e, 'Could not set up your keys.')); }
        finally { setBusy(false); }
      }}>{busy && <span className="spinner" />}{reset ? 'Make new keys' : 'Create my vault keys'}</button>
    </div>
  );
}

const recoveryKit = (key: string, fp: string, me: Me) => [
  'ProjectTracker — sealed vault recovery kit', '', `For: ${me.name} <${me.email}>`, `Made: ${new Date().toUTCString()}`, '', 'Recovery key:', `    ${key}`, '',
  'Your safety code (others can compare it to be sure they share with the real you):', `    ${fp}`, '',
  'Keep this offline. Anyone with this key and access to your account can open your sealed vault.',
  'Nobody else has a copy: not your administrators, not ProjectTracker.', '',
].join('\n');

// ------------------------------------------------------------------ unlocking

export function UnlockPanel({ tenant, me, keys, onUnlocked }: { tenant: string; me: Me; keys: VaultKeysMe; onUnlocked: () => void }) {
  const [mode, setMode] = useState<'choose' | 'recovery' | 'link' | 'circle'>('choose');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ code: string; started: Awaited<ReturnType<typeof sealed.startLink>> } | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const hasPasskey = keys.unlocks.some((u) => u.kind === 'Passkey');
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); toast('Sealed vault unlocked.'); onUnlocked(); } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setError(errText(e, 'It did not unlock.')); }
    finally { setBusy(false); }
  };
  return (
    <div className="vlt-unlock" data-testid="unlock">
      <div className="vlt-unlock-orb" aria-hidden="true"><span /><Icon name="lock" size={28} /></div>
      <h3>Your sealed vault is locked</h3>
      <p className="muted">It opens on this device only, with your keys. Nothing readable is on the server.</p>
      {mode === 'choose' && (
        <div className="vlt-unlock-ways">
          {hasPasskey && <button className="btn btn-primary" disabled={busy || !prfSupported()} onClick={() => void run(() => sealed.unlockWithPasskey(tenant, me.id, keys))}>{busy ? <Spinner /> : <Icon name="key" size={16} />} Unlock with passkey</button>}
          <button className="btn btn-ghost" onClick={() => setMode('recovery')}><Icon name="note" size={16} /> Use my recovery key</button>
          <button className="btn btn-ghost" onClick={async () => {
            setMode('link'); setError(null);
            try {
              const started = await sealed.startLink(navigator.userAgent.includes('Mobile') ? 'A phone' : 'A browser');
              setLink({ code: started.code, started });
              abort.current = new AbortController();
              await run(() => sealed.waitForLink(tenant, me.id, keys, started, abort.current!.signal));
            } catch (e) { setError(errText(e, 'Could not start.')); }
          }}><Icon name="monitor" size={16} /> Use a device that is unlocked</button>
          <button className="btn btn-ghost" onClick={() => { setMode('circle'); setError(null); }}><Icon name="users" size={16} /> Ask my recovery circle</button>
        </div>
      )}
      {mode === 'circle' && <AskCircle tenant={tenant} me={me} keys={keys} onUnlocked={onUnlocked} onBack={() => setMode('choose')} />}
      {mode === 'recovery' && (
        <form className="vlt-unlock-form" onSubmit={(e) => { e.preventDefault(); void run(() => sealed.unlockWithRecoveryKey(tenant, me.id, keys, text)); }}>
          <input className="input vlt-mono" value={text} autoFocus autoComplete="off" spellCheck={false} placeholder="PTV1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" aria-label="Recovery key" onChange={(e) => setText(e.target.value)} />
          <div className="vlt-unlock-ways"><button type="button" className="btn btn-ghost" onClick={() => setMode('choose')}>Back</button><button className="btn btn-primary" disabled={busy || text.replace(/[^A-Za-z0-9]/g, '').length < 32}>{busy && <span className="spinner" />}Unlock</button></div>
          <p className="vlt-small muted">Using the recovery key is recorded and you are notified.</p>
        </form>
      )}
      {mode === 'link' && (
        <div className="vlt-link-wait">
          {link ? <>
            <p>On a device where your vault is unlocked, open the Vault. When it asks, check it shows this code:</p>
            <code className="vlt-link-code" data-testid="link-code">{link.code}</code>
            <p className="muted vlt-small"><Spinner /> Waiting for approval (10 minutes)…</p>
          </> : <Spinner />}
          <button className="btn btn-ghost btn-sm" onClick={() => { abort.current?.abort(); setMode('choose'); setLink(null); }}>Cancel</button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

/** While unlocked: other devices of mine asking to be linked. The person approves only when the codes match. */
export function DeviceApprovals({ unlocked }: { unlocked: boolean }) {
  const q = useWsQuery(['vault', 'devices'], vaultApi.pendingDevices, { enabled: unlocked, refetchInterval: unlocked ? 15_000 : false });
  const [busy, setBusy] = useState(false);
  const link: DeviceLink | undefined = q.data?.[0];
  if (!unlocked || !link) return null;
  return (
    <Modal title="Link a new device?" subtitle="Someone signed in as you asks to open your sealed vault on another device." size="sm" onClose={() => undefined} className="vlt-scope">
      <div className="vlt-link-approve" data-testid="device-approval">
        <p><b>{link.label}</b><br /><span className="muted">{link.userAgent ?? ''}{link.ipAddress ? ` · ${link.ipAddress}` : ''} · {timeAgo(link.createdAt)}</span></p>
        <p>Approve only if the new device shows exactly this code:</p>
        <code className="vlt-link-code">{linkCode(link.x25519Public, link.mlKemPublic)}</code>
        <div className="vlt-unlock-ways">
          <button className="btn btn-ghost danger" disabled={busy} onClick={async () => { setBusy(true); try { await vaultApi.refuseDevice(link.id); toast('Refused.', 'warning'); await q.refetch(); } finally { setBusy(false); } }}>Not me — refuse</button>
          <button className="btn btn-primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await sealed.approveLink(link); toast('Device linked. Its vault is unlocking.'); await q.refetch(); } catch (e) { toast(errText(e, 'Could not approve.'), 'error'); } finally { setBusy(false); }
          }}>{busy && <span className="spinner" />}The codes match — approve</button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ my keys

export function KeysView({ tenant, me, keys, onChanged }: { tenant: string; me: Me; keys: VaultKeysMe; onChanged: () => void }) {
  const ring = useKeyring();
  const step = useStepUp();
  const unlocked = keyring.isOpenFor(tenant, me.id);
  const [kit, setKit] = useState<string | null>(null);
  const [resetting, setResetting] = useState<{ stepUp: string } | null>(null);
  const id = keys.identity;
  if (resetting) return <SetupKeys tenant={tenant} me={me} reset={resetting} onDone={() => { setResetting(null); onChanged(); }} />;
  if (!id) return <SetupKeys tenant={tenant} me={me} onDone={onChanged} />;
  return (
    <div className="vlt-keys">
      <section className="vlt-keys-hero">
        <div className={`vlt-unlock-orb small${unlocked ? ' open' : ''}`} aria-hidden="true"><span /><Icon name={unlocked ? 'checkCircle' : 'lock'} size={22} /></div>
        <div>
          <h3>{unlocked ? 'Unlocked on this device' : 'Locked'}</h3>
          <p className="muted">{unlocked ? `Opened with your ${ring.via}. It locks after five idle minutes or when you close the page.` : 'Open a sealed collection to unlock.'}</p>
        </div>
        {unlocked && <button className="btn btn-ghost btn-sm" onClick={() => { keyring.lock(); toast('Locked.'); }}><Icon name="lock" size={14} /> Lock now</button>}
      </section>
      <section className="card">
        <div className="card-head"><div><h3>Your safety code</h3><p>Read it to someone you share with; they compare it with what their screen shows for you. If it matches, nobody swapped your key.</p></div></div>
        <div className="card-body"><code className="vlt-safety" data-testid="safety-code">{id.fingerprint}</code>
          <p className="vlt-small muted">Keys: X25519 + ML-KEM-768 (post-quantum) for sharing, Ed25519 for signing · generation {id.generation}</p></div>
      </section>
      <section className="card">
        <div className="card-head"><div><h3>Ways to unlock</h3><p>Each one holds your vault secret, encrypted. The server never sees the secret itself.</p></div></div>
        <div className="card-body">
          <ul className="vlt-unlocks">
            {keys.unlocks.map((u) => (
              <li key={u.id}>
                <Icon name={u.kind === 'Passkey' ? 'key' : 'note'} size={16} />
                <span><b>{u.label}</b><span className="muted">{u.kind === 'Passkey' ? 'Passkey' : 'Recovery key'} · added {formatDate(u.createdAt)}{u.lastUsedAt ? ` · used ${timeAgo(u.lastUsedAt)}` : ''}</span></span>
                <button className="btn-icon danger" aria-label={`Remove ${u.label}`} onClick={async () => {
                  if (!(await confirmDialog({ title: `Remove “${u.label}”?`, message: 'It will no longer unlock your vault.', confirmText: 'Remove' }))) return;
                  try { await vaultApi.removeUnlock(u.id); onChanged(); } catch (e) { toast(errText(e, 'Could not remove it.'), 'error'); }
                }}><Icon name="close" size={14} /></button>
              </li>
            ))}
          </ul>
          <div className="vlt-unlock-ways">
            <button className="btn btn-ghost btn-sm" disabled={!unlocked || !prfSupported()} title={unlocked ? undefined : 'Unlock first'} onClick={async () => {
              try { await sealed.addPasskey(me, navigator.userAgent.includes('Mobile') ? 'Phone' : 'This computer'); toast('Passkey added.'); onChanged(); } catch (e) { toast(errText(e, 'No passkey was added.'), 'error'); }
            }}><Icon name="key" size={14} /> Add a passkey on this device</button>
            <button className="btn btn-ghost btn-sm" disabled={!unlocked} onClick={async () => {
              try { const r = await sealed.addRecoveryKey(); setKit(r.recoveryKey); onChanged(); } catch (e) { toast(errText(e, 'Could not make one.'), 'error'); }
            }}><Icon name="note" size={14} /> New recovery key</button>
          </div>
          {!unlocked && <p className="vlt-small muted">Unlock first to add a way to unlock.</p>}
        </div>
      </section>
      <CircleCard tenant={tenant} me={me} unlocked={unlocked} />
      <section className="card vlt-danger-card">
        <div className="card-head"><div><h3>Lost everything?</h3><p>Ask your recovery circle from the locked screen first. Otherwise, make new keys. Shared sealed collections come back as their managers share them again; personal sealed collections cannot.</p></div></div>
        <div className="card-body"><button className="btn btn-ghost btn-sm danger" onClick={async () => {
          if (!(await confirmDialog({ title: 'Make new vault keys?', message: 'Your current keys stop working at once. Only do this if you lost every passkey and the recovery key.', confirmText: 'Continue' }))) return;
          const t = await step.run(async (token) => token ?? '', true);
          if (t) { keyring.lock(); setResetting({ stepUp: t }); }
        }}>Reset my vault keys</button></div>
      </section>
      {kit && (
        <Modal title="Your new recovery key" onClose={() => setKit(null)} size="sm" className="vlt-scope">
          <code className="vlt-recovery">{kit}</code>
          <div className="vlt-kit-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => void saveFile(new Blob([recoveryKit(kit, id.fingerprint, me)], { type: 'text/plain' }), 'projecttracker-vault-recovery-kit.txt')}><Icon name="download" size={14} /> Download the kit</button>
          </div>
          <p className="vlt-small muted">Shown once. The older recovery keys keep working until you remove them.</p>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ comparing safety codes

export function SafetyCodeModal({ tenant, person, onClose }: { tenant: string; person: { userId: string; name: string; fingerprint: string; ed25519Public: string }; onClose: () => void }) {
  const state = pins.check(tenant, person.userId, person.fingerprint, person.ed25519Public);
  return (
    <Modal title={`${person.name}’s safety code`} subtitle="Ask them to read theirs from Vault → My keys. Every group must match." size="sm" onClose={onClose} className="vlt-scope"
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Not now</button><button className="btn btn-primary" onClick={() => { pins.accept(tenant, person.userId, person.fingerprint, person.ed25519Public, true); toast(`${person.name} is verified on this device.`); onClose(); }}>They match — mark verified</button></>}>
      {state === 'changed' && <p className="vlt-warn vlt-small">Their key changed since this device last saw it. That happens when someone resets their keys — or when someone tries to listen in. Compare before trusting it.</p>}
      <code className="vlt-safety">{person.fingerprint}</code>
    </Modal>
  );
}

// ------------------------------------------------------------------ a sealed item

export function SealedItemPanel({ c, item, policy, lockEpoch, binned, onEdit, onClose, onChanged }: {
  c: VaultCollection; item: sealed.SealedItem; policy: VaultPolicy; lockEpoch: number; binned: boolean; onEdit: () => void; onClose: () => void; onChanged: () => void;
}) {
  const p = item.payload;
  const [tab, setTab] = useState<'details' | 'files' | 'history' | 'activity'>('details');
  const [sending, setSending] = useState(false);
  const manage = item.row.myAccess === 'Manage';
  useEffect(() => { setTab('details'); setSending(false); }, [item.row.id, lockEpoch]);
  if (!p) return <section className="vlt-panel"><ErrorState error={new Error(item.error ?? 'This item cannot be read on this device.')} /></section>;
  const copy = async (value: string, label: string) => {
    const ok = await copySecret(value, policy.clipboardSeconds);
    toast(ok ? `${label} copied. The clipboard clears in ${policy.clipboardSeconds} seconds.` : 'The browser did not allow copying.', ok ? 'success' : 'error');
    void vaultApi.sealedEvent(item.row.id, 'copied', label).catch(() => undefined);
  };
  return (
    <section className="vlt-panel vlt-panel-sealed" aria-label={p.title} data-item={p.title}>
      <div className="vlt-card vlt-hero">
      <ItemHead title={p.title} context={`${KIND_LABEL[item.row.kind]} · ${c.name}`} sealed onClose={onClose}
        tile={<BrandTile title={p.title} url={p.url} kind={item.row.kind} size="lg" />}
        actions={<>
          {!binned && <button className="btn btn-ghost btn-sm" onClick={() => setSending(true)} title="A link that opens once, then the secret is destroyed"><Icon name="send" size={15} /> Send once</button>}
          {manage && !binned && <button className="btn btn-ghost btn-sm" onClick={onEdit}><Icon name="edit" size={15} /> Edit</button>}
        </>} />
      <div className="vlt-badges">
        <span className="badge vlt-e2ee" title="Encrypted and decrypted only on this device"><Icon name="lock" size={12} /> End-to-end encrypted</span>
        {p.class === 'Confidential' && <span className="badge badge-warning"><Icon name="shield" size={12} /> Confidential</span>}
        {p.tags.map((t) => <span key={t} className="chip">{t}</span>)}
      </div>
      {item.row.rotationReason && <div className="vlt-health-callout" role="note"><Icon name="alert" size={16} /><div><b>{HEALTH_LABEL.rotate}</b><p>{item.row.rotationReason}. Change it at the source, then save the new value here.</p></div></div>}
      <div className="vlt-tabs" role="tablist" aria-label="Item sections">
        {(['details', 'files', ...(manage ? ['history', 'activity'] as const : [])] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'details' ? 'Details' : t === 'files' ? `Files${item.row.files.length ? ` (${item.row.files.length})` : ''}` : t === 'history' ? `Earlier values${item.row.versions ? ` (${item.row.versions})` : ''}` : 'Activity'}
          </button>
        ))}
      </div>
      {tab === 'details' && (
        <div className="vlt-fields">
          {p.url && <div className="vlt-field"><span className="vlt-field-label">Address</span><div className="vlt-field-row">
            <a className="vlt-field-value vlt-link" href={/^https?:\/\//i.test(p.url) ? p.url : `https://${p.url}`} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">{p.url}</a>
            <button className="btn-icon" aria-label="Copy the address" onClick={() => void navigator.clipboard?.writeText(p.url!).then(() => toast('Address copied.'))}><Icon name="copy" size={15} /></button></div></div>}
          {p.fields.filter((f) => f.value).map((f) => f.type === 'totp'
            ? <SealedTotp key={f.key} seed={f.value!} label={f.label} itemId={item.row.id} policy={policy} lockEpoch={lockEpoch} />
            : (
              <div key={f.key} className="vlt-field" data-field={f.key}>
                <span className="vlt-field-label">{f.label}</span>
                {!f.secret ? <PlainValue label={f.label} type={f.type} value={f.value!} /> : (
                  <div className="vlt-field-row vlt-well">
                    <code className="vlt-field-value vlt-secret" data-state="masked" aria-label={`${f.label}, hidden`}>••••••••••••</code>
                    <button className="btn btn-ghost btn-sm vlt-copy" aria-label={`Copy ${f.label}`} onClick={() => void copy(f.value!, f.label)}><Icon name="copy" size={15} /><span aria-hidden="true">Copy</span></button>
                  </div>
                )}
                {f.type === 'password' && <p className="vlt-small muted">Strength: {STRENGTH_LABEL[strength(f.value!)]}</p>}
              </div>
            ))}
          {!binned && p.fields.some((f) => f.secret && f.value && f.type !== 'totp') && (
            <p className="vlt-small muted vlt-copy-only"><Icon name="lock" size={13} /> {manage ? 'Values are never shown here. Copy them, or open Edit to see one.' : 'Values are never shown. Copy one into a sign-in form; the clipboard clears itself.'}</p>
          )}
          <dl className="vlt-meta">
            {item.row.expiresAt && <><dt>Change by</dt><dd className={Date.parse(item.row.expiresAt) <= Date.now() ? 'danger' : ''}>{formatDate(item.row.expiresAt)}</dd></>}
            {item.row.rotateEveryDays && <><dt>Change every</dt><dd>{item.row.rotateEveryDays} days</dd></>}
            <dt>Value changed</dt><dd>{item.row.valueChangedAt ? timeAgo(item.row.valueChangedAt) : '—'}</dd>
            <dt>Added</dt><dd>{formatDate(item.row.createdAt)}</dd>
          </dl>
          {manage && (binned ? (
            <div className="vlt-danger-zone"><button className="btn btn-primary btn-sm" onClick={async () => { try { await vaultApi.restore(item.row.id); toast('Restored.'); onChanged(); onClose(); } catch (e) { toast(errText(e, 'Could not restore it.'), 'error'); } }}><Icon name="undo" size={14} /> Restore</button></div>
          ) : (
            <div className="vlt-danger-zone"><button className="btn btn-ghost btn-sm danger" onClick={async () => {
              if (!(await confirmDialog({ title: 'Move to the bin?', message: `“${p.title}” can be restored for 30 days, then it is destroyed.`, confirmText: 'Move to bin' }))) return;
              try { await vaultApi.remove(item.row.id); toast('Moved to the bin.', 'warning'); onChanged(); onClose(); } catch (e) { toast(errText(e, 'Could not delete it.'), 'error'); }
            }}><Icon name="trash" size={14} /> Move to bin</button></div>
          ))}
        </div>
      )}
      {tab === 'files' && <SealedFiles c={c} item={item} manage={manage && !binned} onChanged={onChanged} />}
      {tab === 'history' && <SealedHistory c={c} itemId={item.row.id} policy={policy} />}
      {tab === 'activity' && <SealedActivity id={item.row.id} />}
      </div>
      {sending && <SendLinkModal source={{ kind: 'sealed', item }} clipboardSeconds={policy.clipboardSeconds} onClose={() => setSending(false)} />}
    </section>
  );
}

function SealedTotp({ seed, label, itemId, policy, lockEpoch }: { seed: string; label: string; itemId: string; policy: VaultPolicy; lockEpoch: number }) {
  const [on, setOn] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { setOn(false); }, [lockEpoch, itemId]);
  useEffect(() => { if (!on) return; const t = window.setInterval(() => tick((n) => n + 1), 500); const off = window.setTimeout(() => setOn(false), 120_000); return () => { window.clearInterval(t); window.clearTimeout(off); }; }, [on]);
  const now = on ? totpNow(seed) : null;
  return (
    <div className="vlt-field" data-field="totp">
      <span className="vlt-field-label">{label}</span>
      <div className="vlt-field-row">
        {now ? <>
          <code className="vlt-field-value vlt-totp" data-state="revealed" aria-live="polite">{now.code.length === 6 ? `${now.code.slice(0, 3)} ${now.code.slice(3)}` : now.code}</code>
          <span className="vlt-ring" style={{ ['--p' as string]: String(now.left / now.period) }} aria-label={`${now.left} seconds left`}><b>{now.left}</b></span>
          <button className="btn-icon" aria-label="Copy the code" onClick={() => void copySecret(now.code, Math.min(policy.clipboardSeconds, 30)).then((ok) => { toast(ok ? 'Code copied.' : 'The browser did not allow copying.', ok ? 'success' : 'error'); void vaultApi.sealedEvent(itemId, 'totp_used').catch(() => undefined); })}><Icon name="copy" size={15} /></button>
        </> : <button className="btn btn-ghost btn-sm" onClick={() => { if (totpNow(seed)) { setOn(true); void vaultApi.sealedEvent(itemId, 'totp_used').catch(() => undefined); } else toast('The one-time-code key saved here is not valid.', 'error'); }}><Icon name="timer" size={15} /> Show code</button>}
      </div>
    </div>
  );
}

function SealedFiles({ c, item, manage, onChanged }: { c: VaultCollection; item: sealed.SealedItem; manage: boolean; onChanged: () => void }) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { void Promise.all(item.row.files.map(async (f) => [f.id, await sealed.fileName(c, item.row.id, f)] as const)).then((xs) => setNames(Object.fromEntries(xs))); }, [c, item.row]);
  return (
    <div className="vlt-files">
      {item.row.files.length === 0 ? <p className="muted">No files. A key file or recovery sheet kept here is encrypted on this device before it is uploaded.</p> : (
        <ul>{item.row.files.map((f) => (
          <li key={f.id}><Icon name="paperclip" size={15} /><span className="vlt-file-name">{names[f.id] ?? '…'}</span><span className="muted">{formatBytes(f.sizeBytes)} · {timeAgo(f.at)}</span>
            <button className="btn-icon" aria-label={`Download ${names[f.id] ?? 'file'}`} onClick={async () => { try { await sealed.downloadSealedFile(c, item.row, f); } catch (e) { toast(errText(e, 'Could not open it.'), 'error'); } }}><Icon name="download" size={15} /></button>
            {manage && <button className="btn-icon danger" aria-label="Remove the file" onClick={async () => {
              if (!(await confirmDialog({ title: 'Remove this file?', message: 'It is destroyed.', confirmText: 'Remove' }))) return;
              try { await vaultApi.removeAttachment(f.id); onChanged(); } catch (e) { toast(errText(e, 'Could not remove it.'), 'error'); }
            }}><Icon name="close" size={14} /></button>}
          </li>))}</ul>
      )}
      {manage && <>
        <input ref={input} type="file" hidden onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (!f) return;
          if (f.size > 2 * 1024 * 1024) { toast('A file kept in the vault can be up to 2 MB.', 'error'); return; }
          setBusy(true);
          try { await sealed.uploadSealedFile(c, item.row, f); toast('File encrypted and added.'); onChanged(); } catch (err) { toast(errText(err, 'Could not add the file.'), 'error'); } finally { setBusy(false); }
        }} />
        <button className="btn btn-ghost btn-sm" disabled={busy || item.row.files.length >= 5} onClick={() => input.current?.click()}>{busy ? <Spinner /> : <Icon name="upload" size={15} />} Add a file</button>
      </>}
    </div>
  );
}

function SealedHistory({ c, itemId, policy }: { c: VaultCollection; itemId: string; policy: VaultPolicy }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof sealed.sealedHistory>> | null>(null);
  useEffect(() => { void sealed.sealedHistory(c, itemId).then(setRows).catch(() => setRows([])); }, [c, itemId]);
  if (!rows) return <div className="vlt-pad"><Spinner /></div>;
  if (rows.length === 0) return <p className="muted vlt-pad">No earlier values yet. The last ten are kept, encrypted like the item.</p>;
  return (
    <div className="vlt-history">
      <ul>{rows.map((v) => (
        <li key={v.id}>
          <div><b>{formatDateTime(v.at)}</b> <span className="muted">{v.by ? `by ${v.by.name}` : ''}{v.reason ? ` · ${v.reason}` : ''}</span></div>
          <div className="vlt-history-fields">
            {(v.payload?.fields ?? []).filter((f) => f.secret && f.value && f.type !== 'totp').map((f) => (
              <span key={f.key} className="vlt-history-field">
                <span className="muted">{f.label}</span> <code className="vlt-secret" data-state="masked">••••••••</code>
                <button className="btn-icon" aria-label={`Copy the earlier ${f.label}`} onClick={() => void copySecret(f.value!, policy.clipboardSeconds).then((ok) => {
                  toast(ok ? `Earlier ${f.label.toLowerCase()} copied. The clipboard clears in ${policy.clipboardSeconds} seconds.` : 'The browser did not allow copying.', ok ? 'success' : 'error');
                  if (ok) void vaultApi.sealedEvent(itemId, 'copied', `${f.label} (earlier value)`).catch(() => undefined);
                })}><Icon name="copy" size={14} /></button>
              </span>
            ))}
            {!v.payload && <span className="muted">This earlier value cannot be read on this device.</span>}
          </div>
        </li>))}</ul>
      <p className="vlt-small muted">Earlier values are never shown. Each copy is recorded.</p>
    </div>
  );
}

function SealedActivity({ id }: { id: string }) {
  const q = useWsQuery(['vault', 'activity', id], () => vaultApi.activity(id), { staleTime: 0 });
  if (q.isLoading) return <div className="vlt-pad"><Spinner /></div>;
  const rows = q.data ?? [];
  if (rows.length === 0) return <p className="muted vlt-pad">Nothing recorded yet.</p>;
  return <ol className="vlt-activity">{rows.map((r, i) => <li key={i}><span className="vlt-activity-what"><b>{r.by?.name ?? 'Someone'}</b> {(ACTION_LABEL[r.action] ?? r.action.replace('vault.', '').replace(/_/g, ' ')).toLowerCase()}{r.field ? ` · ${r.field}` : ''}</span><span className="muted">{formatDateTime(r.at)}{r.ipAddress ? ` · ${r.ipAddress}` : ''}</span></li>)}</ol>;
}

// ------------------------------------------------------------------ who holds a sealed collection's key

/** In the access list of a sealed collection: who still waits for the key, and whose key changed (compare safety codes first). */
export function SealedKeysPanel({ collection }: { collection: VaultCollection }) {
  const ring = useKeyring();
  const q = useWsQuery(['vault', 'collection-keys', collection.id], () => vaultApi.collectionKeys(collection.id), { staleTime: 0 });
  const [compare, setCompare] = useState<{ userId: string; name: string; fingerprint: string; ed25519Public: string } | null>(null);
  const pending = q.data?.pending ?? [];
  if (q.isLoading) return <Spinner />;
  if (!q.data) return null;
  const tenant = ring.tenant ?? '';
  return (
    <div className="vlt-keys-panel" data-testid="sealed-keys">
      <p className="vlt-small"><Icon name="lock" size={12} /> <b>End-to-end encrypted.</b> People added here get the collection key from a manager’s browser, wrapped to their own keys{q.data.rekeyNeeded ? '; someone lost access, so a new key is made the next time you open it' : ''}.</p>
      {pending.length > 0 && <ul>{pending.map((p) => {
        const state = p.identity && tenant ? pins.check(tenant, p.userId, p.identity.fingerprint, p.identity.ed25519Public) : null;
        return (
          <li key={p.userId}>
            <span><b>{p.name}</b> <span className="muted">{!p.identity ? 'has not set up vault keys yet — they get the key once they do' : state === 'changed' ? 'their key changed — compare safety codes before they get it' : 'gets the key when you open the collection'}</span></span>
            {p.identity && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setCompare({ userId: p.userId, name: p.name, fingerprint: p.identity!.fingerprint, ed25519Public: p.identity!.ed25519Public })}>Safety code</button>}
          </li>
        );
      })}</ul>}
      {compare && <SafetyCodeModal tenant={tenant} person={compare} onClose={() => { setCompare(null); void q.refetch(); }} />}
    </div>
  );
}
