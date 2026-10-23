import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { insightApi, timeApi } from '../../api/endpoints';
import type { GridKind, ParsedTime, ParsedTimeEntry, SearchHit, TimeTarget } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { Select } from '../../components/Select';
import { todayISO } from '../../lib/format';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { haptic } from '../../lib/mobile';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { audioSupported, startRecording, unlockAudio, type Recording } from '../work/voiceAudio';
import { dayName, dayNum, hm, parseCell } from './grid';
import { formatMinutes } from './time';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const targetKey = (t: { kind: GridKind; targetId: string }) => `${t.kind}:${t.targetId}`;
const MATCH: Record<ParsedTimeEntry['match'], string> = { key: 'By its key', title: 'From the words', ai: 'Picked by AI', none: 'Choose the work' };

/** An entry as the person is checking it: the time as typed, the chosen work, the day and the note, and whether it goes in. */
interface Row { id: number; text: string; time: string; date: string; target: TimeTarget | null; note: string; on: boolean; options: TimeTarget[]; match: ParsedTimeEntry['match']; error: string | null }

const rowOf = (e: ParsedTimeEntry, id: number): Row => ({
  id, text: e.text, time: e.minutes ? hm(e.minutes) : '', date: e.date, target: e.target, note: e.note ?? '', options: e.options, match: e.match,
  on: !!e.target && e.minutes > 0 && e.date <= todayISO(), error: null,
});

/** What still stops a row from being logged, in words. */
function problemOf(r: Row): string | null {
  const minutes = parseCell(r.time);
  if (!r.time.trim() || !minutes) return 'How long? Type it like 2h, 45m or 1:30.';
  if (minutes === null || minutes > 24 * 60) return 'Type up to 24 hours, like 1.5, 1:30 or 45m.';
  if (!r.target) return 'Choose the work it was spent on.';
  if (!r.date) return 'Choose the day.';
  if (r.date > todayISO()) return 'That day has not happened yet.';
  return null;
}

/**
 * Records a short voice note as WAV and reads it into entries. On phones the tap that starts it also wakes the audio engine, so the
 * browser allows the microphone.
 */
export function useWordsRecorder(onRead: (r: ParsedTime) => void) {
  const [state, setState] = useState<'idle' | 'recording' | 'reading'>('idle');
  const [secs, setSecs] = useState(0);
  const rec = useRef<Recording | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const started = useRef(0);
  useEffect(() => {
    if (state !== 'recording') return;
    const t = window.setInterval(() => {
      const s = Math.round((Date.now() - started.current) / 1000);
      setSecs(s);
      if (s >= 120) void finishRef.current();   // two minutes is plenty for a day's time
    }, 500);
    return () => window.clearInterval(t);
  }, [state]);
  useEffect(() => () => { rec.current?.cancel(); stream.current?.getTracks().forEach((t) => t.stop()); }, []);
  const stopTracks = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  const start = async () => {
    unlockAudio();
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      rec.current = await startRecording(stream.current);
      started.current = Date.now(); setSecs(0); setState('recording'); haptic();
    } catch { stopTracks(); toast('The microphone is not available. Allow it for this site in the browser.', 'error'); }
  };
  const cancel = () => { rec.current?.cancel(); rec.current = null; stopTracks(); setState('idle'); };
  const finish = async () => {
    const r = rec.current;
    if (!r) return;
    const blob = r.stop(); rec.current = null; stopTracks();
    if ((Date.now() - started.current) / 1000 < 1) { setState('idle'); toast('Say a little more: that was too short.', 'info'); return; }
    setState('reading');
    try { onRead(await timeApi.parseVoice(blob)); }
    catch (e) { toast(errText(e, 'Could not read the recording. Type it instead.'), 'error'); }
    setState('idle');
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  return { supported: audioSupported(), state, secs, start, cancel, finish };
}

/**
 * Check what was understood from "2h on PAY-12 yesterday, 30m standup" before any of it is logged: each entry with its work (found by
 * key, by the words of a title or by AI - or to choose), its time, day and note. Untick what is wrong; "Add" logs the rest, each as an
 * entry of its own, and keeps any that could not be logged with the reason.
 */
export function TimeWordsReview({ parsed, onClose, onLogged, beforeSave }: {
  parsed: ParsedTime; onClose: () => void; onLogged: (dates: string[]) => void; beforeSave?: () => Promise<void>;
}) {
  const wid = useWorkspaceId();
  const [rows, setRows] = useState<Row[]>(() => parsed.entries.map(rowOf));
  const [saving, setSaving] = useState(false);
  const today = todayISO();
  const set = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch, error: null } : r)));
  const chosen = rows.filter((r) => r.on);
  const ready = chosen.filter((r) => !problemOf(r));
  const total = ready.reduce((n, r) => n + (parseCell(r.time) ?? 0), 0);
  const blocked = chosen.length - ready.length;

  const save = async () => {
    if (!ready.length) return;
    setSaving(true);
    try {
      await beforeSave?.();
      const res = await timeApi.logWords(ready.map((r) => ({ kind: r.target!.kind, targetId: r.target!.targetId, date: r.date, minutes: parseCell(r.time)!, note: r.note.trim() || null })));
      void invalidateWorkspace(wid, 'timesheet'); void invalidateWorkspace(wid, 'timer'); void invalidateWorkspace(wid, 'time');
      haptic();
      if (!res.errors.length) {
        toast(`Logged ${res.saved} entr${res.saved === 1 ? 'y' : 'ies'} · ${formatMinutes(res.minutes)}.`, 'success');
        onLogged(ready.map((r) => r.date));
        return;
      }
      // Keep only what did not go in, each with its reason.
      const failed = new Map(res.errors.map((e) => [`${e.kind}:${e.targetId}:${e.date}`, e.message]));
      const left = ready.filter((r) => failed.has(`${targetKey(r.target!)}:${r.date}`));
      setRows((rs) => rs.filter((r) => !r.on || !ready.includes(r) || left.includes(r)).map((r) => {
        const msg = r.target ? failed.get(`${targetKey(r.target)}:${r.date}`) : undefined;
        return msg ? { ...r, error: msg } : r;
      }));
      toast(res.saved ? `Logged ${res.saved}; ${res.errors.length} could not be: ${res.errors[0].message}` : res.errors[0].message, 'error');
    } catch (e) { toast(errText(e, 'Could not log the time. Nothing was lost; try again.'), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Modal title="Check your time" size="lg" onClose={onClose}
      subtitle="Here is what was understood. Change anything, untick what is wrong: nothing is logged until you add it."
      footer={<>
        {blocked > 0 && <span className="tw-blocked"><Icon name="alert" size={13} />{blocked} still need{blocked === 1 ? 's' : ''} a fix</span>}
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || ready.length === 0} onClick={() => void save()}>
          {saving && <span className="spinner" />}Add {ready.length} entr{ready.length === 1 ? 'y' : 'ies'}{ready.length ? ` · ${formatMinutes(total)}` : ''}
        </button>
      </>}>
      <div className="tw">
        {(parsed.transcript || parsed.usedAi) && (
          <div className="tw-heard">
            {parsed.transcript && <p><Icon name="mic" size={13} /><span>Heard: <q>{parsed.transcript}</q></span></p>}
            {parsed.usedAi && <span className="tw-ai"><Icon name="sparkle" size={12} />Read with AI</span>}
          </div>
        )}
        {rows.length === 0 && <p className="tw-none">Nothing in that says how long or what on. Try “2h on PAY-12 yesterday, 30m standup”.</p>}
        {rows.map((r) => <WordsRow key={r.id} r={r} today={today} onChange={(p) => set(r.id, p)} onRemove={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} />)}
      </div>
    </Modal>
  );
}

function WordsRow({ r, today, onChange, onRemove }: { r: Row; today: string; onChange: (p: Partial<Row>) => void; onRemove: () => void }) {
  const [searching, setSearching] = useState(false);
  const problem = r.error ?? problemOf(r);
  const options = useMemo(() => (r.target && !r.options.some((o) => targetKey(o) === targetKey(r.target!)) ? [r.target, ...r.options] : r.options), [r.target, r.options]);
  const pick = (value: string) => {
    if (value === '__search') { setSearching(true); return; }
    const t = options.find((o) => targetKey(o) === value) ?? null;
    onChange({ target: t, match: t ? (r.target && targetKey(r.target) === value ? r.match : 'title') : 'none', on: t ? true : r.on });
  };
  return (
    <div className={`tw-row${r.on ? '' : ' off'}${problem && r.on ? ' bad' : ''}`}>
      <label className="tw-check" title={r.on ? 'Leave this one out' : 'Add this one'}>
        <input type="checkbox" checked={r.on} onChange={(e) => onChange({ on: e.target.checked })} aria-label={`Add “${r.text}”`} />
      </label>
      <div className="tw-body">
        <div className="tw-said"><q>{r.text}</q><span className={`tw-match ${r.match}`}>{MATCH[r.match]}</span></div>
        <div className="tw-fields">
          <div className="tw-work">
            {searching
              ? <WorkSearch onPick={(t) => { setSearching(false); onChange({ target: t, match: 'title', on: true, options: [t, ...r.options.filter((o) => targetKey(o) !== targetKey(t))] }); }} onCancel={() => setSearching(false)} />
              : (
                <Select className="select" value={r.target ? targetKey(r.target) : ''} onChange={(e) => pick(e.target.value)} aria-label={`Work for “${r.text}”`}>
                  <option value="" disabled>Choose the work…</option>
                  {options.map((o) => <option key={targetKey(o)} value={targetKey(o)}>{o.key} · {o.title}{o.projectName ? ` (${o.projectName})` : o.kind === 'work' ? ' (Operational)' : ''}</option>)}
                  <option value="__search">Search for other work…</option>
                </Select>
              )}
          </div>
          <label className="tw-time">
            <span className="sr-only">How long</span>
            <input className="input" inputMode="decimal" value={r.time} placeholder="1:30" aria-label={`How long for “${r.text}”`}
              onChange={(e) => onChange({ time: e.target.value })} onBlur={(e) => { const m = parseCell(e.target.value); if (m) onChange({ time: hm(m) }); }} />
          </label>
          <label className="tw-date">
            <span className="sr-only">Day</span>
            <input className="input" type="date" max={today} value={r.date} aria-label={`Day for “${r.text}”`} onChange={(e) => onChange({ date: e.target.value })} />
            <em aria-hidden>{r.date ? `${dayName(r.date)} ${dayNum(r.date)}` : ''}</em>
          </label>
          <input className="input tw-note" value={r.note} maxLength={500} placeholder="Note (optional)" aria-label={`Note for “${r.text}”`} onChange={(e) => onChange({ note: e.target.value })} />
        </div>
        {problem && r.on && <small className="tw-problem" role="alert"><Icon name="alert" size={12} />{problem}</small>}
      </div>
      <button type="button" className="btn-icon tw-remove" aria-label={`Remove “${r.text}”`} title="Remove" onClick={onRemove}><Icon name="close" size={13} /></button>
    </div>
  );
}

/** Any task or piece of work the person can see, by key or title. */
function WorkSearch({ onPick, onCancel }: { onPick: (t: TimeTarget) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  const search = useWsQuery(['search', 'timewords', q], () => insightApi.search(q), { enabled: q.length >= 2, staleTime: 30_000 });
  const hits = (search.data?.hits ?? []).filter((h: SearchHit) => h.type === 'task' || h.type === 'work' || h.type === 'action').slice(0, 6);
  const toTarget = (h: SearchHit): TimeTarget => ({ kind: h.type === 'task' ? 'task' : 'work', targetId: h.id, key: (h.subtitle ?? '').split(' · ')[0] || h.title, title: h.title, projectName: null });
  return (
    <div className="tw-search">
      <div className="tw-search-box">
        <Icon name="search" size={13} />
        <input className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by key or title…" aria-label="Search work"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }} />
        <button type="button" className="btn-icon" aria-label="Back to the list" onClick={onCancel}><Icon name="close" size={12} /></button>
      </div>
      {q.length >= 2 && (
        <div className="tw-hits">
          {search.isLoading ? <span className="muted">Searching…</span> : hits.length === 0 ? <span className="muted">Nothing matches “{q}”.</span>
            : hits.map((h) => <button type="button" key={h.id} onClick={() => onPick(toTarget(h))}><b>{toTarget(h).key}</b><span>{h.title}</span></button>)}
        </div>
      )}
    </div>
  );
}
