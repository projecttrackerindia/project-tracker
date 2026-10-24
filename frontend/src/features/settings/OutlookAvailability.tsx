import { continueConnectionInBrowser } from '../../lib/personalConnection';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { microsoftApi, microsoftCalendarApi } from '../../api/endpoints.platform';
import type { MicrosoftCalendarAvailability, MicrosoftCalendarInventory } from '../../api/types';
import { Icon } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog } from '../../stores/ui';
import './OutlookAvailability.css';
export function OutlookAvailability() {
  const wid = useWorkspaceId();
  const userId = useAuth(s => s.ctx?.user.id);
  const status = useWsQuery(['account', 'microsoft-status'], microsoftApi.status);
  const zone = useAuth(s => s.ctx?.user.timeZone) || 'UTC';
  const [inventory, setInventory] = useState<MicrosoftCalendarInventory | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [window, setWindow] = useState({ start: '', end: '' });
  const [result, setResult] = useState<MicrosoftCalendarAvailability | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort(); setInventory(null); setSelected([]); setWindow({ start: '', end: '' }); setResult(null); setError(''); setBusy(false);
    return () => request.current?.abort();
  }, [wid, userId, status.data?.email, status.data?.connectedAt, status.data?.calendarsEnabled, status.data?.calendarAccess]);
  const failure = (e: unknown) => e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Outlook availability could not be checked. Try again.';
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setBusy(true); setError(''); setResult(null);
    try { await action(controller.signal); } catch (e) {
      if (!controller.signal.aborted) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403 || ['MICROSOFT_CALENDAR_CONNECTION_CHANGED', 'MICROSOFT_CONNECTION_CHANGED', 'MICROSOFT_SCOPE_REQUIRED', 'MICROSOFT_NOT_CONNECTED', 'MICROSOFT_DISABLED', 'MICROSOFT_CALENDARS_DISABLED'].includes(e.code))) {
          setInventory(null); setSelected([]); setWindow({ start: '', end: '' });
        }
        setError(failure(e));
      }
    }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const load = () => run(async signal => {
    setInventory(null); setSelected([]); const value = await microsoftCalendarApi.list(signal);
    if (!signal.aborted) { setInventory(value); setSelected(value.calendars.filter(c => c.isDefault).slice(0, 1).map(c => c.id)); }
  });
  const allow = async () => {
    if (continueConnectionInBrowser()) return;
    if (!await confirmDialog({ title: 'Allow basic calendar reading?', message: 'Microsoft will ask for Calendars.ReadBasic in addition to your existing profile and email permissions. Project Tracker checks only selected calendars owned by your connected account when you request it. It does not read event notes, create events, invite attendees or share availability with AI.', confirmText: 'Continue to consent' })) return;
    await run(async signal => { const { url } = await microsoftApi.connect(false, true); if (!signal.aborted) globalThis.location.assign(url); });
  };
  const check = () => run(async signal => {
    if (!inventory) return; const start = new Date(window.start), end = new Date(window.end);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || end.getTime() - start.getTime() > 86400000) { setError('Choose a time window of up to 24 hours.'); return; }
    const value = await microsoftCalendarApi.availability({ calendarIds: selected, accessContext: inventory.accessContext, start: start.toISOString(), end: end.toISOString() }, signal);
    if (!signal.aborted) setResult(value);
  });
  const date = (value: string) => new Date(value).toLocaleString(undefined, { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' });
  return <section className="outlook-availability" aria-labelledby="outlook-availability-title">
    <header><span className="outlook-calendar-symbol" aria-hidden="true"><Icon name="calendar" size={21} /></span><div><h3 id="outlook-availability-title">Outlook availability</h3><p>Check your calendars before choosing a time.</p></div><span className="outlook-privacy"><Icon name="lock" size={13} /> Only you</span></header>
    <p className="muted">Checks are read only and use no AI credits. Event titles and notes stay in Outlook.</p>
    {status.isError ? <p role="alert">Microsoft connection status could not be loaded.</p> : !status.data?.calendarsEnabled ? <p className="outlook-status">Awaiting administrator setup</p> : !status.data.calendarAccess ? <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void allow()}>Allow basic calendar reading</button> : <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void load()}>{busy ? 'Checking calendars...' : 'Load my Outlook calendars'}</button>}
    {error && <p role="alert" className="outlook-error">{error}</p>}
    {inventory && <div className="outlook-planning-grid"><fieldset><legend>Choose up to five calendars</legend><p className="muted">{inventory.account}</p>{inventory.calendars.map(c => <label key={c.id}><input type="checkbox" checked={selected.includes(c.id)} disabled={busy || selected.length >= 5 && !selected.includes(c.id)} onChange={e => { setSelected(e.target.checked ? [...selected, c.id] : selected.filter(id => id !== c.id)); setResult(null); }} /><span>{c.name}{c.isDefault && <small>Primary</small>}</span></label>)}{!inventory.calendars.length && <p>No eligible own calendars were returned.</p>}{inventory.truncated && <p>Only the first calendar page is available. Review other calendars in Outlook.</p>}</fieldset><div><p className="muted">Enter times in your browser time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p><label className="outlook-time">Window start<input className="input" aria-label="Outlook window start" type="datetime-local" disabled={busy} value={window.start} onChange={e => { setWindow({ ...window, start: e.target.value }); setResult(null); }} /></label><label className="outlook-time">Window end<input className="input" aria-label="Outlook window end" type="datetime-local" disabled={busy} value={window.end} onChange={e => { setWindow({ ...window, end: e.target.value }); setResult(null); }} /></label><button className="btn" disabled={busy || !selected.length || !window.start || !window.end} onClick={() => void check()}>Check selected calendars</button></div></div>}
    {result && <div className="outlook-result" role="status"><strong>{result.busy.length ? 'Busy periods in this window' : 'No busy periods returned for this window'}</strong><p>{date(result.startUtc)} to {date(result.endUtc)} ({zone})</p>{result.busy.length > 0 && <ul>{result.busy.map(b => <li key={b.startUtc}>{date(b.startUtc)} to {date(b.endUtc)}</li>)}</ul>}<p>{result.scope}</p><small>Checked {date(result.checkedAt)}. This does not reserve a time.</small></div>}
  </section>;
}
