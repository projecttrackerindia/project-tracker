import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Modal, Spinner } from '../../components/ui';
import { formatDate, timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { confirmDialog, toast } from '../../stores/ui';
import { vaultApi, type VaultKeysMe, type VaultRecoveryToHelp } from './api';
import { linkCode } from './e2ee/crypto';
import { pins } from './e2ee/keyring';
import * as sealed from './e2ee/sealed';
import type { Me } from './sealedData';
import { useStepUp } from './stepUpContext';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message || fallback : fallback);

/**
 * The recovery circle on My keys: who holds a share of the vault secret and how many must help. Setting it up splits the secret here (Shamir)
 * and encrypts each share to that colleague's keys; nobody — not one colleague, not the server — can open anything alone.
 */
export function CircleCard({ tenant, me, unlocked }: { tenant: string; me: Me; unlocked: boolean }) {
  const q = useWsQuery(['vault', 'circle'], vaultApi.circle, { staleTime: 30_000 });
  const [editing, setEditing] = useState(false);
  const circle = q.data?.circle ?? null;
  return (
    <section className="card" data-testid="circle">
      <div className="card-head"><div><h3>Recovery circle</h3><p>Colleagues who can, together, give your vault back if you lose every passkey and the recovery key. Any one of them alone learns nothing.</p></div></div>
      <div className="card-body">
        {q.isLoading ? <Spinner /> : circle ? (
          <>
            <p className="vlt-circle-rule"><b>{circle.threshold} of {circle.members.length}</b> must help · set up {formatDate(circle.createdAt)}</p>
            <ul className="vlt-circle-people">
              {circle.members.map((m) => (
                <li key={m.person.id} className={m.stale ? 'stale' : ''}>
                  <span className="vlt-circle-avatar" aria-hidden="true">{m.person.name.slice(0, 1).toUpperCase()}</span>
                  <span>{m.person.name}{m.stale && <span className="muted"> · their keys changed: this share no longer opens</span>}</span>
                </li>
              ))}
            </ul>
            {!circle.usable && <p className="vlt-warn vlt-small">Not enough of the circle can still help. Set it up again.</p>}
          </>
        ) : <p className="muted">No circle yet. With one, losing your passkeys and recovery key is not the end of your sealed vault.</p>}
        <div className="vlt-unlock-ways">
          <button className="btn btn-ghost btn-sm" disabled={!unlocked} title={unlocked ? undefined : 'Unlock first'} onClick={() => setEditing(true)}><Icon name="users" size={14} /> {circle ? 'Choose again' : 'Set up a recovery circle'}</button>
          {circle && <button className="btn btn-ghost btn-sm danger" onClick={async () => {
            if (!(await confirmDialog({ title: 'Remove your recovery circle?', message: 'Their shares are destroyed. Only your passkeys and recovery key can open your vault then.', confirmText: 'Remove' }))) return;
            try { await vaultApi.clearCircle(); toast('Recovery circle removed.'); void q.refetch(); } catch (e) { toast(errText(e, 'Could not remove it.'), 'error'); }
          }}>Remove</button>}
        </div>
        {!unlocked && <p className="vlt-small muted">Unlock first: your secret is split on this device.</p>}
      </div>
      {editing && <CircleModal tenant={tenant} me={me} onClose={() => setEditing(false)} onDone={() => { setEditing(false); void q.refetch(); }} />}
    </section>
  );
}

function CircleModal({ tenant, me, onClose, onDone }: { tenant: string; me: Me; onClose: () => void; onDone: () => void }) {
  const step = useStepUp();
  const people = useWsQuery(['vault', 'directory', 'all'], () => vaultApi.directory([]), { staleTime: 60_000 });
  const [chosen, setChosen] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = (people.data ?? []).filter((p) => p.userId !== me.id);
  const n = chosen.length;
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= 7 ? c : [...c, id]));
  useEffect(() => { if (threshold > Math.max(2, n)) setThreshold(Math.max(2, n)); }, [n, threshold]);
  return (
    <Modal title="Your recovery circle" subtitle="Choose 2 to 7 colleagues you trust, and how many of them must help." onClose={onClose} className="vlt-scope"
      onSubmit={async (e) => {
        e.preventDefault(); setError(null); setBusy(true);
        try {
          const picked = others.filter((p) => chosen.includes(p.userId));
          const r = await step.run((t) => sealed.setUpCircle(picked, threshold, t), true);
          if (r) { toast(`Recovery circle set: any ${threshold} of ${picked.length} can help you back in.`); onDone(); }
        } catch (err) { setError(errText(err, 'Could not set it up.')); }
        finally { setBusy(false); }
      }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || n < 2 || threshold > n}>{busy && <span className="spinner" />}Split and share</button></>}>
      {people.isLoading ? <Spinner /> : (
        <div className="vlt-circle-pick">
          <ul className="vlt-circle-people pick" aria-label="People">
            {others.map((p) => {
              const state = p.identity ? pins.check(tenant, p.userId, p.identity.fingerprint, p.identity.ed25519Public) : null;
              return (
                <li key={p.userId}>
                  <label className={!p.identity ? 'off' : ''}>
                    <input type="checkbox" checked={chosen.includes(p.userId)} disabled={!p.identity || state === 'changed'} onChange={() => toggle(p.userId)} />
                    <span className="vlt-circle-avatar" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
                    <span>{p.name}{!p.identity ? <span className="muted"> · no vault keys yet</span> : state === 'changed' ? <span className="muted"> · key changed: compare safety codes first</span> : state === 'verified' ? <span className="vlt-ok"> · verified</span> : null}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="field"><span className="vlt-field-label">How many must help</span>
            <div className="seg" role="radiogroup" aria-label="How many must help">
              {Array.from({ length: Math.max(1, n - 1) }, (_, i) => i + 2).map((k) => <button key={k} type="button" role="radio" aria-checked={threshold === k} disabled={k > n} onClick={() => setThreshold(k)}>{k}</button>)}
            </div>
            <p className="vlt-small muted">{n >= 2 ? `Any ${threshold} of these ${n} together can give your vault back; ${threshold - 1 === 1 ? 'one alone learns' : `${threshold - 1} together learn`} nothing.` : 'Choose at least two people.'}</p>
          </div>
          <p className="vlt-small muted"><Icon name="shield" size={12} /> Split on this device. Each share is encrypted to that person’s own keys and signed with yours. Needs a fresh two-step check.</p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

/** On the locked screen: ask the circle, show the code to read to each helper, and wait for enough shares. */
export function AskCircle({ tenant, me, keys, onUnlocked, onBack }: { tenant: string; me: Me; keys: VaultKeysMe; onUnlocked: () => void; onBack: () => void }) {
  const [state, setState] = useState<{ code: string; started: Awaited<ReturnType<typeof sealed.startRecovery>> } | null>(null);
  const [progress, setProgress] = useState<{ got: number; need: number; refused: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const start = async () => {
    setError(null);
    try {
      const started = await sealed.startRecovery(navigator.userAgent.includes('Mobile') ? 'A phone' : 'A browser');
      setState({ code: started.code, started });
      setProgress({ got: 0, need: started.status.threshold, refused: 0 });
      abort.current = new AbortController();
      await sealed.waitForRecovery(tenant, me.id, keys, started, abort.current.signal, (got, need, refused) => setProgress({ got, need, refused }));
      if (!abort.current.signal.aborted) { toast('Your circle gave your vault back. Add a new passkey or recovery key now.', 'success'); onUnlocked(); }
    } catch (e) { setError(errText(e, 'Could not ask your circle.')); }
  };
  return (
    <div className="vlt-link-wait" data-testid="ask-circle">
      {!state ? (
        <>
          <p>Your recovery circle gets a notice. Each person who helps must first <b>call you or see you</b> and hear the code this screen shows.</p>
          <div className="vlt-unlock-ways"><button className="btn btn-ghost" onClick={onBack}>Back</button><button className="btn btn-primary" onClick={() => void start()}><Icon name="users" size={15} /> Ask my circle</button></div>
        </>
      ) : (
        <>
          <p>Read this code to each person who helps. They must see the same code:</p>
          <code className="vlt-link-code" data-testid="circle-code">{state.code}</code>
          {progress && (
            <div className="vlt-circle-progress" aria-live="polite">
              <div className="vlt-circle-dots">{Array.from({ length: progress.need }, (_, i) => <span key={i} className={i < progress.got ? 'on' : ''} />)}</div>
              <span className="muted vlt-small">{progress.got} of {progress.need} helped{progress.refused ? ` · ${progress.refused} refused` : ''} · open for 24 hours</span>
            </div>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => { abort.current?.abort(); void vaultApi.finishRecovery(state.started.status.id, false).catch(() => undefined); onBack(); }}>Cancel</button>
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

/** While unlocked: colleagues asking me to help them back into their vault. Help only after hearing the same code from them. */
export function CircleHelpRequests({ unlocked }: { unlocked: boolean }) {
  const q = useWsQuery(['vault', 'circle-help'], vaultApi.recoveryToHelp, { enabled: unlocked, refetchInterval: unlocked ? 30_000 : false });
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const r: VaultRecoveryToHelp | undefined = (q.data ?? []).find((x) => !dismissed.includes(x.requestId));
  if (!unlocked || !r) return null;
  return (
    <Modal title={`Help ${r.person.name} back into their vault?`} subtitle="You are in their recovery circle." size="sm" onClose={() => setDismissed((d) => [...d, r.requestId])} className="vlt-scope">
      <div className="vlt-link-approve" data-testid="circle-help">
        <p className="vlt-warn vlt-small"><b>Call {r.person.name} or see them in person.</b> Do not help because of a message or an email: that is how people get tricked.</p>
        <p className="muted vlt-small">Asked {timeAgo(r.createdAt)}{r.ipAddress ? ` from ${r.ipAddress}` : ''}{r.userAgent ? ` · ${r.userAgent.slice(0, 60)}` : ''}. Any {r.threshold} people in the circle are needed.</p>
        <p>Help only if they read you exactly this code:</p>
        <code className="vlt-link-code">{linkCode(r.x25519Public, r.mlKemPublic)}</code>
        <div className="vlt-unlock-ways">
          <button className="btn btn-ghost danger" disabled={busy} onClick={async () => { setBusy(true); try { await vaultApi.refuseRecovery(r.requestId); toast('Refused. They are told.', 'warning'); await q.refetch(); } catch (e) { toast(errText(e, 'Could not refuse.'), 'error'); } finally { setBusy(false); } }}>Refuse</button>
          <button className="btn btn-primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await sealed.helpRecovery(r); toast(`Your part was sent to ${r.person.name}’s browser, encrypted.`); await q.refetch(); } catch (e) { toast(errText(e, 'Could not help.'), 'error'); } finally { setBusy(false); }
          }}>{busy && <span className="spinner" />}We spoke and the codes match — help</button>
        </div>
      </div>
    </Modal>
  );
}
