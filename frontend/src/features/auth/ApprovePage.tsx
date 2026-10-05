import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { deviceLoginApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { PageLoader } from '../../components/ui';
import { usePageTitle } from '../../lib/title';
import { ApprovePrompt } from './PhoneSignIn';

/** Where a sign-in prompt's notification leads: the same question the island asks, with room to read it. */
export function ApprovePage() {
  usePageTitle('Approve sign-in');
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['device-login', id], queryFn: () => deviceLoginApi.get(id), refetchInterval: false });
  const [result, setResult] = useState<'approved' | 'denied' | null>(null);
  if (q.isLoading) return <PageLoader />;
  return (
    <div className="ap-page">
      <div className="ap-card">
        {result ? (
          <div className="ap-done"><span className={`ps-icon ${result === 'approved' ? 'ok' : 'denied'}`}><Icon name={result === 'approved' ? 'tick' : 'close'} size={30} /></span>
            <h2>{result === 'approved' ? 'Approved' : 'Denied'}</h2><p>{result === 'approved' ? 'You can go back to the other screen: it signs in by itself.' : 'Nobody was signed in.'}</p></div>
        ) : q.data ? (
          <><span className="ps-icon"><Icon name="shield" size={30} /></span><h2>Approve this sign-in?</h2><ApprovePrompt item={q.data} onDone={(ok) => setResult(ok ? 'approved' : 'denied')} /></>
        ) : (
          <div className="ap-done"><span className="ps-icon expired"><Icon name="alarm" size={30} /></span><h2>This request has ended</h2><p>It expired, or it was already answered. Start again on the other screen if you still want to sign in.</p></div>
        )}
        <Link className="link" to="/" style={{ marginTop: 14 }}>Back to the app</Link>
      </div>
    </div>
  );
}
