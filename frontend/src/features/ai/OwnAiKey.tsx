import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { aiProviderApi, type AiKeyCheck, type AiProviderId, type AiProviderStatus } from './providerApi';
import './ownKey.css';

const PROVIDERS: { id: AiProviderId; name: string; where: string; console: string }[] = [
  { id: 'anthropic', name: 'Claude (Anthropic)', where: 'Anthropic', console: 'console.anthropic.com › API keys' },
  { id: 'openai', name: 'ChatGPT (OpenAI)', where: 'OpenAI', console: 'platform.openai.com › API keys' },
];

/** Sensible first choices from the models a key may use: a small fast one, the everyday one, and the strongest. */
function suggest(models: string[], provider: AiProviderId) {
  const find = (re: RegExp) => models.find((m) => re.test(m));
  if (provider === 'anthropic') {
    return { quick: find(/haiku/) ?? models[0], standard: find(/sonnet/) ?? models[0], deep: find(/opus/) ?? find(/sonnet/) ?? models[0] };
  }
  const standard = find(/^gpt-5(\.\d+)?$/) ?? find(/^gpt-4\.1$/) ?? find(/^gpt-4o$/) ?? models[0];
  return { quick: find(/^gpt-5(\.\d+)?-mini$/) ?? find(/mini|nano/) ?? standard, standard, deep: find(/^gpt-5(\.\d+)?-pro$/) ?? find(/^o3$/) ?? standard };
}

/**
 * Settings › Assistant (owners and admins): answer the assistant on the organization's own Claude or ChatGPT account. The key is checked
 * with the provider (its model list is the proof it works) before it is saved; afterwards only its last four characters are shown.
 */
export function AiOwnKeyCard() {
  const wid = useWorkspaceId();
  const role = useAuth((s) => s.ctx?.current?.role);
  const org = useAuth((s) => s.ctx?.current?.type === 'Organization');
  const admin = org && (role === 'Owner' || role === 'Admin');
  const q = useWsQuery(['ai', 'provider'], aiProviderApi.get, { enabled: admin, staleTime: 30_000 });
  const s = q.data;
  const [provider, setProvider] = useState<AiProviderId>('anthropic');
  const [key, setKey] = useState('');
  const [check, setCheck] = useState<AiKeyCheck | null>(null);
  const [models, setModels] = useState({ quick: '', standard: '', deep: '' });
  const [enabled, setEnabled] = useState(true);
  const [fallback, setFallback] = useState(true);
  const [busy, setBusy] = useState<'check' | 'save' | 'remove' | null>(null);

  useEffect(() => {
    if (!s) return;
    setProvider(s.provider); setModels({ quick: s.quickModel, standard: s.standardModel, deep: s.deepModel });
    setEnabled(s.configured ? s.enabled : true); setFallback(s.fallbackToPlatform); setCheck(null); setKey('');
  }, [s]);

  const switching = !!s?.configured && provider !== s.provider;
  const list = useMemo(() => {
    const known = check?.ok ? check.models : [];
    // The saved models stay choosable even before the key is checked again.
    return [...new Set([...known, ...(s?.configured && !switching ? [s.quickModel, s.standardModel, s.deepModel] : [])])].filter(Boolean).sort();
  }, [check, s, switching]);

  if (!admin || !s) return null;
  const info = PROVIDERS.find((p) => p.id === provider)!;
  const needsKey = !s.configured || switching;

  const runCheck = async () => {
    setBusy('check');
    try {
      const r = await aiProviderApi.check(provider, key.trim() || null);
      setCheck(r);
      if (r.ok) {
        // Fresh choices for a new provider or key; otherwise keep what was saved when the key still offers it.
        const pick = suggest(r.models, provider);
        setModels((m) => ({
          quick: r.models.includes(m.quick) && !switching ? m.quick : pick.quick,
          standard: r.models.includes(m.standard) && !switching ? m.standard : pick.standard,
          deep: r.models.includes(m.deep) && !switching ? m.deep : pick.deep,
        }));
        toast(`${info.name} accepted the key: ${r.models.length} models available.`);
      }
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not check the key.', 'error'); }
    finally { setBusy(null); }
  };

  const save = async () => {
    setBusy('save');
    try {
      await aiProviderApi.save({ provider, apiKey: key.trim() || null, quickModel: models.quick, standardModel: models.standard, deepModel: models.deep, enabled, fallbackToPlatform: fallback });
      setKey(''); setCheck(null);
      void invalidateWorkspace(wid, 'ai');
      toast(needsKey || key ? 'Saved. Each person is asked once before their questions go to ' + info.where + '.' : 'Saved.');
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save it.', 'error'); }
    finally { setBusy(null); }
  };

  const remove = async () => {
    if (!(await confirmDialog({ title: 'Remove your own AI key?', message: 'Everyone goes back to Project Tracker\'s AI, which uses the workspace\'s AI credits. The key is deleted here; revoke it with the provider too if you no longer need it.', confirmText: 'Remove key', danger: true }))) return;
    setBusy('remove');
    try { await aiProviderApi.remove(); void invalidateWorkspace(wid, 'ai'); toast('Removed. The assistant uses Project Tracker\'s AI again.'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove it.', 'error'); }
    finally { setBusy(null); }
  };

  const ready = !!models.quick && !!models.standard && !!models.deep && (!needsKey || (!!key.trim() && !!check?.ok)) && (!key.trim() || !!check?.ok);
  return (
    <div className="card own-key" style={{ marginTop: 18 }} data-testid="own-ai-key"><div className="card-body">
      <div className="setting-info" style={{ marginBottom: 12 }}>
        <h4><Icon name="key" size={14} /> Use your own Claude or ChatGPT</h4>
        <p>Answer the assistant on your organization's own AI account. Usage is billed by the provider to you and uses no AI credits here. Each person agrees once before their questions go to it, and can withdraw. Scheduled work (digests, the project agent) keeps using Project Tracker's AI.</p>
      </div>

      {s.configured && (
        <div className={`own-key-state ${s.enabled ? 'on' : ''}`}>
          <b>{s.enabled ? 'On' : 'Off'}</b> · {s.providerName} · key ending <code>{s.keyHint}</code> · {s.peopleAgreed} {s.peopleAgreed === 1 ? 'person has' : 'people have'} agreed
          {s.lastCheckedAt && <> · checked {formatDateTime(s.lastCheckedAt)}</>}
          {s.lastError && <div className="own-key-error" role="alert"><Icon name="alert" size={13} /> Last problem: {s.lastError}</div>}
        </div>
      )}

      <div className="own-key-providers" role="radiogroup" aria-label="Provider">
        {PROVIDERS.map((p) => (
          <label key={p.id} className={`own-key-provider ${provider === p.id ? 'on' : ''}`}>
            <input type="radio" name="own-key-provider" checked={provider === p.id} onChange={() => { setProvider(p.id); setCheck(null); }} />
            <span><b>{p.name}</b><small>Key from {p.console}</small></span>
          </label>
        ))}
      </div>

      <div className="field">
        <label htmlFor="own-key-input">{needsKey ? 'API key' : `New API key (leave empty to keep the key ending ${s.keyHint})`}</label>
        <div className="row" style={{ gap: 8 }}>
          <input id="own-key-input" className="input" type="password" autoComplete="off" spellCheck={false} value={key} placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
            onChange={(e) => { setKey(e.target.value); setCheck(null); }} />
          <button type="button" className="btn" disabled={busy !== null || (needsKey && !key.trim())} onClick={() => void runCheck()} data-testid="own-key-check">
            {busy === 'check' ? 'Checking…' : 'Check key'}
          </button>
        </div>
        {check && !check.ok && <p className="own-key-error" role="alert"><Icon name="alert" size={13} /> {check.error}</p>}
        {check?.ok && <p className="own-key-ok"><Icon name="checkCircle" size={13} /> Accepted. {check.models.length} models available to this key.</p>}
      </div>

      {list.length > 0 && (
        <div className="own-key-models">
          {([['quick', 'Quick answers', 'short lookups and small talk'], ['standard', 'Most questions', 'the everyday model'], ['deep', 'Deep analysis', 'plans, risks, long reports']] as const).map(([k, label, hint]) => (
            <div className="field" key={k}>
              <label htmlFor={`own-key-${k}`}>{label} <small className="muted">· {hint}</small></label>
              <select id={`own-key-${k}`} className="input" value={models[k]} onChange={(e) => setModels((m) => ({ ...m, [k]: e.target.value }))}>
                {!models[k] && <option value="">Choose a model</option>}
                {list.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}

      <label className="own-key-toggle"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> <span><b>On for everyone who agrees</b><small>Turn it off to go back to Project Tracker's AI without removing the key.</small></span></label>
      <label className="own-key-toggle"><input type="checkbox" checked={fallback} onChange={(e) => setFallback(e.target.checked)} /> <span><b>If the key cannot answer, use Project Tracker's AI</b><small>For example when the account is out of credit. Those answers use AI credits. Off: people see what went wrong instead.</small></span></label>

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 14, gap: 8, flexWrap: 'wrap' }}>
        {s.configured ? <button type="button" className="btn btn-ghost danger" disabled={busy !== null} onClick={() => void remove()}><Icon name="trash" size={14} /> Remove key</button> : <span />}
        <button type="button" className="btn btn-primary" disabled={busy !== null || !ready} onClick={() => void save()} data-testid="own-key-save">{busy === 'save' ? 'Saving…' : 'Save'}</button>
      </div>
    </div></div>
  );
}

/** Asks a person, once, to agree before their questions go to the organization's own AI account. */
export function ProviderConsentDialog({ status, onAgreed, onClose }: { status: AiProviderStatus; onAgreed: () => void; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [busy, setBusy] = useState(false);
  const agree = async () => {
    setBusy(true);
    try { await aiProviderApi.agree(); void invalidateWorkspace(wid, 'ai', 'provider-status'); onAgreed(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save your answer.', 'error'); setBusy(false); }
  };
  return (
    <Modal title={`Your organization uses its own ${status.providerName}`} onClose={onClose} footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Not now</button>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void agree()} data-testid="provider-agree">{busy ? 'Saving…' : 'Agree and continue'}</button>
    </>}>
      <div className="provider-consent" data-testid="provider-consent">
        <p>{status.notice}</p>
        <ul>
          <li><Icon name="checkCircle" size={14} /><span>Only what you can already see in Project Tracker is ever looked up for you.</span></li>
          <li><Icon name="checkCircle" size={14} /><span>You are asked once. Withdraw any time in <b>My account › Profile</b>.</span></li>
        </ul>
      </div>
    </Modal>
  );
}

/** Above the assistant's box, until the person has agreed: a quiet line instead of a surprise at the first question. */
export function ProviderNotice({ onAgree }: { onAgree: (s: AiProviderStatus) => void }) {
  const q = useWsQuery(['ai', 'provider-status'], aiProviderApi.status, { staleTime: 60_000 });
  if (!q.data?.active || q.data.agreed) return null;
  return (
    <div className="provider-notice" role="status" data-testid="provider-notice">
      <Icon name="key" size={14} />
      <span>Your organization answers here with its own <b>{q.data.providerName}</b>. You will be asked once before your first question.</span>
      <button type="button" className="link-btn" onClick={() => onAgree(q.data!)}>Review and agree</button>
    </div>
  );
}

/** My account: whether this person agreed to the organization's own AI account, and a way to withdraw. */
export function MyAiProviderCard() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['ai', 'provider-status'], aiProviderApi.status, { staleTime: 30_000 });
  const [busy, setBusy] = useState(false);
  if (!q.data?.active) return null;
  const s = q.data;
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); void invalidateWorkspace(wid, 'ai', 'provider-status'); toast(done); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save that.', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="card own-key" style={{ marginTop: 18 }} data-testid="my-ai-provider"><div className="card-body">
      <div className="setting-info" style={{ marginBottom: 10 }}>
        <h4><Icon name="key" size={14} /> Your organization's own {s.providerName}</h4>
        <p>{s.notice}</p>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 13 }}>{s.agreed ? `You agreed on ${formatDateTime(s.agreedAt!)}.` : 'You have not agreed. The assistant asks before your first question.'}</span>
        {s.agreed
          ? <button type="button" className="btn" disabled={busy} onClick={() => void act(aiProviderApi.withdraw, 'Withdrawn. The assistant will ask again before your next question.')}>Withdraw</button>
          : <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(aiProviderApi.agree, 'Agreed.')}>Agree</button>}
      </div>
    </div></div>
  );
}
