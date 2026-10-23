import { VoiceInput } from './VoiceInput';
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchBlobUrl } from '../../api/client';
import { Icon, type IconName } from '../../components/Icon';
import { formatDateTime } from '../../lib/format';
import type { AiAction, AiAttachment, AiFeedbackReason, AiInsight, AiMessage, AiMode, AiPlanStep, AiStarter, AiTier, AiTierInfo, AiToolUse, AiUsage } from './aiApi';
import { Markdown } from './Markdown';
import { useDetailsDismiss } from '../../lib/hooks';
import { AI_NAME } from './aiBrand';
import { AgentMark } from '../../components/AgentMark';
import { useAuth } from '../../stores/auth';

// ------------------------------------------------------------------ small marks

/** Shared Agent identity, including a reduced-motion alternative. */
export function Orb({ size = 32, busy = false, animated = false }: { size?: number; busy?: boolean; animated?: boolean }) {
  return <AgentMark size={size} busy={busy} animated={animated} />;
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
  const available = options.filter(o => !o.info || o.info.allowed);
  const selectedTab = available.some(o => o.id === mode) ? mode : 'auto';
  const move = (event: KeyboardEvent<HTMLButtonElement>, current: AiMode) => {
    if (disabled || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = available.findIndex(o => o.id === current);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
      : (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length;
    onChange(available[next].id);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-mode="${available[next].id}"]`)?.focus();
  };
  return (
    <div className="ai-modes" role="radiogroup" aria-label="How much thinking">
      {options.map((o) => {
        const locked = o.info ? !o.info.allowed : false;
        return (
          <button key={o.id} type="button" role="radio" data-mode={o.id} aria-checked={mode === o.id} disabled={disabled}
            tabIndex={!locked && o.id === selectedTab ? 0 : -1} onKeyDown={event => move(event, o.id)}
            className={`ai-mode ${mode === o.id ? 'on' : ''} ${locked ? 'locked' : ''}`} title={locked ? `${o.label} is not included in your plan` : o.hint}
            onClick={() => onChange(locked ? mode : o.id)} aria-disabled={locked}>
            <Icon name={locked ? 'lock' : o.icon} size={13} /><span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}



/**
 * The thinking level as one small menu inside the ask box (Auto, Quick, Standard, Deep), in place of the row of buttons.
 * Each level shows what it is for and what an answer costs; levels above the plan are shown locked.
 */
export function ModeMenu({ mode, onChange, usage, disabled }: { mode: AiMode; onChange: (m: AiMode) => void; usage?: AiUsage; disabled?: boolean }) {
  const control = useRef<HTMLDetailsElement>(null);
  useDetailsDismiss(control);
  const options: { id: AiMode; label: string; icon: IconName; info?: AiTierInfo; hint: string }[] = [
    { id: 'auto', label: 'Auto', icon: 'refresh', hint: 'Picks the right level for each question' },
    ...(['quick', 'standard', 'deep'] as AiTier[]).map((t) => {
      const info = usage?.tiers.find((x) => x.id === t);
      return { id: t as AiMode, label: TIER_NAME[t], icon: TIER_ICON[t], info, hint: `${info?.description ?? ''}${info ? `${info.description ? ' · ' : ''}${info.credits} credit${info.credits === 1 ? '' : 's'}` : ''}` };
    }),
  ];
  const current = options.find((o) => o.id === mode) ?? options[0];
  const choose = (o: (typeof options)[number]) => {
    if (o.info && !o.info.allowed) return;
    onChange(o.id);
    if (control.current) { control.current.open = false; control.current.querySelector('summary')?.focus(); }
  };
  return (
    <details ref={control} className={`ai-menu ai-mode-menu${disabled ? ' disabled' : ''}`} onToggle={(e) => { if (disabled) e.currentTarget.open = false; }}>
      <summary className="ai-chip-btn" aria-label={`Thinking level: ${current.label}`} title="How much thinking">
        <Icon name={current.icon} size={14} /><span>{current.id === 'deep' ? 'Deep' : current.label}</span><Icon name="chevronD" size={12} />
      </summary>
      <div className="ai-menu-panel" role="menu" aria-label="How much thinking">
        {options.map((o) => {
          const locked = o.info ? !o.info.allowed : false;
          return (
            <button key={o.id} type="button" role="menuitemradio" aria-checked={mode === o.id} aria-disabled={locked} className={`ai-menu-item${mode === o.id ? ' on' : ''}${locked ? ' locked' : ''}`}
              onClick={() => choose(o)} title={locked ? `${o.label} is not included in your plan` : undefined}>
              <Icon name={locked ? 'lock' : o.icon} size={15} />
              <span><b>{o.label}</b>{o.hint && <small>{locked ? 'Not in your plan' : o.hint}</small>}</span>
              {mode === o.id && <Icon name="check" size={14} />}
            </button>
          );
        })}
      </div>
    </details>
  );
}

/** A compact balance control. The arc represents remaining organization credits, never provider capacity. `compact`: just the ring. */
export function CreditMeter({ usage, compact = false }: { usage?: AiUsage; compact?: boolean }) {
  const role = useAuth((s) => s.ctx?.current?.role);
  const control = useRef<HTMLDetailsElement>(null);
  useDetailsDismiss(control);
  if (!usage) return null;
  const unlimited = usage.unlimited;
  const pct = unlimited ? 100 : usage.creditsLimit > 0 ? Math.max(0, Math.min(100, (usage.creditsLeft / usage.creditsLimit) * 100)) : 0;
  const low = !unlimited && pct < 15;
  const r = 17, c = 2 * Math.PI * r;
  return (
    <details ref={control} className={`ai-credit-control ${low ? 'low' : ''}${compact ? ' compact' : ''}`}>
      <summary className="ai-credit-button" aria-label={unlimited ? 'Usage: unlimited organization credits' : `Usage: ${usage.creditsLeft.toLocaleString()} organization credits remaining, ${Math.round(pct)} percent`} title="View organization credit balance">
        <span className="ai-credit-ring">
          <svg width="42" height="42" viewBox="0 0 42 42" aria-hidden="true">
            <circle cx="21" cy="21" r={r} className="ring-bg" />
            <circle cx="21" cy="21" r={r} className="ring" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 21 21)" />
          </svg>
          <Icon name={unlimited ? 'sparkle' : 'bolt'} size={15} />
        </span>
        {!compact && <><span>Usage</span><Icon name="chevronD" size={12} /></>}
      </summary>
      <div className="ai-credit-panel">
        <div className="ai-credit-panel-heading"><span>Organization credits</span><Icon name="agent" size={18} /></div>
        <strong>{unlimited ? 'Unlimited' : usage.creditsLeft.toLocaleString()}<small>{unlimited ? 'on your plan' : 'remaining'}</small></strong>
        {!unlimited && <>
          <div className="ai-credit-bar" role="meter" aria-label="Organization credits remaining" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${usage.creditsLeft.toLocaleString()} credits remaining`}><span style={{ width: `${pct}%` }} /></div>
          <div className="ai-credit-caption"><span>{Math.round(pct)}% remaining</span><span>{usage.creditsLimit.toLocaleString()} monthly</span></div>
        </>}
        <p>Shared across your organization. Monthly credits renew on the 1st (UTC).</p>
        <p>Auto selects a level within your plan. Request safeguards and any user or team budget still apply.</p>
        {(role === 'Owner' || role === 'Admin') && <Link to="/settings/general" onClick={() => { if (control.current) control.current.open = false; }}>View usage & budgets <Icon name="chevronR" size={13} /></Link>}
      </div>
    </details>
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
  // The plan has its own checklist (PlanSteps), not a chip.
  const shown = tools.filter((t) => t.state !== 'failed' && t.name !== 'show_plan');
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

const STEP_LABEL: Record<AiPlanStep['state'], string> = { pending: 'To do', done: 'Done', waiting: 'Waiting for you', failed: 'Did not work', skipped: 'Not reached' };

/**
 * The plan for a request with several parts, as a checklist. A step that prepared a card follows that card: it is done once the card is
 * confirmed, and shows "Waiting for you" until then.
 */
export function PlanSteps({ steps, actions, live = false }: { steps: AiPlanStep[]; actions: AiAction[]; live?: boolean }) {
  const stateOf = (s: AiPlanStep): AiPlanStep['state'] => {
    const card = s.actionId ? actions.find((a) => a.id === s.actionId) : undefined;
    if (!card) return s.state;
    return card.status === 'done' ? 'done' : card.status === 'failed' ? 'failed' : card.status === 'dismissed' ? 'skipped' : 'waiting';
  };
  const states = steps.map(stateOf);
  const current = live ? states.findIndex((x) => x === 'pending') : -1;
  const finished = states.filter((x) => x === 'done').length;
  return (
    <section className="ai-steps" aria-label="Plan" data-testid="ai-plan">
      <header><Icon name="list" size={13} /><b>Plan</b><span>{finished} of {steps.length} done</span></header>
      <ol>
        {steps.map((s, i) => {
          const st = i === current ? 'running' : states[i];
          return (
            <li key={`${i}-${s.title}`} className={`st-${st}`}>
              <span className="ai-step-mark" aria-hidden>{st === 'running' ? <span className="spinner" /> : st === 'done' ? <Icon name="tick" size={11} /> : st === 'failed' ? <Icon name="close" size={11} /> : st === 'waiting' ? <Icon name="clock" size={11} /> : i + 1}</span>
              <span className="ai-step-title">{s.title}</span>
              <span className="ai-step-state">{st === 'running' ? 'Working…' : STEP_LABEL[states[i]]}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const ACTION_ICON: Record<string, IconName> = {
  send_report: 'mail', reminder: 'alarm', update_reminder: 'alarm', send_message: 'send', chat_reply: 'message', decide_agent_proposal: 'agent', review_timesheet: 'checks',
  submit_week: 'timer', log_time: 'timer', planned_leave: 'calendar', clear_notification: 'bell', edit_page: 'edit', page_comment: 'message', apply_portfolio_option: 'gauge',
  vault_request: 'key', vault_share: 'lock', update_work: 'edit', delete_work: 'trash', mail_forward: 'arrowRight', mail_reply: 'mail', answer_check_in: 'checkCircle', update_project: 'edit', start_meeting: 'video', start_call: 'video', schedule_meeting: 'video', invite_member: 'userPlus',
};

/** A change the assistant proposed. Nothing happens until Confirm. */
/** Minutes and seconds left to undo, ticking; null once the window has closed. */
function useUndoLeft(until: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  const end = until ? Date.parse(until) : NaN;
  useEffect(() => {
    if (!Number.isFinite(end) || end <= Date.now()) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [end]);
  return Number.isFinite(end) && end > now ? Math.ceil((end - now) / 1000) : null;
}

export function ActionCard({ action, onConfirm, onDismiss, onReconcile, onUndo, busy, blocked = false }: { action: AiAction; onConfirm: () => void; onDismiss: () => void; onReconcile?: () => void; onUndo?: () => void; busy: boolean; blocked?: boolean }) {
  const undoLeft = useUndoLeft(action.status === 'done' ? action.undoUntil : null);
  const nav = useNavigate();
  const expiresAt = action.lifecycle?.expiresAt;
  const [expired, setExpired] = useState(() => !!expiresAt && Date.parse(expiresAt) <= Date.now());
  useEffect(() => {
    if (action.status !== 'proposed' || !expiresAt) return;
    const timeout = window.setTimeout(() => setExpired(true), Math.max(0, Date.parse(expiresAt) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [action.status, expiresAt]);
  const icon: IconName = ACTION_ICON[action.kind] ?? 'plus';
  // A call the person just confirmed opens straight away: they asked to be in it.
  const seen = useRef(action.status);
  useEffect(() => {
    if (action.kind === 'start_call' && action.status === 'done' && seen.current !== 'done' && action.link) nav(action.link);
    seen.current = action.status;
  }, [action.kind, action.status, action.link, nav]);
  return (
    <div className={`ai-action ${action.status}`}>
      <span className="ai-action-icon"><Icon name={icon} size={16} /></span>
      <div className="ai-action-main">
        <b>{action.title}</b>
        <span>{action.summary}</span>
        {action.status === 'failed' && <span className="ai-action-error">{action.error}</span>}
        {action.preview && (
          <details className="ai-action-preview" open={action.kind === 'send_message' || action.kind === 'chat_reply'}>
            <summary>{action.kind === 'send_report' ? 'Read the report before it is sent' : action.kind === 'chat_reply' ? 'The exact message' : action.kind === 'edit_page' ? 'The text that goes on the page' : 'Details'}</summary>
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
        {action.status === 'done' && <span className="ai-action-state ok"><Icon name="checkCircle" size={14} /> Done{action.link && <button type="button" className="link-btn" onClick={() => nav(action.link!)}>{action.kind === 'start_call' ? 'Join' : 'Open'}</button>}</span>}
        {action.status === 'done' && onUndo && undoLeft !== null && (
          <button type="button" className="btn btn-ghost btn-sm ai-undo" data-testid="ai-undo" disabled={busy} onClick={onUndo} title={`Undo is available for ${Math.floor(undoLeft / 60)}:${String(undoLeft % 60).padStart(2, '0')} more`}>
            <Icon name="undo" size={13} /> Undo <span className="ai-undo-left">{Math.floor(undoLeft / 60)}:{String(undoLeft % 60).padStart(2, '0')}</span>
          </button>
        )}
        {action.status === 'undone' && <span className="ai-action-state"><Icon name="undo" size={14} /> Undone</span>}
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

export function MessageView({ m, onConfirm, onDismiss, onReconcile, onUndo, onCopy, onDownload, onRegenerate, onEmail, onFollowUp, onFeedback, onConfirmAll, busyAction, canEmail, canRegenerate }: {
  m: AiMessage; onReconcile?: (a: AiAction) => void; onUndo?: (a: AiAction) => void; onConfirm: (a: AiAction) => void; onDismiss: (a: AiAction) => void; onCopy: () => void; onDownload: () => void;
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
          <b>{AI_NAME}</b>
          {m.tier && <RouteChip tier={m.tier} reason={m.routeReason} credits={m.credits || undefined} />}
          {m.status === 'stopped' && <span className="ai-stopped">stopped</span>}
          <time>{formatDateTime(m.createdAt)}</time>
        </div>
        {m.reasoning && <Reasoning text={m.reasoning} live={false} />}
        {m.tools.find((t) => t.name === 'show_plan' && t.steps?.length) && <PlanSteps steps={m.tools.find((t) => t.name === 'show_plan')!.steps!} actions={m.actions} />}
        <ToolChips tools={m.tools} />
        {failed ? <div className="ai-error" role="alert"><Icon name="alert" size={15} /><span>{m.content}</span></div> : <Markdown text={withoutTrailer(m.content)} />}
        {!!m.sources?.length && <details style={{ marginTop: 10 }}><summary>Retrieved sources ({m.sources.length})</summary><ul>{m.sources.map(s => <li key={`${s.kind}:${s.id}:${s.version}`}><Link to={s.link}>{s.key}: {s.title}</Link> · version {s.version} · retrieved {formatDateTime(s.evidenceAt)}</li>)}</ul><p className="muted">These references identify evidence retrieved by the application. They do not verify every claim in the answer.</p></details>}
        {!failed && (m.unverifiedKeys?.length ?? 0) > 0 && (
          <div className="ai-check" role="note"><Icon name="alert" size={14} /><span>Please check <b>{m.unverifiedKeys!.join(', ')}</b>: I mentioned {m.unverifiedKeys!.length === 1 ? 'it' : 'them'} but did not find {m.unverifiedKeys!.length === 1 ? 'it' : 'them'} in your data.</span></div>
        )}
        {onConfirmAll && m.actions.filter((a) => a.status === 'proposed').length >= 2 && (
          <div className="ai-plan"><span>{m.actions.filter((a) => a.status === 'proposed').length} changes are ready</span>
            <button type="button" className="btn btn-primary btn-sm" disabled={busyAction !== null} onClick={onConfirmAll}>{busyAction === 'all' ? 'Working…' : 'Confirm all in order'}</button></div>
        )}
        {m.actions.map((a) => <ActionCard key={a.id} action={a} busy={busyAction === a.id} blocked={a.lifecycle?.dependsOn.some((id) => m.actions.find((step) => step.id === id)?.status !== 'done')} onConfirm={() => onConfirm(a)} onDismiss={() => onDismiss(a)} onReconcile={onReconcile ? () => onReconcile(a) : undefined} onUndo={onUndo ? () => onUndo(a) : undefined} />)}
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
      <Orb size={92} animated />
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

/**
 * The ask box. `tools` (stacked layout): the text on top and one row under it with attach, the given controls (the level menu, usage) and send,
 * as in a modern chat app. Without `tools` it is the single-row box used on the Assistant page.
 */
export function Composer({ value, onChange, onSend, onStop, onFiles, onRemoveFile, files, streaming, canAttach, usage, mode, disabledReason, tools, autoFocus }: {
  value: string; onChange: (v: string) => void; onSend: () => void; onStop: () => void; onFiles: (f: File[]) => void; onRemoveFile: (id: string) => void;
  files: PendingFile[]; streaming: boolean; canAttach: boolean; usage?: AiUsage; mode: AiMode; disabledReason?: string | null; tools?: ReactNode; autoFocus?: boolean;
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
  const picked = <input ref={picker} type="file" multiple hidden accept={accept} onChange={(e) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />;
  const sendButton = streaming
    ? <button type="button" className="ai-send stop" onClick={onStop} aria-label="Stop"><span className="ai-stop-square" /></button>
    : <button type="button" className="ai-send" onClick={onSend} disabled={!ready || uploading || !!disabledReason} aria-label="Send"><Icon name="send" size={17} /></button>;
  const pending = files.length > 0 && (
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
  );

  if (tools !== undefined) {
    return (
      <div className="ai-composer stacked">
        <div className={`ai-box stacked ${streaming ? 'busy' : ''}`}>
          {pending}
          <textarea ref={area} rows={2} value={value} maxLength={8000} autoFocus={autoFocus} placeholder={disabledReason ?? 'Ask about your work, or tell the assistant what to do…'} aria-label="Message the assistant"
            onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onPaste={onPaste} disabled={!!disabledReason} />
          <div className="ai-box-bar">
            <button type="button" className="ai-attach" disabled={!canAttach || streaming} aria-label="Attach files"
              title={canAttach ? 'Attach pictures, PDFs, spreadsheets or documents' : 'Reading files is not included in your plan'} onClick={() => picker.current?.click()}>
              <Icon name="plus" size={18} />
            </button>
            {picked}
            {tools}
            <span className="ai-box-gap" />
            <VoiceInput disabled={streaming || !!disabledReason} onText={(t) => { onChange(value.trim() ? `${value.trimEnd()} ${t}` : t); area.current?.focus(); }} />
            {sendButton}
          </div>
        </div>
        <div className="ai-fineprint short"><span><Icon name="lock" size={11} /> Only what you can already see is shared with the model. Check important answers.</span></div>
      </div>
    );
  }

  return (
    <div className="ai-composer">
      {pending}
      <div className={`ai-box ${streaming ? 'busy' : ''}`}>
        <button type="button" className="ai-attach" disabled={!canAttach || streaming} aria-label="Attach files"
          title={canAttach ? 'Attach pictures, PDFs, spreadsheets or documents' : 'Reading files is not included in your plan'} onClick={() => picker.current?.click()}>
          <Icon name="paperclip" size={18} />
        </button>
        {picked}
        <textarea ref={area} rows={1} value={value} maxLength={8000} placeholder={disabledReason ?? 'Ask about your work, or paste a screenshot…'} aria-label="Message the assistant"
          onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onPaste={onPaste} disabled={!!disabledReason} />
        <VoiceInput disabled={streaming || !!disabledReason} onText={(t) => { onChange(value.trim() ? `${value.trimEnd()} ${t}` : t); area.current?.focus(); }} />
        {sendButton}
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
