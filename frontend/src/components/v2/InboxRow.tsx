import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import './v2.css';

/** The kinds of row the Home inbox shows (V2-PLAN §3, Inbox). */
export type InboxKind = 'ticket' | 'decision' | 'approval' | 'task' | 'mention' | 'reminder' | 'access' | 'review';
const KIND_LABEL: Record<InboxKind, string> = {
  ticket: 'Ticket', decision: 'Decision', approval: 'Approval', task: 'Task', mention: 'Mention', reminder: 'Reminder', access: 'Access', review: 'Review',
};

/**
 * One inbox row: a kind chip, the title with one line under it, one action and Later. A done row fades rather than jumping away, so the
 * list does not move under the pointer. The action sits beside the text, never on top of it.
 */
export function InboxRow({ kind, title, sub, href, action, onLater, done, busy, extra }: {
  kind: InboxKind; title: ReactNode; sub?: ReactNode; href?: string;
  action?: { label: string; onClick: () => void; tone?: 'primary' | 'ghost' }; onLater?: () => void; done?: boolean; busy?: boolean; extra?: ReactNode;
}) {
  const main = <><b>{title}</b>{sub && <span>{sub}</span>}</>;
  return (
    <div className={`v2-inbox-row ${done ? 'done' : ''}`} data-kind={kind}>
      <span className={`v2-kind ${kind}`}>{KIND_LABEL[kind]}</span>
      {href ? <Link className="v2-inbox-main" to={href}>{main}</Link> : <div className="v2-inbox-main">{main}</div>}
      {extra}
      {!done && (action || onLater) && (
        <div className="v2-inbox-acts">
          {action && <button type="button" className={`btn btn-sm ${action.tone === 'ghost' ? 'btn-ghost' : 'btn-primary'}`} disabled={busy} onClick={action.onClick}>{action.label}</button>}
          {onLater && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onLater}>Later</button>}
        </div>
      )}
    </div>
  );
}
