import { useState } from 'react';
import { Link } from 'react-router-dom';
import { integrationsApi } from '../../api/endpoints';
import { microsoftApi } from '../../api/endpoints.platform';
import { Icon } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { mailboxApi } from '../mailbox/mailboxApi';
import { notetakerApi } from '../notetaker/notetakerApi';

/** First days: the two things that make the assistant useful - your mail, and your notetaker. Disappears when done or dismissed. */
export function GetStarted() {
  const uid = useAuth((s) => s.ctx?.user.id ?? '');
  const key = `pm_get_started_${uid}`;
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const mail = useWsQuery(['mailbox', 'accounts'], mailboxApi.accounts, { enabled: !hidden, staleTime: 300_000 });
  const google = useWsQuery(['account', 'google-status'], integrationsApi.googleStatus, { enabled: !hidden, staleTime: 300_000 });
  const ms = useWsQuery(['account', 'microsoft-status'], microsoftApi.status, { enabled: !hidden, staleTime: 300_000 });
  const notes = useWsQuery(['notetaker'], notetakerApi.overview, { enabled: !hidden, staleTime: 300_000 });
  if (hidden || !Array.isArray(mail.data?.imap) || !notes.data?.settings) return null;
  const mailDone = (mail.data.imap.length > 0) || !!google.data?.inboxAccess || !!ms.data?.inboxAccess;
  const notesDone = !!notes.data.settings.projectId;
  if (mailDone && notesDone) return null;
  const dismiss = () => { try { localStorage.setItem(key, '1'); } catch { /* shown again next time */ } setHidden(true); };
  const steps = [
    { done: mailDone, to: '/mailbox', title: 'Connect your mail', text: mail.data.company ? `Just your ${mail.data.company.name} password.` : 'Gmail, Outlook or Rediffmail: read, reply and turn emails into tasks.' },
    { done: notesDone, to: '/meet/notetaker', title: 'Set up your notetaker', text: 'It joins your calls, writes the minutes and updates tasks.' },
  ];
  return (
    <section className="cmd-start" aria-label="Get started">
      <div className="cmd-start-head"><b><Icon name="sparkle" size={15} /> Get the most from your assistant</b>
        <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss}>Hide</button></div>
      <ol>
        {steps.map((s, i) => (
          <li key={s.to} className={s.done ? 'done' : ''}>
            <span className="cmd-start-n">{s.done ? <Icon name="check" size={14} /> : i + 1}</span>
            <span className="cmd-start-text"><b>{s.title}</b><small>{s.text}</small></span>
            {!s.done && <Link className="btn btn-sm btn-primary" to={s.to}>Start</Link>}
          </li>
        ))}
      </ol>
    </section>
  );
}
