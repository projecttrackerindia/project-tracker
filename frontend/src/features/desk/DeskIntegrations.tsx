import { Select } from '../../components/Select';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { deskAiApi, isObj, type DeskEngineer, type DeskSettings, type EngineerStatus, type SaveDeskSettings } from '../../api/deskAiApi';
import { workApi, workspaceApi } from '../../api/endpoints';
import { ToolbarSeg } from '../../components/v2/ToolbarSeg';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { fromTime, toTime } from './deskAiLogic';
import './desk-page.css';
import './desk-ai.css';
import './calm-desk.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const LANGS: [string, string][] = [['en', 'English'], ['hi', 'Hindi'], ['te', 'Telugu'], ['ta', 'Tamil'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['mr', 'Marathi'], ['bn', 'Bengali'], ['gu', 'Gujarati']];

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <label className="dix-sw"><input type="checkbox" role="switch" aria-label={label} checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span /></label>;
}

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <div className="dix-row"><div>{title}{hint && <small>{hint}</small>}</div>{children}</div>;
}

const draftOf = (s: DeskSettings): SaveDeskSettings => ({
  intakeEnabled: s.intakeEnabled, autoAcknowledge: s.autoAcknowledge, autoCreateTicket: s.autoCreateTicket, ackMessage: s.ackMessage, routingEnabled: s.routingEnabled,
  confidenceThreshold: s.confidenceThreshold, acceptMinutes: s.acceptMinutes, maxReassignments: s.maxReassignments, supervisorId: s.supervisor?.id ?? null, notifyOnWhatsApp: s.notifyOnWhatsApp,
  voiceEnabled: s.voiceEnabled, sarvamApiKey: null, voiceLanguages: s.voiceLanguages, consentPrompt: s.consentPrompt, recordCalls: s.recordCalls, retentionDays: s.retentionDays,
  telephonyProvider: s.telephonyProvider, telephonyKey: null,
});

/** Desk › Integrations: WhatsApp intake, AI routing, engineers, Sarvam voice, recording and consent, telephony, SLA policies and the inbound queue. */
export function DeskIntegrations() {
  const qc = useQueryClient();
  const wid = useWorkspaceId();
  const q = useWsQuery(['desk', 'ai-settings'], () => deskAiApi.settings(), { retry: false });
  const members = useWsQuery(['desk', 'members'], () => workspaceApi.members(), { staleTime: 5 * 60_000 });
  const sla = useWsQuery(['desk', 'sla'], () => workApi.sla(), { staleTime: 5 * 60_000, retry: false });
  const settings = isObj<DeskSettings>(q.data) ? q.data : null;
  const [d, setD] = useState<SaveDeskSettings | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (settings && !d) setD(draftOf(settings)); }, [settings, d]);
  const can = settings?.canManage ?? false;
  const queue = useWsQuery(['desk', 'queue'], () => deskAiApi.queue(), { enabled: can, refetchInterval: 30_000, retry: false });
  const set = <K extends keyof SaveDeskSettings>(k: K, v: SaveDeskSettings[K]) => setD((x) => (x ? { ...x, [k]: v } : x));

  const save = async (extra?: Partial<SaveDeskSettings>) => {
    if (!d) return;
    setBusy(true);
    try {
      const next = await deskAiApi.saveSettings({ ...d, ...extra });
      qc.setQueryData([wid, 'desk', 'ai-settings'], next);
      setD(draftOf(next)); setKey('');
      toast('Desk integrations saved.');
    } catch (e) { toast(errText(e, 'Could not save.'), 'error'); }
    finally { setBusy(false); }
  };

  if (q.isLoading || (settings && !d)) return <div className="dq-page dix"><p className="dq-faint">Loading…</p></div>;
  if (!settings || !d) return <div className="dq-page dix"><h1 className="dq-h1">Integrations</h1><p className="dq-faint">The Desk integrations are not available on this server yet.</p></div>;
  const targets = isObj<{ defaults: { priority: string; responseMinutes: number | null; resolutionMinutes: number | null }[] }>(sla.data) ? sla.data.defaults : [];
  const fmtMin = (m: number | null) => (m == null ? '—' : m >= 1440 && m % 1440 === 0 ? `${m / 1440}d` : m >= 60 ? `${Math.round(m / 6) / 10}h` : `${m}m`);
  const qd = isObj<{ pending: number; done: number; dead: number; recent: { id: string; status: string; messageType: string; attempts: number; createdAt: string; lastError: string | null }[] }>(queue.data) ? queue.data : null;

  return (
    <div className="dq-page dix cdix" data-testid="desk-integrations">
      <ToolbarSeg className="dq-tb"><Link className="dai-link" to="/desk">‹ Desk</Link>
        {can && (
          <div className="dix-bar">
            <button type="button" className="dq-btn sm" disabled={busy} onClick={() => { setD(draftOf(settings)); setKey(''); }}>Revert</button>
            <button type="button" className="dq-btn sm pri" disabled={busy} onClick={() => void save(key.trim() ? { sarvamApiKey: key.trim() } : undefined)}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        )}
      </ToolbarSeg>
      <div className="dq-hd">
        <div>
          <div className="cdix-crumb">Desk › Integrations</div>
          <h1 className="cdix-title">Integrations.<em>{(() => { const n = [settings.intakeEnabled, settings.routingEnabled, settings.voiceEnabled].filter(Boolean).length; return n ? `${n} of 3 switched on.` : 'Everything is off.'; })()}</em></h1>
          <div className="dq-eyebrow cdix-hide">{[settings.intakeEnabled && 'WhatsApp intake on', settings.routingEnabled && 'AI routing on', settings.voiceEnabled && 'Voice on'].filter(Boolean).join(' · ') || 'Everything is off until you turn it on'}</div>
        </div>
        {!can && <span className="dix-badge">View only · ask an admin to change these</span>}
      </div>

      <div className="dix-grid">
        <section className="dq-card dix-sec" aria-labelledby="dix-wa">
          <div className="dix-sec-h"><span className="dix-ic" style={{ background: '#25d366' }}>✆</span><div><h2 id="dix-wa">WhatsApp Business</h2><p>Cloud API · one-to-one business conversations</p></div>
            <span className={`dix-badge${settings.whatsAppNumbers ? ' on' : ' warn'}`}>{settings.whatsAppNumbers ? `${settings.whatsAppNumbers} number${settings.whatsAppNumbers > 1 ? 's' : ''} connected` : 'No number connected'}</span></div>
          <Row title="Create tickets from WhatsApp" hint="Signed messages are queued once (by message id), then turned into tickets with the whole chat."><Switch label="WhatsApp intake" on={d.intakeEnabled} disabled={!can} onChange={(v) => set('intakeEnabled', v)} /></Row>
          <Row title="Acknowledge every request" hint="Within WhatsApp's 24-hour window; {ticket} becomes the ticket key."><Switch label="Auto-acknowledge" on={d.autoAcknowledge} disabled={!can} onChange={(v) => set('autoAcknowledge', v)} /></Row>
          <Row title="Raise the ticket automatically" hint="Off: people raise it from the chat."><Switch label="Auto-create tickets" on={d.autoCreateTicket} disabled={!can} onChange={(v) => set('autoCreateTicket', v)} /></Row>
          <textarea className="dix-area" aria-label="Acknowledgement message" maxLength={500} disabled={!can} value={d.ackMessage ?? ''} onChange={(e) => set('ackMessage', e.target.value)} />
          <div className="dix-note"><b>Platform limits.</b> The Cloud API does not support WhatsApp groups, so requests come in as one-to-one chats with your business number. Numbers, tokens and the app secret are set per number in <Link to="/operations?view=whatsapp">Operations › WhatsApp</Link> and stored encrypted.</div>
        </section>

        <section className="dq-card dix-sec" aria-labelledby="dix-route">
          <div className="dix-sec-h"><span className="dix-ic" style={{ background: '#5856d6' }}>⇄</span><div><h2 id="dix-route">AI routing</h2><p>Category, priority and the best available engineer</p></div>
            <span className={`dix-badge${settings.routingEnabled ? ' on' : ''}`}>{settings.routingEnabled ? 'On' : 'Off'}</span></div>
          <Row title="Route new tickets" hint="Availability, shift, department, skills, workload and priority."><Switch label="AI routing" on={d.routingEnabled} disabled={!can} onChange={(v) => set('routingEnabled', v)} /></Row>
          <Row title={`Confidence threshold · ${d.confidenceThreshold}%`} hint="Below it, a person approves the AI's category and priority first.">
            <input type="range" min={0} max={100} step={5} aria-label="Confidence threshold" value={d.confidenceThreshold} disabled={!can} onChange={(e) => set('confidenceThreshold', Number(e.target.value))} /></Row>
          <Row title="Accept within (minutes)" hint="Then it moves to the next engineer."><input type="number" min={1} max={1440} aria-label="Accept within minutes" value={d.acceptMinutes} disabled={!can} onChange={(e) => set('acceptMinutes', Number(e.target.value))} /></Row>
          <Row title="Moves before the supervisor" hint="After this many moves the supervisor is asked."><input type="number" min={0} max={10} aria-label="Moves before the supervisor" value={d.maxReassignments} disabled={!can} onChange={(e) => set('maxReassignments', Number(e.target.value))} /></Row>
          <Row title="Supervisor"><Select aria-label="Supervisor" value={d.supervisorId ?? ''} disabled={!can} onChange={(e) => set('supervisorId', e.target.value || null)}>
            <option value="">Operations escalation contact</option>{(members.data ?? []).map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select></Row>
          <Row title="Tell engineers on WhatsApp too" hint="For people who linked their number; in-app always."><Switch label="WhatsApp notifications" on={d.notifyOnWhatsApp} disabled={!can} onChange={(v) => set('notifyOnWhatsApp', v)} /></Row>
        </section>

        <Engineers canManage={can} />

        <section className="dq-card dix-sec" aria-labelledby="dix-voice">
          <div className="dix-sec-h"><span className="dix-ic" style={{ background: '#ff9500' }}>◉</span><div><h2 id="dix-voice">Voice agent · Sarvam AI</h2><p>Speech-to-text, text-to-speech, translation</p></div>
            <span className={`dix-badge${settings.hasSarvamKey || settings.sarvamFromServer ? ' on' : ' warn'}`}>{settings.hasSarvamKey ? 'Key saved' : settings.sarvamFromServer ? 'Server key' : 'No key'}</span></div>
          <Row title="Voice intake" hint="Browser microphone today; phone calls once telephony is connected."><Switch label="Voice intake" on={d.voiceEnabled} disabled={!can} onChange={(v) => set('voiceEnabled', v)} /></Row>
          <Row title="API subscription key" hint="Write-only: stored encrypted, never shown again.">
            <div className="dix-key">{settings.hasSarvamKey && !key ? <code>••••••••</code> : null}
              <input type="password" autoComplete="off" aria-label="Sarvam API key" placeholder={settings.hasSarvamKey ? 'Replace key' : 'Paste key'} value={key} disabled={!can} onChange={(e) => setKey(e.target.value)} />
              {settings.hasSarvamKey && can && <button type="button" className="dq-btn sm" disabled={busy} onClick={() => void save({ sarvamApiKey: '' })}>Remove</button>}</div></Row>
          <Row title="Languages" hint="The first is the default.">
            <div className="dix-langs">{LANGS.map(([c, n]) => <button key={c} type="button" aria-pressed={d.voiceLanguages.includes(c)} disabled={!can}
              onClick={() => set('voiceLanguages', d.voiceLanguages.includes(c) ? d.voiceLanguages.filter((x) => x !== c) : [...d.voiceLanguages, c])}>{n}</button>)}</div></Row>
        </section>

        <section className="dq-card dix-sec" aria-labelledby="dix-consent">
          <div className="dix-sec-h"><span className="dix-ic" style={{ background: '#ff3b30' }}>●</span><div><h2 id="dix-consent">Recording and consent</h2><p>The assistant says it is automated and asks first</p></div></div>
          <textarea className="dix-area" aria-label="Consent prompt" maxLength={600} disabled={!can} value={d.consentPrompt ?? ''} onChange={(e) => set('consentPrompt', e.target.value)} />
          <Row title="Keep the recording when the caller agrees" hint="A no means transcript only."><Switch label="Record calls" on={d.recordCalls} disabled={!can} onChange={(v) => set('recordCalls', v)} /></Row>
          <Row title="Delete recordings after (days)" hint="Transcript and summary stay on the ticket."><input type="number" min={1} max={3650} aria-label="Retention days" value={d.retentionDays} disabled={!can} onChange={(e) => set('retentionDays', Number(e.target.value))} /></Row>
        </section>

        <section className="dq-card dix-sec" aria-labelledby="dix-tel">
          <div className="dix-sec-h"><span className="dix-ic" style={{ background: '#34c759' }}>☎</span><div><h2 id="dix-tel">Telephony</h2><p>Outbound callbacks and inbound phone calls</p></div>
            <span className={`dix-badge${settings.telephonyReady ? ' on' : ' warn'}`}>{settings.telephonyReady ? 'Connected' : 'Not connected'}</span></div>
          <Row title="Provider"><Select aria-label="Telephony provider" value={d.telephonyProvider} disabled={!can} onChange={(e) => set('telephonyProvider', e.target.value)}>
            <option value="none">None</option><option value="exotel">Exotel</option><option value="plivo">Plivo</option><option value="twilio">Twilio</option></Select></Row>
          <div className="dix-note">Calls are <b>not placed</b> until a provider adapter, a virtual number (with DLT registration for outbound in India) and media streaming are connected. Until then engineers use browser voice intake or call from their phone.</div>
        </section>

        <section className="dq-card dix-sec" aria-labelledby="dix-sla">
          <div className="dix-sec-h"><span className="dix-ic" style={{ background: '#0071e3' }}>◔</span><div><h2 id="dix-sla">SLA policies</h2><p>Response and resolution targets by priority</p></div>
            <Link className="dai-link" style={{ marginLeft: 'auto' }} to="/settings/work-types">Edit</Link></div>
          {targets.length === 0 ? <div className="dq-faint dq-s12">No targets set.</div> : targets.map((t) => (
            <Row key={t.priority} title={t.priority}><span className="dq-faint dq-s12">respond {fmtMin(t.responseMinutes)} · resolve {fmtMin(t.resolutionMinutes)}</span></Row>
          ))}
        </section>

        {can && (
          <section className="dq-card dix-sec wide" aria-labelledby="dix-q">
            <div className="dix-sec-h"><span className="dix-ic" style={{ background: '#8e8e93' }}>≡</span><div><h2 id="dix-q">Inbound queue</h2><p>Retries with back-off; failures end as dead letters</p></div></div>
            <div className="dix-q">
            <dl className="dix-stats"><div><dt>Waiting</dt><dd>{qd?.pending ?? '–'}</dd></div><div><dt>Done</dt><dd>{qd?.done ?? '–'}</dd></div><div className="dead"><dt>Dead letters</dt><dd>{qd?.dead ?? '–'}</dd></div></dl>
            <div>
            {(qd?.recent ?? []).filter((e) => e.status === 'dead').length === 0 && <div className="dq-faint dq-s12">No dead letters. Failed messages are retried 5 times with back-off before they land here.</div>}
            {(qd?.recent ?? []).filter((e) => e.status === 'dead').slice(0, 5).map((e) => (
              <Row key={e.id} title={`${e.messageType} · ${new Date(e.createdAt).toLocaleString()}`} hint={e.lastError ?? undefined}>
                <button type="button" className="dq-btn sm" onClick={() => { deskAiApi.retry(e.id).then(() => { toast('Queued again.'); void qc.invalidateQueries({ queryKey: [wid, 'desk', 'queue'] }); }).catch((x: unknown) => toast(errText(x, 'Could not retry.'), 'error')); }}>Retry</button>
              </Row>
            ))}
            </div>
            </div>
          </section>
        )}
      </div>

    </div>
  );
}

/** Engineers: availability, skills, department, ticket limit and shift. A supervisor edits anyone; others see the list. */
function Engineers({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const wid = useWorkspaceId();
  const q = useWsQuery(['desk', 'engineers'], () => deskAiApi.engineers(), { retry: false });
  const list = Array.isArray(q.data) ? q.data : [];
  const save = async (e: DeskEngineer, patch: Partial<DeskEngineer>) => {
    const n = { ...e, ...patch };
    try {
      await deskAiApi.saveEngineer(e.userId, { status: n.status, skills: n.skills, department: n.department, maxActive: n.maxActive, shiftStartMinutes: n.shiftStartMinutes, shiftEndMinutes: n.shiftEndMinutes });
      void qc.invalidateQueries({ queryKey: [wid, 'desk', 'engineers'] });
    } catch (x) { toast(errText(x, 'Could not save.'), 'error'); }
  };
  return (
    <section className="dq-card dix-sec wide" aria-labelledby="dix-eng">
      <div className="dix-sec-h"><span className="dix-ic" style={{ background: '#af52de' }}>☺</span><div><h2 id="dix-eng">Engineers</h2><p>Who the router may offer tickets to</p></div>
        <span className="dix-badge on">{list.filter((e) => e.status === 'available').length} available</span></div>
      <table className="dix-eng">
        <thead><tr><th>Engineer</th><th>Status</th><th>Skills</th><th>Department</th><th>Open / limit</th><th>Shift</th></tr></thead>
        <tbody>
          {list.slice(0, 40).map((e) => (
            <tr key={e.userId}>
              <td><b>{e.name}</b></td>
              <td><Select aria-label={`${e.name} status`} value={e.status} disabled={!canManage} onChange={(x) => void save(e, { status: x.target.value as EngineerStatus })}>
                {(['available', 'busy', 'away', 'offline'] as EngineerStatus[]).map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</Select></td>
              <td><input aria-label={`${e.name} skills`} defaultValue={e.skills.join(', ')} placeholder="login, payments" disabled={!canManage}
                onBlur={(x) => { const v = x.target.value.split(',').map((s) => s.trim()).filter(Boolean); if (v.join(',') !== e.skills.join(',')) void save(e, { skills: v }); }} /></td>
              <td><input aria-label={`${e.name} department`} defaultValue={e.department} placeholder="IT" disabled={!canManage} onBlur={(x) => { if (x.target.value.trim() !== e.department) void save(e, { department: x.target.value.trim() }); }} /></td>
              <td><span style={{ fontVariantNumeric: 'tabular-nums' }}>{e.active} / </span><input type="number" min={1} max={100} aria-label={`${e.name} limit`} defaultValue={e.maxActive} disabled={!canManage}
                onBlur={(x) => { const v = Number(x.target.value); if (v && v !== e.maxActive) void save(e, { maxActive: v }); }} /></td>
              <td><input type="time" aria-label={`${e.name} shift start`} defaultValue={toTime(e.shiftStartMinutes)} disabled={!canManage}
                onBlur={(x) => { const s = fromTime(x.target.value); if (s !== e.shiftStartMinutes) void save(e, { shiftStartMinutes: s, shiftEndMinutes: s == null ? null : e.shiftEndMinutes ?? Math.min(1439, s + 540) }); }} /> – <input type="time" aria-label={`${e.name} shift end`}
                defaultValue={toTime(e.shiftEndMinutes)} disabled={!canManage} onBlur={(x) => { const s = fromTime(x.target.value); if (s !== e.shiftEndMinutes) void save(e, { shiftEndMinutes: s, shiftStartMinutes: s == null ? null : e.shiftStartMinutes ?? 540 }); }} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 && <div className="dq-faint dq-s12">No members yet.</div>}
    </section>
  );
}
