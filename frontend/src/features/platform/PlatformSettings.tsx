import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { dataLocationApi, holidayApi, statusPageApi, type StatusComponentConfig } from '../../api/platformApi';
import { Icon } from '../../components/Icon';
import { ErrorState, PageLoader } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { SGroup, SPaneHead, SRow, SSwitch, STile } from '../settings/Grouped';
import './platform.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

// ------------------------------------------------------------------ Security › Data location

/**
 * Settings › Security › Data location: the region the workspace's data and backups are kept in (only the region - never servers), the
 * outside services that would process data elsewhere, and "Keep data in India", which stops those from being turned on.
 */
export function DataLocationSection() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['data-location'], dataLocationApi.get, { staleTime: 60_000 });
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const outsideInUse = d.providers.filter((p) => !p.inIndia && p.inUse);

  const set = async (on: boolean) => {
    if (on && outsideInUse.length > 0 && !(await confirmDialog({ title: 'Keep data in India?',
      message: `${outsideInUse.map((p) => p.name).join(' and ')} ${outsideInUse.length === 1 ? 'is' : 'are'} in use and ${outsideInUse.length === 1 ? 'works' : 'work'} outside India. ${outsideInUse.length === 1 ? 'It keeps' : 'They keep'} working until you turn ${outsideInUse.length === 1 ? 'it' : 'them'} off; nothing new outside India can be turned on.`,
      confirmText: 'Keep data in India' }))) return;
    setBusy(true);
    try { await dataLocationApi.set(on); toast(on ? 'Data stays in India from now on.' : 'Services outside India can be turned on again.'); void invalidateWorkspace(wid, 'data-location'); }
    catch (e) { toast(errText(e, 'Could not change the setting.'), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="pv-pane" data-setting="security.dataLocation">
      <SPaneHead icon="⌖" color="#34c759" title="Data location" sub="Where this workspace’s data and backups are kept, and where it may go." />
      <SGroup label="Where your data lives">
        <div className="pv-region">
          <span className="pv-region-map" aria-hidden="true"><Icon name="pin" size={26} /></span>
          <div><b>{d.regionName}</b><span>Projects, work, documents, files and messages are stored in {d.country}. Encrypted at rest and in transit.</span></div>
        </div>
        <SRow icon={<STile color="#0a84ff">⟲</STile>} title="Backups" sub="Daily, encrypted, kept in the same country">{d.backupRegionName}</SRow>
        <SRow icon={<STile color="#8e8e93">◎</STile>} title="Region code" sub="For your compliance records">{d.region}</SRow>
      </SGroup>

      <SGroup label="Keep data in India">
        <SRow icon={<STile color="#ff9500">IN</STile>} title="Keep data in India"
          sub={d.keepDataInIndia ? 'On: integrations and AI providers that work outside India can’t be turned on.' : 'Off: admins may turn on services that process data outside India.'}>
          <SSwitch on={d.keepDataInIndia} label="Keep data in India" disabled={busy || !d.canManage} onChange={(v) => void set(v)} />
        </SRow>
      </SGroup>

      <SGroup label="Services that would process data">
        {d.providers.map((p) => (
          <SRow key={p.key} title={p.name} sub={p.location}>
            {p.inUse && <span className="pv-pill mute">In use</span>}
            <span className={`pv-pill ${p.inIndia ? 'ok' : 'warn'}`}>{p.inIndia ? 'In India' : 'Outside India'}</span>
          </SRow>
        ))}
      </SGroup>
      {outsideInUse.length > 0 && d.keepDataInIndia && (
        <p className="pv-note" role="note">{outsideInUse.map((p) => p.name).join(' and ')} {outsideInUse.length === 1 ? 'was' : 'were'} turned on before. {outsideInUse.length === 1 ? 'It keeps' : 'They keep'} working until an admin turns {outsideInUse.length === 1 ? 'it' : 'them'} off in <Link className="link" to="/settings/ai">AI</Link> or <Link className="link" to="/settings/integrations">Integrations</Link>.</p>
      )}
      {!d.canManage && <p className="pv-note">Only owners and admins can change this.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ General › Holidays

/** Settings › General › Holidays: the workspace's public holidays (days off for everyone in Capacity), with the India list for a year in one tap. */
export function HolidaysSection() {
  const wid = useWorkspaceId();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const q = useWsQuery(['holidays', year], () => holidayApi.list(year), { staleTime: 60_000 });
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDate(''); }, [year]);

  const refresh = () => { void invalidateWorkspace(wid, 'holidays'); void invalidateWorkspace(wid, 'portfolio'); void invalidateWorkspace(wid, 'capacity-plan'); };
  const add = async () => {
    if (!date || !name.trim()) { toast('Pick a date and name the holiday.', 'warning'); return; }
    setBusy(true);
    try { await holidayApi.add({ date, name: name.trim(), region: region.trim() || null }); setName(''); setRegion(''); setDate(''); toast('Holiday added.'); refresh(); }
    catch (e) { toast(errText(e, 'Could not add the holiday.'), 'error'); }
    finally { setBusy(false); }
  };
  const preset = async () => {
    setBusy(true);
    try { const r = await holidayApi.preset(year); toast(r.added ? `Added ${r.added} holidays for ${year}.` : `India’s ${year} holidays are already on the list.`); refresh(); }
    catch (e) { toast(errText(e, 'Could not add the list.'), 'error'); }
    finally { setBusy(false); }
  };
  const remove = async (id: string, label: string) => {
    try { await holidayApi.remove(id); toast(`${label} removed.`); refresh(); }
    catch (e) { toast(errText(e, 'Could not remove it.'), 'error'); }
  };

  return (
    <div className="pv-pane" data-setting="workspace.holidays">
      <SPaneHead icon="☀" color="#ff9500" title="Holidays" sub="Public holidays are days off for everyone: Capacity counts them, and no work is planned on them." />
      <div className="pv-sec-head" style={{ marginTop: 18 }}>
        <div className="pv-seg" role="tablist" aria-label="Year">
          {[thisYear - 1, thisYear, thisYear + 1].map((y) => <button key={y} type="button" role="tab" aria-selected={year === y} onClick={() => setYear(y)}>{y}</button>)}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void preset()}>Add India’s {year} holidays</button>
      </div>
      <SGroup label={`${year} · ${q.data?.length ?? 0} ${q.data?.length === 1 ? 'holiday' : 'holidays'}`}>
        {q.isLoading ? <SRow title="Loading…" /> : q.isError ? <SRow title="Could not load the list." /> : (q.data ?? []).length === 0 ? (
          <SRow title="No holidays yet" sub={`Add India’s ${year} list, or your own days below.`} />
        ) : q.data!.map((h) => (
          <SRow key={h.id} icon={<span className="pv-hol-date">{formatDate(h.date)}</span>} title={h.name} sub={h.region ?? undefined}>
            <button type="button" className="btn-icon danger" aria-label={`Remove ${h.name}`} onClick={() => void remove(h.id, h.name)}><Icon name="trash" size={14} /></button>
          </SRow>
        ))}
        <form className="pv-row-input" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input className="input" type="date" aria-label="Holiday date" value={date} min={`${year}-01-01`} max={`${year}-12-31`} onChange={(e) => setDate(e.target.value)} />
          <input className="input" aria-label="Holiday name" placeholder="Name, e.g. Ugadi" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" aria-label="Where it is observed" placeholder="State (optional)" maxLength={60} value={region} onChange={(e) => setRegion(e.target.value)} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}><Icon name="plus" size={14} />Add</button>
        </form>
      </SGroup>
      <p className="pv-note">The India list follows the central government’s holidays; festival dates move each year. Add your state’s days (Ugadi, Bonalu, Pongal…) as your own.</p>
    </div>
  );
}

// ------------------------------------------------------------------ Integrations › Status page

/**
 * Settings › Integrations › Status page: a public page at /status/{address} with the documented APIs chosen here, their state, 90 days of
 * history and recent incidents. Off until published; nothing about servers or people is ever shown.
 */
export function StatusPageSection() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['status-page'], statusPageApi.get, { staleTime: 30_000 });
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [chosen, setChosen] = useState<StatusComponentConfig[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) { setSlug(q.data.slug); setTitle(q.data.title); setChosen(q.data.components); } }, [q.data]);
  const available = useMemo(() => q.data?.available ?? [], [q.data]);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const s = q.data;
  const isOn = (id: string) => chosen.some((c) => c.apiId === id);
  const toggle = (id: string, name: string) => setChosen((c) => (c.some((x) => x.apiId === id) ? c.filter((x) => x.apiId !== id) : [...c, { apiId: id, name }]));
  const rename = (id: string, name: string) => setChosen((c) => c.map((x) => (x.apiId === id ? { ...x, name } : x)));
  const save = async (published: boolean) => {
    setBusy(true);
    try {
      await statusPageApi.save({ slug: slug.trim().toLowerCase(), title: title.trim(), published, components: chosen });
      toast(published ? (s.published ? 'Status page updated.' : 'Status page published.') : s.published ? 'Status page taken offline.' : 'Saved. Publish when you are ready.');
      void invalidateWorkspace(wid, 'status-page');
    } catch (e) { toast(errText(e, 'Could not save the status page.'), 'error'); }
    finally { setBusy(false); }
  };
  const url = `${window.location.origin}/status/${slug || s.slug}`;

  return (
    <div className="pv-pane" data-setting="integrations.statusPage">
      <SPaneHead icon="◉" color="#30b0c7" title="Status page" sub="A public page showing whether your APIs are up, with 90 days of history. Customers need no account." />
      <SGroup label="Page">
        <SRow icon={<STile color={s.published ? '#34c759' : '#8e8e93'}>●</STile>} title={s.published ? 'Published' : 'Not published'}
          sub={s.published ? <a className="link" href={url} target="_blank" rel="noreferrer">{url.replace(/^https?:\/\//, '')}</a> : 'Only you can see these settings until you publish.'}>
          {s.published && <a className="btn btn-ghost btn-sm" href={url} target="_blank" rel="noreferrer">Open</a>}
        </SRow>
        <div className="pv-row-input" style={{ gridTemplateColumns: '120px minmax(0, 1fr)' }}>
          <label htmlFor="sp-title" className="muted" style={{ fontSize: 13 }}>Title</label>
          <input id="sp-title" className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="pv-row-input" style={{ gridTemplateColumns: '120px minmax(0, 1fr)' }}>
          <label htmlFor="sp-slug" className="muted" style={{ fontSize: 13 }}>Address</label>
          <input id="sp-slug" className="input" value={slug} maxLength={60} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} aria-describedby="sp-slug-hint" />
        </div>
      </SGroup>
      <p className="pv-note" id="sp-slug-hint">/status/{slug || '…'} · lowercase letters, numbers and dashes.</p>

      <SGroup label={`Components · ${chosen.length} shown`}>
        {available.length === 0 ? (
          <SRow title="No documented APIs yet" sub="Document an API in Library › Docs; it can then be shown here." />
        ) : available.map((a) => {
          const c = chosen.find((x) => x.apiId === a.apiId);
          return (
            <SRow key={a.apiId} title={c ? <input className="input pv-comp-name" aria-label={`Name shown for ${a.name}`} value={c.name} maxLength={80} onChange={(e) => rename(a.apiId, e.target.value)} /> : a.name}
              sub={`From “${a.documentTitle}”`}>
              <SSwitch on={isOn(a.apiId)} label={`Show ${a.name}`} onChange={() => toggle(a.apiId, a.name)} />
            </SRow>
          );
        })}
      </SGroup>
      <p className="pv-note">State and the 90-day bars come from critical and high-priority tickets about each API. Incident titles are shown with links, addresses, hosts and keys removed; servers, paths and people never appear.</p>

      <div className="pv-sec-head" style={{ marginTop: 16, justifyContent: 'flex-end', gap: 8 }}>
        {s.published && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save(false)}>Take offline</button>}
        {!s.published && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save(false)}>Save</button>}
        <button type="button" className="btn btn-primary" disabled={busy || chosen.length === 0} onClick={() => void save(true)}>{s.published ? 'Save and keep published' : 'Publish'}</button>
      </div>
    </div>
  );
}
