import { useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Modal, Spinner } from '../../components/ui';
import { confirmDialog, toast } from '../../stores/ui';
import { offerReminderAfterSend } from '../reminders/Suggestions';
import { AgentTools, errText, type Account } from '../mailbox/MailParts';
import { mailboxApi, type MailAttachment } from '../mailbox/mailboxApi';
import { TEMPLATES, type MailDraft, type MailLocal } from './mailSmart';

export interface ComposeInit { to?: string; cc?: string; subject?: string; body?: string; account?: string; draftId?: string }

const MAX_TOTAL = 15 * 1024 * 1024;
const fileToAttachment = (f: File) => new Promise<MailAttachment>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve({ name: f.name, contentType: f.type || 'application/octet-stream', data: String(r.result).split(',')[1] ?? '' });
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});
const sizeOf = (a: MailAttachment) => Math.floor((a.data.length * 3) / 4);
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** When "Schedule" can send: later today, tomorrow morning, Monday morning, or a chosen time. */
function presets(now = new Date()) {
  const at = (d: Date, h: number) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return x; };
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const monday = new Date(now); monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  const list = [{ label: 'Tomorrow 9:00 AM', at: at(tomorrow, 9) }, { label: 'Monday 9:00 AM', at: at(monday, 9) }];
  if (now.getHours() < 16) list.unshift({ label: 'This evening 6:00 PM', at: at(now, 18) });
  return list;
}

/**
 * The composer: write, or describe the mail in a sentence and let the assistant draft it; start from a template; attach files; send now
 * or schedule it. Closing with words in it keeps it in Drafts.
 */
export function Composer({ accounts, init, agent, onClose, onSent, update }: {
  accounts: Account[]; init: ComposeInit; agent: boolean; onClose: () => void; onSent: () => void; update: (fn: (m: MailLocal) => MailLocal) => void;
}) {
  const [from, setFrom] = useState(init.account && accounts.some((a) => a.key === init.account) ? init.account : accounts[0]?.key ?? '');
  const [to, setTo] = useState(init.to ?? '');
  const [cc, setCc] = useState(init.cc ?? '');
  const [showCc, setShowCc] = useState(!!init.cc);
  const [subject, setSubject] = useState(init.subject ?? '');
  const [body, setBody] = useState(init.body ?? '');
  const [files, setFiles] = useState<MailAttachment[]>([]);
  const [idea, setIdea] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [when, setWhen] = useState('');
  const [custom, setCustom] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const account = accounts.find((a) => a.key === from);
  const total = files.reduce((n, f) => n + sizeOf(f), 0);
  const ready = !!account && !!to.trim() && !!body.trim();

  const draftFromIdea = async () => {
    if (!idea.trim()) return;
    setDrafting(true);
    try {
      const r = await mailboxApi.compose({ draft: `${idea.trim()}${subject ? `\n(Subject: ${subject})` : ''}${body.trim() ? `\n\n${body}` : ''}`, mode: 'complete' });
      setBody(r.body);
      if (!subject.trim()) setSubject(idea.trim().replace(/^(write|draft|send|mail|email)\s+(a |an )?(mail |email )?(to \S+ )?/i, '').replace(/^./, (c) => c.toUpperCase()).slice(0, 80));
      setIdea('');
    } catch (e) { toast(errText(e, 'The assistant could not draft this mail.'), 'error'); }
    finally { setDrafting(false); }
  };
  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    try {
      const next = [...files, ...(await Promise.all(Array.from(list).map(fileToAttachment)))];
      if (next.length > 10) { toast('Attach at most 10 files.', 'error'); return; }
      if (next.reduce((n, f) => n + sizeOf(f), 0) > MAX_TOTAL) { toast('Attachments can be up to 15 MB in all.', 'error'); return; }
      setFiles(next);
    } catch { toast('A file could not be read.', 'error'); }
  };
  const draft = (): MailDraft => ({ id: init.draftId ?? `d${Date.now().toString(36)}`, account: from, to, cc, subject, body, savedAt: new Date().toISOString() });
  const dropDraft = () => { if (init.draftId) update((m) => ({ ...m, drafts: m.drafts.filter((d) => d.id !== init.draftId) })); };
  const close = () => {
    if (body.trim() || subject.trim()) {
      const d = draft();
      update((m) => ({ ...m, drafts: [d, ...m.drafts.filter((x) => x.id !== d.id)] }));
      toast('Saved to Drafts.');
    }
    onClose();
  };
  const send = async () => {
    if (!account) return;
    const at = when === 'custom' ? (custom ? new Date(custom) : null) : when ? new Date(when) : null;
    if (at) {
      if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000) { toast('Pick a time in the future.', 'error'); return; }
      update((m) => ({ ...m, drafts: m.drafts.filter((d) => d.id !== init.draftId), scheduled: [...m.scheduled, { ...draft(), at: at.toISOString(), attachments: files }] }));
      toast(`Scheduled for ${at.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}. It goes out when Project Tracker is open.`);
      onClose();
      return;
    }
    if (!(await confirmDialog({ title: 'Send this email?', message: `From ${account.email} to ${to}${cc ? `, cc ${cc}` : ''}${files.length ? `, with ${files.length} attachment${files.length === 1 ? '' : 's'}` : ''}.`, confirmText: 'Send' }))) return;
    setSending(true);
    try {
      await mailboxApi.send({ account: account.key, to, cc, subject, body, attachments: files.length ? files : undefined, confirmed: true });
      toast('Email sent.'); offerReminderAfterSend(body, 'email'); dropDraft(); onSent(); onClose();
    } catch (e) { toast(errText(e, 'The email could not be sent.'), 'error'); }
    finally { setSending(false); }
  };

  return (
    <Modal title="New message" onClose={close} size="lg" className="ml-compose-modal" footer={<>
      <button type="button" className="btn btn-ghost" onClick={() => { dropDraft(); onClose(); }}>Discard</button>
      <Select className="select ml-when" aria-label="When to send" value={when} onChange={(e) => setWhen(e.target.value)}>
        <option value="">Send now</option>
        {presets().map((p) => <option key={p.label} value={p.at.toISOString()}>{p.label}</option>)}
        <option value="custom">Pick a time…</option>
      </Select>
      {when === 'custom' && <input type="datetime-local" className="input ml-when-at" aria-label="Send at" value={custom} onChange={(e) => setCustom(e.target.value)} />}
      <button type="button" className="btn btn-primary" disabled={sending || !ready} onClick={() => void send()} data-testid="ml-send">
        {sending ? <Spinner /> : <Icon name={when ? 'clock' : 'send'} size={14} />} {when ? 'Schedule' : 'Send'}</button>
    </>}>
      {accounts.length === 0 ? <p className="muted">Connect a mail account that can send first (Settings › Integrations › Mail).</p> : <div className="mb-compose ml-compose" data-testid="ml-composer">
        {agent && (
          <form className="ml-idea" onSubmit={(e) => { e.preventDefault(); void draftFromIdea(); }}>
            <span className="ml-orb" aria-hidden="true" />
            <input value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="Describe the mail — “ask CRIF to whitelist our UAT IP by Thursday”" aria-label="Describe the mail for the assistant" />
            <button type="submit" className="btn btn-sm" disabled={drafting || !idea.trim()}>{drafting ? <Spinner /> : null} Draft it</button>
          </form>
        )}
        <label className="mb-line"><span>From</span>
          <Select className="select" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)}>{accounts.map((a) => <option key={a.key} value={a.key}>{a.label} · {a.email}</option>)}</Select>
        </label>
        <label className="mb-line"><span>To</span><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com, …" />
          {!showCc && <button type="button" className="mb-link" onClick={() => setShowCc(true)}>Cc</button>}</label>
        {showCc && <label className="mb-line"><span>Cc</span><input value={cc} onChange={(e) => setCc(e.target.value)} /></label>}
        <label className="mb-line"><span>Subject</span><input value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
        <div className="ml-templates" role="group" aria-label="Templates">
          <span>Templates</span>
          {TEMPLATES.map((t) => <button key={t.id} type="button" className="ds-chip" onClick={() => { if (!subject.trim()) setSubject(t.subject); setBody((b) => (b.trim() ? `${b.trimEnd()}\n\n${t.body}` : t.body)); }}>{t.label}</button>)}
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={11} placeholder="Write your message…" aria-label="Message"
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && ready) void send(); }} />
        <AgentTools draft={body} setDraft={setBody} agent={agent} replying={false} />
        <div className="ml-files">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => fileInput.current?.click()}><Icon name="paperclip" size={14} /> Attach</button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} aria-label="Attach files" />
          {files.map((f, i) => (
            <span key={`${f.name}${i}`} className="ml-file"><Icon name="paperclip" size={12} />{f.name}<small>{kb(sizeOf(f))}</small>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}><Icon name="close" size={11} /></button></span>
          ))}
          {files.length > 0 && <small className="muted">{kb(total)} of 15 MB</small>}
        </div>
      </div>}
    </Modal>
  );
}
