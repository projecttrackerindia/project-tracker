import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { devApi } from '../../api/endpoints';
import { formatDateTime } from '../../lib/format';

/** Development-only: shows the emails the API "sent" (verification, reset, invitation links). */
export function MailboxPage() {
  const q = useQuery({ queryKey: ['dev-mailbox'], queryFn: devApi.emails, refetchInterval: 4000, retry: false });
  return (
    <div className="auth-shell" style={{ alignItems: 'start' }}>
      <div className="auth-card" style={{ maxWidth: 760 }}>
        <h1 className="auth-title">Dev mailbox</h1>
        <p className="auth-sub">Emails sent by the API in development. In production these go out through your configured email provider.</p>
        {q.isError && <div className="form-error">The mailbox is only available when the API runs in Development.</div>}
        {q.data?.length === 0 && <div className="form-info">No emails yet.</div>}
        <div className="member-list">
          {q.data?.map((m) => {
            const link = m.text?.match(/https?:\/\/\S+/)?.[0];
            const url = link ? new URL(link) : null;
            return (
              <div className="member-item" key={m.id} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
                <div className="row" style={{ justifyContent: 'space-between', width: '100%' }}><b>{m.subject}</b><span className="muted" style={{ fontSize: 11 }}>{formatDateTime(m.sentAt)}</span></div>
                <span className="muted" style={{ fontSize: 12 }}>To: {m.to}</span>
                {url && <Link className="link" style={{ fontSize: 12.5, wordBreak: 'break-all' }} to={url.pathname + url.search}>{url.pathname + url.search}</Link>}
              </div>
            );
          })}
        </div>
        <div className="auth-foot"><Link className="link" to="/login">Back to sign in</Link></div>
      </div>
    </div>
  );
}
