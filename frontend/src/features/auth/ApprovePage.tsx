import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { deviceLoginApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { PageLoader } from '../../components/ui';
import { usePageTitle } from '../../lib/title';
import { CalmCard, CalmPage } from '../../components/calm';
import './approve-page.css';
import { ApprovePrompt } from './PhoneSignIn';

/** Where a sign-in prompt's notification leads: the same question the island asks, with room to read it. */
export function ApprovePage() {
  usePageTitle('Approve sign-in');
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['device-login', id], queryFn: () => deviceLoginApi.get(id), refetchInterval: false });
  const [result, setResult] = useState<'approved' | 'denied' | null>(null);
  if (q.isLoading) return <PageLoader />;
  // Calm (the sign-in approval, demo style): one centred card on the page tone, the calm title and the one decision.
  const title = result ? (result === 'approved' ? ['Approved.', 'The other screen signs in by itself.'] : ['Denied.', 'Nobody was signed in.'])
    : q.data ? ['Approve this sign-in?', 'Only if it is you, on the other screen.'] : ['This request has ended.', 'Start again on the other screen.'];
  return (
    <CalmPage width="full" className="sa-page" label="Approve sign-in">
      <CalmCard className="sa-card">
        <span className={`sa-tile${result === 'denied' ? ' no' : ''}`}><Icon name={result === 'approved' ? 'tick' : result === 'denied' ? 'close' : q.data ? 'shield' : 'alarm'} size={26} /></span>
        <h1 className="sa-title">{title[0]}<em>{title[1]}</em></h1>
        {!result && q.data && <ApprovePrompt item={q.data} onDone={(ok) => setResult(ok ? 'approved' : 'denied')} />}
        {!result && !q.data && <p className="sa-note">It expired, or it was already answered.</p>}
        <Link className="calm-link accent sa-back" to="/">Back to the app</Link>
      </CalmCard>
    </CalmPage>
  );
}
