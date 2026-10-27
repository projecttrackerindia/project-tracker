import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { aiProviderApi, type AiKeyCheck, type AiProviderId, type AiProviderSettings, type AiProviderStatus } from './providerApi';
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

const ROUTES = [
  { k: 'quick', label: 'Quick answers', hint: 'short lookups and small talk', speed: 'Fastest', cost: '$' },
  { k: 'standard', label: 'Most questions', hint: 'the everyday model', speed: 'Fast', cost: '$$' },
  { k: 'deep', label: 'Deep analysis', hint: 'plans, risks, long reports', speed: 'Thorough', cost: '$$$' },
] as const;

/** The state of the saved key in one word, from the last check's error text: connected, a key problem, out of credit, or off. */
function stateOf(s: { enabled: boolean; lastError: string | null }) {
  if (s.lastError) {
    const e = s.lastError.toLowerCase();
    if (/credit|quota|billing|rate|limit|balance|429/.test(e)) return { tone: 'warn', word: 'Out of credit or rate limited' } as const;
    if (/invalid|revoked|expired|401|403|unauthori|permission|refused/.test(e)) return { tone: 'bad', word: 'Key not accepted' } as const;
    return { tone: 'warn', word: 'Last check failed' } as const;
  }
  return s.enabled ? { tone: 'ok', word: 'Connected' } as const : { tone: 'off', word: 'Saved, switched off' } as const;
}

/**
 * Settings › AI (owners and admins): answer the assistant on the organization's own Claude or ChatGPT account. The status sits at the top
 * (provider, key ending, who added it, last check and its latency, any error in the provider's words); below, the provider, the key and
 * which model answers which kind of question. The key is checked with the provider before it is saved; afterwards only its last four
 * characters are shown.
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
  const [busy, setBusy] = useState<'check' | 'test' | 'save' | 'remove' | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const keyBox = useRef<HTMLInputElement>(null);

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
  /** Re-read the saved state from the server (and everything that depends on it) - the answer of a save is put in place straight away. */
  const refresh = async (fresh?: AiProviderSettings) => {
    if (fresh && typeof fresh === 'object' && 'configured' in fresh) queryClient.setQueryData([wid, 'ai', 'provider'], fresh);
    await invalidateWorkspace(wid, 'ai');
  };

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

  /** "Test now": checks the saved key with the provider; the server records the time and any error. */
  const testNow = async () => {
    setBusy('test');
    const t0 = performance.now();
    try {
      const r = await aiProviderApi.check(s.provider, null);
      setLatency(Math.round(performance.now() - t0));
      toast(r.ok ? `${s.providerName} answered: the key works.` : r.error ?? 'The key did not work.', r.ok ? undefined : 'error');
      await refresh();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not test the key.', 'error'); }
    finally { setBusy(null); }
  };

  const save = async () => {
    setBusy('save');
    try {
      const fresh = await aiProviderApi.save({ provider, apiKey: key.trim() || null, quickModel: models.quick, standardModel: models.standard, deepModel: models.deep, enabled, fallbackToPlatform: fallback });
      setKey(''); setCheck(null);
      await refresh(fresh);
      toast(needsKey || key ? 'Saved. Each person is asked once before their questions go to ' + info.where + '.' : 'Saved.');
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save it.', 'error'); }
    finally { setBusy(null); }
  };

  const remove = async () => {
    if (!(await confirmDialog({ title: 'Remove your own AI key?', message: 'Everyone goes back to Project Tracker\'s AI, which uses the workspace\'s AI credits. The key is deleted here; revoke it with the provider too if you no longer need it.', confirmText: 'Remove key', danger: true }))) return;
    setBusy('remove');
    try { await aiProviderApi.remove(); queryClient.removeQueries({ queryKey: [wid, 'ai', 'provider'] }); await refresh(); toast('Removed. The assistant uses Project Tracker\'s AI again.'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove it.', 'error'); }
    finally { setBusy(null); }
  };

  const replace = () => { keyBox.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); keyBox.current?.focus(); };
  const st = s.configured ? stateOf(s) : null;
  const ready = !!models.quick && !!models.standard && !!models.deep && (!needsKey || (!!key.trim() && !!check?.ok)) && (!key.trim() || !!check?.ok);
  return (
    <div className="own-key" data-testid="own-ai-key">
      {/* 1. Status: what answers the assistant right now. */}
      {s.configured && st ? (
        <div className={`own-key-state on tone-${st.tone}`} data-testid="own-key-status">
          <span className={`own-key-logo ${s.provider}`} aria-hidden="true">{s.provider === 'anthropic' ? 'A' : 'O'}</span>
          <div className="own-key-state-main">
            <div className="own-key-state-title"><b>{s.providerName}</b><span className={`own-key-pill ${st.tone}`}><i />{st.word}</span></div>
            <div className="own-key-state-meta">
              <span>key ending <code>{s.keyHint}</code></span>
              {s.updatedByName && <span>added by {s.updatedByName}{s.updatedAt ? ` · ${formatDateTime(s.updatedAt)}` : ''}</span>}
              {s.lastCheckedAt && <span>{s.lastError ? 'checked' : 'last good check'} {formatDateTime(s.lastCheckedAt)}{latency !== null ? ` · ${latency} ms` : ''}</span>}
              <span>{s.peopleAgreed} {s.peopleAgreed === 1 ? 'person has' : 'people have'} agreed</span>
            </div>
            {s.lastError && <div className="own-key-error" role="alert"><Icon name="alert" size={13} /> {s.lastError}</div>}
            {!s.enabled && <p className="own-key-note">The key is saved but switched off: everyone is answered by Project Tracker&rsquo;s AI (Gemini, AI credits).</p>}
            {s.enabled && s.lastError && <p className="own-key-note">{s.fallbackToPlatform ? 'Until it works again, questions are answered by Project Tracker’s AI (Gemini) and use AI credits.' : 'Until it works again, people see this error instead of an answer.'}</p>}
          </div>
          <div className="own-key-state-actions">
            <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void testNow()} data-testid="own-key-test">{busy === 'test' ? 'Testing…' : 'Test now'}</button>
            <button type="button" className="btn btn-sm" onClick={replace}>Replace key</button>
            <button type="button" className="btn btn-sm btn-ghost danger" disabled={busy !== null} onClick={() => void remove()}>Remove key</button>
          </div>
        </div>
      ) : (
        <div className="own-key-state tone-off" data-testid="own-key-status">
          <span className="own-key-logo gemini" aria-hidden="true">G</span>
          <div className="own-key-state-main">
            <div className="own-key-state-title"><b>Project Tracker&rsquo;s AI (Gemini)</b><span className="own-key-pill off"><i />No own key</span></div>
            <div className="own-key-state-meta"><span>Answers use the workspace&rsquo;s AI credits. Add a Claude or ChatGPT key below to answer on your own account.</span></div>
          </div>
        </div>
      )}

      <div className="own-key-group">
        <div className="setting-info own-key-intro">
          <h4><Icon name="key" size={14} /> Use your own Claude or ChatGPT</h4>
          <p>Answer the assistant on your organization's own AI account. Usage is billed by the provider to you and uses no AI credits here. Each person agrees once before their questions go to it, and can withdraw. Scheduled work (digests, the project agent) keeps using Project Tracker's AI.</p>
        </div>

        {/* 2. Provider: two large cards, each saying whether it is connected. */}
        <div className="own-key-providers" role="radiogroup" aria-label="Provider">
          {PROVIDERS.map((p) => {
            const connected = s.configured && s.provider === p.id;
            return (
              <label key={p.id} className={`own-key-provider ${provider === p.id ? 'on' : ''}`}>
                <input type="radio" name="own-key-provider" checked={provider === p.id} onChange={() => { setProvider(p.id); setCheck(null); }} />
                <span className={`own-key-logo ${p.id}`} aria-hidden="true">{p.id === 'anthropic' ? 'A' : 'O'}</span>
                <span className="own-key-provider-text"><b>{p.name}</b><small>Key from {p.console}</small>
                  <em className={connected ? 'yes' : ''}>{connected ? `Connected · •••• ${s.keyHint ?? ''}` : 'Not connected'}</em></span>
              </label>
            );
          })}
        </div>
        <div className="own-key-fallback-card"><span className="own-key-logo gemini" aria-hidden="true">G</span>
          <span><b>Gemini (included)</b><small>{!s.configured || !s.enabled ? 'Answering now · uses AI credits' : fallback ? 'Fallback when your key cannot answer' : 'Not used: fallback is off'}</small></span></div>

        <div className="field">
          <label htmlFor="own-key-input">{needsKey ? 'API key' : `New API key (leave empty to keep the key ending ${s.keyHint})`}</label>
          <div className="row" style={{ gap: 8 }}>
            <input ref={keyBox} id="own-key-input" className="input" type="password" autoComplete="new-password" name="own-ai-api-key" data-1p-ignore="true" data-lpignore="true" data-form-type="other" spellCheck={false} value={key} placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
              onChange={(e) => { setKey(e.target.value); setCheck(null); }} />
            <button type="button" className="btn" disabled={busy !== null || (needsKey && !key.trim())} onClick={() => void runCheck()} data-testid="own-key-check">
              {busy === 'check' ? 'Checking…' : 'Check key'}
            </button>
          </div>
          {check && !check.ok && <p className="own-key-error" role="alert"><Icon name="alert" size={13} /> {check.error}</p>}
          {check?.ok && <p className="own-key-ok"><Icon name="checkCircle" size={13} /> Accepted. {check.models.length} models available to this key.</p>}
        </div>
      </div>

      {/* 3. Model routing: which model answers which kind of question. */}
      {list.length > 0 && (
        <div className="own-key-group">
          <h5 className="own-key-label">Model routing</h5>
          <div className="own-key-routes" role="table" aria-label="Model routing">
            {ROUTES.map((r) => (
              <div className="own-key-route" role="row" key={r.k}>
                <div role="cell" className="own-key-route-what"><label htmlFor={`own-key-${r.k}`}><b>{r.label}</b></label><small>{r.hint}</small></div>
                <div role="cell" className="own-key-route-pills"><span className="own-key-chip">{r.speed}</span><span className="own-key-chip cost" title="Relative cost">{r.cost}</span></div>
                <div role="cell"><select id={`own-key-${r.k}`} className="input" value={models[r.k]} onChange={(e) => setModels((m) => ({ ...m, [r.k]: e.target.value }))}>
                  {!models[r.k] && <option value="">Choose a model</option>}
                  {list.map((m) => <option key={m} value={m}>{m}</option>)}
                </select></div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="own-key-group">
        <label className="own-key-toggle"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> <span><b>On for everyone who agrees</b><small>Turn it off to go back to Project Tracker's AI without removing the key.</small></span></label>
        <label className="own-key-toggle"><input type="checkbox" checked={fallback} onChange={(e) => setFallback(e.target.checked)} /> <span><b>If the key cannot answer, use Project Tracker's AI</b><small>For example when the account is out of credit. Those answers use AI credits. Off: people see what went wrong instead.</small></span></label>
        <div className="row own-key-foot">
          <button type="button" className="btn btn-primary" disabled={busy !== null || !ready} onClick={() => void save()} data-testid="own-key-save">{busy === 'save' ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
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
