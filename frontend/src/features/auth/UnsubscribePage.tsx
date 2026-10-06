import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { unsubscribeApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { AuthLayout } from '../../layouts/AuthLayout';
import { usePageTitle } from '../../lib/title';

/** "Stop emails like this": reached from the link in an e-mail, without signing in. Opening it changes nothing; the button does. */
export function UnsubscribePage() {
  usePageTitle('Stop emails like this');
  const token = useSearchParams()[0].get('token') ?? '';
  const info = useQuery({ queryKey: ['unsubscribe', token], queryFn: () => unsubscribeApi.info(token), enabled: !!token, retry: false });
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const stop = async () => { setState('busy'); try { await unsubscribeApi.confirm(token); setState('done'); } catch { setState('failed'); } };

  if (!token || info.isError) return (
    <AuthLayout title="This link is not valid" sub="It may be incomplete or out of date. You can change which emails you get under Settings → Notifications after signing in." footer={<a className="link" href="/login">Sign in</a>}><span /></AuthLayout>
  );
  if (info.isLoading) return <AuthLayout title="One moment" sub=" " footer={null}><span /></AuthLayout>;
  const off = state === 'done' || info.data?.alreadyOff;
  return (
    <AuthLayout title={off ? 'You are unsubscribed' : 'Stop these emails?'} footer={<a className="link" href="/login">Sign in to manage all emails</a>}
      sub={off ? `You will no longer get “${info.data?.label}” emails. Notifications in the app are not affected, and you can turn this back on under Settings → Notifications.` : `You will stop getting “${info.data?.label}” emails. Notifications in the app are not affected.`}>
      <div className="ps-result"><span className={`ps-icon ${off ? 'ok' : ''}`}><Icon name={off ? 'tick' : 'mail'} size={30} /></span></div>
      {!off && <button type="button" className="auth-submit" disabled={state === 'busy'} onClick={() => void stop()}><span className="label">Stop these emails</span></button>}
      {state === 'failed' && <p className="ap-err" role="alert">Something went wrong. Try again in a moment.</p>}
    </AuthLayout>
  );
}
