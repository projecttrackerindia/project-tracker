import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchBlobUrl } from '../../api/client';
import { Icon, type IconName } from '../../components/Icon';
import { formatDateTime } from '../../lib/format';
import type { AiAction, AiAttachment, AiFeedbackReason, AiInsight, AiMessage, AiMode, AiStarter, AiTier, AiTierInfo, AiToolUse, AiUsage } from './aiApi';
import { Markdown } from './Markdown';

// ------------------------------------------------------------------ small marks

/** The assistant's mark: a slowly turning ring of light. `busy` quickens it while the assistant is working. */
export function Orb({ size = 32, busy = false }: { size?: number; busy?: boolean }) {
  return <span className={`ai-orb ${busy ? 'busy' : ''}`} style={{ width: size, height: size }} aria-hidden="true"><i /><Icon name="sparkle" size={Math.round(size * 0.46)} /></span>;
}

const TIER_ICON: Record<AiTier, IconName> = { quick: 'bolt', standard: 'sparkle', deep: 'target' };
const TIER_NAME: Record<AiTier, string> = { quick: 'Quick', standard: 'Standard', deep: 'Deep thinking' };
export const tierName = (t: AiTier) => TIER_NAME[t];

const fileSize = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// ------------------------------------------------------------------ header controls

/** Auto lets the assistant pick the cheapest level that suits the question; the others fix it. Levels above the plan are locked. */
export function ModeSwitch({ mode, onChange, usage, disabled }: { mode: AiMode; onChange: (m: AiMode) => void; usage?: AiUsage; disabled?: boolean }) {
  const options: { id: AiMode; label: string; icon: IconName; info?: AiTierInfo; hint: string }[] = [
    { id: 'auto', label: 'Auto', icon: 'refresh', hint: 'The assistant picks the right level for each question and keeps simple ones fast and cheap.' },
    ...(['quick', 'standard', 'deep'] as AiTier[]).map((t) => {
      const info = usage?.tiers.find((x) => x.id === t);
      return { id: t as AiMode, label: t === 'deep' ? 'Deep' : TIER_NAME[t], icon: TIER_ICON[t], info, hint: `${info?.description ?? ''}${info ? ` · ${info.credits} credit${info.credits === 1 ? '' : 's'} per answer` : ''}` };
    }),
  ];
  return (
    <div className="ai-modes" role="radiogroup" aria-label="How much thinking">
      {options.map((o) => {
        const locked = o.info ? !o.info.allowed : false;
        return (
          <button key={o.id} type="button" role="radio" aria-checked={mode === o.id} disabled={disabled}
            className={`ai-mode ${mode === o.id ? 'on' : ''} ${locked ? 'locked' : ''}`} title={locked ? `${o.label} is not included in your plan` : o.hint}
            onClick={() => onChange(locked ? mode : o.id)} aria-disabled={locked}>
            <Icon name={locked ? 'lock' : o.icon} size={13} /><span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A ring showing how much of the month's credits is left. */
export function CreditMeter({ usage }: { usage?: AiUsage }) {
  if (!usage) return null;
  const unlimited = usage.unlimited;
  const pct = unlimited ? 100 : usage.creditsLimit > 0 ? Math.max(0, Math.min(100, (usage.creditsLeft / usage.creditsLimit) * 100)) : 0;
  const low = !unlimited && pct < 15;
  const r = 15, c = 2 * Math.PI * r;
  return (
    <div className={`ai-credits ${low ? 'low' : ''}`} title={unlimited ? 'Unlimited AI credits on your plan' : `${usage.creditsUsed.toLocaleString()} of ${usage.creditsLimit.toLocaleString()} credits used this month. They renew on the 1st.`}>
      <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden="true">
        <circle cx="19" cy="19" r={r} className="ring-bg" />
        <circle cx="19" cy="19" r={r} className="ring" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 19 19)" />
      </svg>
      <span><b>{unlimited ? 'Unlimited' : usage.creditsLeft.toLocaleString()}</b><i>{unlimited ? 'credits' : 'credits left'}</i></span>
    </div>
  );
}

// ------------------------------------------------------------------ an answer's parts

export function RouteChip({ tier, reason, credits, limited, wanted }: { tier: AiTier; reason?: string | null; credits?: number; limited?: boolean; wanted?: AiTier }) {
  return (
    <span className={`ai-route ${tier}`} title={reason ?? undefined}>
      <Icon name={TIER_ICON[tier]} size={12} />{TIER_NAME[tier]}
      {credits ? <em>−{credits}</em> : null}
      {limited && wanted ? <b title={`This deserved ${TIER_NAME[wanted]}, but your plan or remaining credits allow ${TIER_NAME[tier]}.`}>limited</b> : null}
    </span>
  );
}

/** The model's own summary of its reasoning, folded away once the answer is written. */
export function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => { setOpen(live); }, [live]);
  if (!text && !live) return null;
  return (
    <div className={`ai-reason ${live ? 'live' : ''}`}>
      <button type="button" className="ai-reason-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="ai-pulse" />{live ? 'Thinking…' : 'How I approached this'}<Icon name={open ? 'chevronD' : 'chevronR'} size={13} />
      </button>
      {open && <div className="ai-reason-body">{text || 'Working out how to approach this…'}</div>}
    </div>
  );
}

export function ToolChips({ tools }: { tools: (AiToolUse & { state?: 'running' | 'done' | 'failed' })[] }) {
  // A lookup that failed is not shown as a chip: the assistant tells the person in words what it could not read.
  const shown = tools.filter((t) => t.state !== 'failed');
  if (shown.length === 0) return null;
  return (
    <div className="ai-tools">
      {shown.map((t, i) => (
        <span key={`${t.label}${i}`} className={`ai-tool ${t.state ?? 'done'}`}>
          {t.state === 'running' ? <span className="spinner" /> : <Icon name={t.state === 'failed' ? 'alert' : 'tick'} size={12} />}{t.label}
        </span>
      ))}
    </div>
  );
}

/** A change the assistant proposed. Nothing happens until Confirm. */
export function ActionCard({ action, onConfirm, onDismiss, onReconcile, busy, blocked = false }: { action: AiAction; onConfirm: () => void; onDismiss: () => void; onReconcile?: () => void; busy: boolean; blocked?: boolean }) {
  const nav = useNavigate();
  const expiresAt = action.lifecycle?.expiresAt;
  const [expired, setExpired] = useState(() => !!expiresAt && Date.parse(expiresAt) <= Date.now());
  useEffect(() => {
    if (action.status !== 'proposed' || !expiresAt) return;
    const timeout = window.setTimeout(() => setExpired(true), Math.max(0, Date.parse(expiresAt) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [action.status, expiresAt]);
  const icon: IconName = action.kind === 'send_report' ? 'mail' : action.kind === 'reminder' ? 'alarm' : 'plus';
  return (
    <div className={`ai-action ${action.status}`}>
      <span className="ai-action-icon"><Icon name={icon} size={16} /></span>
      <div className="ai-action-main">
        <b>{action.title}</b>
        <span>{action.summary}</span>
        {action.status === 'failed' && <span className="ai-action-error">{action.error}</span>}
        {action.preview && (
          <details className="ai-action-preview" open={action.kind === 'send_message'}>
            <summary>{action.kind === 'send_report' ? 'Read the report before it is sent' : 'Details'}</summary>
            <Markdown text={action.preview} />
          </details>
        )}
      </div>
      <div className="ai-action-side">
        {action.status === 'proposed' && <>
          {expired && <span className="ai-action-state">Expired. Request a new proposal.</span>}
          {!expired && blocked && <span className="ai-action-state">Complete the prerequisite suggestion first.</span>}
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !!expired || blocked} onClick={onConfirm}>Confirm</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onDismiss}>Not now</button>
        </>}
        {action.status === 'running' && <><span className="ai-action-state"><span className="spinner" /> Working…</span>{action.kind === 'send_message' && onReconcile && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onReconcile}>Check saved result</button>}</>}
        {action.status === 'done' && <span className="ai-action-state ok"><Icon name="checkCircle" size={14} /> Done{action.link && <button type="button" className="link-btn" onClick={() => nav(action.link!)}>Open</button>}</span>}
        {action.status === 'dismissed' && <span className="ai-action-state">Dismissed</span>}
        {action.status === 'failed' && <><span className="ai-action-state">Check the application before making a new proposal.</span>{action.kind === 'send_message' && onReconcile && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onReconcile}>Check saved result</button>}</>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ files

/** A picture or file that came with a question. Pictures are fetched with the person's sign-in and shown small. */
export function AttachmentView({ file }: { file: AiAttachment }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.isImage) return;
    const ac = new AbortController();
    let made: string | null = null;
    fetchBlobUrl(`/ai/files/${file.id}?inline=true`, ac.signal).then((u) => { made = u; setUrl(u); }).catch(() => { /* the file may be gone; the name is still shown */ });
    return () => { ac.abort(); if (made) URL.revokeObjectURL(made); };
  }, [file.id, file.isImage]);
  return file.isImage && url
    ? <img className="ai-thumb" src={url} alt={file.name} title={file.name} />
    : <span className="ai-file"><Icon name={file.isImage ? 'image' : 'note'} size={14} /><span>{file.name}</span><em>{fileSize(file.sizeBytes)}</em></span>;
}

// ------------------------------------------------------------------ one message

/** The "<followups>…" line the assistant ends with is for the chips below the answer, not for reading; this hides it, even while it is still being typed. */
export function withoutTrailer(text: string): string {
  const at = text.search(/<followups/i);
  return at < 0 ? text : text.slice(0, at).trimEnd();
}

const REASONS: { id: AiFeedbackReason; label: string }[] = [{ id: 'too_long', label: 'Too long' }, { id: 'too_short', label: 'Too short' }, { id: 'wrong', label: 'Wrong' }, { id: 'off_topic', label: 'Off topic' }];

function Feedback({ m, onFeedback }: { m: AiMessage; onFeedback: (rating: 'up' | 'down' | 'none', reason?: AiFeedbackReason) => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button type="button" className={`ai-foot-btn${m.feedback === 'up' ? ' on' : ''}`} aria-pressed={m.feedback === 'up'} onClick={() => { setAsking(false); onFeedback(m.feedback === 'up' ? 'none' : 'up'); }}><Icon name="checkCircle" size={13} /> Helpful</button>
      <button type="button" className={`ai-foot-btn${m.feedback === 'down' ? ' on' : ''}`} aria-pressed={m.feedback === 'down'} onClick={() => { if (m.feedback === 'down') onFeedback('none'); else setAsking((a) => !a); }}><Icon name="close" size={13} /> Not helpful</button>
      {asking && m.feedback !== 'down' && (
        <span className="ai-why" role="group" aria-label="What was wrong?">
          {REASONS.map((r) => <button key={r.id} type="button" onClick={() => { setAsking(false); onFeedback('down', r.id); }}>{r.label}</button>)}
        </span>
      )}
    </>
  );
}

export function MessageView({ m, onConfirm, onDismiss, onReconcile, onCopy, onDownload, onRegenerate, onEmail, onFollowUp, onFeedback, onConfirmAll, busyAction, canEmail, canRegenerate }: {
  m: AiMessage; onReconcile?: (a: AiAction) => void; onConfirm: (a: AiAction) => void; onDismiss: (a: AiAction) => void; onCopy: () => void; onDownload: () => void;
  onRegenerate?: () => void; onEmail?: () => void; onFollowUp?: (text: string) => void; onConfirmAll?: () => void; onFeedback?: (rating: 'up' | 'down' | 'none', reason?: AiFeedbackReason) => void;
  busyAction: string | null; canEmail: boolean; canRegenerate: boolean;
}) {
  if (m.role === 'user') {
    return (
      <div className="ai-msg user">
        <div className="ai-bubble">
          {m.attachments.length > 0 && <div className="ai-attached">{m.attachments.map((a) => <AttachmentView key={a.id} file={a} />)}</div>}
          <p>{m.content}</p>
        </div>
      </div>
    );
  }
  const failed = m.status === 'failed';
  return (
    <div className="ai-msg assistant">
      <Orb size={30} />
      <div className="ai-body">
        <div className="ai-meta">
          <b>Assistant</b>
          {m.tier && <RouteChip tier={m.tier} reason={m.routeReason} credits={m.credits || undefined} />}
          {m.status === 'stopped' && <span className="ai-stopped">stopped</span>}
          <time>{formatDateTime(m.createdAt)}</time>
        </div>
        {m.reasoning && <Reasoning text={m.reasoning} live={false} />}
        <ToolChips tools={m.tools} />
        {failed ? <div className="ai-error" role="alert"><Icon name="alert" size={15} /><span>{m.content}</span></div> : <Markdown text={withoutTrailer(m.content)} />}
        {!failed && (m.unverifiedKeys?.length ?? 0) > 0 && (
          <div className="ai-check" role="note"><Icon name="alert" size={14} /><span>Please check <b>{m.unverifiedKeys!.join(', ')}</b>: I mentioned {m.unverifiedKeys!.length === 1 ? 'it' : 'them'} but did not find {m.unverifiedKeys!.length === 1 ? 'it' : 'them'} in your data.</span></div>
        )}
        {onConfirmAll && m.actions.filter((a) => a.status === 'proposed').length >= 2 && (
          <div className="ai-plan"><span>{m.actions.filter((a) => a.status === 'proposed').length} changes are ready</span>
            <button type="button" className="btn btn-primary btn-sm" disabled={busyAction !== null} onClick={onConfirmAll}>{busyAction === 'all' ? 'Working…' : 'Confirm all in order'}</button></div>
        )}
        {m.actions.map((a) => <ActionCard key={a.id} action={a} busy={busyAction === a.id} blocked={a.lifecycle?.dependsOn.some((id) => m.actions.find((step) => step.id === id)?.status !== 'done')} onConfirm={() => onConfirm(a)} onDismiss={() => onDismiss(a)} onReconcile={onReconcile ? () => onReconcile(a) : undefined} />)}
        {!failed && m.content && (
          <div className="ai-foot">
            <button type="button" className="ai-foot-btn" onClick={onCopy}><Icon name="copy" size={13} /> Copy</button>
            <button type="button" className="ai-foot-btn" onClick={onDownload}><Icon name="download" size={13} /> Download</button>
            {canEmail && onEmail && <button type="button" className="ai-foot-btn" onClick={onEmail}><Icon name="mail" size={13} /> Email me this</button>}
            {canRegenerate && onRegenerate && <button type="button" className="ai-foot-btn" onClick={onRegenerate}><Icon name="refresh" size={13} /> Try again</button>}
            {onFeedback && <Feedback m={m} onFeedback={onFeedback} />}
          </div>
        )}
        {!failed && canRegenerate && onFollowUp && (m.followUps?.length ?? 0) > 0 && (
          <div className="ai-next" role="group" aria-label="Suggested next steps">{m.followUps!.map((f) => <button key={f} type="button" onClick={() => onFollowUp(f)}>{f}</button>)}</div>
        )}
        {failed && canRegenerate && onRegenerate && <div className="ai-foot"><button type="button" className="ai-foot-btn" onClick={onRegenerate}><Icon name="refresh" size={13} /> Try again</button></div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the empty page

export interface Suggestion { icon: IconName; title: string; text: string; prompt: string; mode?: AiMode; attach?: boolean }

export const SUGGESTIONS: Suggestion[] = [
  { icon: 'dashboard', title: 'Summarise my portfolio', text: 'What needs attention across my projects, and what is going well.', prompt: 'Give me an executive summary of all active projects: what needs attention, what is going well and what I should do next.' },
  { icon: 'alert', title: 'What is at risk this week?', text: 'Find the work most likely to slip and say why.', prompt: 'Which projects and tasks are most at risk of missing their dates in the next two weeks, and why? Rank them and recommend what to do about each.', mode: 'deep' },
  { icon: 'target', title: 'Plan my day', text: 'Order my open and overdue work by what matters.', prompt: 'Look at my open and overdue work and plan my day: what to do first, what can wait, and what I should delegate.' },
  { icon: 'users', title: 'Check team workload', text: 'Who is stretched, who has room, and how to rebalance.', prompt: 'Review the workload across my team. Who is overloaded, who has capacity, and how should we rebalance the work?', mode: 'deep' },
  { icon: 'chart', title: 'Write a status report', text: 'A shareable weekly report, ready to email.', prompt: 'Write a weekly status report for leadership covering progress, risks and next steps across my projects, then offer to email it to me.' },
  { icon: 'image', title: 'Read a file for me', text: 'A screenshot, spreadsheet, PDF or document.', prompt: '', attach: true },
];

export function Hero({ name, onPick, onAsk, canAttach, starters, insights }: { name: string; onPick: (s: Suggestion) => void; onAsk: (prompt: string) => void; canAttach: boolean; starters?: AiStarter[]; insights?: AiInsight[] }) {
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return (
    <div className="ai-hero">
      <Orb size={92} />
      <h1>{greeting}{name ? `, ${name}` : ''}.</h1>
      <p>Ask anything about your work. I read your projects, people and files, reason through hard problems, and prepare changes for you to confirm.</p>
      {insights && insights.length > 0 && (
        <div className="ai-insights" aria-label="Worth a look">
          <h3>Worth a look</h3>
          {insights.map((i) => (
            <button key={i.id} type="button" className={`ai-insight ${i.severity}`} onClick={() => onAsk(i.prompt)}>
              <b>{i.title}</b><span>{i.detail}</span><em>Analyse with AI</em>
            </button>
          ))}
        </div>
      )}
      {starters && starters.length > 0 && (
        <div className="ai-now" aria-label="Right now">
          {starters.map((s) => <button key={s.label} type="button" onClick={() => onAsk(s.prompt)}><b>{s.label}</b>{s.hint && <span>{s.hint}</span>}</button>)}
        </div>
      )}
      <div className="ai-suggest">
        {SUGGESTIONS.filter((s) => !s.attach || canAttach).map((s) => (
          <button key={s.title} type="button" className="ai-suggest-card" onClick={() => onPick(s)}>
            <span className="ai-suggest-icon"><Icon name={s.icon} size={17} /></span>
            <b>{s.title}</b><span>{s.text}</span>
            {s.mode === 'deep' && <em><Icon name="target" size={11} /> deep thinking</em>}
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ composer

export interface PendingFile { localId: string; file: File; status: 'uploading' | 'ready' | 'error'; attachment?: AiAttachment; previewUrl?: string; error?: string }

export function Composer({ value, onChange, onSend, onStop, onFiles, onRemoveFile, files, streaming, canAttach, usage, mode, disabledReason }: {
  value: string; onChange: (v: string) => void; onSend: () => void; onStop: () => void; onFiles: (f: File[]) => void; onRemoveFile: (id: string) => void;
  files: PendingFile[]; streaming: boolean; canAttach: boolean; usage?: AiUsage; mode: AiMode; disabledReason?: string | null;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const uploading = files.some((f) => f.status === 'uploading');
  const ready = value.trim().length > 0 || files.some((f) => f.status === 'ready');
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!streaming && ready && !uploading && !disabledReason) onSend(); }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length > 0 && canAttach) { e.preventDefault(); onFiles(pasted); }
  };
  const accept = usage ? usage.attachmentTypes.map((x) => `.${x}`).join(',') : undefined;

  return (
    <div className="ai-composer">
      {files.length > 0 && (
        <div className="ai-pending">
          {files.map((f) => (
            <span key={f.localId} className={`ai-pending-item ${f.status}`} title={f.error ?? f.file.name}>
              {f.previewUrl ? <img src={f.previewUrl} alt="" /> : <Icon name="note" size={15} />}
              <span className="ai-pending-name">{f.file.name}</span>
              {f.status === 'uploading' && <span className="spinner" />}
              {f.status === 'error' && <Icon name="alert" size={13} />}
              <button type="button" aria-label={`Remove ${f.file.name}`} onClick={() => onRemoveFile(f.localId)}><Icon name="close" size={12} /></button>
            </span>
          ))}
        </div>
      )}
      <div className={`ai-box ${streaming ? 'busy' : ''}`}>
        <button type="button" className="ai-attach" disabled={!canAttach || streaming} aria-label="Attach files"
          title={canAttach ? 'Attach pictures, PDFs, spreadsheets or documents' : 'Reading files is not included in your plan'} onClick={() => picker.current?.click()}>
          <Icon name="paperclip" size={18} />
        </button>
        <input ref={picker} type="file" multiple hidden accept={accept} onChange={(e) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        <textarea ref={area} rows={1} value={value} maxLength={8000} placeholder={disabledReason ?? 'Ask about your work, or paste a screenshot…'} aria-label="Message the assistant"
          onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onPaste={onPaste} disabled={!!disabledReason} />
        {streaming
          ? <button type="button" className="ai-send stop" onClick={onStop} aria-label="Stop"><span className="ai-stop-square" /></button>
          : <button type="button" className="ai-send" onClick={onSend} disabled={!ready || uploading || !!disabledReason} aria-label="Send"><Icon name="send" size={17} /></button>}
      </div>
      <div className="ai-fineprint">
        <span><Icon name="lock" size={11} /> Only what you can already see is shared with the model. Check important answers before acting on them.</span>
        <span>{mode === 'auto' ? 'Auto level' : `${TIER_NAME[mode as AiTier]} level`} · Enter to send, Shift+Enter for a new line</span>
      </div>
    </div>
  );
}

export function DropOverlay() {
  return <div className="ai-drop"><Icon name="upload" size={30} /><b>Drop to attach</b><span>Pictures, PDFs, spreadsheets and documents</span></div>;
}

/** Marks a drag that carries files (so the overlay is not shown for dragged text). */
export const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

export function PlanNotice({ title, text, to, action }: { title: string; text: string; to?: string; action?: string }) {
  return (
    <div className="ai-notice">
      <Orb size={64} />
      <h2>{title}</h2>
      <p>{text}</p>
      {to && <Link className="btn btn-primary" to={to}>{action ?? 'Open'}</Link>}
    </div>
  );
}
