import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, put, ApiError } from '../../api/client';
import { savedViewApi, type SavedView, type ViewSharing } from '../../api/platformApi';
import { CalmSheet } from '../../components/calm/CalmSheet';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { haptic } from '../../lib/mobile';
import { useAuth, useIsPersonal, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import type { PortfolioMode, PortfolioUrlState } from './portfolioShared';
import type { Tok } from './planSheetQuery';
import { deleteWithUndo } from '../../lib/undoDelete';

/** A view as the bar shows it: a built-in or a saved one (personal or shared). */
export interface PView { id: string; name: string; kind: 'builtin' | 'mine' | 'shared'; sharing?: ViewSharing; owner?: string; mode: PortfolioMode; toks: Tok[]; tg?: string | null; saved?: SavedView }

export const BUILTIN_VIEWS: PView[] = [
  { id: 'b:my-overdue', name: 'My overdue', kind: 'builtin', mode: 'sheet', toks: [{ kind: 'owner', value: 'me', label: 'Me' }, { kind: 'due', value: 'overdue', label: 'Overdue' }] },
  { id: 'b:week-owner', name: 'This week by owner', kind: 'builtin', mode: 'timeline', toks: [{ kind: 'due', value: 'this-week', label: 'This week' }], tg: 'owner' },
  { id: 'b:extended', name: 'Dates extended', kind: 'builtin', mode: 'sheet', toks: [{ kind: 'due', value: 'extended', label: 'Dates extended' }] },
];
const DEFAULT_PINS = BUILTIN_VIEWS.map((v) => v.id);
const key = (t: Tok[]) => JSON.stringify([...t].map((x) => `${x.kind}:${x.value}`).sort());

function fromSaved(v: SavedView): PView {
  const c = v.config as { tokens?: Tok[]; mode?: PortfolioMode; tg?: string | null };
  return { id: v.id, name: v.name, kind: v.mine ? 'mine' : 'shared', sharing: v.sharing, owner: v.ownerName, mode: c.mode ?? 'sheet', toks: c.tokens ?? [], tg: c.tg ?? null, saved: v };
}

/** My pinned views on Portfolio (saved with the account, /me/ui/portfolio-pins). The three built-ins are pinned until unpinned. */
function usePins() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['ui', 'portfolio-pins'], async () => { try { return (await get<{ value: { pins?: string[] } | null }>('/me/ui/portfolio-pins'))?.value?.pins ?? null; } catch { return null; } }, { staleTime: 300_000 });
  const pins = q.data ?? DEFAULT_PINS;
  const toggle = async (id: string) => {
    const next = pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id];
    try { await put('/me/ui/portfolio-pins', { value: { pins: next } }); void invalidateWorkspace(wid, 'ui', 'portfolio-pins'); }
    catch { toast('Could not pin that view.', 'error'); }
  };
  return { pins, toggle };
}

/**
 * Portfolio saved views (calm-round4a): the pinned ones as chips under the tabs, and "Views" opening a sheet with the built-ins (My overdue,
 * This week by owner, Dates extended), my views and views shared with me, each pinnable; "Save this view" names the current tab and filter
 * and says who sees it (only me, everyone, or a team).
 */
export function PortfolioViewsBar({ url }: { url: PortfolioUrlState }) {
  const [, setParams] = useSearchParams();
  const views = useWsQuery(['saved-views', 'portfolio'], () => savedViewApi.list('portfolio'), { staleTime: 60_000, retry: false });
  const all = useMemo(() => [...BUILTIN_VIEWS, ...(Array.isArray(views.data) ? views.data : []).filter((v) => v.config.list !== 'sheet' || v.config.tokens).map(fromSaved)], [views.data]);
  const { pins, toggle } = usePins();
  const [open, setOpen] = useState(false);
  const cur = key(url.toks);
  const activeId = all.find((v) => v.mode === url.mode && key(v.toks) === cur && v.toks.length > 0)?.id ?? null;
  const apply = (v: PView) => {
    haptic();
    if (activeId === v.id) { url.setToks([]); return; }
    url.setToks(v.toks);
    url.setMode(v.mode);
    setParams((p) => { const n = new URLSearchParams(p); if (v.tg) n.set('tg', v.tg); else n.delete('tg'); return n; }, { replace: true });
  };
  const pinned = all.filter((v) => pins.includes(v.id));
  return (
    <div className="pfv" role="toolbar" aria-label="Saved views" data-testid="portfolio-views">
      <div className="pfv-scroll">
        {pinned.map((v) => (
          <button key={v.id} type="button" className={`pfv-chip${activeId === v.id ? ' on' : ''}`} aria-pressed={activeId === v.id} onClick={() => apply(v)} data-view={v.id}
            title={v.kind === 'shared' ? `Shared by ${v.owner}` : v.kind === 'builtin' ? 'Built-in view' : v.sharing === 'private' ? 'Only you' : 'Shared'}>
            {v.kind !== 'builtin' && v.sharing && v.sharing !== 'private' && <Icon name="users" size={12} />}{v.name}
          </button>
        ))}
      </div>
      <button type="button" className="pfv-more" onClick={() => setOpen(true)} aria-haspopup="dialog"><Icon name="list" size={13} />Views</button>
      <CalmSheet open={open} onClose={() => setOpen(false)} title="Saved views" sub="Pin the ones you use; pinned views sit under the tabs." width={520}>
        <ViewsSheet all={all} pins={pins} toggle={toggle} activeId={activeId} apply={(v) => { apply(v); setOpen(false); }} url={url} />
      </CalmSheet>
    </div>
  );
}

function ViewsSheet({ all, pins, toggle, activeId, apply, url }: { all: PView[]; pins: string[]; toggle: (id: string) => Promise<void>; activeId: string | null; apply: (v: PView) => void; url: PortfolioUrlState }) {
  const wid = useWorkspaceId();
  const personal = useIsPersonal();
  const guest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const [params] = useSearchParams();
  const [name, setName] = useState('');
  const [sharing, setSharing] = useState<ViewSharing>('private');
  const [busy, setBusy] = useState(false);
  const groups: [string, PView[]][] = [['Built-in', all.filter((v) => v.kind === 'builtin')], ['My views', all.filter((v) => v.kind === 'mine')], ['Shared with me', all.filter((v) => v.kind === 'shared')]];
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const v = await savedViewApi.create({ scope: 'portfolio', name: name.trim(), sharing, config: { list: 'portfolio', mode: url.mode, tokens: url.toks, tg: params.get('tg') } });
      await put('/me/ui/portfolio-pins', { value: { pins: [...pins, v.id] } }).catch(() => undefined);
      void invalidateWorkspace(wid, 'saved-views'); void invalidateWorkspace(wid, 'ui', 'portfolio-pins');
      toast(`Saved and pinned “${v.name}”.`); setName('');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'The view could not be saved.', 'error'); }
    finally { setBusy(false); }
  };
  const remove = (v: PView) => {
    const s = v.saved!;
    void deleteWithUndo({ what: 'View', remove: () => savedViewApi.remove(s.id),
      restore: () => savedViewApi.create({ scope: 'portfolio', name: s.name, sharing: s.sharing, teamId: s.teamId, config: s.config }),
      onRemoved: () => void invalidateWorkspace(wid, 'saved-views'), onRestored: () => void invalidateWorkspace(wid, 'saved-views') });
  };
  return (
    <div className="pfv-sheet">
      {groups.filter(([, l]) => l.length > 0).map(([title, list]) => (
        <section key={title}>
          <h4>{title}</h4>
          <ul>
            {list.map((v) => (
              <li key={v.id}>
                <button type="button" className={`pfv-row${activeId === v.id ? ' on' : ''}`} onClick={() => apply(v)}>
                  <span className="pfv-row-t">{v.name}<small>{v.kind === 'builtin' ? 'Built-in' : v.kind === 'shared' ? `Shared by ${v.owner}` : v.sharing === 'private' ? 'Only you' : v.sharing === 'team' ? 'Shared with a team' : 'Shared with everyone'}</small></span>
                </button>
                <button type="button" className={`pfv-pin${pins.includes(v.id) ? ' on' : ''}`} aria-pressed={pins.includes(v.id)} aria-label={`${pins.includes(v.id) ? 'Unpin' : 'Pin'} ${v.name}`} onClick={() => void toggle(v.id)}>
                  <Icon name="pin" size={15} />
                </button>
                {v.kind === 'mine' && <button type="button" className="pfv-pin" aria-label={`Delete ${v.name}`} onClick={() => remove(v)}><Icon name="trash" size={15} /></button>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section>
        <h4>Save this view</h4>
        <form className="pfv-save" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, for example Lending late work" aria-label="View name" maxLength={60} />
          <div className="pfv-seg" role="radiogroup" aria-label="Who sees it">
            {([['private', 'Only me'], ...(!personal && !guest ? [['workspace', 'Everyone']] : [])] as [ViewSharing, string][]).map(([id, l]) => (
              <button key={id} type="button" role="radio" aria-checked={sharing === id} className={sharing === id ? 'on' : ''} onClick={() => setSharing(id)}>{l}</button>
            ))}
          </div>
          <button type="submit" className="pfv-go" disabled={busy || !name.trim()}>Save and pin</button>
        </form>
      </section>
    </div>
  );
}
