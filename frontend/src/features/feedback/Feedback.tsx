import { useCallback, useEffect, useRef, useState } from 'react';
import { CalmSheet } from '../../components/calm';
import { problemApi, type ProblemReceipt } from '../../api/endpoints.notifySmart';
import { ApiError } from '../../api/client';
import { useFlag } from '../../lib/flags';
import { useIsMobile } from '../../lib/mobile';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { appVersion, OPEN_WHATS_NEW, recentConsole, recentNetwork, REPORT_PROBLEM } from './capture';
import md from './whats-new.md?raw';
import { markSeen, parseChangelog, seenVersion, shouldShow } from './whatsNew';
import '../../styles/notify-smart.css';

/** A picture of the screen as it is now (before the sheet opens), small enough to send: html-to-image, loaded only when needed. */
async function snapshot(): Promise<string | null> {
  try {
    const { toJpeg } = await import('html-to-image');
    const root = document.documentElement;
    const w = window.innerWidth, h = window.innerHeight;
    return await toJpeg(root, {
      quality: 0.72, pixelRatio: Math.min(1, window.devicePixelRatio || 1), width: w, height: h, canvasWidth: w, canvasHeight: h, cacheBust: false, skipFonts: true,
      style: { transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)` },
      // Embedded frames, videos and other people's images cannot be drawn (and may hold someone else's data): left out.
      filter: (n) => !(n instanceof HTMLIFrameElement || n instanceof HTMLVideoElement || (n instanceof HTMLElement && n.dataset.noCapture !== undefined)),
    });
  } catch { return null; }
}

/**
 * "Report a problem": the person says what went wrong; a screenshot of the screen they were on (they can remove it), the route, the app
 * version and the recent errors come along (they can leave the errors out). Opened from the ⋯ menu, Settings, the command palette, or by
 * shaking a phone when the workspace turned that on.
 */
function ProblemReporter() {
  const phone = useIsMobile();
  const allowed = useFlag('report-problem');
  const shake = useFlag('shake-to-report');
  const [open, setOpen] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [logs, setLogs] = useState(true);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<ProblemReceipt | null>(null);
  const route = useRef('');

  const start = useCallback(async () => {
    if (open) return;
    route.current = `${window.location.pathname}${window.location.search}`;
    setDone(null); setMessage(''); setLogs(true); setShot(null);
    setShot(await snapshot());
    setOpen(true);
  }, [open]);

  useEffect(() => {
    if (!allowed) return;
    const go = () => { void start(); };
    window.addEventListener(REPORT_PROBLEM, go);
    return () => window.removeEventListener(REPORT_PROBLEM, go);
  }, [allowed, start]);

  // Shake to report (phones, when turned on): three strong jolts within a second.
  useEffect(() => {
    if (!allowed || !shake || !phone || typeof window.DeviceMotionEvent === 'undefined') return;
    let hits: number[] = [];
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a) return;
      const force = Math.abs(a.x ?? 0) + Math.abs(a.y ?? 0) + Math.abs(a.z ?? 0);
      if (force < 38) return;
      const now = Date.now();
      hits = [...hits.filter((t) => now - t < 1000), now];
      if (hits.length >= 3) { hits = []; void start(); }
    };
    window.addEventListener('devicemotion', onMotion);
    return () => window.removeEventListener('devicemotion', onMotion);
  }, [allowed, shake, phone, start]);

  const errors = recentConsole().length + recentNetwork().length;
  const send = async () => {
    if (!message.trim()) return;
    setSending(true);
    try {
      setDone(await problemApi.submit({
        message: message.trim(), route: route.current, appVersion: appVersion(), userAgent: navigator.userAgent,
        console: logs ? recentConsole() : [], network: logs ? recentNetwork() : [], screenshot: shot,
      }));
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not send the report. Try again.', 'error'); }
    finally { setSending(false); }
  };

  return (
    <CalmSheet open={open} onClose={() => setOpen(false)} title={done ? undefined : 'Report a problem'} label="Report a problem"
      sub={done ? undefined : 'Tell us what happened. We read every report.'} width={520}>
      {done ? (
        <div className="prb prb-done" role="status">
          <b>Thanks. We have it.</b>
          <span>Reference {done.reference}{done.emailed ? ' · support has been told' : ''}</span>
          <div className="prb-actions" style={{ justifyContent: 'center' }}><button type="button" className="prb-primary" onClick={() => setOpen(false)}>Done</button></div>
        </div>
      ) : (
        <div className="prb">
          <textarea aria-label="What went wrong" placeholder="What were you doing, and what went wrong?" value={message} maxLength={4000} autoFocus
            onChange={(e) => setMessage(e.target.value)} />
          <div className="prb-shot" data-no-capture>
            {shot ? <><img src={shot} alt="Screenshot of the screen you were on" /><button type="button" className="sg-btn" onClick={() => setShot(null)}>Remove</button></>
              : <span>No screenshot</span>}
          </div>
          <label className="prb-row"><input type="checkbox" checked={logs} onChange={(e) => setLogs(e.target.checked)} />
            Include recent errors{errors ? ` (${errors})` : ''}</label>
          <dl className="prb-facts"><dt>Page</dt><dd>{route.current}</dd><dt>Version</dt><dd>{appVersion()}</dd></dl>
          <div className="prb-actions">
            <button type="button" className="sg-btn" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="prb-primary" disabled={!message.trim() || sending} onClick={() => void send()}>{sending ? 'Sending…' : 'Send report'}</button>
          </div>
        </div>
      )}
    </CalmSheet>
  );
}

const RELEASES = parseChangelog(md);

/** "What's new": a calm sheet, once after each release (never on a first visit), and any time from the ⋯ menu. */
function WhatsNew() {
  const on = useFlag('whats-new');
  const [open, setOpen] = useState(false);
  const latest = RELEASES[0];
  useEffect(() => {
    if (!on || !latest) return;
    const next = shouldShow(latest.version, seenVersion());
    if (next === 'mark') markSeen(latest.version);
    if (next !== 'show') return;
    const t = window.setTimeout(() => setOpen(true), 1200);   // after the page settles, never over its first paint
    return () => window.clearTimeout(t);
  }, [on, latest]);
  useEffect(() => {
    const go = () => setOpen(true);
    window.addEventListener(OPEN_WHATS_NEW, go);
    return () => window.removeEventListener(OPEN_WHATS_NEW, go);
  }, []);
  const close = () => { if (latest) markSeen(latest.version); setOpen(false); };
  if (!latest) return null;
  return (
    <CalmSheet open={open} onClose={close} kind="bottom" title="What’s new" sub={latest.name || undefined} width={880}>
      <div className="wn">
        <p className="wn-ver">Version {latest.version}</p>
        <ul className="wn-list">
          {latest.items.map((it, i) => <li key={i}><i aria-hidden="true" /><div>{it.title && <b>{it.title}</b>}<span>{it.text}</span></div></li>)}
        </ul>
        {RELEASES.length > 1 && (
          <details className="wn-older">
            <summary>Earlier releases</summary>
            {RELEASES.slice(1).map((r) => (
              <div key={r.version}><p className="wn-ver">{r.version}{r.name ? ` · ${r.name}` : ''}</p>
                <ul className="wn-list">{r.items.map((it, i) => <li key={i}><i aria-hidden="true" /><div>{it.title && <b>{it.title}</b>}<span>{it.text}</span></div></li>)}</ul></div>
            ))}
          </details>
        )}
        <div className="prb-actions"><button type="button" className="prb-primary" onClick={close}>Got it</button></div>
      </div>
    </CalmSheet>
  );
}

/** Mounted once for a signed-in person inside a workspace. */
export function Feedback() {
  const signedIn = useAuth((s) => !!s.ctx?.current && !s.ctx.user.isPlatformAdmin);
  if (!signedIn) return null;
  return <><ProblemReporter /><WhatsNew /></>;
}
export default Feedback;
