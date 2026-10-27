import type { ReactNode } from 'react';
import { Icon } from '../Icon';
import './v2.css';

/**
 * A ✦ suggestion from the AI, inline where it applies ("Thursday is clear, block it for SIA"): one line of what it noticed, at most one
 * action, and a way to dismiss it. Violet is used only for this, so people learn that violet means "the AI says".
 * `stacked`: the title, the text and then the action with a "Not now" under them (a side panel's narrow column); `dismissLabel` names
 * the dismiss button instead of a small ✕.
 */
export function AiCard({ title, children, action, onDismiss, dismissLabel, stacked, className = '' }: {
  title?: ReactNode; children?: ReactNode; action?: { label: string; onClick: () => void; busy?: boolean }; onDismiss?: () => void;
  dismissLabel?: string; stacked?: boolean; className?: string;
}) {
  const act = action && <button type="button" className="btn btn-sm btn-ai" disabled={action.busy} onClick={action.onClick}>{action.busy ? 'Working…' : action.label}</button>;
  const dismiss = onDismiss && (dismissLabel
    ? <button type="button" className="btn btn-sm v2-ai-later" onClick={onDismiss}>{dismissLabel}</button>
    : <button type="button" className="v2-ai-dismiss" aria-label="Dismiss" onClick={onDismiss}><Icon name="close" size={14} /></button>);
  if (stacked) return (
    <div className={`v2-ai-card stacked ${className}`} role="note">
      <div className="v2-ai-card-main">
        {title && <b><span className="v2-spark" aria-hidden="true">✦</span> {title}</b>}
        {children && <span>{children}</span>}
        {(act || dismiss) && <div className="v2-ai-card-acts">{act}{dismiss}</div>}
      </div>
    </div>
  );
  return (
    <div className={`v2-ai-card ${className}`} role="note">
      <span className="v2-spark" aria-hidden="true">✦</span>
      <div className="v2-ai-card-main">{title && <b>{title}</b>}{children && <span>{children}</span>}</div>
      {act}
      {dismiss}
    </div>
  );
}
