import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { ErrorState, Modal, PageLoader } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const PRESETS = [10, 15, 30, 60];

/** Owners and admins: how long a revealed value stays on screen, the data key, and the check of the audit trail. */
export function DocumentSecurityModal({ onClose }: { onClose: () => void }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['document-security'], documentApi.security);
  const d = q.data;
  const [custom, setCustom] = useState('');
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  useEffect(() => { if (d) { const preset = PRESETS.includes(d.revealSeconds); setMode(preset ? 'preset' : 'custom'); setCustom(preset ? '' : String(d.revealSeconds)); } }, [d?.revealSeconds]);   // eslint-disable-line react-hooks/exhaustive-deps
  const done = (msg: string) => { invalidateWorkspace(wid, 'document-security'); invalidateWorkspace(wid, 'documents'); toast(msg); };
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : 'That did not work.', 'error');
  const setSeconds = useMutation({ mutationFn: (s: number) => documentApi.setRevealSeconds(s), onSuccess: () => done('Reveal time saved.'), onError: fail });
  const rotate = useMutation({ mutationFn: () => documentApi.rotateKey(), onSuccess: () => done('Data key rotated. Values were re-encrypted.'), onError: fail });
  const verify = useMutation({ mutationFn: () => documentApi.verifyAudit(), onSuccess: (r) => { done(r.intact ? 'The audit trail is intact.' : 'The audit trail does not verify.'); }, onError: fail });
  const customValid = /^\d+$/.test(custom) && +custom >= 5 && +custom <= 300;
  return (
    <Modal title="Document security" subtitle="Secrets, reveal time and the audit trail." size="lg" onClose={onClose} footer={<button className="btn btn-ghost" onClick={onClose}>Close</button>}>
      {q.isLoading ? <PageLoader /> : q.isError || !d ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <div className="dsec">
          <section>
            <h4>Reveal time</h4>
            <p className="muted">A revealed value hides again after this long. It protects an unattended screen; the audit record protects against a copy.</p>
            <div className="seg" role="radiogroup" aria-label="Reveal time">
              {PRESETS.map((s) => <button key={s} role="radio" aria-checked={mode === 'preset' && d.revealSeconds === s} className={mode === 'preset' && d.revealSeconds === s ? 'on' : ''} disabled={!d.entitled || setSeconds.isPending} onClick={() => { setMode('preset'); setSeconds.mutate(s); }}>{s} s</button>)}
              <button role="radio" aria-checked={mode === 'custom'} className={mode === 'custom' ? 'on' : ''} disabled={!d.entitled} onClick={() => setMode('custom')}>Custom</button>
            </div>
            {mode === 'custom' && (
              <div className="dsec-custom">
                <input aria-label="Custom seconds" inputMode="numeric" value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, ''))} placeholder="5 – 300" />
                <span className="muted">seconds</span>
                <button className="btn btn-primary btn-sm" disabled={!customValid || setSeconds.isPending} onClick={() => setSeconds.mutate(+custom)}>Save</button>
              </div>
            )}
            {!d.entitled && <p className="muted dsec-plan"><Icon name="lock" size={13} /> Choosing the reveal time, confidential values, key rotation and the audit check are on the Business plan. Until then values hide after {d.revealSeconds} seconds.</p>}
          </section>
          <section>
            <h4>Data key</h4>
            <p className="muted">Each workspace has its own key, itself protected by the platform key. Rotating makes a new one and re-encrypts every value; nothing stops working meanwhile.</p>
            <div className="dsec-row">
              <span>Key version <b>{d.keyVersion || '–'}</b> · {d.valuesTotal.toLocaleString()} value{d.valuesTotal === 1 ? '' : 's'}{d.valuesOnOldKeys > 0 && <> · <span className="badge badge-warning">{d.valuesOnOldKeys.toLocaleString()} still on an older key</span></>}{d.lastRotatedAt && <> · rotated {timeAgo(d.lastRotatedAt)}</>}</span>
              <button className="btn btn-ghost btn-sm" disabled={!d.entitled || rotate.isPending} onClick={async () => { if (await confirmDialog({ title: 'Rotate the data key?', message: 'A new key is made and every secret is re-encrypted with it. This takes a moment for large workspaces.', confirmText: 'Rotate' })) rotate.mutate(); }}>{rotate.isPending ? <span className="spinner" /> : <Icon name="refresh" size={15} />} Rotate key</button>
            </div>
          </section>
          <section>
            <h4>Audit trail</h4>
            <p className="muted">Every audit record is chained to the one before it, so a changed or removed record is detected and named.</p>
            <div className="dsec-row">
              <span>{d.chain.intact ? <span className="badge badge-success"><Icon name="checkCircle" size={13} /> Intact</span> : <span className="badge badge-danger"><Icon name="alert" size={13} /> Broken at record {d.chain.brokenSeq}</span>} {d.chain.records.toLocaleString()} records{d.chain.verifiedAt && <> · checked {timeAgo(d.chain.verifiedAt)}</>}</span>
              <button className="btn btn-ghost btn-sm" disabled={!d.entitled || verify.isPending} onClick={() => verify.mutate()}>{verify.isPending ? <span className="spinner" /> : <Icon name="shield" size={15} />} Verify now</button>
            </div>
            {!d.chain.intact && <p className="form-error" role="alert">Record {d.chain.brokenSeq} {d.chain.reason ?? 'does not fit the chain'}{d.chain.verifiedAt ? ` (found ${formatDateTime(d.chain.verifiedAt)})` : ''}. Keep the database as it is and contact support.</p>}
          </section>
        </div>
      )}
    </Modal>
  );
}
