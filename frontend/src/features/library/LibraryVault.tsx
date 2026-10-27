import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, Modal, PageLoader, Segmented } from '../../components/ui';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { holdScreenShield, screenShieldInfo, type ShieldInfo } from '../../lib/screenShield';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { DotsMenu } from '../talk/DotsMenu';
import { HEALTH_LABEL, KIND_LABEL, vaultApi, type VaultCollection, type VaultHealth, type VaultHealthFlag, type VaultItem, type VaultItemKind, type VaultItemSummary } from '../vault/api';
import { copySecret } from '../vault/secure';
import { ApiError } from '../../api/client';
import { BrandTile } from '../vault/brand';
import { keyring, useKeyring } from '../vault/e2ee/keyring';
import * as sealed from '../vault/e2ee/sealed';
import { DeviceApprovals, KeysView, SealedItemPanel, SetupKeys, UnlockPanel } from '../vault/SealedVault';
import { sealedSummary, useSealedData, type Me } from '../vault/sealedData';
import { CircleHelpRequests } from '../vault/RecoveryCircle';
import { AdminView, HealthView } from '../vault/VaultAdmin';
import { ClipboardCountdown } from '../vault/VaultChrome';
import { CollectionEditor, Generator, ImportModal, ItemEditor, ShareEditor, type SealedEdit } from '../vault/VaultEditors';
import { VaultItemPanel } from '../vault/VaultItemPanel';
import { LinksView } from '../vault/VaultLinks';
import { RequestsView } from '../vault/VaultRequests';
import { useVaultRequests } from '../vault/requestsData';
import { StepUpProvider } from '../vault/stepUp';
import { useStepUp } from '../vault/stepUpContext';
import { LibraryHead } from './LibraryHead';
import '../vault/vault.css';
import '../vault/vault-ds.css';

type Show = 'all' | 'mine' | 'shared' | 'requests';
type View = 'items' | 'health' | 'bin' | 'keys' | 'links' | 'admin' | 'collections';
/** The field a row's quick copy takes, by kind (the one people reach for). */
const QUICK: Partial<Record<VaultItemKind, { key: string; label: string }>> = {
  Login: { key: 'password', label: 'password' }, Server: { key: 'password', label: 'password' }, Database: { key: 'password', label: 'password' },
  ApiKey: { key: 'key', label: 'API key' }, Card: { key: 'number', label: 'card number' },
};
type Row = VaultItemSummary & { sealed?: boolean };
const IDLE_MS = 5 * 60_000;
const SHIELD_SEEN_KEY = 'pt-vault-shield-seen';

/**
 * Library › Vault: the same vault (the same calls, step-up checks, sealed collections and their keys, idle lock and screen-share cover),
 * shown the v2 way: All · Mine · Shared · Requests and a search on the left; the item on the right with Username, Website, Password, 2FA code
 * and Notes first and one Share button; Generator, Import, Health, One-time links, Bin and Seal my vault under ···.
 * Addresses: /library/vault/{item id}; the less-used views are ?view=health|bin|links|keys|admin.
 */
export function LibraryVault({ switcher }: { switcher: ReactNode }) {
  const overview = useWsQuery(['vault', 'overview'], vaultApi.overview, { staleTime: 30_000 });
  if (overview.isLoading) return <div className="page lib"><LibraryHead eyebrow="Vault" switcher={switcher} /><PageLoader /></div>;
  if (overview.error || !overview.data) return <div className="page lib"><LibraryHead eyebrow="Vault" switcher={switcher} /><ErrorState error={overview.error} retry={() => overview.refetch()} /></div>;
  return <StepUpProvider mfaEnabled={overview.data.mfaEnabled} hasPasskeys={overview.data.hasPasskeys}><VaultTab switcher={switcher} /></StepUpProvider>;
}

function VaultTab({ switcher }: { switcher: ReactNode }) {
  const wid = useWorkspaceId();
  const user = useAuth((s) => s.ctx?.user);
  const me: Me | null = user ? { id: user.id, email: user.email, name: user.displayName } : null;
  const meId = me?.id ?? null;
  const overview = useWsQuery(['vault', 'overview'], vaultApi.overview, { staleTime: 30_000 });
  const keysMe = useWsQuery(['vault', 'keys', 'me'], vaultApi.keysMe, { staleTime: 60_000 });
  const o = overview.data!;
  const step = useStepUp();
  const ring = useKeyring();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const itemId = (() => { const m = /\/library\/vault\/([^/?#]+)/.exec(location.pathname); return m ? decodeURIComponent(m[1]) : params.get('item'); })();
  const v = params.get('view');
  const view: View = v === 'health' || v === 'bin' || v === 'keys' || v === 'links' || v === 'collections' || (v === 'admin' && o.canAdmin) ? v : 'items';
  // One collection's items (?c=…), chosen from Collections under ···.
  const collectionId = o.collections.some((c) => c.id === params.get('c')) ? params.get('c') : null;
  const collection = collectionId ? o.collections.find((c) => c.id === collectionId)! : null;
  const show: Show = (['mine', 'shared', 'requests'] as const).find((s) => s === params.get('show')) ?? 'all';
  const health = params.get('health') as VaultHealthFlag | 'any' | null;
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);
  const [lockEpoch, setLockEpoch] = useState(0);
  const [editing, setEditing] = useState<VaultItem | SealedEdit | 'new' | null>(null);
  // + New › Secret (?new=item): the new-item editor, once; the address is left clean so a reload does not open it again.
  useEffect(() => {
    if (params.get('new') !== 'item') return;
    setEditing('new');
    setParams((p) => { const n = new URLSearchParams(p); n.delete('new'); n.delete('title'); return n; }, { replace: true });
  }, [params, setParams]);
  const [sharing, setSharing] = useState<{ c: VaultCollection; start?: 'person' | 'time' } | null>(null);
  const [importing, setImporting] = useState(false);
  const [generator, setGenerator] = useState(false);
  const [collectionEdit, setCollectionEdit] = useState<VaultCollection | 'new' | null>(null);
  const [breached, setBreached] = useState<Map<string, number>>(new Map());

  /** Moves within the vault: an item is in the path, the rest in the query. */
  const go = useCallback((o2: { item?: string | null; view?: View | null; show?: Show | null; health?: string | null; c?: string | null }) => {
    const next = new URLSearchParams(params);
    if (o2.view !== undefined) { if (o2.view && o2.view !== 'items') next.set('view', o2.view); else next.delete('view'); }
    if (o2.show !== undefined) { if (o2.show && o2.show !== 'all') next.set('show', o2.show); else next.delete('show'); }
    if (o2.health !== undefined) { if (o2.health) next.set('health', o2.health); else next.delete('health'); }
    if (o2.c !== undefined) { if (o2.c) next.set('c', o2.c); else next.delete('c'); }
    next.delete('item');
    const item = o2.item === undefined ? itemId : o2.item;
    const qs = next.toString();
    navigate(`/library/vault${item ? `/${encodeURIComponent(item)}` : ''}${qs ? `?${qs}` : ''}`);
  }, [params, itemId, navigate]);

  // Locks itself when nobody has touched the page for a while: revealed codes go, the two-step check is forgotten, sealed keys are wiped.
  useEffect(() => {
    let t = window.setTimeout(lock, IDLE_MS);
    function lock() { step.forget(); keyring.lock(); setLockEpoch((e) => e + 1); }
    const bump = () => { window.clearTimeout(t); t = window.setTimeout(lock, IDLE_MS); };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    return () => { window.clearTimeout(t); evs.forEach((e) => window.removeEventListener(e, bump)); };
  }, [step]);
  useEffect(() => { if (keyring.get().identity && !keyring.isOpenFor(wid, meId)) keyring.lock(); }, [wid, meId]);

  // Screen sharing: the apps keep the window out of shares; in a browser tab the vault covers itself while the window is not in use.
  const shield = useMemo(screenShieldInfo, []);
  useEffect(() => holdScreenShield(), []);
  const away = useAway(shield.level !== 'blocked');

  const requests = useVaultRequests();
  const waiting = requests.data?.toDecide.length ?? 0;
  const sealedData = useSealedData(o.collections, wid, meId);
  const unlocked = sealedData.unlocked;
  const personal = o.collections.find((c) => c.kind === 'Personal') ?? null;
  const inShow = useCallback((cid: string) => (!collectionId || cid === collectionId) && (show === 'mine' ? cid === personal?.id : show === 'shared' ? cid !== personal?.id : true), [show, personal, collectionId]);
  const listing = view === 'items' || view === 'bin';
  const listCollection = view === 'bin' ? null : collectionId ?? (show === 'mine' ? personal?.id ?? null : null);
  const items = useWsQuery(['vault', 'items', view === 'bin' ? 'bin' : listCollection ?? 'all', q, '', health],
    () => vaultApi.items({ collectionId: listCollection, q, health, bin: view === 'bin' }),
    { enabled: listing && show !== 'requests', staleTime: 15_000, placeholderData: (prev) => prev });
  const { load: loadSealed, sealedCols } = sealedData;
  useEffect(() => { if (view === 'bin' && unlocked) for (const c of sealedCols) if (c.myAccess === 'Manage') void loadSealed(c, true); }, [view, unlocked, sealedCols, loadSealed]);

  const sealedRows = useMemo(() => {
    const all = sealedData.sealedCols.flatMap((c) => (sealedData.data[c.id]?.items ?? []).map((s) => ({ c, s })));
    const passwords = new Map<string, number>();
    for (const { s } of all) { const p = s.payload?.fields.find((f) => f.key === 'password')?.value; if (p) passwords.set(p, (passwords.get(p) ?? 0) + 1); }
    const reused = new Set([...passwords].filter(([, n]) => n > 1).map(([p]) => p));
    const text = q.trim().toLowerCase();
    return all.map(({ c, s }) => ({ c, s, sum: sealedSummary(c, s, reused, breached) }))
      .filter(({ c, sum }) => inShow(c.id) && (!health || (health === 'any' ? sum.health.length > 0 : sum.health.includes(health)))
        && (!text || [sum.title, sum.url, sum.usernameHint, ...sum.tags].some((x) => x?.toLowerCase().includes(text))));
  }, [sealedData.sealedCols, sealedData.data, breached, q, health, inShow]);
  const sealedBin = useMemo(() => sealedData.sealedCols.flatMap((c) => (sealedData.data[c.id]?.bin ?? []).map((s) => ({ c, s, sum: sealedSummary(c, s, new Set(), breached) }))), [sealedData, breached]);

  const refresh = useCallback(() => {
    void invalidateWorkspace(wid, 'vault');
    if (unlocked) for (const c of sealedData.sealedCols) void sealedData.load(c, view === 'bin');
  }, [wid, unlocked, sealedData, view]);
  const list: Row[] = view === 'bin' ? [...(items.data ?? []), ...sealedBin.map((r) => r.sum)]
    : [...(items.data ?? []).filter((r) => inShow(r.collectionId)), ...sealedRows.map((r) => r.sum)]
      .sort((a, b) => (b.health.length > 0 ? 1 : 0) - (a.health.length > 0 ? 1 : 0) || a.title.localeCompare(b.title));
  const selectedSealed = (view === 'bin' ? sealedBin : sealedRows).find((r) => r.s.row.id === itemId) ?? null;
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
  const atRisk = health2.total - Math.round((health2.score / 100) * health2.total);

  const sealMine = async () => {
    if (!personal) return;
    if (!canSeal) { toast('Set up and unlock your vault keys first (My keys).', 'warning'); go({ view: 'keys', item: null }); return; }
    if (!(await confirmDialog({ title: 'Seal your vault?', message: 'Every item is encrypted on this device with a new key only you hold, and the server-readable copies and their history are destroyed. This cannot be undone.', confirmText: 'Seal it' }))) return;
    try {
      const r = await step.run((t) => sealed.sealCollection(personal, t), true);
      if (r) { toast(`Sealed ${r.items} item${r.items === 1 ? '' : 's'}. The server can no longer read them.`); refresh(); }
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not seal it.', 'error'); }
  };
  const openShare = async (cid: string, start?: 'person' | 'time') => {
    try { setSharing({ c: await vaultApi.collection(cid), start }); } catch { toast('Could not open the access list.', 'error'); }
  };
  // Seal a shared collection (from its settings): encrypted on this device for its members only.
  const sealIt = async (c: VaultCollection) => {
    setCollectionEdit(null);
    if (!canSeal) { toast('Set up and unlock your vault keys first (My keys).', 'warning'); go({ view: 'keys', item: null }); return; }
    if (!(await confirmDialog({ title: `Seal “${c.name}”?`, message: 'Every item is encrypted on this device with a new key only members hold, and the server-readable copies and their history are destroyed. Use-only access becomes view. This cannot be undone.', confirmText: 'Seal it' }))) return;
    try {
      const r = await step.run((t) => sealed.sealCollection(c, t), true);
      if (r) { toast(`Sealed ${r.items} item${r.items === 1 ? '' : 's'}. The server can no longer read them.`); refresh(); }
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not seal it.', 'error'); }
  };
  // Copy straight from the list (C on a row, or its copy button): the same checks as copying from the item, and recorded the same way.
  const quickCopy = async (row: Row) => {
    const qk = QUICK[row.kind];
    if (!qk) return;
    try {
      if (row.sealed) {
        const s2 = sealedRows.find((r) => r.s.row.id === row.id)?.s;
        const f = s2?.payload?.fields.find((x) => x.key === qk.key && x.value);
        if (!f?.value) { toast(`“${row.title}” has no ${qk.label}.`, 'warning'); return; }
        const ok = await copySecret(f.value, o.policy.clipboardSeconds);
        toast(ok ? `${f.label} of “${row.title}” copied.` : 'The browser did not allow copying.', ok ? 'success' : 'error');
        if (ok) void vaultApi.sealedEvent(row.id, 'copied', f.label).catch(() => undefined);
        return;
      }
      const res = await step.run((t) => vaultApi.reveal(row.id, qk.key, true, t), row.class === 'Confidential' || o.policy.stepUpAlways);
      if (!res) return;
      const ok = await copySecret(res.value, res.clipboardSeconds);
      toast(ok ? `The ${qk.label} of “${row.title}” is copied.` : 'The browser did not allow copying.', ok ? 'success' : 'error');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VAULT_APPROVAL_REQUIRED') { go({ item: row.id }); toast('This needs someone’s approval first. Ask from the item.', 'warning'); return; }
      toast(e instanceof ApiError ? e.message : 'Could not copy it.', 'error');
    }
  };
  const listRef = useRef<HTMLUListElement>(null);
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.lib-vault-item') ?? []);
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus(); }
    else if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && at >= 0 && view !== 'bin') { e.preventDefault(); void quickCopy(list[at]); }
  };

  // A sealed collection that is not open on this device yet: set up keys, unlock, or wait for the key.
  const sealedGate = (c: VaultCollection) => {
    if (!me || !wid) return null;
    if (!hasKeys) return <SetupKeys tenant={wid} me={me} onDone={() => { void keysMe.refetch(); void overview.refetch(); }} />;
    if (!unlocked) return keysMe.data ? <UnlockPanel tenant={wid} me={me} keys={keysMe.data} onUnlocked={() => setLockEpoch((e) => e + 1)} /> : <PageLoader />;
    const d = sealedData.data[c.id];
    if (!d || d.status === 'loading') return <PageLoader />;
    if (d.status === 'waiting') return <EmptyState icon="key" title="Waiting for the key" text="Someone who manages this collection shares its key with you from their browser the next time they open it." />;
    if (d.status === 'unreadable') return <EmptyState icon="alert" title="Your keys cannot open this" text="This happens after a key reset. Ask someone who manages it to open the collection." />;
    if (d.status === 'error') return <ErrorState error={new Error(d.error ?? 'Could not open it.')} retry={() => void sealedData.load(c)} />;
    return null;
  };
  const mineGate = collection?.sealed ? sealedGate(collection) : show === 'mine' && personal?.sealed ? sealedGate(personal) : null;

  const viewTitle: Record<Exclude<View, 'items'>, string> = { health: 'Health', bin: 'Bin', keys: 'My keys', links: 'One-time links', admin: 'Administration', collections: 'Collections' };
  const right = view === 'keys' ? (me && wid && keysMe.data ? <KeysView tenant={wid} me={me} keys={keysMe.data} onChanged={() => { void keysMe.refetch(); void overview.refetch(); }} /> : <PageLoader />)
    : view === 'health' ? <HealthView health={health2} onFilter={(f) => go({ view: null, show: null, health: f, item: null, c: null })}
        extra={unlocked && sealedRows.length > 0 ? <button className="btn btn-ghost btn-sm" onClick={async () => {
          const next = new Map(breached);
          for (const r of sealedRows) { const p = r.s.payload?.fields.find((f) => f.key === 'password')?.value; if (p) next.set(r.s.row.id, await sealed.breachesFor(p).catch(() => 0)); }
          setBreached(next); toast('Sealed passwords checked against breach lists (only hash prefixes were sent).');
        }}><Icon name="shield" size={14} /> Check sealed items for breaches</button> : null} />
    : view === 'admin' ? <AdminView policy={o.policy} onPolicy={refresh} />
    : view === 'collections' ? <CollectionsView collections={o.collections} onOpen={(cid) => go({ view: null, c: cid, show: null, item: null })}
        onAccess={(cid) => void openShare(cid)} onSettings={(c) => setCollectionEdit(c)} />
    : view === 'links' ? <LinksView clipboardSeconds={o.policy.clipboardSeconds} />
    : itemId && selectedSealed ? <SealedItemPanel c={selectedSealed.c} item={selectedSealed.s} policy={o.policy} lockEpoch={lockEpoch} binned={view === 'bin'}
        onEdit={() => setEditing({ item: selectedSealed.s, collection: selectedSealed.c })} onClose={() => go({ item: null })} onChanged={refresh} />
    // In a sealed collection an item is only ever a sealed one: wait for it to be opened here rather than asking the server for it.
    : itemId && collection?.sealed ? <PageLoader />
    : itemId
      ? <VaultItemPanel key={itemId} id={itemId} layout="v2" policy={o.policy} lockEpoch={lockEpoch} binned={view === 'bin'} collections={o.collections} canAdmin={o.canAdmin}
          onEdit={(d) => setEditing(d)} onClose={() => go({ item: null })} onChanged={refresh} onShare={(cid, start) => void openShare(cid, start)} />
    : null;

  return (
    <div className={`page lib lib-vault-page vlt-scope${itemId || view !== 'items' ? ' has-item' : ''}`}>
      <LibraryHead switcher={switcher} eyebrowTone={atRisk > 0 ? 'warning' : 'success'}
        eyebrow={`${health2.total} item${health2.total === 1 ? '' : 's'} · ${atRisk > 0 ? `${atRisk} at risk` : 'all healthy'}`}>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} /> New secret</button>
        <DotsMenu label="More in the vault" items={[
          { label: 'Generator', hint: 'A strong password or passphrase', icon: 'sparkle', onSelect: () => setGenerator(true) },
          { label: 'Import', hint: 'From another password manager', icon: 'upload', onSelect: () => setImporting(true) },
          { label: 'Collections', hint: 'Open one, its access and its rules', icon: 'folder', onSelect: () => go({ view: 'collections', item: null }) },
          { label: 'Health', hint: health2.total ? `Score ${health2.score}` : undefined, icon: 'gauge', onSelect: () => go({ view: 'health', item: null }) },
          { label: 'One-time links', icon: 'send', onSelect: () => go({ view: 'links', item: null }) },
          { label: 'Bin', hint: 'Deleted items, for 30 days', icon: 'trash', onSelect: () => go({ view: 'bin', item: null, show: null }) },
          { label: 'Seal my vault', hint: 'End-to-end: only your devices can open it', icon: 'lock', onSelect: () => void sealMine(), hidden: !personal || personal.sealed },
          { label: hasKeys ? (unlocked ? 'My keys · sealed vault open' : 'My keys · unlock sealed vault') : 'Set up sealed vault', icon: 'key', onSelect: () => go({ view: 'keys', item: null }) },
          { label: 'New shared collection', icon: 'users', onSelect: () => setCollectionEdit('new'), hidden: !o.canCreateShared },
          { label: 'Administration', icon: 'shield', onSelect: () => go({ view: 'admin', item: null }), hidden: !o.canAdmin },
        ]} />
      </LibraryHead>
      <ShieldOnce info={shield} />
      {!o.mfaEnabled && (
        <div className="vlt-banner" role="note"><Icon name="shield" size={16} /><span>Turn on two-step verification to copy confidential items and earlier values.</span><Link className="btn btn-ghost btn-xs" to="/settings/profile">Set it up</Link></div>
      )}

      <div className={`lib-vault${show === 'requests' ? ' wide' : ''}`}>
        <section className="lib-card lib-vault-list" aria-label="Vault items">
          {view === 'bin' ? (
            <div className="lib-vault-mode"><button type="button" className="btn btn-link btn-sm" onClick={() => go({ view: null, item: null })}><Icon name="arrowLeft" size={14} /> All items</button><b>Bin</b></div>
          ) : (
            <Segmented label="Show" wide value={show} onChange={(s) => go({ show: s, item: null, view: null })}
              options={[{ id: 'all', label: 'All' }, { id: 'mine', label: 'Mine' }, { id: 'shared', label: 'Shared' }, { id: 'requests', label: 'Requests', count: waiting || undefined }]} />
          )}
          {show === 'requests' && view !== 'bin' ? <div className="lib-vault-requests"><RequestsView /></div> : (
            <>
              <label className="lib-vault-search"><Icon name="search" size={15} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search names, URLs, tags" aria-label="Search the vault" /></label>
              {collection && (
                <div className="lib-vault-coll" data-collection={collection.name}>
                  <button type="button" className="ds-chip on lib-vault-flag" onClick={() => go({ c: null, item: null })} aria-label={`Show every collection, not only ${collection.name}`}>{collection.name} <Icon name="close" size={12} /></button>
                  {collection.myAccess === 'Manage' && collection.kind !== 'Personal' && <>
                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => void openShare(collection.id)}><Icon name="users" size={13} /> Access</button>
                    <button type="button" className="btn-icon" aria-label="Collection settings" onClick={() => setCollectionEdit(collection)}><Icon name="settings" size={14} /></button>
                  </>}
                </div>
              )}
              {health && <button type="button" className="ds-chip on lib-vault-flag" onClick={() => go({ health: null })}>{health === 'any' ? 'At risk' : HEALTH_LABEL[health]} <Icon name="close" size={12} /></button>}
              {!personal?.sealed && hasKeys && !unlocked && sealedData.sealedCols.length > 0 && show !== 'mine' && (
                <button type="button" className="vlt-locked-note" onClick={() => go({ view: 'keys', item: null })}><Icon name="lock" size={14} /> {sealedData.sealedCols.length} sealed collection{sealedData.sealedCols.length === 1 ? ' is' : 's are'} locked — unlock to include them</button>
              )}
              {mineGate ?? (items.isLoading ? <PageLoader /> : items.error ? <ErrorState error={items.error} retry={() => items.refetch()} /> : list.length === 0 ? (
                view === 'bin' ? <EmptyState icon="trash" title="The bin is empty" text="Deleted items wait here for 30 days, then they are destroyed." />
                  : q || health ? <EmptyState icon="search" title="Nothing matches" />
                    : <EmptyState icon="lock" title={show === 'shared' ? 'Nothing shared with you yet' : 'Your vault is empty'} text="Save a password, an API key, a server or a secure note. Or import from another password manager."
                        action={<button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} /> New secret</button>} />
              ) : (
                <ul className="lib-vault-items" aria-label="Items" ref={listRef} onKeyDown={onListKey}>
                  {list.map((it) => {
                    const host = it.url?.replace(/^https?:\/\//, '').split('/')[0];
                    const quick = view !== 'bin' ? QUICK[it.kind] : undefined;
                    return (
                      <li key={it.id} className="lib-vault-row">
                        <button type="button" className={`lib-vault-item${it.id === itemId ? ' on' : ''}`} onClick={() => go({ item: it.id, view: view === 'bin' ? 'bin' : null })} data-item={it.title} aria-current={it.id === itemId || undefined}>
                          <BrandTile title={it.title} url={it.url} kind={it.kind} />
                          <span className="lib-vault-item-main"><b>{it.title}</b><small>{host || it.usernameHint || KIND_LABEL[it.kind]}{show !== 'mine' && it.collectionId !== personal?.id ? ` · ${it.collectionName}` : ''}</small></span>
                          {it.sealed && <span className="vlt-e2ee-dot" title="End-to-end encrypted"><Icon name="lock" size={12} /></span>}
                          {it.health.length > 0 && <span className={`vlt-risk ${it.health.includes('breached') || it.health.includes('rotate') ? 'bad' : ''}`} title={it.health.map((h) => HEALTH_LABEL[h]).join(', ')} aria-label={it.health.map((h) => HEALTH_LABEL[h]).join(', ')} />}
                        </button>
                        {quick && <button type="button" className="vlt-quick" tabIndex={-1} onClick={() => void quickCopy(it)} aria-label={`Copy the ${quick.label} of ${it.title}`} title={`Copy the ${quick.label} (or press C)`}><Icon name="copy" size={14} /></button>}
                      </li>
                    );
                  })}
                </ul>
              ))}
            </>
          )}
        </section>

        {show !== 'requests' && (
          <section className="lib-card lib-vault-detail" aria-label={view !== 'items' && view !== 'bin' ? viewTitle[view] : 'Item'}>
            {view !== 'items' && view !== 'bin' && (
              <div className="lib-vault-mode"><button type="button" className="btn btn-link btn-sm" onClick={() => go({ view: null })}><Icon name="arrowLeft" size={14} /> Items</button><b>{viewTitle[view]}</b></div>
            )}
            {right ?? (
              <div className="lib-vault-empty"><Icon name="lock" size={28} /><p>Pick an item to see its username, website, password, 2FA code and notes.</p></div>
            )}
          </section>
        )}
      </div>

      <DeviceApprovals unlocked={unlocked} />
      <CircleHelpRequests unlocked={unlocked} />
      {editing && <ItemEditor existing={editing === 'new' || 'collection' in editing ? null : editing} sealedEdit={editing !== 'new' && 'collection' in editing ? editing : null}
        collections={o.collections} defaultCollection={collectionId ?? personal?.id ?? null} clipboardSeconds={o.policy.clipboardSeconds} revealSeconds={o.policy.revealSeconds}
        onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); refresh(); go({ item: id, view: null }); }} />}
      {collectionEdit && <CollectionEditor existing={collectionEdit === 'new' ? null : collectionEdit} canSeal={canSeal} onSeal={(c) => void sealIt(c)} onClose={() => setCollectionEdit(null)}
        onSaved={(id) => { setCollectionEdit(null); refresh(); if (id) void openShare(id); }} />}
      {sharing && <ShareEditor collection={sharing.c} start={sharing.start} meId={meId} onClose={() => setSharing(null)} onSaved={() => { setSharing(null); refresh(); }} />}
      {importing && <ImportModal collections={o.collections} defaultCollection={personal?.id ?? null} onClose={() => setImporting(false)} onDone={() => { setImporting(false); refresh(); go({ view: null, item: null }); }} />}
      {generator && <Modal title="Password generator" onClose={() => setGenerator(false)} size="sm" className="vlt-scope"><Generator clipboardSeconds={o.policy.clipboardSeconds} /></Modal>}
      <span hidden data-ring={ring.version} />
      <ClipboardCountdown />
      {away && createPortal(<div className="vlt-cover" role="status" aria-live="polite" data-testid="vault-cover"><Icon name="lock" size={28} /><b>Vault hidden</b><span>It shows again when you come back to this window.</span></div>, document.body)}
      {params.get('item') && !/\/library\/vault\//.test(location.pathname) && <RedirectItem id={params.get('item')!} onGo={(id) => { const n = new URLSearchParams(params); n.delete('item'); setParams(n, { replace: true }); go({ item: id }); }} />}
    </div>
  );
}

const COLLECTION_ICON: Record<VaultCollection['kind'], IconName> = { Personal: 'user', Shared: 'users', Project: 'folder', Team: 'users' };

/** Collections (under ···): open one to see only its items; its managers reach its access list and its rules (two-person rule, sealing…). */
function CollectionsView({ collections, onOpen, onAccess, onSettings }: { collections: VaultCollection[]; onOpen: (id: string) => void; onAccess: (id: string) => void; onSettings: (c: VaultCollection) => void }) {
  return (
    <ul className="lib-vault-colls" aria-label="Collections">
      {collections.map((c) => (
        <li key={c.id} data-collection={c.name}>
          <button type="button" className="lib-vault-coll-main" onClick={() => onOpen(c.id)}>
            <Icon name={c.sealed ? 'lock' : COLLECTION_ICON[c.kind]} size={16} />
            <span><b>{c.name}</b><small>{c.kind === 'Personal' ? 'Only you' : c.kind === 'Project' ? `Project ${c.projectName ?? ''}` : c.kind === 'Team' ? `Team ${c.teamName ?? ''}` : 'Shared'}
              {' · '}{c.items} item{c.items === 1 ? '' : 's'}{c.atRisk > 0 ? ` · ${c.atRisk} at risk` : ''}{c.requireApproval ? ' · two-person rule' : ''}</small></span>
          </button>
          {c.myAccess === 'Manage' && c.kind !== 'Personal' && <>
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => onAccess(c.id)}>Access</button>
            <button type="button" className="btn-icon" aria-label={`Settings of ${c.name}`} onClick={() => onSettings(c)}><Icon name="settings" size={14} /></button>
          </>}
        </li>
      ))}
    </ul>
  );
}

/** An old ?item= link: move the item into the path once. */
function RedirectItem({ id, onGo }: { id: string; onGo: (id: string) => void }) {
  useEffect(() => { onGo(id); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
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

/** What screen sharing can see here, said once (the first time the vault opens on this device); after that it stays out of the way. */
function ShieldOnce({ info }: { info: ShieldInfo }) {
  const [show, setShow] = useState(() => { try { return info.level !== 'blocked' && localStorage.getItem(SHIELD_SEEN_KEY) !== info.where; } catch { return false; } });
  useEffect(() => { if (show) { try { localStorage.setItem(SHIELD_SEEN_KEY, info.where); } catch { /* storage unavailable */ } } }, [show, info.where]);
  if (!show) return null;
  return (
    <div className="vlt-banner vlt-shield lib-shield" role="note" data-testid="shield-note">
      <Icon name="eye" size={16} />
      <span>{info.level === 'partial'
        ? 'On a Mac, most screenshots and shares show this window black, but some newer recording apps can still see it. Values are never shown here, and the vault hides itself when you switch windows.'
        : 'Screen sharing can see a browser tab. The vault never shows a value here and hides when you switch windows; the Windows and Android apps go fully black in shares.'}</span>
      <button className="btn-icon" aria-label="Dismiss" onClick={() => setShow(false)}><Icon name="close" size={14} /></button>
    </div>
  );
}
