import { Icon, type IconName } from '../../components/Icon';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { documentApi, meetingApi } from '../../api/endpoints';
import { Modal } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { audioSupported, startRecording, unlockAudio, type Recording } from '../work/voiceAudio';
import { docAiApi, LANGUAGES, type AiLanguage, type DocDraft, type DraftSource } from './docAi';
import { RichEditor } from './RichEditor';

const SOURCES: { id: DraftSource; label: string; icon: IconName; hint: string }[] = [
  { id: 'prompt', label: 'Describe it', icon: 'edit', hint: 'One line is enough' },
  { id: 'voice', label: 'Say it', icon: 'mic', hint: 'Talk in Telugu, Hindi or English' },
  { id: 'meeting', label: 'From a meeting', icon: 'calendar', hint: 'Its decisions, actions and transcript' },
  { id: 'tasks', label: 'From project work', icon: 'checkCircle', hint: 'Status, what is done and what is late' },
  { id: 'files', label: 'From files', icon: 'paperclip', hint: 'PDF, Word, text or Markdown' },
  { id: 'template', label: 'Fill a template', icon: 'layers', hint: 'Its sections, written for you' },
];
const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown';
const MAX_VOICE_S = 600;

/** The microphone, as a plain WAV note (what the speech service reads best on every phone and browser). */
function VoiceNote({ value, onChange }: { value: Blob | null; onChange: (b: Blob | null) => void }) {
  const [rec, setRec] = useState<Recording | null>(null);
  const [secs, setSecs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const url = useRef<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const stopAll = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  useEffect(() => () => { rec?.cancel(); stopAll(); if (url.current) URL.revokeObjectURL(url.current); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!rec) return;
    const t = window.setInterval(() => setSecs((s) => { if (s + 1 >= MAX_VOICE_S) stop(); return s + 1; }), 1000);
    return () => window.clearInterval(t);
  }, [rec]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    setError(null);
    unlockAudio();
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      setRec(await startRecording(stream.current)); setSecs(0); onChange(null);
    } catch { stopAll(); setError('The microphone is not available. Allow it for this site in the browser, or describe the page in words.'); }
  };
  function stop() {
    setRec((r) => {
      if (!r) return r;
      const blob = r.stop(); stopAll();
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(blob); setSrc(url.current);
      onChange(blob);
      return null;
    });
  }
  if (!audioSupported()) return <p className="muted">This browser cannot record. Describe the page in words instead.</p>;
  return (
    <div className="aid-voice">
      {rec ? (
        <button type="button" className="aid-rec on" onClick={stop} aria-label="Stop recording"><span className="aid-dot" aria-hidden="true" /> Stop · {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</button>
      ) : (
        <button type="button" className="aid-rec" onClick={() => void start()}><Icon name="mic" size={15} /> {value ? 'Record again' : 'Start recording'}</button>
      )}
      {!rec && value && src && <audio controls src={src} aria-label="Your voice note" />}
      <p className="muted small">Say what the page should cover, the way you would explain it to a colleague. Up to 10 minutes.</p>
      {error && <p className="aid-err" role="alert">{error}</p>}
    </div>
  );
}

/**
 * A page written by AI from whatever is at hand: a line, a voice note, a meeting, a project's work, files, or a template's sections. The draft is
 * shown first; nothing is saved until "Use this".
 */
export function AiDraftDialog({ projects, projectId: initialProject, onUse, onClose, useLabel = 'Use this page' }: {
  projects: { id: string; name: string }[]; projectId?: string | null;
  /** The draft, and the project it was written from (a meeting, its work or a template filled from it), if any. */
  onUse: (draft: DocDraft, from: { projectId: string | null }) => Promise<void> | void; onClose: () => void; useLabel?: string;
}) {
  const [source, setSource] = useState<DraftSource>('prompt');
  const [prompt, setPrompt] = useState('');
  const [projectId, setProjectId] = useState<string>(initialProject ?? projects[0]?.id ?? '');
  const [meetingId, setMeetingId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [voice, setVoice] = useState<Blob | null>(null);
  const [language, setLanguage] = useState<AiLanguage>('en');
  const [busy, setBusy] = useState(false);
  const [using, setUsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DocDraft | null>(null);

  const meetings = useWsQuery(['meetings', projectId], () => meetingApi.list(projectId), { enabled: source === 'meeting' && !!projectId, staleTime: 60_000 });
  const types = useWsQuery(['document-types'], documentApi.types, { staleTime: 300_000 });
  const templates = (types.data ?? []).filter((t) => t.sections.length > 0);
  const pastMeetings = (meetings.data ?? []).filter((m) => m.status !== 'Cancelled').sort((a, b) => b.startTime.localeCompare(a.startTime)).slice(0, 30);

  const ready = source === 'prompt' ? prompt.trim().length >= 3 : source === 'voice' ? !!voice : source === 'meeting' ? !!meetingId
    : source === 'tasks' ? !!projectId : source === 'files' ? files.length > 0 : !!templateId;

  const write = async () => {
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      setDraft(await docAiApi.draft({
        source, prompt: prompt.trim() || undefined, language,
        projectId: source === 'tasks' || source === 'meeting' || (source === 'template' && projectId) ? projectId || null : initialProject ?? null,
        meetingId: source === 'meeting' ? meetingId : null, templateTypeId: source === 'template' ? templateId : null,
        files: source === 'files' ? files : undefined, voice: source === 'voice' ? voice : null,
      }));
    } catch (e) { setError(e instanceof ApiError ? e.message : 'The AI could not write the page right now. Try again in a moment.'); }
    setBusy(false);
  };
  const use = async () => {
    if (!draft || using) return;
    setUsing(true);
    const fromProject = source === 'tasks' || source === 'meeting' || (source === 'template' && !!projectId) ? projectId || null : initialProject ?? null;
    try { await onUse(draft, { projectId: fromProject }); } finally { setUsing(false); }
  };

  return (
    <Modal title={draft ? draft.title : 'Write a page with AI'} subtitle={draft ? `Written from ${draft.sources.join(', ') || 'your request'}. You can change every word once it is in.` : 'Pick what to write from. You check the draft before anything is saved.'}
      size="lg" onClose={onClose} className="doc-scope"
      footer={draft ? <>
        <button type="button" className="btn btn-ghost" onClick={() => setDraft(null)}>Back</button>
        <button type="button" className="btn btn-ghost" onClick={() => void write()} disabled={busy}>{busy && <span className="spinner" />}Write again</button>
        <button type="button" className="btn btn-primary" onClick={() => void use()} disabled={using}>{using && <span className="spinner" />}{useLabel}</button>
      </> : <>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={() => void write()} disabled={!ready || busy}>{busy && <span className="spinner" />}{busy ? 'Writing…' : <><Icon name="sparkle" size={15} /> Write the page</>}</button>
      </>}>
      {error && <div className="doc-alert" role="alert"><div>{error}</div></div>}
      {draft ? (
        <div className="aid-preview" aria-label="The draft">
          <RichEditor key={draft.body} value={draft.body} readOnly label="The draft" minimal />
        </div>
      ) : (
        <div className="aid">
          <div className="aid-sources" role="radiogroup" aria-label="Write from">
            {SOURCES.map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={source === s.id} className={`aid-src${source === s.id ? ' on' : ''}`} onClick={() => { setSource(s.id); setError(null); }}>
                <span className="aid-src-icon ds-tile-ico" aria-hidden="true"><Icon name={s.icon} size={18} /></span><b>{s.label}</b><small>{s.hint}</small>
              </button>
            ))}
          </div>

          {(source === 'meeting' || source === 'tasks' || source === 'template') && projects.length > 0 && (
            <label className="field"><span>Project{source === 'template' ? ' (optional: its work fills the sections)' : ''}</span>
              <select className="input" value={projectId} onChange={(e) => { setProjectId(e.target.value); setMeetingId(''); }}>
                {source === 'template' && <option value="">No project</option>}
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
          )}
          {source === 'meeting' && (
            <label className="field"><span>Meeting</span>
              <select className="input" value={meetingId} onChange={(e) => setMeetingId(e.target.value)} disabled={meetings.isLoading}>
                <option value="">{meetings.isLoading ? 'Loading meetings…' : pastMeetings.length ? 'Choose a meeting' : 'No meetings in this project'}</option>
                {pastMeetings.map((m) => <option key={m.id} value={m.id}>{m.title} · {formatDateTime(m.startTime)}</option>)}
              </select></label>
          )}
          {source === 'template' && (
            <label className="field"><span>Template</span>
              <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Choose a template</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.icon} {t.name} · {t.sections.length} sections</option>)}
              </select></label>
          )}
          {source === 'files' && (
            <div className="field"><span>Files (up to 5)</span>
              <input type="file" multiple accept={ACCEPT} aria-label="Files to write from" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))} />
              {files.length > 0 && <ul className="aid-files">{files.map((f) => <li key={f.name}><Icon name="paperclip" size={14} /> {f.name} <small>{Math.max(1, Math.round(f.size / 1024))} KB</small></li>)}</ul>}
            </div>
          )}
          {source === 'voice' && <VoiceNote value={voice} onChange={setVoice} />}

          <label className="field"><span>{source === 'prompt' ? 'What should the page be?' : 'Anything to add (optional)'}</span>
            <textarea className="input" rows={source === 'prompt' ? 4 : 2} maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus={source === 'prompt'}
              placeholder={source === 'prompt' ? 'e.g. How we hand over a finished site to the customer: checks, documents, sign-off, who does what' : 'e.g. Keep it to one page; it is for the customer'} /></label>
          <label className="field aid-lang"><span>Write in</span>
            <select className="input" value={language} onChange={(e) => setLanguage(e.target.value as AiLanguage)}>{LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select></label>
        </div>
      )}
    </Modal>
  );
}
