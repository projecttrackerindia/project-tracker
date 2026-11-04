import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { chatApi } from '../../../api/endpoints.platform';
import type { Conversation } from '../../../api/types';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/ui';
import { confirmDialog, toast } from '../../../stores/ui';
import { useWorkspaceId } from '../../../stores/auth';
import { passphraseProblem } from './crypto';
import { deviceIdentity, e2eApi, restoreDevice, setUpDevice } from './session';

/** Whether this device holds a private-chat key (re-checked when the sheet below sets one up). */
export function useDeviceReady() {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const check = () => void deviceIdentity().then((d) => { if (live) setReady(!!d); });
    check();
    window.addEventListener('pt:e2e-device', check);
    return () => { live = false; window.removeEventListener('pt:e2e-device', check); };
  }, []);
  return ready;
}

/** The note under a private conversation's header: what it means, and what to do when this device cannot read it yet. */
export function PrivateBanner({ conversation }: { conversation: Conversation }) {
  const ready = useDeviceReady();
  const [setup, setSetup] = useState(false);
  if (!conversation.isPrivate) return null;
  return (
    <>
      <div className="e2e-banner" role="note" data-testid="e2e-banner">
        <Icon name="lock" size={14} />
        <span><b>Private chat</b> · End-to-end encrypted on your devices. Aura, search and the bot can't read it; files and polls are off.</span>
        {ready === false && <button type="button" className="btn btn-primary btn-sm" onClick={() => setSetup(true)}>Set up this device</button>}
      </div>
      {setup && <PrivateSetupSheet onClose={() => setSetup(false)} />}
    </>
  );
}

/** First device: choose a recovery passphrase. Another device: type it to restore. */
export function PrivateSetupSheet({ onClose, onReady }: { onClose: () => void; onReady?: () => void }) {
  const [mode, setMode] = useState<'loading' | 'new' | 'restore'>('loading');
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void e2eApi.me().then((m) => setMode(m.hasBackup ? 'restore' : 'new')).catch(() => setMode('new')); }, []);
  const submit = async () => {
    setError(null);
    if (mode === 'new') {
      const p = passphraseProblem(pass);
      if (p) { setError(p); return; }
      if (pass !== again) { setError('The two passphrases are different.'); return; }
    }
    setBusy(true);
    try {
      if (mode === 'new') await setUpDevice(pass); else await restoreDevice(pass);
      setPass(''); setAgain('');
      window.dispatchEvent(new Event('pt:e2e-device'));
      toast(mode === 'new' ? 'Private chat is ready on this device.' : 'Private chats restored on this device.');
      onReady?.(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not set it up.'); }
    finally { setBusy(false); }
  };
  return (
    <Modal size="sm" className="e2e-modal" title={mode === 'restore' ? 'Restore private chats' : 'Set up private chat'} onClose={onClose}
      subtitle={mode === 'restore' ? 'Type your recovery passphrase to read your private chats on this device.' : 'Your key is made on this device and never leaves it. The passphrase protects a recovery copy, so you can read private chats on a new device.'}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Not now</button><button type="submit" className="btn btn-primary" disabled={busy || mode === 'loading'}>{busy ? 'Working…' : mode === 'restore' ? 'Restore' : 'Set up'}</button></>}>
      <div className="e2e-setup">
        <label className="field full"><span>Recovery passphrase</span>
          <input className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus /></label>
        {mode === 'new' && <label className="field full"><span>Type it again</span>
          <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>}
        <p className="muted e2e-small"><Icon name="shield" size={13} /> We can't reset it: without it, private messages can't be read on a new device. Write it down somewhere safe.</p>
        {mode === 'restore' && <button type="button" className="link-btn" onClick={() => setMode('new')}>Lost it? Start again with a new key (old private messages stay unreadable here)</button>}
        {error && <div className="field-error" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

/** Turns private chat on or off from the conversation's ⋯ menu (sets up this device first when needed). */
export function usePrivateToggle(conversation: Conversation) {
  const qc = useQueryClient();
  const wid = useWorkspaceId();
  const [needsSetup, setNeedsSetup] = useState(false);
  const allowed = conversation.type !== 'Project' && (conversation.type === 'Direct' || conversation.canManage);
  const apply = async (enabled: boolean) => {
    try {
      const updated = await chatApi.setPrivate(conversation.id, enabled);
      qc.setQueryData<Conversation[]>([wid, 'chat', 'conversations'], (old) => old?.map((c) => (c.id === updated.id ? updated : c)));
      void qc.invalidateQueries({ queryKey: [wid, 'chat'] });
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not change it.', 'error'); }
  };
  const toggle = async () => {
    if (conversation.isPrivate) {
      if (await confirmDialog({ title: 'Turn off private chat?', message: 'New messages will no longer be end-to-end encrypted. Everyone here is told.', confirmText: 'Turn off' })) await apply(false);
      return;
    }
    if (!(await deviceIdentity())) { setNeedsSetup(true); return; }
    await apply(true);
  };
  const sheet = needsSetup ? <PrivateSetupSheet onClose={() => setNeedsSetup(false)} onReady={() => void apply(true)} /> : null;
  return { allowed, toggle, sheet, label: conversation.isPrivate ? 'Turn off private chat' : 'Private chat (end-to-end encrypted)' };
}
