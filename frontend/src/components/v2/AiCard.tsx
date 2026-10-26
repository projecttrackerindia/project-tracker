import type { ReactNode } from 'react';
import { Icon } from '../Icon';
import './v2.css';

/**
 * A ✦ suggestion from the AI, inline where it applies ("Thursday is clear, block it for SIA"): one line of what it noticed, at most one
 * action, and a way to dismiss it. Violet is used only for this, so people learn that violet means "the AI says".
 */
export function AiCard({ title, children, action, onDismiss, className = '' }: {
  title?: ReactNode; children?: ReactNode; action?: { label: string; onClick: () => void; busy?: boolean }; onDismiss?: () => void; className?: string;
}) {
  return (
    <div className={`v2-ai-card ${className}`} role="note">
      <span className="v2-spark" aria-hidden="true">✦</span>
      <div className="v2-ai-card-main">{title && <b>{title}</b>}{children && <span>{children}</span>}</div>
      {action && <button type="button" className="btn btn-sm btn-ai" disabled={action.busy} onClick={action.onClick}>{action.busy ? 'Working…' : action.label}</button>}
      {onDismiss && <button type="button" className="v2-ai-dismiss" aria-label="Dismiss" onClick={onDismiss}><Icon name="close" size={14} /></button>}
    </div>
  );
}
