import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { workspaceAutomationApi } from '../../api/endpoints';
import type { AutomationDraft, AutomationRule, AutomationStep, AutomationTest, AutomationTrigger, StatusCategory } from '../../api/types';
import { workItemsApi } from '../../api/workItemsApi';
import { Icon } from '../../components/Icon';
import { EmptyState, PriorityOptions } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useDebounced, useWsQuery } from '../../lib/hooks';
import { useCan, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { useAi } from '../ai/Assistant';
import { StepEditor } from '../automation/AutomationPanel';
import { draftToFlow, emptyFlow, flowToInput, ruleToFlow, TEMPLATES, TRIGGER_LABEL, isScheduled, type Flow } from './automationFlow';
import './desk.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const CATEGORIES: { id: StatusCategory; label: string }[] = [
  { id: 'Todo', label: 'a to-do status' }, { id: 'Active', label: 'an in-progress status' }, { id: 'Done', label: 'a done status' }, { id: 'Cancelled', label: 'a cancelled status' },
];
const MAX_STEPS = 5;
const MAX_RUNS_PER_HOUR = 100;

/**
 * Work › Automations: the workspace's automation rules as a flow - When, If, Then - started from a sentence (drafted by the AI when it is on)
 * or a template, tried against a past task (nothing is changed or sent), switched on and off, with each rule's recent runs. Only what the
 * rule engine runs is offered; rules never trigger each other, and each rule runs at most 100 times an hour.
 */
export function AutomationsPage() {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const canEdit = useCan('workflow.manage');
  const included = useEntitlement('AUTOMATION') > 0;
  const q = useWsQuery(['automations', 'workspace'], () => workspaceAutomationApi.list());
  const rules = q.data ?? [];
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [seed, setSeed] = useState<Flow | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: [wid, 'automations'] });
  const current = selected && selected !== 'new' ? rules.find((r) => r.id === selected) ?? null : null;
  const firstId = q.data?.[0]?.id ?? null;
  useEffect(() => { if (selected === null && firstId) setSelected(firstId); }, [firstId, selected]);

  const startNew = (flow: Flow | null) => { setSeed(flow ?? emptyFlow()); setSelected('new'); };

  return (
    <div className="au">
      <aside className="au-side">
        <div className="au-bar"><h3 className="au-h grow">Rules</h3>
          {canEdit && included && <button type="button" className="btn btn-primary btn-sm" onClick={() => startNew(null)}><Icon name="plus" size={14} /> New</button>}</div>
        {!included && <div className="notice">Automation is part of the Pro plan and above. <Link className="link" to="/settings/billing">See plans</Link></div>}
        {rules.length === 0 && !q.isLoading ? <p className="au-note">No rules yet. Start from a sentence or a template.</p> : (
          <div className="au-list">
            {rules.map((r) => (
              <button key={r.id} type="button" className={`au-item ${selected === r.id ? 'on' : ''}`} onClick={() => setSelected(r.id)}>
                <b>{r.name}</b>{!r.isEnabled ? <span className="off">Off</span> : <span />}
                <small>{r.runCount ? `Ran ${r.runCount}×${r.lastRunAt ? ` · ${timeAgo(r.lastRunAt)}` : ''}` : 'Has not run yet'}</small>
              </button>
            ))}
          </div>
        )}
        {canEdit && included && (
          <>
            <h3 className="au-h">Templates</h3>
            <div className="au-templates">
              {TEMPLATES.map((t) => t.flow ? (
                <button key={t.id} type="button" className="au-tpl" onClick={() => startNew(t.flow!())}><b>{t.name}</b><span>{t.text}</span></button>
              ) : (
                <div key={t.id} className="au-tpl" role="note"><b>{t.name} · built in</b><span>{t.text}</span></div>
              ))}
            </div>
            <p className="au-note">Tickets’ SLA breach escalation is set in <Link className="link" to="/work?tab=tickets&view=settings">Desk settings</Link>.</p>
          </>
        )}
      </aside>
      <div className="au-main">
        {selected === 'new' && seed ? (
          <Builder key={`new-${JSON.stringify(seed)}`} initial={seed} canEdit={canEdit && included} onSaved={(r) => { refresh(); setSelected(r.id); }} onRemoved={() => setSelected(null)} />
        ) : current ? (
          <Builder key={current.id} rule={current} initial={ruleToFlow(current)} canEdit={canEdit && included} onSaved={() => refresh()} onRemoved={() => { refresh(); setSelected(null); }} />
        ) : (
          <EmptyState icon="bolt" title="Automate the busywork" text="Describe what should happen, or pick a template. Rules act on project tasks across the workspace." />
        )}
      </div>
    </div>
  );
}

function Builder({ rule, initial, canEdit, onSaved, onRemoved }: {
  rule?: AutomationRule; initial: Flow; canEdit: boolean; onSaved: (r: AutomationRule) => void; onRemoved: () => void;
}) {
  const ai = useAi();
  const [f, setF] = useState<Flow>(initial);
  const [sentence, setSentence] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Flow>(k: K, v: Flow[K]) => setF((x) => ({ ...x, [k]: v }));

  const draft = async () => {
    if (sentence.trim().length < 8) return;
    setDrafting(true); setDraftNote(null);
    try {
      const d: AutomationDraft = await workspaceAutomationApi.draft(sentence.trim());
      setF((x) => ({ ...draftToFlow(d), isEnabled: x.isEnabled }));
      setDraftNote(d.reason);
    } catch (e) { setDraftNote(errText(e, 'The AI could not draft it. Build it below.')); }
    finally { setDrafting(false); }
  };

  const save = async (patch?: Partial<Flow>) => {
    const next = { ...f, ...patch };
    if (!next.name.trim()) { setError('Give the rule a name.'); return; }
    setBusy(true); setError(null);
    try {
      const input = flowToInput(next);
      const saved = rule ? await workspaceAutomationApi.update(rule.id, input) : await workspaceAutomationApi.create(input);
      setF(next);
      toast(rule ? (patch ? (next.isEnabled ? 'Rule switched on.' : 'Rule switched off.') : 'Rule saved.') : 'Rule added.');
      onSaved(saved);
    } catch (e) { setError(errText(e, 'Could not save the rule.')); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!rule) { onRemoved(); return; }
    if (!(await confirmDialog({ title: 'Delete rule?', message: `“${rule.name}” will stop running. Tasks it already changed stay as they are.`, confirmText: 'Delete' }))) return;
    try { await workspaceAutomationApi.remove(rule.id); toast('Rule deleted.', 'warning'); onRemoved(); }
    catch (e) { toast(errText(e, 'Could not delete the rule.'), 'error'); }
  };

  return (
    <>
      {canEdit && (
        <div>
          <form className="au-ask" onSubmit={(e) => { e.preventDefault(); void draft(); }}>
            <input className="input" value={sentence} maxLength={1000} onChange={(e) => setSentence(e.target.value)} aria-label="Describe what should happen"
              placeholder="Describe what should happen, e.g. “When a critical task is a day overdue, raise it and tell the owner”" />
            {ai && <button type="submit" className="btn btn-primary" disabled={drafting || sentence.trim().length < 8}><Icon name="sparkle" size={14} />{drafting ? 'Drafting…' : 'Draft flow'}</button>}
          </form>
          <p className="au-note" role="status">{!ai ? 'AI is off for this workspace: build the flow below.' : draftNote ?? 'The AI drafts the flow; you check it before saving.'}</p>
        </div>
      )}

      <input className="input" aria-label="Rule name" value={f.name} maxLength={100} disabled={!canEdit} onChange={(e) => set('name', e.target.value)} placeholder="Name this rule" />

      <div className="au-flow">
        <section className="au-card when">
          <div className="au-card-h"><em>When</em></div>
          <select className="select" aria-label="Trigger" value={f.trigger} disabled={!canEdit} onChange={(e) => set('trigger', e.target.value as AutomationTrigger)}>
            {(Object.keys(TRIGGER_LABEL) as AutomationTrigger[]).map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
          </select>
          {isScheduled(f.trigger) && (
            <label className="au-pills">
              <span>{f.trigger === 'DueSoon' ? 'Days before due' : f.trigger === 'Overdue' ? 'Days after due' : 'Days without change'}</span>
              <input className="input" type="number" style={{ maxWidth: 90 }} min={f.trigger === 'Stale' ? 1 : 0} max={365} value={f.triggerDays} disabled={!canEdit}
                onChange={(e) => set('triggerDays', Number(e.target.value))} />
              <span className="au-note">Checked every few minutes; once per task per due date (or quiet spell).</span>
            </label>
          )}
        </section>
        <div className="au-link" aria-hidden="true" />
        <section className="au-card if">
          <div className="au-card-h"><em>If</em></div>
          {f.trigger === 'StatusChanged' ? (
            <div className="au-pills"><span className="au-pill">Status is
              <select aria-label="Status condition" value={f.whenStatusCategory ?? ''} disabled={!canEdit} onChange={(e) => set('whenStatusCategory', (e.target.value || null) as StatusCategory | null)}>
                <option value="">any status</option>{CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select></span></div>
          ) : f.trigger === 'PriorityChanged' ? (
            <div className="au-pills"><span className="au-pill">Priority is
              <select aria-label="Priority condition" value={f.whenPriority ?? ''} disabled={!canEdit} onChange={(e) => set('whenPriority', e.target.value || null)}>
                <option value="">any priority</option><PriorityOptions />
              </select></span></div>
          ) : <p className="au-note">Every open task that matches the trigger. (This trigger has no extra conditions.)</p>}
        </section>
        <div className="au-link" aria-hidden="true" />
        <section className="au-card then">
          <div className="au-card-h"><em>Then</em></div>
          {f.steps.map((s, i) => (
            <StepEditor key={i} n={i} step={s} workspace statuses={[]} canRemove={canEdit && f.steps.length > 1}
              onChange={(next: AutomationStep) => set('steps', f.steps.map((x, k) => (k === i ? next : x)))} onRemove={() => set('steps', f.steps.filter((_, k) => k !== i))} />
          ))}
          {canEdit && f.steps.length < MAX_STEPS && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => set('steps', [...f.steps, { ...f.steps[0], action: 'Notify', actionTarget: 'Assignee', actionText: '' }])}>
              <Icon name="plus" size={14} /> And also…
            </button>
          )}
        </section>
      </div>

      <div className="au-guard">
        <span><Icon name="shield" size={13} /> Cannot trigger itself: actions never start other rules.</span>
        <span><Icon name="clock" size={13} /> At most {MAX_RUNS_PER_HOUR} runs an hour.</span>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
      {canEdit && (
        <div className="au-bar">
          {rule && (
            <label className="au-switch"><input type="checkbox" checked={f.isEnabled} disabled={busy} onChange={(e) => void save({ isEnabled: e.target.checked })} /> Enabled</label>
          )}
          <span className="grow" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove()}>{rule ? 'Delete' : 'Discard'}</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : rule ? 'Save' : 'Add rule'}</button>
        </div>
      )}
      {canEdit && <TestRun flow={f} />}
      {rule && <Runs id={rule.id} />}
    </>
  );
}

/** Tries the flow as it stands against one past task: per step, whether it would pass or stop. Nothing is changed or sent. */
function TestRun({ flow }: { flow: Flow }) {
  const [text, setText] = useState('');
  const term = useDebounced(text.trim(), 300);
  const hits = useWsQuery(['work-items', 'au-test', term], () => workItemsApi.list({ kind: ['task'], status: 'all', q: term, limit: 8 }), { enabled: term.length >= 2, staleTime: 30_000 });
  const [result, setResult] = useState<AutomationTest | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (taskId: string) => {
    setBusy(true); setResult(null);
    try { setResult(await workspaceAutomationApi.test(flowToInput(flow), taskId)); }
    catch (e) { toast(errText(e, 'Could not run the test.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <section className="au-test" aria-label="Test run">
      <h3 className="au-h">Test run · dry run, nothing is sent</h3>
      <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Find a past task by key or title" aria-label="Find a task to test with" />
      {term.length >= 2 && (hits.data?.items.length ?? 0) > 0 && !result && (
        <div className="au-hits">
          {hits.data!.items.map((h) => <button key={h.id} type="button" className="au-hit" disabled={busy} onClick={() => void run(h.id)}>{h.key} · {h.title}</button>)}
        </div>
      )}
      {busy && <p className="au-note">Running…</p>}
      {result && (
        <>
          <p className="au-note"><b>{result.taskKey}</b> {result.taskTitle} — {result.wouldRun ? 'the rule would act on it.' : 'the rule would not change it.'}
            {' '}<button type="button" className="wkp-link" onClick={() => setResult(null)}>Try another</button></p>
          <ol>
            {result.steps.map((s, i) => (
              <li key={i}><b className={s.pass ? 'pass' : 'stop'}>{s.pass ? '✓' : '✕'}</b><span><b>{s.step}</b> {s.note}</span></li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function Runs({ id }: { id: string }) {
  const q = useWsQuery(['automations', 'runs', id], () => workspaceAutomationApi.runs(id), { staleTime: 30_000 });
  return (
    <section aria-label="Run history">
      <h3 className="au-h">Run history</h3>
      {q.isLoading ? <p className="au-note">Loading…</p> : (q.data?.length ?? 0) === 0 ? <p className="au-note">No runs yet.</p> : (
        <ul className="au-runs">
          {q.data!.map((r, i) => (
            <li key={i}><time dateTime={r.at} title={new Date(r.at).toLocaleString()}>{timeAgo(r.at)}</time>
              {r.taskId ? <Link className="link" to={`/work?item=${r.taskId}`}>{r.summary}</Link> : <span>{r.summary}</span>}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

