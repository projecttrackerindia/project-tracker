import { useEffect, useMemo, useState } from 'react';
import { SiriOrb } from '../../components/aura/SiriOrb';
import { Face } from '../../components/Face';
import { CalmCard } from '../../components/calm';
import { recordingApi } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';
import { toast } from '../../stores/ui';
import { useRecorder, type RecordPhase, type RecordSource } from './useRecorder';
import './record.css';

/**
 * "Record this meeting" from the person's own device: no bot joins. The sound is written down in the language it is spoken in and then dropped,
 * so only the words are kept. When the person stops, the agent writes the minutes and proposes tasks, which become tasks only when ticked.
 * With `pm_record_preview` set the panel runs on sample data (no microphone, no server), for design review.
 */
type Keep = 'off' | '30' | 'forever';
type Line = { t: string; who: string; lang: string; text: string; me?: boolean };
type Suggestion = { id: number; kind: 'task' | 'reminder'; title: string; owner?: string; when: string; because: string };

const LANGS = ['Auto', 'English', 'తెలుగు', 'हिन्दी', 'தமிழ்'];
const SOURCES: { id: RecordSource; label: string; hint: string }[] = [
  { id: 'tab', label: 'This tab + mic', hint: 'Meet, Teams or Zoom open in your browser. You pick the tab and tick “Share tab audio”.' },
  { id: 'desktop', label: 'Desktop app', hint: 'Any app’s sound and your mic. You choose the screen or window to take sound from.' },
  { id: 'mic', label: 'Mic only', hint: 'In-person meetings and phone calls on speaker.' },
];
const KEEP: { id: Keep; label: string }[] = [{ id: 'off', label: 'Off' }, { id: '30', label: '30 days' }, { id: 'forever', label: 'Forever' }];

const DEMO_LINES: Line[] = [
  { t: '00:41', who: 'Ravi Menon', lang: 'EN', text: 'Let us lock the UPI AutoPay release for the 14th. Tomas, is the HSM slot confirmed?' },
  { t: '01:12', who: 'You', lang: 'తె', text: 'ఇంకా లేదు. వెండర్ 4 లేదా 6 తారీఖు ఇచ్చారు, నేను రేపటికి confirm చేస్తాను.', me: true },
  { t: '01:40', who: 'Tomas Rivera', lang: 'EN', text: 'I will hold the 4th until Ravi confirms the sandbox date with the bank.' },
  { t: '02:05', who: 'Mira Das', lang: 'हि', text: 'NPCI वाले से sandbox की date मैं पूछ लूँगी, शुक्रवार तक बता दूँगी।' },
  { t: '02:31', who: 'Ravi Menon', lang: 'EN', text: 'Good. And someone needs to book the PCI assessor call before the 5th.' },
  { t: '02:48', who: 'You', lang: 'EN', text: 'I will take that. Remind me on Monday morning to send the fraud thresholds too.', me: true },
];
const DEMO_SUGGESTIONS: Suggestion[] = [
  { id: 0, kind: 'task', title: 'Confirm HSM vendor slot with the vendor', owner: 'Asha Rao', when: 'Tomorrow', because: 'You said “రేపటికి confirm చేస్తాను” at 01:12' },
  { id: 1, kind: 'task', title: 'Get sandbox date from the NPCI liaison', owner: 'Mira Das', when: 'Fri 13 Nov', because: 'Mira: “शुक्रवार तक बता दूँगी” at 02:05' },
  { id: 2, kind: 'task', title: 'Book the PCI assessor call', owner: 'Asha Rao', when: 'Thu 5 Nov', because: 'You took it at 02:48' },
  { id: 3, kind: 'reminder', title: 'Send the fraud rule thresholds', when: 'Mon 16 Nov · 9:00', because: 'You asked to be reminded at 02:48' },
];

export const recordPreviewOn = () => { try { return localStorage.getItem('pm_record_preview') === '1'; } catch { return false; } };
const startPhase = (): RecordPhase => { try { const v = localStorage.getItem('pm_record_state'); return v === 'recording' || v === 'done' ? v : 'ready'; } catch { return 'ready'; } };
const clock = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const LANG_TAG: Record<string, string> = { en: 'EN', te: 'తె', hi: 'हि', ta: 'த', kn: 'ಕ', ml: 'മ', bn: 'বা', mr: 'म', gu: 'ગુ', pa: 'ਪ', od: 'ଓ' };

/** What the panel draws, whether it is real or sample data. */
type Engine = {
  phase: RecordPhase; secs: number; lines: Line[]; summary: string; discussion: string[]; suggestions: Suggestion[]; languages: number; error: string | null;
  start: (source: RecordSource) => void; stop: () => void; reset: () => void; addTasks: (items: number[]) => Promise<number>;
};

function useDemoEngine(): Engine {
  const [phase, setPhase] = useState<RecordPhase>(startPhase);
  const [secs, setSecs] = useState(phase === 'recording' ? 169 : 0);
  useEffect(() => {
    if (phase !== 'recording') return;
    const t = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [phase]);
  const lines = useMemo(() => DEMO_LINES.filter((l) => phase === 'done' || l.t <= clock(secs).slice(3, 8)), [phase, secs]);
  return {
    phase, secs, lines, languages: 3, error: null,
    summary: 'The release is locked for the 14th. The HSM slot waits for the vendor, and the bank sandbox date comes from NPCI by Friday. The PCI assessor call is booked before the 5th.',
    discussion: [], suggestions: DEMO_SUGGESTIONS,
    start: () => { setSecs(0); setPhase('recording'); }, stop: () => setPhase('done'), reset: () => setPhase('ready'), addTasks: async (items) => items.length,
  };
}

function useLiveEngine(meetingId: string): Engine {
  const r = useRecorder(meetingId);
  const lines: Line[] = r.lines.map((l) => ({ t: clock(l.offset).slice(3), who: l.who, lang: l.lang ? LANG_TAG[l.lang] ?? l.lang.toUpperCase() : '', text: l.text, me: l.who === 'Others' ? false : true }));
  const items = r.minutes?.content.actionItems ?? [];
  return {
    phase: r.phase, secs: r.secs, lines, error: r.error, languages: new Set(r.lines.map((l) => l.lang).filter(Boolean)).size,
    summary: r.minutes?.content.summary ?? (r.phase === 'done' ? 'Nothing could be written up from this recording.' : ''), discussion: r.minutes?.content.discussion ?? [],
    suggestions: items.map((a, i) => ({ id: i, kind: 'task' as const, title: a.task, owner: a.owner ?? undefined, when: a.due ?? 'No date', because: a.owner ? `${a.owner} in the call` : 'Said in the call' })),
    start: (s) => void r.start(s), stop: () => void r.stop(), reset: r.reset,
    addTasks: async (picked) => (await recordingApi.tasks(r.recordingId()!, picked)).created.length,
  };
}

export function MeetingRecord({ meetingId, title }: { meetingId: string; title: string }) {
  return recordPreviewOn() ? <DemoPanel title={title} /> : <Live meetingId={meetingId} title={title} />;
}
function DemoPanel({ title }: { title: string }) { return <Panel eng={useDemoEngine()} title={title} />; }

/** The real panel appears only where the speech service is set up. */
function Live({ meetingId, title }: { meetingId: string; title: string }) {
  const status = useWsQuery(['recordings', 'status'], () => recordingApi.status(), { staleTime: 600_000, retry: false });
  if (!status.data?.speech) return null;
  return <LivePanel meetingId={meetingId} title={title} />;
}
function LivePanel({ meetingId, title }: { meetingId: string; title: string }) { return <Panel eng={useLiveEngine(meetingId)} title={title} />; }

function Panel({ eng, title }: { eng: Engine; title: string }) {
  const [source, setSource] = useState<RecordSource>('tab');
  const [lang, setLang] = useState('Auto');
  const [keep, setKeep] = useState<Keep>('off');
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [added, setAdded] = useState(0);
  const [busy, setBusy] = useState(false);
  const { phase } = eng;
  const picks = eng.suggestions.filter((s) => picked[s.id] ?? true);
  const hint = SOURCES.find((s) => s.id === source)!.hint;
  const add = async () => {
    setBusy(true);
    try { const n = await eng.addTasks(picks.map((s) => s.id)); setAdded(n); toast(`${n} task${n === 1 ? '' : 's'} added to your work.`); }
    catch { toast('The tasks could not be added. Try again.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <CalmCard className="mz-card rc" title="Recording" aside={<span className="rc-note">Only the words are kept</span>}>
      {eng.error && <p className="rc-error" role="alert">{eng.error}</p>}
      {phase === 'ready' && (
        <div className="rc-ready">
          <button type="button" className="rc-rec" onClick={() => eng.start(source)} aria-label="Start recording"><i /></button>
          <div className="rc-setup">
            <div><span className="rc-lab">Record from</span>
              <div className="rc-seg" role="group" aria-label="Record from">{SOURCES.map((s) => <button key={s.id} type="button" aria-pressed={source === s.id} onClick={() => setSource(s.id)}>{s.label}</button>)}</div>
              <p className="rc-hint">{hint}</p></div>
            <div><span className="rc-lab">Spoken languages</span>
              <div className="rc-chips" role="group" aria-label="Languages">{LANGS.map((l) => <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>{l}</button>)}</div>
              <p className="rc-hint">Each piece is written in the language it is spoken in, including Telugu or Hindi mixed with English.</p></div>
            {recordPreviewOn() && <div><span className="rc-lab">Keep the audio</span>
              <div className="rc-seg" role="group" aria-label="Keep the audio">{KEEP.map((k) => <button key={k.id} type="button" aria-pressed={keep === k.id} onClick={() => setKeep(k.id)}>{k.label}</button>)}</div>
              <p className="rc-hint">{keep === 'off' ? 'The words are kept. The sound is deleted as soon as it is written down.' : 'Saved as MP3 on this meeting, with a player.'}</p></div>}
          </div>
        </div>
      )}

      {(phase === 'recording' || phase === 'finishing') && (
        <div className="rc-live">
          <div className="rc-bar">
            <span className="rc-dot" aria-hidden="true" /><b className="rc-clock" data-testid="rc-clock">{clock(eng.secs)}</b>
            <span className="rc-meter" aria-hidden="true">{Array.from({ length: 22 }, (_, i) => <i key={i} style={{ height: `${28 + ((i * 37) % 62)}%` }} />)}</span>
            <span className="rc-grow" />
            <span className="rc-pill">{source === 'tab' ? 'Tab + mic' : source === 'desktop' ? 'Desktop' : 'Mic'}</span>
            <span className="rc-pill">{lang === 'Auto' ? 'Auto language' : lang}</span>
            <button type="button" className="rc-stop" disabled={phase === 'finishing'} onClick={eng.stop}><i />{phase === 'finishing' ? 'Writing up…' : 'Stop'}</button>
          </div>
          <p className="rc-notice">Tell everyone in the meeting that it is being recorded. Keep this tab open.</p>
          <Transcript lines={eng.lines} typing={phase === 'recording'} />
        </div>
      )}

      {phase === 'done' && (
        <div className="rc-done">
          <div className="rc-cols">
            <div className="rc-col">
              <h3 className="rc-h">Minutes</h3>
              <p className="rc-sum">{eng.summary}</p>
              {eng.discussion.length > 0 && <ul className="rc-pts">{eng.discussion.slice(0, 6).map((d) => <li key={d}>{d}</li>)}</ul>}
              <h3 className="rc-h">Transcript <small>{eng.languages > 1 ? `${eng.languages} languages · ` : ''}{Math.max(1, Math.round(eng.secs / 60))} min</small></h3>
              <Transcript lines={eng.lines} />
            </div>
            <div className="rc-col">
              <h3 className="rc-h">Suggested from this meeting <small>{picks.length} of {eng.suggestions.length} selected</small></h3>
              {eng.suggestions.length === 0 ? <p className="rc-hint">No tasks were agreed in this recording.</p> : (
                <ul className="rc-sug">
                  {eng.suggestions.map((s) => (
                    <li key={s.id} className={picked[s.id] ?? true ? 'on' : ''}>
                      <button type="button" className="rc-tick" role="checkbox" aria-checked={picked[s.id] ?? true} aria-label={`Include ${s.title}`} onClick={() => setPicked({ ...picked, [s.id]: !(picked[s.id] ?? true) })} />
                      <div className="rc-sug-main">
                        <span className="rc-kind">{s.kind === 'task' ? 'Task' : 'Reminder'}</span>
                        <b>{s.title}</b>
                        <small>{s.because}</small>
                      </div>
                      <div className="rc-sug-meta">{s.owner && <Face userId={undefined} name={s.owner} className="mz-av sm" />}<span>{s.owner ? `${s.owner} · ` : ''}{s.when}</span></div>
                    </li>
                  ))}
                </ul>
              )}
              {eng.suggestions.length > 0 && <p className="mz-aura"><SiriOrb className="calm-orb" />Owners and dates are read from what people said. Nothing is created until you add it.</p>}
              <div className="rc-actions">
                {eng.suggestions.length > 0 && <button type="button" className="btn btn-primary" disabled={!picks.length || !!added || busy} onClick={() => void add()}>{added ? `Added ${added} to your work` : `Add ${picks.length} to my work`}</button>}
                <button type="button" className="btn btn-ghost" onClick={() => { eng.reset(); setAdded(0); setPicked({}); }}>New recording</button>
              </div>
              <span className="sr-only">{title}</span>
            </div>
          </div>
        </div>
      )}
    </CalmCard>
  );
}

function Transcript({ lines, typing = false }: { lines: Line[]; typing?: boolean }) {
  return (
    <ul className="rc-tr" tabIndex={0} aria-label="Transcript">
      {lines.map((l, i) => (
        <li key={`${l.t}-${i}`} className={l.me ? 'me' : ''}>
          <span className="rc-t">{l.t}</span>
          <div><b>{l.who}{l.lang && <em>{l.lang}</em>}</b><p>{l.text}</p></div>
        </li>
      ))}
      {typing && <li className="rc-typing"><span className="rc-t">·</span><div><p>Listening<span>…</span></p></div></li>}
    </ul>
  );
}
