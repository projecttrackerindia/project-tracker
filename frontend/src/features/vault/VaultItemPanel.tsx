import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { ErrorState, Spinner } from '../../components/ui';
import { formatBytes, formatDate, formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { ACTION_LABEL, HEALTH_LABEL, KIND_LABEL, vaultApi, type VaultCollection, type VaultField, type VaultItem, type VaultPolicy, type VaultTotp } from './api';
import { RequestAccessModal, RequestRotationModal } from './VaultRequests';
import { useItemGrant } from './requestsData';
import { SendLinkModal } from './VaultLinks';
import { BrandTile } from './brand';
import { ItemHead, ItemSharing } from './VaultChrome';
import { PlainValue } from './PlainValue';
import { copySecret, STRENGTH_LABEL } from './secure';
import { useStepUp } from './stepUpContext';
import { DotsMenu } from '../talk/DotsMenu';
import { AccessLog, CountRing, RevealSecret, SharedPeople } from './VaultPass';

const MASK = '••••••••••••';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/**
 * One item. Secret values are never drawn here: they stay masked, and a value is fetched only to be copied (one field at a time, straight to
 * the clipboard, which clears itself). Showing one on screen needs Reveal: the password and a two-step code or passkey, checked by the server.
 */
export function VaultItemPanel({ id, policy, lockEpoch, binned = false, collections = [], canAdmin = false, onEdit, onClose, onChanged, onShare, layout = 'classic', insight = null }: {
  id: string; policy: VaultPolicy; lockEpoch: number; binned?: boolean; collections?: VaultCollection[]; canAdmin?: boolean; onEdit: (item: VaultItem) => void; onClose: () => void; onChanged: () => void;
  /** Opens this collection's access list (time-bound sharing); `start` adds a line for a person, ongoing or with an end date. */ onShare?: (collectionId: string, start?: 'person' | 'time') => void;
  /** 'v2' (Library): Username · Website · Password · 2FA · Notes first, and one Share button with three choices. Same calls, same checks. */
  layout?: 'classic' | 'v2';
  /** v2: one line from the vault's health ("3 items use a password used elsewhere") with its action. */ insight?: { text: string; act: () => void } | null;
}) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['vault', 'item', id], () => vaultApi.item(id), { staleTime: 0 });
  const step = useStepUp();
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<'details' | 'files' | 'history' | 'activity'>('details');
  useEffect(() => { setTab('details'); }, [id, lockEpoch]);
  // The two-person rule: someone else approves each use window; this shows where the person stands and lets them ask.
  const approval = !!collections.find((c) => c.id === q.data?.item.collectionId)?.requireApproval;
  const { grant, pending, refetch: refetchGrant } = useItemGrant(id, approval);
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState<boolean | { hours: number; views: number }>(false);
  const [shareFor, setShareFor] = useState<'1h' | '1d' | 'once'>('1d');
  const [rotating, setRotating] = useState(false);
  const decoys = useWsQuery(['vault', 'decoys'], vaultApi.decoys, { enabled: canAdmin, staleTime: 30_000 });
  const isDecoy = !!decoys.data?.some((x) => x.itemId === id);

  const d = q.data;
  if (q.isLoading) return <div className="vlt-panel vlt-panel-loading"><Spinner /></div>;
  if (q.error || !d) return <div className="vlt-panel"><ErrorState error={q.error} retry={() => q.refetch()} /></div>;
  const it = d.item;

  const copy = async (f: VaultField) => {
    setBusy(`copy:${f.key}`);
    try {
      const res = await step.run((t) => vaultApi.reveal(id, f.key, true, t), d.needsStepUp);
      if (!res) return;
      const ok = await copySecret(res.value, res.clipboardSeconds);
      toast(ok ? `${f.label} copied. The clipboard clears in ${res.clipboardSeconds} seconds.` : 'The browser did not allow copying.', ok ? 'success' : 'error');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VAULT_APPROVAL_REQUIRED') { setAsking(true); return; }
      toast(errText(e, 'Could not copy it.'), 'error');
    }
    finally { setBusy(null); }
  };

  const health = it.health;
  const collection = collections.find((c) => c.id === it.collectionId) ?? null;
  const context = [KIND_LABEL[it.kind], it.collectionName, it.valueChangedAt ? `changed ${timeAgo(it.valueChangedAt)}` : null].filter(Boolean).join(' · ');

  if (layout === 'v2') {
    const field = (key: string) => d.fields.find((f) => f.key === key);
    const username = field('username');
    const password = field('password');
    const totp = d.fields.find((f) => f.type === 'totp');
    const notes = field('note');
    const firstKeys = new Set([username?.key, password?.key, totp?.key, notes?.key].filter(Boolean));
    const rest = d.fields.filter((f) => !firstKeys.has(f.key) && (f.secret || !!f.value));
    const href = it.url ? (/^https?:\/\//i.test(it.url) ? it.url : `https://${it.url}`) : null;
    const canGrant = d.canManage && !!collection && collection.kind !== 'Personal' && !!onShare;
    const canLink = d.canCopy && d.canReveal;
    // Reveal on screen: only for people who manage the item (and it is not use-only); it needs the password and a second factor (checked by the server).
    const canShow = d.canManage && d.canReveal && !it.useOnly && !binned;
    const secretRow = (f: VaultField) => (
      <div key={f.key} className="vlt2-field pw-f" data-field={f.key}>
        <span className="vlt2-label pw-l">{f.label}</span>
        <RevealSecret itemId={id} field={f} canReveal={canShow} lockEpoch={lockEpoch} busy={busy === `copy:${f.key}`} onApproval={() => setAsking(true)}
          onCopy={d.canCopy && !binned ? () => void copy(f) : null} />
      </div>
    );
    const plainRow = (label: string, value: React.ReactNode, key: string, actions: React.ReactNode, cls = '') => (
      <div key={key} className="vlt2-field pw-f" data-field={key}>
        <span className="vlt2-label pw-l">{label}</span>
        <span className={`vlt2-value pw-v ${cls}`}>{value}</span>
        {actions}
      </div>
    );
    const copyPlain = (label: string, value: string) => () => void navigator.clipboard?.writeText(value).then(() => toast(`${label} copied.`)).catch(() => undefined);
    const editedBy = d.versions[0]?.by?.name;
    const changed = it.valueChangedAt ? `${editedBy ? `edited by ${editedBy.split(' ')[0]} ` : 'changed '}${timeAgo(it.valueChangedAt)}` : null;
    const SHARE_FOR = [{ id: '1h', label: '1 hour', hint: 'auto‑expires', hours: 1, views: 5 }, { id: '1d', label: '1 day', hint: 'auto‑expires', hours: 24, views: 5 }, { id: 'once', label: 'Once', hint: 'view one time', hours: 24, views: 1 }] as const;
    return (
      <section className="vlt-panel vlt2 pw-panel" aria-label={it.title} data-item={it.title}>
        <header className="vlt2-head pw-big">
          <button className="btn-icon vlt-back" aria-label="Back to the list" onClick={onClose}><Icon name="arrowLeft" /></button>
          <BrandTile title={it.title} url={it.url} kind={it.kind} size="xl" pass />
          <div className="vlt2-title">
            <h2>{it.title}</h2>
            <p>{[it.collectionName, changed].filter(Boolean).join(' · ')}{it.class === 'Confidential' && <> · <span className="vlt2-conf">Confidential</span></>}{isDecoy && <> · <span className="vlt2-conf">Decoy</span></>}{it.useOnly && <> · <span className="vlt2-conf" title="Can be copied into a sign-in form, never shown">Use only</span></>}</p>
          </div>
          {d.canManage && !binned && <button type="button" className="pw-btn lg" onClick={() => onEdit(d)}>Edit</button>}
          <DotsMenu label="Item actions" items={[
            { label: 'Share with a person', hint: 'Ongoing access to its collection', icon: 'users', onSelect: () => onShare!(it.collectionId, 'person'), hidden: binned || !canGrant },
            { label: 'Share for dates', hint: 'Access that ends on a date', icon: 'calendar', onSelect: () => onShare!(it.collectionId, 'time'), hidden: binned || !canGrant },
            { label: 'Ask for access', hint: 'Two-person rule', icon: 'users', onSelect: () => setAsking(true), hidden: !!(binned || !approval || grant || pending) },
            { label: `Files${d.attachments.length ? ` (${d.attachments.length})` : ''}`, icon: 'paperclip', onSelect: () => setTab('files') },
            { label: `Earlier values${d.versions.length ? ` (${d.versions.length})` : ''}`, icon: 'clock', onSelect: () => setTab('history'), hidden: !d.canManage },
            { label: 'Activity', hint: 'Every copy, share and change', icon: 'list', onSelect: () => setTab('activity'), hidden: !d.canManage },
            { label: 'Ask for a new value', hint: 'It leaked, or someone who left knows it', icon: 'refresh', onSelect: () => setRotating(true), hidden: binned || !!it.rotationReason || d.canManage },
            { label: isDecoy ? 'Stop being a decoy' : 'Make it a decoy', icon: 'radar', hidden: !(canAdmin && d.canManage && !binned), onSelect: async () => {
              if (!isDecoy && !(await confirmDialog({ title: 'Make it a decoy?', message: `Anyone who copies or opens “${it.title}” sets off an alert to the admins at once. Nobody but vault admins can tell it is a decoy.`, confirmText: 'Make it a decoy' }))) return;
              try { await vaultApi.setDecoy(id, !isDecoy); toast(isDecoy ? 'No longer a decoy.' : 'It is a decoy now.'); void decoys.refetch(); } catch (e) { toast(errText(e, 'Could not change it.'), 'error'); }
            } },
            { label: 'Restore', icon: 'undo', hidden: !(d.canManage && binned), onSelect: async () => { try { await vaultApi.restore(id); toast('Restored.'); onChanged(); onClose(); } catch (e) { toast(errText(e, 'Could not restore it.'), 'error'); } } },
            { label: 'Move to bin', icon: 'trash', danger: true, hidden: !d.canManage || binned, onSelect: async () => {
              if (!(await confirmDialog({ title: 'Move to the bin?', message: `“${it.title}” can be restored for 30 days, then it is destroyed with its earlier values and files.`, confirmText: 'Move to bin' }))) return;
              try { await vaultApi.remove(id); toast('Moved to the bin.', 'warning', { label: 'Undo', onClick: () => { void vaultApi.restore(id).then(() => invalidateWorkspace(wid, 'vault')); } }); onChanged(); onClose(); }
              catch (e) { toast(errText(e, 'Could not delete it.'), 'error'); }
            } },
          ]} />
        </header>

        {approval && !binned && (
          <div className={`vlt-approval${grant ? ' live' : ''}`} role="note" data-testid="approval">
            <Icon name={grant ? 'checkCircle' : 'users'} size={15} />
            <span>{grant ? `Approved by ${grant.decidedBy?.name ?? 'a manager'} until ${formatDateTime(grant.grantedUntil!)}.` : pending ? 'Asked — waiting for someone to approve.' : 'Two-person rule: someone else approves each use window.'}</span>
            {!grant && !pending && <button className="btn btn-ghost btn-xs" onClick={() => setAsking(true)}>Ask for access</button>}
          </div>
        )}
        {health.length > 0 && (
          <div className="vlt-health-callout" role="note">
            <Icon name="alert" size={16} />
            <div><b>{health.map((h) => HEALTH_LABEL[h]).join(' · ')}</b>{it.rotationReason && <p>{it.rotationReason}. Change it at the source, then save the new value here.</p>}</div>
          </div>
        )}

        {tab !== 'details' ? (
          <div className="vlt2-sub">
            <button type="button" className="btn btn-link btn-sm" onClick={() => setTab('details')}><Icon name="arrowLeft" size={14} /> Details</button>
            {tab === 'files' && <FilesTab item={d} onChanged={() => void q.refetch()} />}
            {tab === 'history' && d.canManage && <HistoryTab item={d} />}
            {tab === 'activity' && d.canManage && <ActivityTab id={id} />}
          </div>
        ) : (
          <>
            <div className="vlt2-fields pw-grp">
              {plainRow(username?.label === 'User name' ? 'Username' : username?.label ?? 'Username', username?.value || '—', 'username', username?.value ? <button type="button" className="pw-link" aria-label="Copy the username" onClick={copyPlain('Username', username.value)}>Copy</button> : null, 'mono')}
              {password ? secretRow(password) : plainRow('Password', '—', 'password', null)}
              {totp ? <TotpField key={totp.key} itemId={id} label="Verification code" needsStepUp={d.needsStepUp} lockEpoch={lockEpoch} policy={policy} onApproval={() => setAsking(true)} v2 />
                : plainRow('Verification code', 'Not set', 'totp', null, 'dim')}
              {plainRow('Website', href ? <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">{it.url}</a> : '—', 'url', null)}
              {notes ? secretRow(notes) : plainRow('Notes', '—', 'note', null, 'dim')}
              {rest.map((f) => f.type === 'totp' ? null : f.secret ? secretRow(f)
                : <div key={f.key} className="vlt2-field pw-f" data-field={f.key}><span className="vlt2-label pw-l">{f.label}</span><div className="vlt2-value pw-v"><PlainValue label={f.label} type={f.type} value={f.value ?? ''} /></div></div>)}
            </div>

            {!binned && (canLink || d.canManage) && (
              <div className={`pw-cols${d.canManage ? '' : ' one'}`}>
                {canLink ? (
                  <div className="pw-sharefor">
                    <h3>Share for…</h3>
                    <div className="pw-opt" role="radiogroup" aria-label="Share for" data-testid="share-choices">
                      {SHARE_FOR.map((o) => (
                        <button key={o.id} type="button" role="radio" aria-checked={shareFor === o.id} className={shareFor === o.id ? 'on' : ''}
                          onClick={() => { setShareFor(o.id); setSending({ hours: o.hours, views: o.views }); }}>
                          <b>{o.label}</b><small>{o.hint}</small>
                        </button>
                      ))}
                    </div>
                    <SharedPeople collection={collection} canManage={canGrant} onChanged={onChanged} />
                  </div>
                ) : <div />}
                {d.canManage && <AccessLog id={id} />}
              </div>
            )}
            {insight && !binned && (
              <div className="pw-ai" role="note"><span className="pw-orb" aria-hidden="true" /><span>{insight.text}</span><button type="button" className="pw-btn white" onClick={insight.act}>Change it</button></div>
            )}
            {d.links.length > 0 && (
              <div className="pw-used">
                <h3>Used by</h3>
                <ul>{d.links.map((l) => <li key={l.kind + l.id}><b>{l.label}</b><small>{l.kind === 'work' ? 'Work item' : l.kind[0].toUpperCase() + l.kind.slice(1)}</small></li>)}</ul>
              </div>
            )}
          </>
        )}
        {sending && <SendLinkModal source={{ kind: 'guarded', item: d }} clipboardSeconds={policy.clipboardSeconds} initial={sending === true ? undefined : sending} onClose={() => setSending(false)} />}
        {rotating && <RequestRotationModal item={{ id, title: it.title }} onClose={() => setRotating(false)} onDone={() => { void q.refetch(); onChanged(); }} />}
        {asking && <RequestAccessModal target={{ kind: 'item', id, title: it.title }} onClose={() => setAsking(false)} onDone={() => void refetchGrant()} />}
      </section>
    );
  }

  return (
    <section className="vlt-panel" aria-label={it.title} data-item={it.title}>
      <div className="vlt-card vlt-hero">
      <ItemHead title={it.title} context={context} sealed={false} onClose={onClose}
        tile={<BrandTile title={it.title} url={it.url} kind={it.kind} size="lg" />}
        actions={<>
          {d.canCopy && d.canReveal && !binned && <button className="btn btn-ghost btn-sm" onClick={() => setSending(true)} title="A link that opens once, then the secret is destroyed"><Icon name="send" size={15} /> Send once</button>}
          {d.canManage && !binned && <button className="btn btn-ghost btn-sm" onClick={() => onEdit(d)}><Icon name="edit" size={15} /> Edit</button>}
        </>} />

      <div className="vlt-badges">
        {it.class === 'Confidential' && <span className="badge badge-warning" title="Every copy needs a fresh two-step check"><Icon name="shield" size={12} /> Confidential</span>}
        {d.needsStepUp && it.class !== 'Confidential' && <span className="badge badge-warning"><Icon name="shield" size={12} /> Two-step check</span>}
        {it.useOnly && <span className="badge badge-info" title="Can be copied into a sign-in form, never shown">Use only</span>}
        {it.myAccess !== 'Manage' && <span className="badge badge-neutral">Your access: {it.myAccess === 'UseOnly' ? 'use only' : it.myAccess.toLowerCase()}</span>}
        {it.tags.map((t) => <span key={t} className="chip">{t}</span>)}
        {isDecoy && <span className="badge badge-danger" title="Only vault admins see this">Decoy</span>}
      </div>

      {approval && !binned && (
        <div className={`vlt-approval${grant ? ' live' : ''}`} role="note" data-testid="approval">
          <Icon name={grant ? 'checkCircle' : 'users'} size={15} />
          <span>{grant ? `Approved by ${grant.decidedBy?.name ?? 'a manager'} until ${formatDateTime(grant.grantedUntil!)}.`
            : pending ? 'Asked — waiting for someone to approve.' : 'Two-person rule: someone else approves each use window.'}</span>
          {!grant && !pending && <button className="btn btn-ghost btn-xs" onClick={() => setAsking(true)}>Ask for access</button>}
        </div>
      )}

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
            ? <TotpField key={f.key} itemId={id} label={f.label} needsStepUp={d.needsStepUp} lockEpoch={lockEpoch} policy={policy} onApproval={() => setAsking(true)} />
            : (
              <div key={f.key} className="vlt-field" data-field={f.key}>
                <span className="vlt-field-label">{f.label}</span>
                {!f.secret ? <PlainValue label={f.label} type={f.type} value={f.value ?? ''} /> : (
                  <>
                    <div className="vlt-field-row vlt-well">
                      <code className="vlt-field-value vlt-secret" data-state="masked" aria-label={`${f.label}, hidden`}>{MASK}</code>
                      {d.canCopy && !binned && <button className="btn btn-ghost btn-sm vlt-copy" aria-label={`Copy ${f.label}`} disabled={busy !== null} onClick={() => void copy(f)}>{busy === `copy:${f.key}` ? <Spinner /> : <Icon name="copy" size={15} />}<span aria-hidden="true">Copy</span></button>}
                    </div>
                  </>
                )}
              </div>
            ))}
          {d.fields.some((f) => f.secret && f.type !== 'totp') && d.canCopy && !binned && (
            <p className="vlt-small muted vlt-copy-only"><Icon name="lock" size={13} /> {d.canManage && d.canReveal
              ? 'Values stay hidden; copy them. Reveal asks for your password and a two-step code or passkey.'
              : 'Values are never shown. Copy one into a sign-in form; the clipboard clears itself.'}
              <span className="vlt-policy-line">{[d.needsStepUp ? 'copy needs a two-step check' : null, `clipboard clears after ${policy.clipboardSeconds}s`].filter(Boolean).join(' · ')}</span></p>
          )}
          <dl className="vlt-meta">
            {it.owner && <><dt>Owner</dt><dd>{it.owner.name}</dd></>}
            <dt>Strength</dt><dd>{it.strength === null ? '—' : STRENGTH_LABEL[it.strength]}</dd>
            {it.expiresAt && <><dt>Change by</dt><dd className={it.expired ? 'danger' : ''}>{formatDate(it.expiresAt)}</dd></>}
            {d.rotateEveryDays && <><dt>Change every</dt><dd>{d.rotateEveryDays} days</dd></>}
            <dt>Value changed</dt><dd>{it.valueChangedAt ? timeAgo(it.valueChangedAt) : '—'}</dd>
            <dt>Last used</dt><dd>{it.lastUsedAt ? timeAgo(it.lastUsedAt) : 'Never'}</dd>
            <dt>Added</dt><dd>{formatDate(d.createdAt)}{d.createdBy ? ` by ${d.createdBy.name}` : ''}</dd>
          </dl>
          {!binned && !it.rotationReason && !d.canManage && (
            <p className="vlt-small muted vlt-rotate-ask">Think this value leaked, or someone who left still knows it?{' '}
              <button type="button" className="link-btn" onClick={() => setRotating(true)}>Ask for a new value</button></p>
          )}
          {d.links.length > 0 && <div className="vlt-links"><span className="vlt-field-label">Used by</span>{d.links.map((l) => <span key={l.kind + l.id} className="chip">{l.label}</span>)}</div>}
          {d.canManage && binned && (
            <div className="vlt-danger-zone">
              <p className="muted vlt-small">In the bin: destroyed 30 days after it was deleted, with its earlier values and files.</p>
              <button className="btn btn-primary btn-sm" onClick={async () => {
                try { await vaultApi.restore(id); toast('Restored.'); onChanged(); onClose(); } catch (e) { toast(errText(e, 'Could not restore it.'), 'error'); }
              }}><Icon name="undo" size={14} /> Restore</button>
            </div>
          )}
          {canAdmin && d.canManage && !binned && (
            <div className="vlt-decoy-zone">
              <button className="btn btn-ghost btn-sm" onClick={async () => {
                if (!isDecoy && !(await confirmDialog({ title: 'Make it a decoy?', message: `Anyone who copies or opens “${it.title}” sets off an alert to the admins at once. Nobody but vault admins can tell it is a decoy. Use it for a credential nobody has a reason to touch.`, confirmText: 'Make it a decoy' }))) return;
                try { await vaultApi.setDecoy(id, !isDecoy); toast(isDecoy ? 'No longer a decoy.' : 'It is a decoy now. Leave it where an intruder would look.'); void decoys.refetch(); } catch (e) { toast(errText(e, 'Could not change it.'), 'error'); }
              }}><Icon name="radar" size={14} /> {isDecoy ? 'Stop being a decoy' : 'Make it a decoy'}</button>
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
      {tab === 'history' && d.canManage && <HistoryTab item={d} />}
      {tab === 'activity' && d.canManage && <ActivityTab id={id} />}
      </div>
      {!binned && <ItemSharing collection={collection} canManage={d.canManage} canSend={d.canCopy && d.canReveal} approval={approval}
        onShare={onShare ? () => onShare(it.collectionId) : undefined} onSend={() => setSending(true)} onAsk={() => setAsking(true)} />}
      {sending &&<SendLinkModal source={{ kind: 'guarded', item: d }} clipboardSeconds={policy.clipboardSeconds} onClose={() => setSending(false)} />}
      {rotating && <RequestRotationModal item={{ id, title: it.title }} onClose={() => setRotating(false)} onDone={() => { void q.refetch(); onChanged(); }} />}
      {asking && <RequestAccessModal target={{ kind: 'item', id, title: it.title }} onClose={() => setAsking(false)} onDone={() => void refetchGrant()} />}
    </section>
  );
}

/** The current code, computed on the server (the seed never comes to the page), refreshed as each one runs out while the tab is visible. */
function TotpField({ itemId, label, needsStepUp, lockEpoch, policy, onApproval, v2 = false }: { itemId: string; label: string; needsStepUp: boolean; lockEpoch: number; policy: VaultPolicy; onApproval: () => void; v2?: boolean }) {
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
    } catch (e) {
      setCode(null);
      if (e instanceof ApiError && e.code === 'VAULT_APPROVAL_REQUIRED') onApproval();
      else toast(errText(e, 'Could not get the code.'), 'error');
    }
    finally { setBusy(false); }
  }, [itemId, needsStepUp, step, onApproval]);
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
  if (v2) return (
    <div className="vlt2-field pw-f" data-field="totp">
      <span className="vlt2-label pw-l">{label}</span>
      {code ? <>
        <code className="vlt2-value pw-v pw-otp vlt-totp" aria-live="polite" data-state="revealed">{pretty}</code>
        <span className="pw-hide pw-otp-ring" aria-label={`${left} seconds left`}><CountRing left={left} total={code.period} size={22} stroke={3} tone="green" />{left}s</span>
        <button type="button" className="pw-link" aria-label="Copy the code" onClick={() => void copySecret(code.code, Math.min(policy.clipboardSeconds, 30)).then((ok) => toast(ok ? 'Code copied.' : 'The browser did not allow copying.', ok ? 'success' : 'error'))}>Copy</button>
      </> : <>
        <code className="vlt2-value pw-v pw-otp vlt-secret" data-state="masked" aria-label={`${label}, hidden`}>••• •••</code>
        <button type="button" className="pw-btn" disabled={busy} onClick={() => { refreshes.current = 0; void load(); }}>{busy ? <Spinner /> : 'Show code'}</button>
      </>}
    </div>
  );
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

function HistoryTab({ item }: { item: VaultItem }) {
  const step = useStepUp();
  const secretFields = item.fields.filter((f) => f.secret && f.type !== 'totp');
  const [field, setField] = useState(secretFields.find((f) => f.key === 'password')?.key ?? secretFields[0]?.key ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  if (item.versions.length === 0) return <p className="muted vlt-pad">No earlier values yet. When a secret changes, the old value is kept here (encrypted) for the last ten changes.</p>;
  const label = secretFields.find((f) => f.key === field)?.label ?? 'Value';
  return (
    <div className="vlt-history">
      {secretFields.length > 1 && (
        <label className="field vlt-inline-field"><span>Field</span>
          <select className="input" value={field} onChange={(e) => setField(e.target.value)}>{secretFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
        </label>
      )}
      <ul>
        {item.versions.map((v) => (
          <li key={v.id}>
            <div><b>{formatDateTime(v.at)}</b> <span className="muted">{v.by ? `by ${v.by.name}` : ''}{v.reason ? ` · ${v.reason}` : ''}</span></div>
            <code className="vlt-secret" data-state="masked">{MASK}</code>
            <button className="btn btn-ghost btn-sm" disabled={busy !== null} aria-label={`Copy the earlier ${label}`} onClick={async () => {
              setBusy(v.id);
              try {
                const res = await step.run((t) => vaultApi.revealVersion(item.item.id, v.id, field, t, true), true);
                if (!res) return;
                const ok = await copySecret(res.value, res.clipboardSeconds);
                toast(ok ? `Earlier ${label.toLowerCase()} copied. The clipboard clears in ${res.clipboardSeconds} seconds.` : 'The browser did not allow copying.', ok ? 'success' : 'error');
              } catch (e) { toast(errText(e, 'Could not copy it.'), 'error'); }
              finally { setBusy(null); }
            }}>{busy === v.id ? <Spinner /> : <Icon name="copy" size={14} />} Copy</button>
          </li>
        ))}
      </ul>
      <p className="vlt-small muted">Earlier values are never shown. Copying one always needs a fresh two-step check and is recorded.</p>
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
