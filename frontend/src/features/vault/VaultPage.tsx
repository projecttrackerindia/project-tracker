import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError } from '../../api/client';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, Modal, PageHead, PageLoader } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { holdScreenShield, screenShieldInfo, type ShieldInfo } from '../../lib/screenShield';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { HEALTH_LABEL, KIND_LABEL, vaultApi, type VaultCollection, type VaultHealth, type VaultHealthFlag, type VaultItem, type VaultItemKind, type VaultItemSummary } from './api';
import { keyring, useKeyring } from './e2ee/keyring';
import * as sealed from './e2ee/sealed';
import { DeviceApprovals, KeysView, SealedItemPanel, SetupKeys, UnlockPanel } from './SealedVault';
import { sealedSummary, useSealedData, type Me } from './sealedData';
import { AdminView, HealthView } from './VaultAdmin';
import { CollectionEditor, Generator, ImportModal, ItemEditor, ShareEditor, type SealedEdit } from './VaultEditors';
import { VaultItemPanel } from './VaultItemPanel';
import { CircleHelpRequests } from './RecoveryCircle';
import { LinksView } from './VaultLinks';
import { BrandTile } from './brand';
import { AccessFaces, ClipboardCountdown, PostureStrip } from './VaultChrome';
import { copySecret } from './secure';
import { RequestsView } from './VaultRequests';
import { useVaultRequests } from './requestsData';
import { StepUpProvider } from './stepUp';
import { useStepUp } from './stepUpContext';
import './vault.css';

type View = 'items' | 'health' | 'bin' | 'admin' | 'keys' | 'requests' | 'links';
type Row = VaultItemSummary & { sealed?: boolean };
const IDLE_MS = 5 * 60_000;
/** The field a row's quick copy takes, by kind (the one people reach for). */
const QUICK: Partial<Record<VaultItemKind, { key: string; label: string }>> = {
  Login: { key: 'password', label: 'password' }, Server: { key: 'password', label: 'password' }, Database: { key: 'password', label: 'password' },
  ApiKey: { key: 'key', label: 'API key' }, Card: { key: 'number', label: 'card number' },
};
const COLLECTION_ICON: Record<VaultCollection['kind'], IconName> = { Personal: 'user', Shared: 'users', Project: 'folder', Team: 'users' };

/**
 * The password vault, in two modes side by side. Guarded collections are encrypted by the server, which enforces use-only, two-step checks
 * and one-time codes. Sealed collections are end-to-end encrypted: opened only on members' devices with keys the server never sees. After five
 * idle minutes everything locks: revealed values go, the two-step check is forgotten, and the sealed keys are wiped from memory.
 */
export function VaultPage() {
  const overview = useWsQuery(['vault', 'overview'], vaultApi.overview, { staleTime: 30_000 });
  if (overview.isLoading) return <PageLoader />;
  if (overview.error || !overview.data) return <div className="page"><ErrorState error={overview.error} retry={() => overview.refetch()} /></div>;
  return <StepUpProvider mfaEnabled={overview.data.mfaEnabled} hasPasskeys={overview.data.hasPasskeys}><Vault /></StepUpProvider>;
}

function Vault() {
  const wid = useWorkspaceId();
  const user = useAuth((s) => s.ctx?.user);
  const me: Me | null = user ? { id: user.id, email: user.email, name: user.displayName } : null;
  const meId = me?.id ?? null;
  const overview = useWsQuery(['vault', 'overview'], vaultApi.overview, { staleTime: 30_000 });
  const keysMe = useWsQuery(['vault', 'keys', 'me'], vaultApi.keysMe, { staleTime: 60_000 });
  const o = overview.data!;
  const step = useStepUp();
  const ring = useKeyring();
  const [params, setParams] = useSearchParams();
  const view = ((): View => {
    const v = params.get('view') ?? (params.get('tab') === 'access' ? 'admin' : null);
    return v === 'health' || v === 'bin' || v === 'keys' || v === 'requests' || v === 'links' || (v === 'admin' && o.canAdmin) ? v : 'items';
  })();
  const collectionId = params.get('c');
  const itemId = params.get('item');
  const health = params.get('health') as VaultHealthFlag | 'any' | null;
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);
  const [kind, setKind] = useState<VaultItemKind | ''>('');
  const [lockEpoch, setLockEpoch] = useState(0);
  const [editing, setEditing] = useState<VaultItem | SealedEdit | 'new' | null>(null);
  const [collectionEdit, setCollectionEdit] = useState<VaultCollection | 'new' | null>(null);
  const [sharing, setSharing] = useState<VaultCollection | null>(null);
  const [importing, setImporting] = useState(false);
  const [generator, setGenerator] = useState(false);
  const [breached, setBreached] = useState<Map<string, number>>(new Map());

  const set = useCallback((patch: Record<string, string | null>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) { if (v === null) n.delete(k); else n.set(k, v); }
      n.delete('tab');
      return n;
    }, { replace: false });
  }, [setParams]);

  // Locks itself when nobody has touched the page for a while (and when another workspace or person is in front of it).
  useEffect(() => {
    let t = window.setTimeout(lock, IDLE_MS);
    function lock() { step.forget(); keyring.lock(); setLockEpoch((e) => e + 1); }
    const bump = () => { window.clearTimeout(t); t = window.setTimeout(lock, IDLE_MS); };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    return () => { window.clearTimeout(t); evs.forEach((e) => window.removeEventListener(e, bump)); };
  }, [step]);
  useEffect(() => { if (keyring.get().identity && !keyring.isOpenFor(wid, meId)) keyring.lock(); }, [wid, meId]);

  // Screen sharing: the apps keep this window out of every share and recording while the vault is open; in a browser tab (which cannot)
  // the vault covers itself whenever the window is not the one in use — switching to the meeting app is enough to hide it.
  const shield = useMemo(screenShieldInfo, []);
  useEffect(() => holdScreenShield(), []);
  const away = useAway(shield.level !== 'blocked');

  const requests = useVaultRequests();
  const waiting = requests.data?.toDecide.length ?? 0;
  const sealedData = useSealedData(o.collections, wid, meId);
  const unlocked = sealedData.unlocked;
  const collection = o.collections.find((c) => c.id === collectionId) ?? null;
  const sealedOnly = !!collection?.sealed;
  const items = useWsQuery(['vault', 'items', view === 'bin' ? 'bin' : collectionId ?? 'all', q, kind, health],
    () => vaultApi.items({ collectionId: view === 'bin' ? null : collectionId, q, kind: kind || null, health, bin: view === 'bin' }),
    { enabled: (view === 'items' && !sealedOnly) || view === 'bin', staleTime: 15_000, placeholderData: (prev) => prev });
  const { load: loadSealed, sealedCols } = sealedData;
  useEffect(() => { if (view === 'bin' && unlocked) for (const c of sealedCols) if (c.myAccess === 'Manage') void loadSealed(c, true); }, [view, unlocked, sealedCols, loadSealed]);

  // Sealed items, decrypted here, shown and filtered like the others.
  const sealedRows = useMemo(() => {
    const all = sealedData.sealedCols.flatMap((c) => (sealedData.data[c.id]?.items ?? []).map((s) => ({ c, s })));
    const passwords = new Map<string, number>();
    for (const { s } of all) { const p = s.payload?.fields.find((f) => f.key === 'password')?.value; if (p) passwords.set(p, (passwords.get(p) ?? 0) + 1); }
    const reused = new Set([...passwords].filter(([, n]) => n > 1).map(([p]) => p));
    const text = q.trim().toLowerCase();
    return all.map(({ c, s }) => ({ c, s, sum: sealedSummary(c, s, reused, breached) }))
      .filter(({ c, sum }) => (!collectionId || c.id === collectionId) && (!kind || sum.kind === kind) && (!health || (health === 'any' ? sum.health.length > 0 : sum.health.includes(health)))
        && (!text || [sum.title, sum.url, sum.usernameHint, ...sum.tags].some((x) => x?.toLowerCase().includes(text))));
  }, [sealedData.sealedCols, sealedData.data, breached, q, kind, health, collectionId]);
  const sealedBin = useMemo(() => sealedData.sealedCols.flatMap((c) => (sealedData.data[c.id]?.bin ?? []).map((s) => ({ c, s, sum: sealedSummary(c, s, new Set(), breached) }))), [sealedData, breached]);

  const refresh = useCallback(() => {
    void invalidateWorkspace(wid, 'vault');
    if (unlocked) for (const c of sealedData.sealedCols) void sealedData.load(c, view === 'bin');
  }, [wid, unlocked, sealedData, view]);
  const personal = o.collections.find((c) => c.kind === 'Personal');
  const shared = o.collections.filter((c) => c.kind !== 'Personal');
  const list: Row[] = view === 'bin' ? [...(items.data ?? []), ...sealedBin.map((r) => r.sum)]
    : sealedOnly ? sealedRows.map((r) => r.sum) : [...(items.data ?? []), ...sealedRows.map((r) => r.sum)].sort((a, b) => (b.health.length > 0 ? 1 : 0) - (a.health.length > 0 ? 1 : 0) || a.title.localeCompare(b.title));
  const selectedSealed = (view === 'bin' ? sealedBin : sealedRows).find((r) => r.s.row.id === itemId) ?? null;
  const title = view === 'bin' ? 'Bin' : view === 'health' ? 'Health' : view === 'admin' ? 'Administration' : view === 'keys' ? 'My keys' : view === 'requests' ? 'Requests' : view === 'links' ? 'One-time links' : collection?.name ?? 'All items';
  const hasKeys = !!keysMe.data?.identity;
  const canSeal = hasKeys && unlocked;

  const health2 = useMemo<VaultHealth>(() => {
    const s = sealedRows.map((r) => r.sum);
    const c = (f: VaultHealthFlag) => s.filter((x) => x.health.includes(f)).length;
    const total = o.health.total + s.length;
    const healthy = Math.round((o.health.score / 100) * o.health.total) + s.filter((x) => x.health.length === 0).length;
    return { total, weak: o.health.weak + c('weak'), reused: o.health.reused + c('reused'), breached: o.health.breached + c('breached'), expired: o.health.expired + c('expired'), old: o.health.old + c('old'),
      toRotate: o.health.toRotate + c('rotate'), score: total === 0 ? 100 : Math.round((100 * healthy) / total) };
  }, [o.health, sealedRows]);

  // Copy straight from the list: the same checks as copying from the item (two-step, approval, risk, decoys), and recorded the same way.
  const quickCopy = useCallback(async (row: Row) => {
    const q = QUICK[row.kind];
    if (!q) return;
    try {
      if (row.sealed) {
        const s = sealedRows.find((r) => r.s.row.id === row.id)?.s;
        const f = s?.payload?.fields.find((x) => x.key === q.key && x.value);
        if (!f?.value) { toast(`“${row.title}” has no ${q.label}.`, 'warning'); return; }
        const ok = await copySecret(f.value, o.policy.clipboardSeconds);
        toast(ok ? `${f.label} of “${row.title}” copied.` : 'The browser did not allow copying.', ok ? 'success' : 'error');
        if (ok) void vaultApi.sealedEvent(row.id, 'copied', f.label).catch(() => undefined);
        return;
      }
      const res = await step.run((t) => vaultApi.reveal(row.id, q.key, true, t), row.class === 'Confidential' || o.policy.stepUpAlways);
      if (!res) return;
      const ok = await copySecret(res.value, res.clipboardSeconds);
      toast(ok ? `The ${q.label} of “${row.title}” is copied.` : 'The browser did not allow copying.', ok ? 'success' : 'error');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VAULT_APPROVAL_REQUIRED') { set({ item: row.id }); toast('This needs someone’s approval first. Ask from the item.', 'warning'); return; }
      toast(e instanceof ApiError ? e.message : 'Could not copy it.', 'error');
    }
  }, [sealedRows, o.policy.clipboardSeconds, o.policy.stepUpAlways, step, set]);

  const sealIt = async (c: VaultCollection) => {
    setCollectionEdit(null);
    if (!canSeal) { toast('Set up and unlock your vault keys first (My keys).', 'warning'); set({ view: 'keys' }); return; }
    if (!(await confirmDialog({ title: `Seal “${c.name}”?`, message: 'Every item is encrypted on this device with a new key only members hold, and the server-readable copies and their history are destroyed. Use-only access becomes view. This cannot be undone.', confirmText: 'Seal it' }))) return;
    try {
      const r = await step.run((t) => sealed.sealCollection(c, t), true);
      if (r) { toast(`Sealed ${r.items} item${r.items === 1 ? '' : 's'}. The server can no longer read them.`); refresh(); }
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not seal it.', 'error'); }
  };

  const lockState = !hasKeys ? 'none' : unlocked ? 'open' : 'locked';
  const rail = (
    <nav className="vlt-rail" aria-label="Vault collections">
      <button className={`vlt-lockstate ${lockState}${view === 'keys' ? ' on' : ''}`} onClick={() => set({ view: 'keys', item: null })} data-testid="lock-state">
        <span className="vlt-lockdot" aria-hidden="true" />
        <span>{lockState === 'none' ? 'Set up sealed vault' : lockState === 'open' ? 'Sealed vault open' : 'Sealed vault locked'}</span>
        <Icon name={lockState === 'open' ? 'checkCircle' : 'lock'} size={14} />
      </button>
      <button className={view === 'items' && !collectionId ? 'on' : ''} onClick={() => set({ view: null, c: null, item: null, health: null })}><Icon name="grid" size={16} /><span>All items</span></button>
      {personal && <CollectionButton c={personal} active={view === 'items' && collectionId === personal.id} onClick={() => set({ view: null, c: personal.id, item: null, health: null })} />}
      {shared.length > 0 && <p className="vlt-rail-title">Shared</p>}
      {shared.map((c) => <CollectionButton key={c.id} c={c} active={view === 'items' && collectionId === c.id} onClick={() => set({ view: null, c: c.id, item: null, health: null })} />)}
      {o.canCreateShared && <button className="vlt-rail-add" onClick={() => setCollectionEdit('new')}><Icon name="plus" size={15} /><span>New collection</span></button>}
      <p className="vlt-rail-title">Tools</p>
      <button className={view === 'health' ? 'on' : ''} onClick={() => set({ view: 'health', item: null })}><Icon name="gauge" size={16} /><span>Health</span>{health2.score < 100 && health2.total > 0 && <em className={health2.score < 60 ? 'bad' : ''}>{health2.score}</em>}</button>
      <button className={view === 'requests' ? 'on' : ''} onClick={() => set({ view: 'requests', item: null })} data-testid="rail-requests"><Icon name="inbox" size={16} /><span>Requests</span>{waiting > 0 && <em className="bad" title={`${waiting} waiting for you`}>{waiting}</em>}</button>
      <button className={view === 'links' ? 'on' : ''} onClick={() => set({ view: 'links', item: null })}><Icon name="send" size={16} /><span>One-time links</span></button>
      <button className={view === 'bin' ? 'on' : ''} onClick={() => set({ view: 'bin', c: null, item: null, health: null })}><Icon name="trash" size={16} /><span>Bin</span></button>
      {o.canAdmin && <button className={view === 'admin' ? 'on' : ''} onClick={() => set({ view: 'admin', item: null })}><Icon name="shield" size={16} /><span>Administration</span></button>}
    </nav>
  );

  const sealedGate = (c: VaultCollection) => {
    if (!me || !wid) return null;
    if (!hasKeys) return <SetupKeys tenant={wid} me={me} onDone={() => { void keysMe.refetch(); void overview.refetch(); }} />;
    if (!unlocked) return keysMe.data ? <UnlockPanel tenant={wid} me={me} keys={keysMe.data} onUnlocked={() => setLockEpoch((e) => e + 1)} /> : <PageLoader />;
    const d = sealedData.data[c.id];
    if (!d || d.status === 'loading') return <PageLoader />;
    if (d.status === 'waiting') return <EmptyState icon="key" title="Waiting for the key" text="Someone who manages this collection shares its key with you from their browser the next time they open it. Your keys are ready." />;
    if (d.status === 'unreadable') return <EmptyState icon="alert" title="Your keys cannot open this" text="This happens after a key reset. Ask someone who manages it to open the collection: it is shared with your new keys then." />;
    if (d.status === 'error') return <ErrorState error={new Error(d.error ?? 'Could not open it.')} retry={() => void sealedData.load(c)} />;
    return null;
  };
  const gate = view === 'items' && collection?.sealed ? sealedGate(collection) : null;

  return (
    <div className={`page vlt vlt-scope${itemId ? ' has-item' : ''}`}>
      <PageHead title="Vault" sub="Passwords, keys and secrets: end-to-end encrypted or server-guarded, shared on purpose, every use recorded.">
        <button className="btn btn-ghost" onClick={() => setGenerator(true)}><Icon name="sparkle" size={15} /> Generator</button>
        <button className="btn btn-ghost" onClick={() => setImporting(true)}><Icon name="upload" size={15} /> Import</button>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} /> New item</button>
      </PageHead>
      <ShieldNote info={shield} />
      {!o.mfaEnabled && (
        <div className="vlt-banner" role="note"><Icon name="shield" size={16} /><span>Turn on two-step verification to open confidential items and earlier values.</span><Link className="btn btn-ghost btn-xs" to="/account/security">Set it up</Link></div>
      )}
      <div className="vlt-layout">
        {rail}
        <main className="vlt-main" aria-label={title}>
          {view === 'keys' ? (me && wid && keysMe.data ? <KeysView tenant={wid} me={me} keys={keysMe.data} onChanged={() => { void keysMe.refetch(); void overview.refetch(); }} /> : <PageLoader />)
            : view === 'health' ? <HealthView health={health2} onFilter={(f) => set({ view: null, c: null, health: f })}
                extra={unlocked && sealedRows.length > 0 ? <button className="btn btn-ghost btn-sm" onClick={async () => {
                  const next = new Map(breached);
                  for (const r of sealedRows) { const p = r.s.payload?.fields.find((f) => f.key === 'password')?.value; if (p) next.set(r.s.row.id, await sealed.breachesFor(p).catch(() => 0)); }
                  setBreached(next); toast('Sealed passwords checked against breach lists (only hash prefixes were sent).');
                }}><Icon name="shield" size={14} /> Check sealed items for breaches</button> : null} />
            : view === 'admin' ? <AdminView policy={o.policy} onPolicy={refresh} />
            : view === 'requests' ? <RequestsView />
            : view === 'links' ? <LinksView clipboardSeconds={o.policy.clipboardSeconds} />
            : (
              <>
                <div className="vlt-list-head">
                  <div className="vlt-list-title">
                    <h2>{title}{collection?.sealed && <span className="vlt-e2ee-tag"><Icon name="lock" size={12} /> End-to-end encrypted</span>}</h2>
                    {collection && collection.kind !== 'Personal' && <span className="muted">{collection.kind === 'Project' ? `Project ${collection.projectName ?? ''}` : collection.kind === 'Team' ? `Team ${collection.teamName ?? ''}` : 'Shared'} · your access: {collection.myAccess === 'UseOnly' ? 'use only' : collection.myAccess.toLowerCase()}</span>}
                    {collection?.kind === 'Personal' && <span className="muted">Only you can open this, not even an administrator.</span>}
                  </div>
                  {collection && collection.myAccess === 'Manage' && (
                    <div className="vlt-list-actions">
                      {collection.kind !== 'Personal' && <AccessFaces collection={collection} onOpen={async () => { try { setSharing(await vaultApi.collection(collection.id)); } catch { toast('Could not open the access list.', 'error'); } }} />}
                      {collection.kind !== 'Personal' && <button className="btn btn-ghost btn-sm" onClick={async () => { try { setSharing(await vaultApi.collection(collection.id)); } catch { toast('Could not open the access list.', 'error'); } }}><Icon name="users" size={14} /> Access</button>}
                      {collection.kind === 'Personal' && !collection.sealed && <button className="btn btn-ghost btn-sm" onClick={() => void sealIt(collection)}><Icon name="lock" size={14} /> Seal my vault</button>}
                      {collection.kind !== 'Personal' && <button className="btn-icon" aria-label="Collection settings" onClick={() => setCollectionEdit(collection)}><Icon name="settings" size={15} /></button>}
                    </div>
                  )}
                </div>
                {gate ?? (
                  <>
                    {view === 'items' && !collectionId && !q && !kind && <PostureStrip health={health2} active={health} onFilter={(f) => set({ health: f })} />}
                    {view === 'items' && (
                      <div className="vlt-filters">
                        <label className="vlt-search"><Icon name="search" size={15} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search names, addresses, tags" aria-label="Search the vault" /></label>
                        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as VaultItemKind | '')} aria-label="Kind">
                          <option value="">All kinds</option>{(Object.keys(KIND_LABEL) as VaultItemKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                        </select>
                        {health && <button className="chip vlt-chip-on" onClick={() => set({ health: null })}>{health === 'any' ? 'At risk' : HEALTH_LABEL[health]} <Icon name="close" size={12} /></button>}
                      </div>
                    )}
                    {!sealedOnly && !collectionId && view === 'items' && hasKeys && !unlocked && sealedData.sealedCols.length > 0 && (
                      <button className="vlt-locked-note" onClick={() => set({ c: sealedData.sealedCols[0].id })}><Icon name="lock" size={14} /> {sealedData.sealedCols.length} sealed collection{sealedData.sealedCols.length === 1 ? ' is' : 's are'} locked — unlock to include them</button>
                    )}
                    {items.isLoading && !sealedOnly ? <PageLoader /> : items.error && !sealedOnly ? <ErrorState error={items.error} retry={() => items.refetch()} /> : list.length === 0 ? (
                      view === 'bin' ? <EmptyState icon="trash" title="The bin is empty" text="Deleted items wait here for 30 days, then they are destroyed." />
                        : q || kind || health ? <EmptyState icon="search" title="Nothing matches" />
                        : <EmptyState icon="lock" title={collection?.kind === 'Personal' ? 'Your vault is empty' : 'No items yet'} text="Save a password, an API key, a server or a secure note. Or import from another password manager."
                            action={<button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} /> New item</button>} />
                    ) : (
                      <ItemList list={list} showCollection={!collectionId} active={itemId} binned={view === 'bin'} onOpen={(id) => set({ item: id })} onCopy={(r) => void quickCopy(r)} />
                    )}
                  </>
                )}
              </>
            )}
        </main>
        {itemId && (view === 'items' || view === 'bin') && (selectedSealed
          ? <SealedItemPanel c={selectedSealed.c} item={selectedSealed.s} policy={o.policy} lockEpoch={lockEpoch} binned={view === 'bin'}
              onEdit={() => setEditing({ item: selectedSealed.s, collection: selectedSealed.c })} onClose={() => set({ item: null })} onChanged={refresh} />
          : (!collection?.sealed || view === 'bin') && <VaultItemPanel id={itemId} policy={o.policy} lockEpoch={lockEpoch} binned={view === 'bin'} collections={o.collections} canAdmin={o.canAdmin} onEdit={(d) => setEditing(d)} onClose={() => set({ item: null })} onChanged={refresh} />)}
      </div>

      <DeviceApprovals unlocked={unlocked} />
      <CircleHelpRequests unlocked={unlocked} />
      {editing && <ItemEditor existing={editing === 'new' || 'collection' in editing ? null : editing} sealedEdit={editing !== 'new' && 'collection' in editing ? editing : null}
        collections={o.collections} defaultCollection={collectionId ?? personal?.id ?? null} clipboardSeconds={o.policy.clipboardSeconds} revealSeconds={o.policy.revealSeconds}
        onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); refresh(); set({ item: id, view: null }); }} />}
      {collectionEdit && <CollectionEditor existing={collectionEdit === 'new' ? null : collectionEdit} canSeal={canSeal} onSeal={(c) => void sealIt(c)} onClose={() => setCollectionEdit(null)}
        onSaved={(id) => { const wasNew = collectionEdit === 'new'; setCollectionEdit(null); refresh(); set({ c: id, item: null, view: null }); if (wasNew && id) void vaultApi.collection(id).then(setSharing).catch(() => undefined); }} />}
      {sharing && <ShareEditor collection={sharing} meId={meId} onClose={() => setSharing(null)} onSaved={() => { setSharing(null); refresh(); }} />}
      {importing && <ImportModal collections={o.collections} defaultCollection={collectionId ?? personal?.id ?? null} onClose={() => setImporting(false)} onDone={(c) => { setImporting(false); refresh(); set({ c, view: null, item: null }); }} />}
      {generator && (
        <Modal title="Password generator" onClose={() => setGenerator(false)} size="sm" className="vlt-scope">
          <Generator clipboardSeconds={o.policy.clipboardSeconds} />
        </Modal>
      )}
      <span hidden data-ring={ring.version} />
      <ClipboardCountdown />
      {away && createPortal(<div className="vlt-cover" role="status" aria-live="polite" data-testid="vault-cover"><Icon name="lock" size={28} /><b>Vault hidden</b><span>It shows again when you come back to this window.</span></div>, document.body)}
    </div>
  );
}

/** True while this window is not the one in use (another app or tab is in front, or the window is minimised). */
function useAway(enabled: boolean) {
  const [away, setAway] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const off = () => setAway(true), on = () => setAway(false);
    const vis = () => setAway(document.hidden || !document.hasFocus());
    window.addEventListener('blur', off); window.addEventListener('focus', on); document.addEventListener('visibilitychange', vis);
    return () => { window.removeEventListener('blur', off); window.removeEventListener('focus', on); document.removeEventListener('visibilitychange', vis); };
  }, [enabled]);
  return enabled && away;
}

const SHIELD_NOTE_KEY = 'pt-vault-shield-note';
/** Says plainly what screen sharing can see here, and where it is fully black. */
function ShieldNote({ info }: { info: ShieldInfo }) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(SHIELD_NOTE_KEY) === info.where; } catch { return false; } });
  if (info.level === 'blocked') {
    return <p className="vlt-shield ok" data-testid="shield-note"><Icon name="eyeOff" size={14} /> Hidden from screen sharing and screenshots on this {info.where === 'android' ? 'phone' : 'computer'}: others see a black window.</p>;
  }
  if (hidden) return null;
  const dismiss = () => { setHidden(true); try { localStorage.setItem(SHIELD_NOTE_KEY, info.where); } catch { /* storage unavailable */ } };
  return (
    <div className="vlt-banner vlt-shield" role="note" data-testid="shield-note">
      <Icon name="eye" size={16} />
      <span>{info.level === 'partial'
        ? 'On a Mac, most screenshots and shares show this window black, but some newer recording apps can still see it. Values are never shown outside the edit screen, and the vault hides itself when you switch windows.'
        : 'Screen sharing can see a browser tab. The vault never shows a value here and hides when you switch windows; the Windows and Android apps go fully black in shares.'}</span>
      {info.where === 'browser' && <a className="btn btn-ghost btn-xs" href="/download/" target="_blank" rel="noopener noreferrer">Get the app</a>}
      <button className="btn-icon" aria-label="Dismiss" onClick={dismiss}><Icon name="close" size={14} /></button>
    </div>
  );
}

function CollectionButton({ c, active, onClick }: { c: VaultCollection; active: boolean; onClick: () => void }) {
  return (
    <button className={`${active ? 'on' : ''}${c.sealed ? ' sealed' : ''}`} onClick={onClick} data-collection={c.name} title={[c.description, c.sealed ? 'End-to-end encrypted' : null, c.requireApproval ? 'Two-person rule' : null].filter(Boolean).join(' · ') || undefined}>
      <Icon name={c.sealed ? 'lock' : COLLECTION_ICON[c.kind]} size={16} />
      <span>{c.name}</span>
      {c.requireStepUp && <Icon name="shield" size={12} />}
      {c.requireApproval && <Icon name="users" size={12} />}
      {c.atRisk > 0 ? <em className="bad" title={`${c.atRisk} at risk`}>{c.atRisk}</em> : <i>{c.items}</i>}
    </button>
  );
}

/**
 * The list. Arrow keys move between items, Enter opens one, C copies its password (or key, or card number) without opening it.
 */
function ItemList({ list, showCollection, active, binned, onOpen, onCopy }: { list: Row[]; showCollection: boolean; active: string | null; binned: boolean; onOpen: (id: string) => void; onCopy: (r: Row) => void }) {
  const ref = useRef<HTMLUListElement>(null);
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const rows = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('.vlt-item') ?? []);
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && at >= 0 && !binned) {
      e.preventDefault();
      onCopy(list[at]);
    }
  };
  return (
    <>
      <ul className="vlt-items" aria-label="Items" ref={ref} onKeyDown={onKey}>
        {list.map((it) => <ItemRow key={it.id} it={it} showCollection={showCollection} active={it.id === active} binned={binned} onOpen={() => onOpen(it.id)} onCopy={() => onCopy(it)} />)}
      </ul>
      {list.length > 1 && <p className="vlt-keys-hint muted" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>Enter</kbd> open <kbd>C</kbd> copy</p>}
    </>
  );
}

function ItemRow({ it, showCollection, active, binned, onOpen, onCopy }: { it: Row; showCollection: boolean; active: boolean; binned: boolean; onOpen: () => void; onCopy: () => void }) {
  const flags = useMemo(() => it.health.map((h) => HEALTH_LABEL[h]).join(', '), [it.health]);
  const quick = !binned ? QUICK[it.kind] : undefined;
  const host = it.url?.replace(/^https?:\/\//, '').split('/')[0];
  return (
    <li className="vlt-row">
      <button className={`vlt-item${active ? ' on' : ''}`} onClick={onOpen} data-item={it.title} aria-current={active || undefined}>
        <BrandTile title={it.title} url={it.url} kind={it.kind} />
        <span className="vlt-item-main">
          <b>{it.title}</b>
          <span className="muted">{[it.usernameHint, showCollection ? it.collectionName : null, host].filter(Boolean).join(' · ') || KIND_LABEL[it.kind]}</span>
        </span>
        <span className="vlt-item-tags">
          {it.sealed && <span className="vlt-e2ee-dot" title="End-to-end encrypted"><Icon name="lock" size={12} /></span>}
          {it.class === 'Confidential' && <span title="Confidential: a fresh check every time"><Icon name="shield" size={13} /></span>}
          {it.useOnly && <span className="badge badge-info">Use only</span>}
          {it.hasTotp && <span title="Has a one-time code"><Icon name="timer" size={13} /></span>}
          {it.health.length > 0 && <span className={`vlt-risk ${it.health.includes('breached') || it.health.includes('rotate') ? 'bad' : ''}`} title={flags} aria-label={flags} />}
          {it.lastUsedAt && <span className="muted vlt-used">{timeAgo(it.lastUsedAt)}</span>}
        </span>
      </button>
      {quick && <button type="button" className="vlt-quick" tabIndex={-1} onClick={onCopy} aria-label={`Copy the ${quick.label} of ${it.title}`} title={`Copy the ${quick.label}`}><Icon name="copy" size={14} /></button>}
    </li>
  );
}
