import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { ApiError } from '../../api/client';
import { meApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Badge, Field, Modal, SubmitButton } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';

type Mode = null | 'setup' | 'disable' | 'regenerate';

/** Settings → Security row for authenticator-app two-step verification. */
export function TwoStepRow() {
  const qc = useQueryClient();
  const reload = useAuth((s) => s.reloadContext);
  const status = useQuery({ queryKey: ['me', 'mfa'], queryFn: meApi.mfaStatus });
  const [mode, setMode] = useState<Mode>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const on = status.data?.enabled ?? false;

  // Re-checking access (reloadContext) can unmount this whole screen on success — e.g. the blocked-workspace
  // fallback swaps itself out the instant MFA satisfies the org's requirement. Do that only once there are no
  // recovery codes still waiting to be shown, so a just-opened codes modal never gets yanked out from under the user.
  const changed = () => { qc.invalidateQueries({ queryKey: ['me', 'mfa'] }); void reload(); };

  return (
    <div className="setting-row">
      <div className="setting-info">
        <h4>Two-step verification {status.data && (on ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>)}</h4>
        <p>
          {on
            ? <>Signing in needs a code from your authenticator app. On since {formatDate(status.data!.enabledAt)} · {status.data!.recoveryCodesLeft} recovery codes left.</>
            : 'Ask for a 6-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…) after your password.'}
        </p>
      </div>
      {on ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={() => setMode('regenerate')}><Icon name="refresh" /> New recovery codes</button>
          <button className="btn btn-danger" onClick={() => setMode('disable')}>Turn off</button>
        </div>
      ) : <button className="btn btn-primary" onClick={() => setMode('setup')} disabled={!status.data}><Icon name="lock" /> Set up</button>}

      {mode === 'setup' && <SetupModal onClose={() => setMode(null)} onDone={(c) => { setMode(null); setCodes(c); qc.invalidateQueries({ queryKey: ['me', 'mfa'] }); }} />}
      {(mode === 'disable' || mode === 'regenerate') && (
        <ConfirmModal mode={mode} onClose={() => setMode(null)}
          onDone={(c) => { setMode(null); if (c) { setCodes(c); qc.invalidateQueries({ queryKey: ['me', 'mfa'] }); } else { toast('Two-step verification is off.', 'warning'); changed(); } }} />
      )}
      {codes && <RecoveryCodesModal codes={codes} onClose={() => { setCodes(null); changed(); }} />}
    </div>
  );
}

function errorsOf(e: unknown, fallback: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (e instanceof ApiError) { e.errors.forEach((x) => { out[x.field ?? 'code'] = x.message; }); if (!Object.keys(out).length) out.code = e.message; }
  else out.code = fallback;
  return out;
}

function SetupModal({ onClose, onDone }: { onClose: () => void; onDone: (codes: string[]) => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpAuthUri: string } | null>(null);
  const [qr, setQr] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => { if (setup) QRCode.toDataURL(setup.otpAuthUri, { margin: 1, width: 196 }).then(setQr).catch(() => setQr('')); }, [setup]);

  const start = useMutation({ mutationFn: () => meApi.mfaSetup(password), onSuccess: setSetup, onError: (e) => setErrors(errorsOf(e, 'Could not start the setup.')) });
  const enable = useMutation({ mutationFn: () => meApi.mfaEnable(code), onSuccess: (r) => onDone(r.codes), onError: (e) => setErrors(errorsOf(e, 'Could not turn it on.')) });

  return (
    <Modal size="sm" title="Set up two-step verification" onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); setErrors({}); if (!setup) { if (!password) return setErrors({ password: 'Enter your password.' }); start.mutate(); } else { if (code.replace(/\s/g, '').length < 6) return setErrors({ code: 'Enter the 6-digit code.' }); enable.mutate(); } }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={start.isPending || enable.isPending}>{setup ? 'Turn on' : 'Continue'}</SubmitButton></>}>
      {!setup ? (
        <Field label="Confirm your password" error={errors.password}>
          <input className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>1. Scan this QR code with your authenticator app.</p>
          <div style={{ display: 'flex', justifyContent: 'center', background: '#fff', borderRadius: 12, padding: 8, width: 212, margin: '0 auto 10px' }}>
            {qr ? <img src={qr} alt="QR code for your authenticator app" width={196} height={196} /> : <div style={{ width: 196, height: 196 }} />}
          </div>
          <p className="muted" style={{ fontSize: 12.5 }}>Can’t scan? Enter this key by hand: <code style={{ wordBreak: 'break-all' }}>{setup.secret}</code></p>
          <p className="muted">2. Type the 6-digit code it shows.</p>
          <Field label="Code" error={errors.code}>
            <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={7} autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        </>
      )}
    </Modal>
  );
}

function ConfirmModal({ mode, onClose, onDone }: { mode: 'disable' | 'regenerate'; onClose: () => void; onDone: (codes?: string[]) => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const run = useMutation({
    mutationFn: async () => mode === 'disable' ? (await meApi.mfaDisable(password, code), undefined) : (await meApi.mfaRecoveryCodes(password, code)).codes,
    onSuccess: (c) => onDone(c),
    onError: (e) => setErrors(errorsOf(e, 'Could not complete that.')),
  });
  return (
    <Modal size="sm" title={mode === 'disable' ? 'Turn off two-step verification' : 'Generate new recovery codes'} onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); setErrors({}); if (!password) return setErrors({ password: 'Enter your password.' }); if (!code.trim()) return setErrors({ code: 'Enter a code.' }); run.mutate(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={run.isPending}>{mode === 'disable' ? 'Turn off' : 'Generate'}</SubmitButton></>}>
      <p className="muted" style={{ marginTop: 0 }}>{mode === 'regenerate' ? 'Your old recovery codes stop working. ' : ''}Confirm with your password and a code from your app (or a recovery code).</p>
      <Field label="Password" error={errors.password}><input className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Field label="Code" error={errors.code}><input className="input" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
    </Modal>
  );
}

function RecoveryCodesModal({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const text = codes.join('\n');
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`Project Management recovery codes\nEach code works once.\n\n${text}\n`], { type: 'text/plain' }));
    a.download = 'recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <Modal size="sm" title="Save your recovery codes" onClose={onClose}
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>I’ve saved them</button>}>
      <p className="muted" style={{ marginTop: 0 }}>If you lose your phone, each of these signs you in once. They are shown only now — store them somewhere safe.</p>
      <div className="recovery-codes">{codes.map((c) => <code key={c}>{c}</code>)}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard?.writeText(text); toast('Recovery codes copied.'); }}>Copy</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={download}><Icon name="download" /> Download</button>
      </div>
    </Modal>
  );
}
