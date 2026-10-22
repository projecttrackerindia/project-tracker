import { useId, useMemo, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Spinner } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import {
  emptyFlow, errText, samplePaths, sampleValue, TOOL_TEMPLATES, voiceApi,
  type Connector, type ConnectorDraft, type FieldFormat, type FlowField, type FlowInput, type FlowStep, type InputType, type StepType, type ToolTest, type VoiceFlow, type VoiceSettings,
} from './voiceApi';

type Node = 'source' | 'request' | 'logic' | 'response';
const NODES: { id: Node; title: string; icon: IconName; hint: string }[] = [
  { id: 'source', title: 'Source', icon: 'user', hint: 'When to use it, what to ask the caller' },
  { id: 'request', title: 'Request', icon: 'link', hint: 'Your API: address, key, body, sample' },
  { id: 'logic', title: 'Logic', icon: 'workflow', hint: 'Identity check, rules, follow-on calls' },
  { id: 'response', title: 'Response', icon: 'message', hint: 'The only facts the agent may say' },
];
const INPUT_TYPES: [InputType, string][] = [['text', 'Text'], ['digits', 'Number (digits only)'], ['date', 'Date'], ['phone', 'Phone (10 digits)'], ['email', 'E-mail'], ['last4', 'Last 4 digits']];
const FORMATS: [FieldFormat, string, string][] = [
  ['text', 'Text', 'as it is'], ['inr', 'Rupees', '₹1,24,999.50'], ['number', 'Number', '1,24,999'], ['date', 'Date', '5 November 2026'], ['datetime', 'Date and time', '5 November 2026, 3:30 PM'],
  ['mask4', 'Masked (last 4)', 'ending 7890'], ['yesno', 'Yes / no', 'yes'], ['percent', 'Percent', '12.5%'],
];
const OPS: [NonNullable<FlowStep['op']>, string][] = [['eq', 'is'], ['ne', 'is not'], ['gt', 'is more than'], ['gte', 'is at least'], ['lt', 'is less than'], ['lte', 'is at most'], ['contains', 'contains'], ['empty', 'is empty / missing'], ['notempty', 'has a value']];
const ACTIONS: [NonNullable<FlowStep['action']>, string][] = [['say', 'Say something'], ['ticket', 'Log a ticket'], ['transfer', 'Hand over to a person'], ['stop', 'Share nothing from this lookup']];
const COMPARES: [NonNullable<FlowStep['compare']>, string][] = [['date', 'Same date (any format)'], ['digits', 'Same digits'], ['last4', 'Last 4 digits match'], ['exact', 'Exactly the same text']];
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]{0,39})\}/g;

/** The Tools tab: every API the agent can read, each shown as its flow, and the builder. */
export function ToolsTab({ s }: { s: VoiceSettings }) {
  const q = useWsQuery(['voice', 'connectors'], voiceApi.connectors);
  const [edit, setEdit] = useState<{ draft: ConnectorDraft; id?: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const list = q.data ?? [];
  if (edit) return <ToolBuilder key={edit.id ?? 'new'} initial={edit.draft} id={edit.id} all={list} s={s} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void q.refetch(); }} />;
  const open = (c: Connector) => setEdit({ id: c.id, draft: { name: c.name, description: c.description, method: c.method, urlTemplate: c.urlTemplate, headerName: c.headerName, enabled: c.enabled, flow: c.flow ?? null } });
  return (
    <div className="vt">
      <div className="vt-intro">
        <div>
          <h3>Your systems {s.agentName} can read</h3>
          <p>Each tool is one of your APIs (MuleSoft, core banking, CRM) with a flow: what the agent asks the caller, the request, the rules it applies, and the only facts it may say.
            The agent never sees the raw answer of a tool with a flow.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setPicking(true)}><Icon name="plus" size={14} /> New tool</button>
      </div>
      {picking && (
        <div className="vt-templates" role="group" aria-label="Start from">
          {TOOL_TEMPLATES.map((t) => (
            <button key={t.id} type="button" className="vt-template" onClick={() => { setPicking(false); setEdit({ draft: t.draft() }); }}>
              <b>{t.title}</b><span>{t.blurb}</span>
            </button>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicking(false)}>Cancel</button>
        </div>
      )}
      {list.length === 0 && !picking ? (
        <div className="vt-empty"><Icon name="link" size={22} /><b>No tools yet</b><span>Without them the agent takes a ticket for account questions. Start from a ready-made loan lookup.</span>
          <button className="btn" onClick={() => setPicking(true)}>Choose a starting point</button></div>
      ) : (
        <ul className="vt-list">{list.map((c) => <ToolCard key={c.id} c={c} onOpen={() => open(c)} onChanged={() => void q.refetch()} />)}</ul>
      )}
    </div>
  );
}

function ToolCard({ c, onOpen, onChanged }: { c: Connector; onOpen: () => void; onChanged: () => void }) {
  const f = c.flow;
  let host = c.urlTemplate;
  try { host = new URL(c.urlTemplate.replace(PLACEHOLDER, 'x')).host; } catch { /* keep the template */ }
  const remove = async () => {
    if (!(await confirmDialog({ title: `Remove ${c.name}?`, message: 'The agent can no longer read this system.', confirmText: 'Remove', danger: true }))) return;
    try { await voiceApi.removeConnector(c.id); onChanged(); } catch (e) { toast(errText(e, 'Could not remove.'), 'error'); }
  };
  const chips = [
    { k: 'Source', v: f?.inputs.length ? f.inputs.map((i) => i.label || i.name).join(', ') : c.placeholders.join(', ') || 'no inputs' },
    { k: 'Request', v: `${c.method} ${host}` },
    { k: 'Logic', v: f ? `${f.steps.length} step${f.steps.length === 1 ? '' : 's'}${f.steps.some((s) => s.type === 'verify') ? ' · checks identity' : ''}` : 'none' },
    { k: 'Response', v: f ? `${f.fields.length} fact${f.fields.length === 1 ? '' : 's'}${f.requiresVerifiedCaller ? ' · verified callers only' : ''}` : 'raw answer (add a flow)' },
  ];
  return (
    <li className={`vt-card ${c.enabled ? '' : 'off'}`}>
      <button type="button" className="vt-card-main" onClick={onOpen}>
        <span className="vt-card-title"><Icon name="database" size={15} /><b>{c.name}</b>{!c.enabled && <span className="vt-pill">Off</span>}{!f && <span className="vt-pill warn">No flow</span>}</span>
        <span className="vt-card-desc">{c.description}</span>
        <span className="vt-mini" aria-hidden="true">{chips.map((x, i) => <span key={x.k} className="vt-mini-node"><small>{x.k}</small>{x.v}{i < 3 && <i className="vt-mini-arrow" />}</span>)}</span>
      </button>
      <span className="vt-card-actions">
        {c.updatedAt && <small>Updated {formatDateTime(c.updatedAt)}</small>}
        <button className="btn btn-sm btn-ghost" onClick={onOpen}>Open</button>
        <button className="btn btn-sm btn-ghost" onClick={() => void remove()} aria-label={`Remove ${c.name}`}><Icon name="trash" size={14} /></button>
      </span>
    </li>
  );
}

// ------------------------------------------------------------------------------------------------ the builder

function ToolBuilder({ initial, id, all, s, onClose, onSaved }: { initial: ConnectorDraft; id?: string; all: Connector[]; s: VoiceSettings; onClose: () => void; onSaved: () => void }) {
  const wid = useWorkspaceId();
  const [d, setD] = useState<ConnectorDraft>(() => ({ ...initial, flow: initial.flow ?? emptyFlow() }));
  const [node, setNode] = useState<Node>('source');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(!id);
  const flow = d.flow!;
  const others = all.filter((c) => c.id !== id && c.name !== d.name);
  const setFlow = (f: Partial<VoiceFlow>) => { setD((x) => ({ ...x, flow: { ...x.flow!, ...f } })); setDirty(true); };
  const set = <K extends keyof ConnectorDraft>(k: K, v: ConnectorDraft[K]) => { setD((x) => ({ ...x, [k]: v })); setDirty(true); };
  const aliases = ['main', ...flow.steps.filter((st) => st.type === 'chain' && st.as).map((st) => st.as!)];
  const paths = useMemo(() => aliases.flatMap((a) => samplePaths(a, flow.samples[a])), [flow.samples, aliases.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const issues = checkDraft(d, others);
  const status: Record<Node, number> = {
    source: issues.filter((i) => i.node === 'source').length, request: issues.filter((i) => i.node === 'request').length,
    logic: issues.filter((i) => i.node === 'logic').length, response: issues.filter((i) => i.node === 'response').length,
  };
  const save = async () => {
    setBusy(true);
    try {
      await voiceApi.saveConnector({ ...d, secret: d.secret || undefined }, id);
      toast(`${d.name} saved.`); void invalidateWorkspace(wid, 'voice'); setDirty(false); onSaved();
    } catch (e) { toast(errText(e, 'Could not save.'), 'error'); } finally { setBusy(false); }
  };
  const close = async () => {
    if (dirty && !(await confirmDialog({ title: 'Leave without saving?', message: 'Your changes to this tool will be lost.', confirmText: 'Leave', danger: true }))) return;
    onClose();
  };
  return (
    <div className="vb">
      <header className="vb-head">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void close()}><Icon name="arrowLeft" size={14} /> Tools</button>
        <div className="vb-title">
          <input value={d.name} onChange={(e) => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} placeholder="tool_name" aria-label="Tool name" />
          <small>{id ? 'Editing' : 'New tool'}{dirty ? ' · unsaved changes' : ''}</small>
        </div>
        <label className="vb-switch"><input type="checkbox" checked={d.enabled} onChange={(e) => set('enabled', e.target.checked)} /><span>{d.enabled ? 'On' : 'Off'}</span></label>
        <button className="btn btn-primary" disabled={busy || issues.length > 0} title={issues[0]?.text} onClick={() => void save()}>{busy ? <Spinner /> : <Icon name="check" size={14} />} Save tool</button>
      </header>

      <div className="vb-body">
        <nav className="vb-rail" aria-label="Flow">
          {NODES.map((n, i) => (
            <div key={n.id} className="vb-rail-item">
              <button type="button" className={`vb-node ${node === n.id ? 'on' : ''} ${status[n.id] ? 'warn' : 'ok'}`} onClick={() => setNode(n.id)} aria-current={node === n.id ? 'step' : undefined}>
                <span className="vb-node-ic"><Icon name={n.icon} size={16} /></span>
                <span className="vb-node-txt"><b>{i + 1}. {n.title}</b><small>{nodeSummary(n.id, d)}</small></span>
                <span className="vb-node-state" aria-label={status[n.id] ? `${status[n.id]} to fix` : 'Ready'}>{status[n.id] ? status[n.id] : <Icon name="check" size={12} />}</span>
              </button>
              {i < NODES.length - 1 && <span className="vb-link" aria-hidden="true" />}
            </div>
          ))}
          {issues.length > 0 && (
            <div className="vb-issues" role="status"><b>Before saving</b><ul>{issues.slice(0, 6).map((x, i) => <li key={i}><button type="button" onClick={() => setNode(x.node)}>{x.text}</button></li>)}</ul></div>
          )}
        </nav>

        <section className="vb-editor" aria-label={NODES.find((n) => n.id === node)!.title}>
          <div className="vb-editor-head"><h3>{NODES.find((n) => n.id === node)!.title}</h3><p>{NODES.find((n) => n.id === node)!.hint}</p></div>
          {node === 'source' && <SourceEditor d={d} set={set} flow={flow} setFlow={setFlow} />}
          {node === 'request' && <RequestEditor d={d} set={set} flow={flow} setFlow={setFlow} hasSecret={!!all.find((c) => c.id === id)?.hasSecret} aliases={aliases} />}
          {node === 'logic' && <LogicEditor flow={flow} setFlow={setFlow} paths={paths} others={others} />}
          {node === 'response' && <ResponseEditor flow={flow} setFlow={setFlow} paths={paths} s={s} />}
          <div className="vb-nav">
            {node !== 'source' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNode(NODES[NODES.findIndex((n) => n.id === node) - 1].id)}><Icon name="chevronL" size={14} /> Back</button>}
            {node !== 'response' && <button type="button" className="btn btn-sm" onClick={() => setNode(NODES[NODES.findIndex((n) => n.id === node) + 1].id)}>Next <Icon name="chevronR" size={14} /></button>}
          </div>
        </section>

        <TestPanel d={d} id={id} s={s} canRun={issues.filter((x) => x.blocksTest).length === 0} />
      </div>
    </div>
  );
}

interface Issue { node: Node; text: string; blocksTest?: boolean }
/** The same checks the server makes, shown while editing so nothing surprises on save. */
function checkDraft(d: ConnectorDraft, others: Connector[]): Issue[] {
  const f = d.flow!; const out: Issue[] = [];
  if (!/^[a-z][a-z0-9_]{1,59}$/.test(d.name)) out.push({ node: 'source', text: 'Give the tool a short name like loan_details.', blocksTest: true });
  if (!d.description.trim()) out.push({ node: 'source', text: 'Say when the agent should use it.', blocksTest: true });
  const names = new Set(f.inputs.map((i) => i.name));
  f.inputs.forEach((i) => { if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(i.name)) out.push({ node: 'source', text: `Input "${i.name || '(blank)'}" needs a name like loanNumber.`, blocksTest: true }); });
  let urlOk = false;
  try { urlOk = new URL(d.urlTemplate.replace(PLACEHOLDER, 'x')).protocol === 'https:'; } catch { urlOk = false; }
  if (!urlOk) out.push({ node: 'request', text: 'Enter an https address for your API.', blocksTest: true });
  for (const m of d.urlTemplate.matchAll(PLACEHOLDER)) if (!names.has(m[1])) out.push({ node: 'source', text: `The address uses {${m[1]}}: add it as an input.`, blocksTest: true });
  if (f.bodyTemplate?.trim()) {
    if (d.method !== 'POST') out.push({ node: 'request', text: 'A body is only sent with POST.', blocksTest: true });
    else { try { JSON.parse(f.bodyTemplate.replace(PLACEHOLDER, '0')); } catch { out.push({ node: 'request', text: 'The body is not valid JSON.', blocksTest: true }); } }
  }
  for (const [a, json] of Object.entries(f.samples)) if (json.trim()) { try { JSON.parse(json); } catch { out.push({ node: 'request', text: `The sample answer for ${a} is not valid JSON.`, blocksTest: true }); } }
  const aliases = new Set(['main']);
  f.steps.forEach((st, i) => {
    const at = `Step ${i + 1}`;
    if (st.type === 'verify') {
      if (!st.path) out.push({ node: 'logic', text: `${at}: choose the field to check against.`, blocksTest: true });
      if (!st.input || !names.has(st.input)) out.push({ node: 'logic', text: `${at}: choose the input the caller gives.`, blocksTest: true });
    } else if (st.type === 'branch') {
      if (!st.path) out.push({ node: 'logic', text: `${at}: choose the field to test.`, blocksTest: true });
      if ((st.action === 'say' || st.action === 'ticket') && !st.text?.trim()) out.push({ node: 'logic', text: `${at}: write what to say or the ticket title.`, blocksTest: true });
    } else if (st.type === 'chain') {
      if (!st.connector || !others.some((o) => o.name === st.connector)) out.push({ node: 'logic', text: `${at}: choose another API to call.`, blocksTest: true });
      if (!st.as || aliases.has(st.as)) out.push({ node: 'logic', text: `${at}: give its answer a unique short name.`, blocksTest: true });
      else aliases.add(st.as);
    }
  });
  const keys = new Set<string>();
  f.fields.forEach((x) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(x.key) || keys.has(x.key)) out.push({ node: 'response', text: `Fact "${x.key || '(blank)'}" needs a unique short name.`, blocksTest: true });
    keys.add(x.key);
    if (!x.path) out.push({ node: 'response', text: `Fact "${x.key}": choose where it comes from.`, blocksTest: true });
  });
  for (const [lang, t] of Object.entries(f.templates)) for (const m of t.matchAll(PLACEHOLDER)) if (!keys.has(m[1])) out.push({ node: 'response', text: `The ${lang} sentence uses {${m[1]}}, which is not a fact.`, blocksTest: true });
  if (f.fields.length === 0) out.push({ node: 'response', text: 'Choose at least one fact the agent may say.' });
  return out;
}

function nodeSummary(n: Node, d: ConnectorDraft): string {
  const f = d.flow!;
  if (n === 'source') return f.inputs.length ? `Asks for ${f.inputs.map((i) => i.label || i.name).join(', ')}` : 'No inputs yet';
  if (n === 'request') { try { return `${d.method} ${new URL(d.urlTemplate.replace(PLACEHOLDER, 'x')).host}`; } catch { return 'Address needed'; } }
  if (n === 'logic') return f.steps.length ? f.steps.map((st) => (st.type === 'verify' ? 'identity' : st.type === 'chain' ? `→ ${st.connector ?? '?'}` : 'rule')).join(' · ') : 'No rules (optional)';
  return f.fields.length ? `${f.fields.length} fact${f.fields.length === 1 ? '' : 's'}${f.requiresVerifiedCaller ? ' · verified only' : ''}` : 'Nothing chosen yet';
}

type SetDraft = <K extends keyof ConnectorDraft>(k: K, v: ConnectorDraft[K]) => void;
type SetFlow = (f: Partial<VoiceFlow>) => void;

function SourceEditor({ d, set, flow, setFlow }: { d: ConnectorDraft; set: SetDraft; flow: VoiceFlow; setFlow: SetFlow }) {
  const upd = (i: number, x: Partial<FlowInput>) => setFlow({ inputs: flow.inputs.map((y, j) => (j === i ? { ...y, ...x } : y)) });
  return (
    <div className="vb-form">
      <label className="vb-field"><span>When should the agent use this?</span>
        <textarea rows={2} value={d.description} onChange={(e) => set('description', e.target.value)} placeholder="The caller asks about their loan balance, next EMI date or amount." />
        <small>The agent reads this to decide. Be specific: the questions it answers, not how the API works.</small></label>
      <div className="vb-sub"><h4>What the agent collects from the caller first</h4><p>Every value is checked against its type before anything is sent to your API. A wrong value means the agent asks again.</p></div>
      <div className="vb-table" role="table" aria-label="Inputs">
        <div className="vb-tr vb-th" role="row"><span>Name in the API</span><span>Spoken label</span><span>Type</span><span>Example</span><span>Required</span><span /></div>
        {flow.inputs.map((i, n) => (
          <div className="vb-tr" role="row" key={n}>
            <input aria-label="Name" value={i.name} onChange={(e) => upd(n, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} placeholder="loanNumber" />
            <input aria-label="Label" value={i.label} onChange={(e) => upd(n, { label: e.target.value })} placeholder="Loan number" />
            <Select className="select" aria-label="Type" value={i.type} onChange={(e) => upd(n, { type: e.target.value as InputType })}>{INPUT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            <input aria-label="Example" value={i.example ?? ''} onChange={(e) => upd(n, { example: e.target.value })} placeholder="1234567890" />
            <label className="vb-check"><input type="checkbox" checked={i.required} onChange={(e) => upd(n, { required: e.target.checked })} /><span className="sr-only">Required</span></label>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove input" onClick={() => setFlow({ inputs: flow.inputs.filter((_, j) => j !== n) })}><Icon name="trash" size={13} /></button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-sm" disabled={flow.inputs.length >= 8} onClick={() => setFlow({ inputs: [...flow.inputs, { name: '', label: '', type: 'text', required: true }] })}><Icon name="plus" size={13} /> Add input</button>
    </div>
  );
}

function RequestEditor({ d, set, flow, setFlow, hasSecret, aliases }: { d: ConnectorDraft; set: SetDraft; flow: VoiceFlow; setFlow: SetFlow; hasSecret: boolean; aliases: string[] }) {
  const [alias, setAlias] = useState('main');
  const insert = (name: string) => set('urlTemplate', d.urlTemplate + `{${name}}`);
  const pretty = () => { try { setFlow({ samples: { ...flow.samples, [alias]: JSON.stringify(JSON.parse(flow.samples[alias] ?? ''), null, 2) } }); } catch { toast('That is not valid JSON yet.', 'error'); } };
  return (
    <div className="vb-form">
      <div className="vb-row">
        <label className="vb-field vb-short"><span>Method</span><Select className="select" aria-label="Method" value={d.method} onChange={(e) => set('method', e.target.value)}><option>GET</option><option>POST</option></Select></label>
        <label className="vb-field"><span>Address</span><input className="mono" value={d.urlTemplate} onChange={(e) => set('urlTemplate', e.target.value)} placeholder="https://api.yourcompany.in/loans/v1/{loanNumber}" /></label>
      </div>
      {flow.inputs.length > 0 && <div className="vb-chips"><small>Insert:</small>{flow.inputs.filter((i) => i.name).map((i) => <button key={i.name} type="button" onClick={() => insert(i.name)}>{`{${i.name}}`}</button>)}</div>}
      <div className="vb-row">
        <label className="vb-field"><span>Key header</span><input className="mono" value={d.headerName ?? ''} onChange={(e) => set('headerName', e.target.value || null)} placeholder="client_id or Authorization" /></label>
        <label className="vb-field"><span>Key {hasSecret ? '(saved — leave empty to keep)' : ''}</span><input type="password" value={d.secret ?? ''} onChange={(e) => set('secret', e.target.value)} autoComplete="off" placeholder={hasSecret ? '••••••••' : 'Paste a read-only key'} /></label>
      </div>
      <p className="vb-note"><Icon name="lock" size={13} /> Keys are encrypted and never shown again. Use a read-only key made for the agent. Private and local addresses are refused.</p>
      <details className="vb-more" open={flow.headers.length > 0 || !!flow.bodyTemplate}>
        <summary>More headers and a request body</summary>
        {flow.headers.map((h, n) => (
          <div className="vb-row" key={n}>
            <input className="mono" aria-label="Header name" value={h.name} onChange={(e) => setFlow({ headers: flow.headers.map((x, j) => (j === n ? { ...x, name: e.target.value } : x)) })} placeholder="X-Channel" />
            <input className="mono" aria-label="Header value" value={h.value} onChange={(e) => setFlow({ headers: flow.headers.map((x, j) => (j === n ? { ...x, value: e.target.value } : x)) })} placeholder="voice-agent" />
            <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove header" onClick={() => setFlow({ headers: flow.headers.filter((_, j) => j !== n) })}><Icon name="trash" size={13} /></button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => setFlow({ headers: [...flow.headers, { name: '', value: '' }] })}><Icon name="plus" size={13} /> Add header</button>
        {d.method === 'POST' && <label className="vb-field"><span>Body (JSON; {'{input}'} placeholders, in quotes for text)</span>
          <textarea className="mono" rows={5} value={flow.bodyTemplate ?? ''} onChange={(e) => setFlow({ bodyTemplate: e.target.value || null })} placeholder={'{\n  "loanNumber": "{loanNumber}",\n  "channel": "voice"\n}'} />
          <small>Leave empty to send the collected inputs as JSON.</small></label>}
      </details>
      <div className="vb-sub"><h4>Sample answer</h4><p>Paste a real answer from your API (with test data). It lets you pick fields instead of typing paths, and test the whole flow without calling anything.</p></div>
      {aliases.length > 1 && <div className="vb-seg" role="tablist">{aliases.map((a) => <button key={a} role="tab" aria-selected={alias === a} className={alias === a ? 'on' : ''} onClick={() => setAlias(a)}>{a === 'main' ? 'This API' : a}</button>)}</div>}
      <textarea className="mono vb-sample" rows={10} value={flow.samples[alias] ?? ''} aria-label="Sample answer"
        onChange={(e) => setFlow({ samples: { ...flow.samples, [alias]: e.target.value } })} placeholder={'{\n  "loan": { "number": "1234567890", "outstanding": 124999.5, "nextDue": "2026-11-05" },\n  "customer": { "dob": "1990-04-12" }\n}'} />
      <div className="vb-row-end"><small>{samplePaths(alias, flow.samples[alias]).length} fields found</small><button type="button" className="btn btn-ghost btn-sm" onClick={pretty}>Format JSON</button></div>
    </div>
  );
}

function PathField({ value, onChange, paths, samples, label }: { value: string; onChange: (v: string) => void; paths: string[]; samples: Record<string, string>; label: string }) {
  const list = useId();
  const v = value ? sampleValue(samples, value) : undefined;
  return (
    <span className="vb-path">
      <input className="mono" list={list} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder="main.loan.outstanding" />
      <datalist id={list}>{paths.map((p) => <option key={p} value={p}>{sampleValue(samples, p)}</option>)}</datalist>
      {value && <small className={v === undefined ? 'miss' : ''}>{v === undefined ? (paths.length ? 'not in the sample' : '') : `sample: ${v.length > 40 ? v.slice(0, 40) + '…' : v}`}</small>}
    </span>
  );
}

function LogicEditor({ flow, setFlow, paths, others }: { flow: VoiceFlow; setFlow: SetFlow; paths: string[]; others: Connector[] }) {
  const upd = (i: number, x: Partial<FlowStep>) => setFlow({ steps: flow.steps.map((y, j) => (j === i ? { ...y, ...x } : y)) });
  const move = (i: number, by: number) => { const a = [...flow.steps]; const [x] = a.splice(i, 1); a.splice(i + by, 0, x); setFlow({ steps: a }); };
  const add = (type: StepType) => setFlow({
    steps: [...flow.steps, type === 'verify' ? { type, path: '', input: flow.inputs.find((i) => i.type === 'date')?.name ?? flow.inputs[0]?.name ?? '', compare: 'date', action: 'stop' }
      : type === 'branch' ? { type, path: '', op: 'eq', value: '', action: 'say', text: '' } : { type, connector: others[0]?.name ?? '', as: '', args: {} }],
  });
  const inputs = flow.inputs.filter((i) => i.name);
  return (
    <div className="vb-form">
      <p className="vb-note">Steps run top to bottom on your API's answer. A failed identity check or a "share nothing" rule stops the flow; everything else continues.</p>
      <ol className="vb-steps">
        {flow.steps.map((st, i) => (
          <li key={i} className={`vb-step ${st.type}`}>
            <div className="vb-step-head">
              <span className="vb-step-badge">{st.type === 'verify' ? <><Icon name="shield" size={13} /> Identity check</> : st.type === 'branch' ? <><Icon name="workflow" size={13} /> Rule</> : <><Icon name="link" size={13} /> Call another API</>}</span>
              <input className="vb-step-label" aria-label="Step name" value={st.label ?? ''} onChange={(e) => upd(i, { label: e.target.value })} placeholder="Name this step (optional)" />
              <span className="vb-step-tools">
                <button type="button" className="btn btn-ghost btn-sm" disabled={i === 0} aria-label="Move up" onClick={() => move(i, -1)}><Icon name="chevronL" size={13} style={{ transform: 'rotate(90deg)' }} /></button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={i === flow.steps.length - 1} aria-label="Move down" onClick={() => move(i, 1)}><Icon name="chevronD" size={13} /></button>
                <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove step" onClick={() => setFlow({ steps: flow.steps.filter((_, j) => j !== i) })}><Icon name="trash" size={13} /></button>
              </span>
            </div>
            {st.type === 'verify' && (
              <div className="vb-sentence">
                <span>Continue only if the caller's</span>
                <Select className="select" aria-label="Input" value={st.input ?? ''} onChange={(e) => upd(i, { input: e.target.value })}><option value="">choose…</option>{inputs.map((x) => <option key={x.name} value={x.name}>{x.label || x.name}</option>)}</Select>
                <span>matches</span>
                <PathField label="Field" value={st.path ?? ''} onChange={(v) => upd(i, { path: v })} paths={paths} samples={flow.samples} />
                <span>by</span>
                <Select className="select" aria-label="How to compare" value={st.compare ?? 'exact'} onChange={(e) => upd(i, { compare: e.target.value as FlowStep['compare'] })}>{COMPARES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
                <span>Otherwise</span>
                <Select className="select" aria-label="If it does not match" value={st.action === 'transfer' || st.action === 'ticket' ? st.action : 'stop'} onChange={(e) => upd(i, { action: e.target.value as FlowStep['action'] })}>
                  <option value="stop">share nothing and ask again</option><option value="ticket">log a ticket</option><option value="transfer">hand over to a person</option></Select>
                {st.action === 'ticket' && <input aria-label="Ticket title" value={st.text ?? ''} onChange={(e) => upd(i, { text: e.target.value })} placeholder="Identity check failed on a call" />}
                <small className="vb-explain">When it matches, the caller counts as verified for the rest of the call.</small>
              </div>
            )}
            {st.type === 'branch' && (
              <div className="vb-sentence">
                <span>If</span>
                <PathField label="Field" value={st.path ?? ''} onChange={(v) => upd(i, { path: v })} paths={paths} samples={flow.samples} />
                <Select className="select" aria-label="Condition" value={st.op ?? 'eq'} onChange={(e) => upd(i, { op: e.target.value as FlowStep['op'] })}>{OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
                {st.op !== 'empty' && st.op !== 'notempty' && <input className="vb-val" aria-label="Value" value={st.value ?? ''} onChange={(e) => upd(i, { value: e.target.value })} placeholder={st.op?.startsWith('g') || st.op?.startsWith('l') ? '100000 or today' : 'OVERDUE'} />}
                <span>then</span>
                <Select className="select" aria-label="Then" value={st.action ?? 'say'} onChange={(e) => upd(i, { action: e.target.value as FlowStep['action'] })}>{ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
                {st.action !== 'transfer' && <input className="vb-text" aria-label={st.action === 'ticket' ? 'Ticket title' : 'What to say'} value={st.text ?? ''} onChange={(e) => upd(i, { text: e.target.value })}
                  placeholder={st.action === 'ticket' ? 'Ticket title, e.g. Overdue account — call back' : st.action === 'stop' ? 'Optional: what the agent says instead' : 'I can see a payment is overdue on this loan.'} />}
                {st.action === 'ticket' && <Select className="select" aria-label="Priority" value={st.priority ?? 'Medium'} onChange={(e) => upd(i, { priority: e.target.value })}>{['Low', 'Medium', 'High', 'Critical'].map((p) => <option key={p}>{p}</option>)}</Select>}
              </div>
            )}
            {st.type === 'chain' && (
              <div className="vb-sentence">
                <span>Call</span>
                <Select className="select" aria-label="API" value={st.connector ?? ''} onChange={(e) => upd(i, { connector: e.target.value })}><option value="">choose…</option>{others.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}</Select>
                <span>and name its answer</span>
                <input className="vb-val mono" aria-label="Answer name" value={st.as ?? ''} onChange={(e) => upd(i, { as: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} placeholder="emi" />
                <div className="vb-args">
                  {(others.find((o) => o.name === st.connector)?.flow?.inputs.map((x) => x.name) ?? others.find((o) => o.name === st.connector)?.placeholders ?? []).map((arg) => (
                    <label key={arg} className="vb-arg"><span className="mono">{arg} =</span>
                      <input className="mono" list={`${arg}-${i}`} value={st.args?.[arg] ?? ''} onChange={(e) => upd(i, { args: { ...st.args, [arg]: e.target.value } })} placeholder="main.loan.id or {loanNumber}" />
                      <datalist id={`${arg}-${i}`}>{[...inputs.map((x) => `{${x.name}}`), ...paths].map((p) => <option key={p} value={p} />)}</datalist></label>
                  ))}
                  {!st.connector && <small>Choose the API first; its inputs appear here.</small>}
                  {others.length === 0 && <small>Save another tool first (for example emi_schedule), then chain it here.</small>}
                </div>
                {st.as && <small className="vb-explain">Later steps and facts can use <span className="mono">{st.as}.…</span> — add its sample answer under Request to pick fields.</small>}
              </div>
            )}
          </li>
        ))}
      </ol>
      {flow.steps.length === 0 && <p className="vb-muted">No rules yet. That is fine for public information; for account details add an identity check.</p>}
      <div className="vb-add">
        <button type="button" className="btn btn-sm" onClick={() => add('verify')}><Icon name="shield" size={13} /> Identity check</button>
        <button type="button" className="btn btn-sm" onClick={() => add('branch')}><Icon name="workflow" size={13} /> Rule</button>
        <button type="button" className="btn btn-sm" onClick={() => add('chain')}><Icon name="link" size={13} /> Call another API</button>
      </div>
    </div>
  );
}

function ResponseEditor({ flow, setFlow, paths, s }: { flow: VoiceFlow; setFlow: SetFlow; paths: string[]; s: VoiceSettings }) {
  const upd = (i: number, x: Partial<FlowField>) => setFlow({ fields: flow.fields.map((y, j) => (j === i ? { ...y, ...x } : y)) });
  const [lang, setLang] = useState(s.languages[0] ?? 'en');
  const keys = flow.fields.map((f) => f.key).filter(Boolean);
  return (
    <div className="vb-form">
      <label className="vb-toggle"><input type="checkbox" checked={flow.requiresVerifiedCaller} onChange={(e) => setFlow({ requiresVerifiedCaller: e.target.checked })} />
        <span><b>Only for verified callers</b><small>Nothing below is shared until the caller passes an identity check — in this flow or earlier in the call.</small></span></label>
      <div className="vb-sub"><h4>Facts the agent may say</h4><p>Only these leave your API. Everything else in the answer (PAN, address, internal codes) is never shown to the agent.</p></div>
      <div className="vb-table" role="table" aria-label="Facts">
        <div className="vb-tr vb-th facts" role="row"><span>Fact</span><span>From</span><span>Said as</span><span>Meaning (for the agent)</span><span /></div>
        {flow.fields.map((f, n) => (
          <div className="vb-tr facts" role="row" key={n}>
            <div className="f-key"><input className="mono" aria-label="Fact name" value={f.key} onChange={(e) => upd(n, { key: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} placeholder="balance" /></div>
            <div className="f-path"><PathField label="From" value={f.path} onChange={(v) => upd(n, { path: v })} paths={paths} samples={flow.samples} /></div>
            <div className="f-fmt"><Select className="select" aria-label="Format" value={f.format} onChange={(e) => upd(n, { format: e.target.value as FieldFormat })}>{FORMATS.map(([v, l, ex]) => <option key={v} value={v}>{l} — {ex}</option>)}</Select></div>
            <div className="f-label"><input aria-label="Meaning" value={f.label ?? ''} onChange={(e) => upd(n, { label: e.target.value })} placeholder="What it is, e.g. outstanding balance" /></div>
            <div className="f-del"><button type="button" className="btn btn-ghost btn-sm" aria-label="Remove fact" onClick={() => setFlow({ fields: flow.fields.filter((_, j) => j !== n) })}><Icon name="trash" size={13} /></button></div>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-sm" disabled={flow.fields.length >= 20} onClick={() => setFlow({ fields: [...flow.fields, { key: '', path: '', format: 'text' }] })}><Icon name="plus" size={13} /> Add fact</button>

      <div className="vb-sub"><h4>What the agent says</h4><p>One sentence per language. Without one, the agent words the facts itself — always in the caller's language, never adding figures.</p></div>
      <div className="vb-seg" role="tablist">{s.languages.map((l) => <button key={l} role="tab" aria-selected={lang === l} className={`${lang === l ? 'on' : ''} ${flow.templates[l] ? 'has' : ''}`} onClick={() => setLang(l)}>{s.availableLanguages[l] ?? l}</button>)}</div>
      <textarea rows={3} aria-label={`Sentence in ${s.availableLanguages[lang] ?? lang}`} value={flow.templates[lang] ?? ''}
        onChange={(e) => { const t = { ...flow.templates }; if (e.target.value) t[lang] = e.target.value; else delete t[lang]; setFlow({ templates: t }); }}
        placeholder={lang === 'en' ? 'For your loan {loan}, the outstanding balance is {balance}. Your next EMI of {emiAmount} is due on {emiDate}.' : 'Write it the way people speak — common English words like EMI and loan are fine.'} />
      {keys.length > 0 && <div className="vb-chips"><small>Insert:</small>{keys.map((k) => <button key={k} type="button" onClick={() => setFlow({ templates: { ...flow.templates, [lang]: (flow.templates[lang] ?? '') + `{${k}}` } })}>{`{${k}}`}</button>)}</div>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ test

function TestPanel({ d, id, s, canRun }: { d: ConnectorDraft; id?: string; s: VoiceSettings; canRun: boolean }) {
  const flow = d.flow!;
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [lang, setLang] = useState(s.languages[0] ?? 'en');
  const [useSamples, setUseSamples] = useState(true);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<ToolTest | null>(null);
  const [show, setShow] = useState<'facts' | 'agent' | 'raw'>('facts');
  const hasSample = !!flow.samples.main?.trim();
  const fill = () => setInputs(Object.fromEntries(flow.inputs.map((i) => [i.name, i.example ?? ''])));
  const run = async () => {
    setBusy(true);
    try { setR(await voiceApi.testConnector({ draft: { ...d, secret: d.secret || undefined }, inputs, language: lang, useSamples: useSamples && hasSample, callerVerified: verified }, id)); setShow('facts'); }
    catch (e) { toast(errText(e, 'The test did not run.'), 'error'); } finally { setBusy(false); }
  };
  return (
    <aside className="vb-test" aria-label="Test">
      <div className="vb-test-head"><h3><Icon name="play" size={14} /> Test</h3><small>Runs exactly like a call</small></div>
      <div className="vb-test-form">
        {flow.inputs.filter((i) => i.name).map((i) => (
          <label key={i.name} className="vb-field"><span>{i.label || i.name}</span>
            <input value={inputs[i.name] ?? ''} onChange={(e) => setInputs({ ...inputs, [i.name]: e.target.value })} placeholder={i.example ?? ''} /></label>
        ))}
        {flow.inputs.some((i) => i.example) && <button type="button" className="btn btn-ghost btn-sm" onClick={fill}>Use the examples</button>}
        <div className="vb-row">
          <label className="vb-field vb-short"><span>Language</span><Select className="select" aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)}>{s.languages.map((l) => <option key={l} value={l}>{s.availableLanguages[l] ?? l}</option>)}</Select></label>
        </div>
        <label className="vb-toggle sm"><input type="checkbox" checked={useSamples && hasSample} disabled={!hasSample} onChange={(e) => setUseSamples(e.target.checked)} /><span>Use the sample answer<small>{hasSample ? 'Nothing is sent to your API.' : 'Add a sample under Request to test offline.'}</small></span></label>
        <label className="vb-toggle sm"><input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} /><span>Caller already verified<small>As if an earlier step in the call checked them.</small></span></label>
        <button type="button" className="btn btn-primary" disabled={busy || !canRun} onClick={() => void run()}>{busy ? <Spinner /> : <Icon name="play" size={14} />} Run test</button>
        {!canRun && <small className="vb-muted">Fix the items listed on the left first.</small>}
      </div>
      {r && (
        <div className="vb-result">
          <ol className="vb-trace">{r.trace.map((t, i) => (
            <li key={i} className={`t-${t.status}`}><span className="vb-trace-dot" /><span><b>{t.step}</b><small>{t.detail}</small></span><em>{t.status}</em></li>
          ))}</ol>
          {r.say && <div className="vb-say"><Icon name="message" size={14} /><span>{r.say}</span></div>}
          {r.action !== 'none' && <div className={`vb-action a-${r.action}`}><b>{r.action === 'ticket' ? 'Logs a ticket' : r.action === 'transfer' ? 'Hands over to a person' : r.action === 'ask' ? 'Asks the caller' : 'Shares nothing'}</b>{r.actionText && <span>{r.actionText}</span>}</div>}
          <div className="vb-seg sm" role="tablist">
            {(['facts', 'agent', 'raw'] as const).map((k) => <button key={k} role="tab" aria-selected={show === k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>{k === 'facts' ? 'Facts' : k === 'agent' ? 'What the agent sees' : 'Raw answer'}</button>)}
          </div>
          {show === 'facts' && (Object.keys(r.facts).length ? <dl className="vb-facts">{Object.entries(r.facts).map(([k, v]) => <div key={k}><dt className="mono">{k}</dt><dd>{v}</dd></div>)}</dl> : <p className="vb-muted">No facts shared{r.error ? `: ${r.error}` : '.'}</p>)}
          {show === 'agent' && <pre className="vb-pre">{pretty(r.agentSees)}</pre>}
          {show === 'raw' && (Object.keys(r.raw).length ? Object.entries(r.raw).map(([k, v]) => <div key={k}><small className="mono">{k}</small><pre className="vb-pre">{pretty(v)}</pre></div>) : <p className="vb-muted">No answer.</p>)}
        </div>
      )}
    </aside>
  );
}

const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
