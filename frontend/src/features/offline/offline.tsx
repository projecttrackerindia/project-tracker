import { useEffect, useState } from 'react';
import { BrandMark } from '../../components/BrandMark';
import { Icon } from '../../components/Icon';
import { formatDate, formatDateTime } from '../../lib/format';
import { KIND_META } from '../workitems/workItems';
import { readOfflineSnapshot } from './storage';

export { clearOfflineData, readOfflineSnapshot, saveOfflineSnapshot } from './storage';

/** Shown instead of the app when it starts without a connection: the saved list, read-only, and back to normal as soon as it is online. */
export function OfflineWork() {
  const snap = readOfflineSnapshot();
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    const back = () => window.location.reload();
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, []);
  return (
    <div className="offline-shell">
      <header className="offline-head">
        <span className="brand-mark"><BrandMark size={18} /></span>
        <div><b>You are offline</b><span>{snap ? `${snap.workspace} · your work as of ${formatDateTime(snap.savedAt)}` : 'Nothing saved on this device yet'}</span></div>
        <button type="button" className="btn btn-primary btn-sm" disabled={retrying} onClick={() => { setRetrying(true); window.location.reload(); }}><Icon name="refresh" size={14} /> Try again</button>
      </header>
      {snap && snap.items.length > 0 ? (
        <ul className="offline-list">
          {snap.items.map((i) => (
            <li key={`${i.kind}:${i.id}`} className={i.isOverdue ? 'late' : ''}>
              <span className={`offline-kind`} style={{ background: `var(--kind-${i.kind})` }} title={KIND_META[i.kind].label} />
              <span className="offline-main"><b><span className="task-key">{i.key}</span> {i.title}</b><i>{[i.projectName, i.status, i.priority].filter(Boolean).join(' · ')}</i></span>
              {i.dueDate && <span className="offline-due">{i.isOverdue ? 'Overdue · ' : ''}{formatDate(i.dueDate)}</span>}
            </li>
          ))}
        </ul>
      ) : <p className="offline-empty">Open My work once while online and it will be here next time.</p>}
      <p className="offline-foot">Read-only. Changes need a connection; the app comes back by itself when you are online.</p>
    </div>
  );
}
