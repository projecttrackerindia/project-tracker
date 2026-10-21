import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { del, get, post, put } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { ErrorState, Modal, PageLoader } from '../../components/ui';
import { Select } from '../../components/Select';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const PRESETS = [10, 15, 30, 60];

/** Owners and admins: how long a revealed value stays on screen, the data key, and the check of the audit trail. */
export function DocumentSecurityModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Document security" subtitle="Secrets, reveal time and the audit trail." size="lg" onClose={onClose} className="doc-scope" footer={<button className="btn btn-ghost" onClick={onClose}>Close</button>}>
      <div className="dsec"><MaskingSection /></div>
      <SecuritySettings />
    </Modal>
  );
}

/** Reveal time, the data key and the audit chain check (owners and admins). */
export function SecuritySettings() {
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
    <>
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
    </>
  );
}

interface MaskBuiltIn { label: string; strategy: string; example: string; masked: string; enabled: boolean }
interface MaskRuleRow { id: string; field: string; match: string; strategy: string; label: string; enabled: boolean }
interface Masking { enabled: boolean; builtIns: MaskBuiltIn[]; rules: MaskRuleRow[]; canManage: boolean }
const maskingApi = {
  get: () => get<Masking>('/document-security/masking'),
  save: (b: { enabled: boolean; disabledBuiltIns: string[] }) => put<Masking>('/document-security/masking', b),
  addRule: (b: Omit<MaskRuleRow, 'id'>) => post<Masking>('/document-security/masking/rules', b),
  removeRule: (id: string) => del<Masking>(`/document-security/masking/rules/${id}`),
  preview: (text: string) => post<{ masked: string; count: number }>('/document-security/masking/preview', { text }),
};
const STRATEGY: Record<string, string> = { full: 'Hide all', last4: 'Show last 4', last2: 'Show last 2', first2last2: 'Show first 2 and last 2', email: 'Hide the name, keep the domain', secret: 'Credential' };

/** What is masked in documents: on or off, the built-in kinds, the workspace's own rules, and a box to try a sample. */
export function MaskingSection() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['document-security', 'masking'], maskingApi.get);
  const [field, setField] = useState(''); const [strategy, setStrategy] = useState('full'); const [match, setMatch] = useState('exact');
  const [sample, setSample] = useState('Ravi 98765 43210, PAN ABCDE1234F, client_secret: s3cr3tValue');
  const [preview, setPreview] = useState<{ masked: string; count: number } | null>(null);
  const done = () => { void q.refetch(); invalidateWorkspace(wid, 'documents'); };
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'That did not work.', 'error');
  const save = useMutation({ mutationFn: maskingApi.save, onSuccess: () => { done(); toast('Masking saved.'); }, onError: fail });
  const add = useMutation({ mutationFn: maskingApi.addRule, onSuccess: () => { done(); setField(''); toast('Rule added.'); }, onError: fail });
  const remove = useMutation({ mutationFn: maskingApi.removeRule, onSuccess: done, onError: fail });
  const m = q.data;
  if (!m) return <section><h4>Data masking</h4>{q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : <PageLoader />}</section>;
  const off = m.builtIns.filter((b) => !b.enabled).map((b) => b.label);
  const toggle = (label: string) => save.mutate({ enabled: m.enabled, disabledBuiltIns: off.includes(label) ? off.filter((x) => x !== label) : [...off, label] });
  return (
    <section className="dmask">
      <div className="dmask-head">
        <div><h4>Data masking</h4><p className="muted">Personal and secret values in documents are masked before they leave the server - for readers, in version history and in PDFs. Editors unlock them to edit; others with the reveal permission give a reason. Every reveal is in the audit trail.</p></div>
        <label className="dmask-switch"><input type="checkbox" checked={m.enabled} disabled={!m.canManage || save.isPending} onChange={(e) => save.mutate({ enabled: e.target.checked, disabledBuiltIns: off })} /><span>{m.enabled ? 'On' : 'Off'}</span></label>
      </div>
      {m.enabled && <>
        <div className="dmask-kinds" role="group" aria-label="Built-in kinds">
          {m.builtIns.map((b) => (
            <button key={b.label} type="button" className={`dmask-kind${b.enabled ? ' on' : ''}`} aria-pressed={b.enabled} disabled={!m.canManage || save.isPending} onClick={() => toggle(b.label)} title={`${b.example} → ${b.masked}`}>
              <Icon name={b.enabled ? 'lock' : 'eye'} size={12} /><span>{b.label}</span><code>{b.masked}</code>
            </button>
          ))}
        </div>
        <div className="dmask-rules">
          <b>Your own fields</b>
          {m.rules.length === 0 && <p className="muted">None yet. Add fields your company uses, like loan_account_no or Employee code.</p>}
          {m.rules.map((r) => (
            <div key={r.id} className="dmask-rule"><code>{r.field}</code><span className="muted">{r.match === 'exact' ? 'exact name' : r.match}</span><span>{STRATEGY[r.strategy] ?? r.strategy}</span>
              {m.canManage && <button type="button" className="btn-icon" aria-label={`Remove ${r.field}`} onClick={() => remove.mutate(r.id)}><Icon name="trash" size={14} /></button>}</div>
          ))}
          {m.canManage && (
            <form className="dmask-add" onSubmit={(e) => { e.preventDefault(); if (field.trim()) add.mutate({ field: field.trim(), match, strategy, label: field.trim(), enabled: true }); }}>
              <input aria-label="Field name" value={field} onChange={(e) => setField(e.target.value)} placeholder="Field name, e.g. loan_account_no" />
              <Select className="select" aria-label="Match" value={match} onChange={(e) => setMatch(e.target.value)}><option value="exact">Exact name</option><option value="contains">Name contains</option><option value="regex">Pattern (regex)</option></Select>
              <Select className="select" aria-label="Mask" value={strategy} onChange={(e) => setStrategy(e.target.value)}>{Object.entries(STRATEGY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
              <button className="btn btn-primary btn-sm" disabled={!field.trim() || add.isPending}>Add</button>
            </form>
          )}
        </div>
        <div className="dmask-try">
          <b>Try it</b>
          <div className="dmask-try-row"><input aria-label="Sample text" value={sample} onChange={(e) => setSample(e.target.value)} /><button type="button" className="btn btn-ghost btn-sm" onClick={async () => { try { setPreview(await maskingApi.preview(sample)); } catch (e) { fail(e); } }}>Preview</button></div>
          {preview && <p className="dmask-out"><code>{preview.masked}</code> <span className="muted">{preview.count} masked</span></p>}
        </div>
      </>}
    </section>
  );
}
