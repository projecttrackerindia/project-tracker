import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, Modal, PageHead, PageLoader } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { HEALTH_LABEL, KIND_ICON, KIND_LABEL, vaultApi, type VaultCollection, type VaultHealthFlag, type VaultItem, type VaultItemKind, type VaultItemSummary } from './api';
import { AdminView, HealthView } from './VaultAdmin';
import { CollectionEditor, Generator, ImportModal, ItemEditor, ShareEditor } from './VaultEditors';
import { VaultItemPanel } from './VaultItemPanel';
import { StepUpProvider } from './stepUp';
import { useStepUp } from './stepUpContext';
import './vault.css';

type View = 'items' | 'health' | 'bin' | 'admin';
const IDLE_MS = 5 * 60_000;
const COLLECTION_ICON: Record<VaultCollection['kind'], IconName> = { Personal: 'user', Shared: 'users', Project: 'folder', Team: 'users' };

/**
 * The password vault. Collections on the left (my own vault first), items in the middle, the open item on the right; on a phone one at a
 * time. After five idle minutes it locks itself: revealed values go and the two-step check is forgotten.
 */
export function VaultPage() {
  const overview = useWsQuery(['vault', 'overview'], vaultApi.overview, { staleTime: 30_000 });
  if (overview.isLoading) return <PageLoader />;
  if (overview.error || !overview.data) return <div className="page"><ErrorState error={overview.error} retry={() => overview.refetch()} /></div>;
  return <StepUpProvider mfaEnabled={overview.data.mfaEnabled}><Vault /></StepUpProvider>;
}

function Vault() {
  const wid = useWorkspaceId();
  const meId = useAuth((s) => s.ctx?.user.id ?? null);
  const overview = useWsQuery(['vault', 'overview'], vaultApi.overview, { staleTime: 30_000 });
  const o = overview.data!;
  const step = useStepUp();
  const [params, setParams] = useSearchParams();
  const view = ((): View => { const v = params.get('view') ?? (params.get('tab') === 'access' ? 'admin' : null); return v === 'health' || v === 'bin' || (v === 'admin' && o.canAdmin) ? v : 'items'; })();
  const collectionId = params.get('c');
  const itemId = params.get('item');
  const health = params.get('health') as VaultHealthFlag | 'any' | null;
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);
  const [kind, setKind] = useState<VaultItemKind | ''>('');
  const [lockEpoch, setLockEpoch] = useState(0);
  const [editing, setEditing] = useState<VaultItem | 'new' | null>(null);
  const [collectionEdit, setCollectionEdit] = useState<VaultCollection | 'new' | null>(null);
  const [sharing, setSharing] = useState<VaultCollection | null>(null);
  const [importing, setImporting] = useState(false);
  const [generator, setGenerator] = useState(false);

  const set = useCallback((patch: Record<string, string | null>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) { if (v === null) n.delete(k); else n.set(k, v); }
      n.delete('tab');
      return n;
    }, { replace: false });
  }, [setParams]);

  // Locks itself when nobody has touched the page for a while.
  useEffect(() => {
    let t = window.setTimeout(lock, IDLE_MS);
    function lock() { step.forget(); setLockEpoch((e) => e + 1); }
    const bump = () => { window.clearTimeout(t); t = window.setTimeout(lock, IDLE_MS); };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    return () => { window.clearTimeout(t); evs.forEach((e) => window.removeEventListener(e, bump)); };
  }, [step]);

  const collection = o.collections.find((c) => c.id === collectionId) ?? null;
  const items = useWsQuery(['vault', 'items', view === 'bin' ? 'bin' : collectionId ?? 'all', q, kind, health],
    () => vaultApi.items({ collectionId: view === 'bin' ? null : collectionId, q, kind: kind || null, health, bin: view === 'bin' }),
    { enabled: view === 'items' || view === 'bin', staleTime: 15_000, placeholderData: (prev) => prev });

  const refresh = () => invalidateWorkspace(wid, 'vault');
  const personal = o.collections.find((c) => c.kind === 'Personal');
  const shared = o.collections.filter((c) => c.kind !== 'Personal');
  const list = items.data ?? [];
  const title = view === 'bin' ? 'Bin' : view === 'health' ? 'Health' : view === 'admin' ? 'Administration' : collection?.name ?? 'All items';

  const rail = (
    <nav className="vlt-rail" aria-label="Vault collections">
      <button className={view === 'items' && !collectionId ? 'on' : ''} onClick={() => set({ view: null, c: null, item: null, health: null })}><Icon name="grid" size={16} /><span>All items</span></button>
      {personal && <CollectionButton c={personal} active={view === 'items' && collectionId === personal.id} onClick={() => set({ view: null, c: personal.id, item: null, health: null })} />}
      {shared.length > 0 && <p className="vlt-rail-title">Shared</p>}
      {shared.map((c) => <CollectionButton key={c.id} c={c} active={view === 'items' && collectionId === c.id} onClick={() => set({ view: null, c: c.id, item: null, health: null })} />)}
      {o.canCreateShared && <button className="vlt-rail-add" onClick={() => setCollectionEdit('new')}><Icon name="plus" size={15} /><span>New collection</span></button>}
      <p className="vlt-rail-title">Tools</p>
      <button className={view === 'health' ? 'on' : ''} onClick={() => set({ view: 'health', item: null })}><Icon name="gauge" size={16} /><span>Health</span>{o.health.score < 100 && o.health.total > 0 && <em className={o.health.score < 60 ? 'bad' : ''}>{o.health.score}</em>}</button>
      <button className={view === 'bin' ? 'on' : ''} onClick={() => set({ view: 'bin', c: null, item: null, health: null })}><Icon name="trash" size={16} /><span>Bin</span></button>
      {o.canAdmin && <button className={view === 'admin' ? 'on' : ''} onClick={() => set({ view: 'admin', item: null })}><Icon name="shield" size={16} /><span>Administration</span></button>}
    </nav>
  );

  return (
    <div className={`page vlt vlt-scope${itemId ? ' has-item' : ''}`}>
      <PageHead title="Vault" sub="Passwords, keys and secrets: encrypted, shared on purpose, every use recorded.">
        <button className="btn btn-ghost" onClick={() => setGenerator(true)}><Icon name="sparkle" size={15} /> Generator</button>
        <button className="btn btn-ghost" onClick={() => setImporting(true)}><Icon name="upload" size={15} /> Import</button>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} /> New item</button>
      </PageHead>
      {!o.mfaEnabled && (
        <div className="vlt-banner" role="note"><Icon name="shield" size={16} /><span>Turn on two-step verification to open confidential items and earlier values.</span><Link className="btn btn-ghost btn-xs" to="/account/security">Set it up</Link></div>
      )}
      <div className="vlt-layout">
        {rail}
        <main className="vlt-main" aria-label={title}>
          {view === 'health' ? <HealthView health={o.health} onFilter={(f) => set({ view: null, c: null, health: f })} />
            : view === 'admin' ? <AdminView policy={o.policy} onPolicy={refresh} />
            : (
              <>
                <div className="vlt-list-head">
                  <div className="vlt-list-title">
                    <h2>{title}</h2>
                    {collection && collection.kind !== 'Personal' && <span className="muted">{collection.kind === 'Project' ? `Project ${collection.projectName ?? ''}` : collection.kind === 'Team' ? `Team ${collection.teamName ?? ''}` : 'Shared'} · your access: {collection.myAccess === 'UseOnly' ? 'use only' : collection.myAccess.toLowerCase()}</span>}
                    {collection?.kind === 'Personal' && <span className="muted">Only you can open this, not even an administrator.</span>}
                  </div>
                  {collection && collection.myAccess === 'Manage' && collection.kind !== 'Personal' && (
                    <div className="vlt-list-actions">
                      <button className="btn btn-ghost btn-sm" onClick={async () => { try { setSharing(await vaultApi.collection(collection.id)); } catch { toast('Could not open the access list.', 'error'); } }}><Icon name="users" size={14} /> Access</button>
                      <button className="btn-icon" aria-label="Collection settings" onClick={() => setCollectionEdit(collection)}><Icon name="settings" size={15} /></button>
                    </div>
                  )}
                </div>
                {view === 'items' && (
                  <div className="vlt-filters">
                    <label className="vlt-search"><Icon name="search" size={15} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search names, addresses, tags" aria-label="Search the vault" /></label>
                    <select className="input" value={kind} onChange={(e) => setKind(e.target.value as VaultItemKind | '')} aria-label="Kind">
                      <option value="">All kinds</option>{(Object.keys(KIND_LABEL) as VaultItemKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                    </select>
                    {health && <button className="chip vlt-chip-on" onClick={() => set({ health: null })}>{health === 'any' ? 'At risk' : HEALTH_LABEL[health]} <Icon name="close" size={12} /></button>}
                  </div>
                )}
                {items.isLoading ? <PageLoader /> : items.error ? <ErrorState error={items.error} retry={() => items.refetch()} /> : list.length === 0 ? (
                  view === 'bin' ? <EmptyState icon="trash" title="The bin is empty" text="Deleted items wait here for 30 days, then they are destroyed." />
                    : q || kind || health ? <EmptyState icon="search" title="Nothing matches" />
                    : <EmptyState icon="lock" title={collection?.kind === 'Personal' ? 'Your vault is empty' : 'No items yet'} text="Save a password, an API key, a server or a secure note. Or import from another password manager."
                        action={<button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} /> New item</button>} />
                ) : (
                  <ul className="vlt-items" aria-label="Items">
                    {list.map((it) => <ItemRow key={it.id} it={it} showCollection={!collectionId} active={it.id === itemId} onOpen={() => set({ item: it.id })} />)}
                  </ul>
                )}
              </>
            )}
        </main>
        {itemId && (view === 'items' || view === 'bin') && (
          <VaultItemPanel id={itemId} policy={o.policy} lockEpoch={lockEpoch} binned={view === 'bin'} onEdit={(d) => setEditing(d)} onClose={() => set({ item: null })} onChanged={refresh} />
        )}
      </div>

      {editing && <ItemEditor existing={editing === 'new' ? null : editing} collections={o.collections} defaultCollection={collectionId ?? personal?.id ?? null} clipboardSeconds={o.policy.clipboardSeconds}
        onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); void refresh(); set({ item: id, view: null }); }} />}
      {collectionEdit && <CollectionEditor existing={collectionEdit === 'new' ? null : collectionEdit} onClose={() => setCollectionEdit(null)}
        onSaved={(id) => { const wasNew = collectionEdit === 'new'; setCollectionEdit(null); void refresh(); set({ c: id, item: null, view: null }); if (wasNew && id) void vaultApi.collection(id).then(setSharing).catch(() => undefined); }} />}
      {sharing && <ShareEditor collection={sharing} meId={meId} onClose={() => setSharing(null)} onSaved={() => { setSharing(null); void refresh(); }} />}
      {importing && <ImportModal collections={o.collections} defaultCollection={collectionId ?? personal?.id ?? null} onClose={() => setImporting(false)} onDone={(c) => { setImporting(false); void refresh(); set({ c, view: null, item: null }); }} />}
      {generator && (
        <Modal title="Password generator" onClose={() => setGenerator(false)} size="sm" className="vlt-scope">
          <Generator clipboardSeconds={o.policy.clipboardSeconds} />
        </Modal>
      )}
    </div>
  );
}

function CollectionButton({ c, active, onClick }: { c: VaultCollection; active: boolean; onClick: () => void }) {
  return (
    <button className={active ? 'on' : ''} onClick={onClick} data-collection={c.name} title={c.description ?? undefined}>
      <Icon name={COLLECTION_ICON[c.kind]} size={16} />
      <span>{c.name}</span>
      {c.requireStepUp && <Icon name="shield" size={12} />}
      {c.atRisk > 0 ? <em className="bad" title={`${c.atRisk} at risk`}>{c.atRisk}</em> : <i>{c.items}</i>}
    </button>
  );
}

function ItemRow({ it, showCollection, active, onOpen }: { it: VaultItemSummary; showCollection: boolean; active: boolean; onOpen: () => void }) {
  const flags = useMemo(() => it.health.map((h) => HEALTH_LABEL[h]).join(', '), [it.health]);
  return (
    <li>
      <button className={`vlt-item${active ? ' on' : ''}`} onClick={onOpen} data-item={it.title} aria-current={active || undefined}>
        <span className={`vlt-kind-icon kind-${it.kind.toLowerCase()}`} aria-hidden="true"><Icon name={KIND_ICON[it.kind]} size={16} /></span>
        <span className="vlt-item-main">
          <b>{it.title}</b>
          <span className="muted">{[it.usernameHint, showCollection ? it.collectionName : null, it.url?.replace(/^https?:\/\//, '').split('/')[0]].filter(Boolean).join(' · ') || KIND_LABEL[it.kind]}</span>
        </span>
        <span className="vlt-item-tags">
          {it.class === 'Confidential' && <Icon name="shield" size={13} />}
          {it.useOnly && <span className="badge badge-info">Use only</span>}
          {it.hasTotp && <Icon name="timer" size={13} />}
          {it.health.length > 0 && <span className={`vlt-risk ${it.health.includes('breached') || it.health.includes('rotate') ? 'bad' : ''}`} title={flags} aria-label={flags} />}
          {it.lastUsedAt && <span className="muted vlt-used">{timeAgo(it.lastUsedAt)}</span>}
        </span>
      </button>
    </li>
  );
}
