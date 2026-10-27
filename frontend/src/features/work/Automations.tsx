import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { chatApi, labelApi, workspaceApi, workspaceAutomationApi } from '../../api/endpoints';
import type { AutomationAction, AutomationBacktest, AutomationCondition, AutomationConditionField, AutomationDraft, AutomationRule, AutomationStep, AutomationTarget, AutomationTest, AutomationTrigger, StatusCategory } from '../../api/types';
import { workItemsApi } from '../../api/workItemsApi';
import { Icon } from '../../components/Icon';
import { PriorityOptions } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useDebounced, useWsQuery } from '../../lib/hooks';
import { useCan, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { useAi } from '../ai/Assistant';
import {
  CONDITIONS, draftToFlow, emptyFlow, EVENTS, flowToInput, isScheduled, newCondition, RECIPES, ruleToFlow, step, subjectOf, TASK_CATEGORIES, TICKET_STATUSES,
  type Flow, type Subject,
} from './automationFlow';
import './desk.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const MAX_STEPS = 5;
const MAX_RUNS_PER_HOUR = 100;
const NUMBERS = ['①', '②', '③', '④', '⑤'];
const isOn = (r: AutomationRule) => r.isEnabled && !r.isDraft;

/**
 * Work › Automations: one rule at a time as a sentence - When / If / Then - with AND conditions and numbered steps, on Desk tickets or
 * project tasks. Every change is replayed over the last 7 days ("would have fired N times"), nothing is changed or sent. Rules can be
 * kept as drafts until they are turned on. Rules never trigger each other, and each runs at most 100 times an hour.
 */
export function AutomationsPage() {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const canEdit = useCan('workflow.manage');
  const included = useEntitlement('AUTOMATION') > 0;
  const q = useWsQuery(['automations', 'workspace'], () => workspaceAutomationApi.list());
  const rules = useMemo(() => q.data ?? [], [q.data]);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [seed, setSeed] = useState<Flow | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: [wid, 'automations'] });
  const current = selected && selected !== 'new' ? rules.find((r) => r.id === selected) ?? null : null;
  const firstId = q.data?.[0]?.id ?? null;
  useEffect(() => { if (selected === null && firstId) setSelected(firstId); }, [firstId, selected]);
  useEffect(() => { if (selected === null && q.isSuccess && !firstId && canEdit && included) { setSeed(emptyFlow()); setSelected('new'); } }, [selected, q.isSuccess, firstId, canEdit, included]);
  const editable = canEdit && included;
  const onCount = rules.filter(isOn).length;

  const startNew = (flow: Flow | null) => { setSeed(flow ?? emptyFlow()); setSelected('new'); };

  const side = (
    <aside className="au-side" aria-label="Automations">
      {editable && <Describe onDraft={(f) => startNew(f)} />}
      {!included && <div className="notice">Automation is part of the Pro plan and above. <Link className="link" to="/settings/billing">See plans</Link></div>}
      <div className="au-bar"><h3 className="au-h grow">Your automations</h3>
        {editable && <button type="button" className="btn btn-ghost btn-sm" onClick={() => startNew(null)}><Icon name="plus" size={14} /> New</button>}</div>
      {rules.length === 0 && !q.isLoading ? <p className="au-note">No automations yet. Describe one, or start from a recipe.</p> : (
        <div className="au-list">
          {rules.map((r) => (
            <button key={r.id} type="button" className={`au-item ${selected === r.id ? 'on' : ''}`} onClick={() => setSelected(r.id)} aria-current={selected === r.id}>
              <b>{r.name}</b>{r.isDraft ? <span className="off">Draft</span> : !r.isEnabled ? <span className="off">Off</span> : <span className="au-on">On</span>}
              <small>{r.runCount ? `Ran ${r.runCount}×${r.lastRunAt ? ` · ${timeAgo(r.lastRunAt)}` : ''}` : 'Has not run yet'}</small>
            </button>
          ))}
        </div>
      )}
      {editable && (
        <>
          <h3 className="au-h">Recipes</h3>
          <div className="au-recipes">
            {RECIPES.map((t) => {
              const body = (<><span className="au-rec-i" style={{ background: t.color }} aria-hidden="true">{t.icon}</span><span><b>{t.name}</b><span>{t.text}</span>
                {t.builtIn && <em>{t.builtIn.text} ›</em>}</span></>);
              return t.flow
                ? <button key={t.id} type="button" className="au-rec" onClick={() => startNew(t.flow!())}>{body}</button>
                : <Link key={t.id} className="au-rec" to={t.builtIn!.to}>{body}</Link>;
            })}
          </div>
          <p className="au-note">Tickets’ SLA breach escalation is set in <Link className="link" to="/work?tab=tickets&view=settings">Desk settings</Link>.</p>
        </>
      )}
    </aside>
  );

  return (
    <div className="au">
      <div className="au-main">
        {selected === 'new' && seed ? (
          <Builder key={`new-${JSON.stringify(seed)}`} initial={seed} onCount={onCount} canEdit={editable} onSaved={(r) => { refresh(); setSelected(r.id); }} onRemoved={() => setSelected(null)} />
        ) : current ? (
          <Builder key={current.id} rule={current} initial={ruleToFlow(current)} onCount={onCount} canEdit={editable} onSaved={() => refresh()} onRemoved={() => { refresh(); setSelected(null); }} />
        ) : (
          <div className="au-empty"><div className="eyebrow">{onCount} automation{onCount === 1 ? '' : 's'} on</div><h2 className="au-title">Automate the busywork</h2>
            <p className="au-note">Describe what should happen, or pick a recipe. Rules act on Desk tickets and on project tasks across the workspace.</p></div>
        )}
      </div>
      {side}
    </div>
  );
}

/** "Describe it in words": the AI drafts a flow from a sentence; it opens as a draft to check before turning on. */
function Describe({ onDraft }: { onDraft: (f: Flow) => void }) {
  const ai = useAi();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const go = async () => {
    if (text.trim().length < 8) return;
    setBusy(true); setNote(null);
    try { const d: AutomationDraft = await workspaceAutomationApi.draft(text.trim()); onDraft(draftToFlow(d)); setNote(d.reason); setText(''); }
    catch (e) { setNote(errText(e, 'The AI could not draft it. Build it with the sentence instead.')); }
    finally { setBusy(false); }
  };
  return (
    <form className="au-describe" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <div className="au-describe-h">Describe it in words</div>
      <div className="au-describe-line"><span className="au-orb" aria-hidden="true" />
        <textarea rows={2} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} disabled={!ai || busy} aria-label="Describe the automation in words"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void go(); } }}
          placeholder={ai ? '“If a critical ticket sits 30 min without reply, give it to on-call and tell the incidents channel.”' : 'AI is off for this workspace: build it with the sentence.'} />
      </div>
      {ai && text.trim().length >= 8 && <button type="submit" className="btn btn-primary btn-sm" disabled={busy}><Icon name="sparkle" size={14} />{busy ? 'Drafting…' : 'Draft it'}</button>}
      {note && <p className="au-note" role="status">{note}</p>}
    </form>
  );
}

/** A token in the sentence: a native select (keyboard, screen reader and phone friendly) dressed as a pill. */
function Tok({ label, value, onChange, disabled, children, plain }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; children: ReactNode; plain?: boolean }) {
  return (
    <span className={`au-tok ${plain ? '' : 'v'}`}>
      <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>{children}</select>
      {!disabled && <Icon name="chevronD" size={12} />}
    </span>
  );
}

function TokInput({ label, value, onChange, disabled, placeholder, width, type = 'text', min, max, quoted }: {
  label: string; value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string; width?: number; type?: 'text' | 'number'; min?: number; max?: number; quoted?: boolean;
}) {
  return (
    <span className={`au-tok v au-in ${quoted ? 'quoted' : ''}`}>
      <input aria-label={label} type={type} min={min} max={max} value={value} disabled={disabled} placeholder={placeholder} maxLength={type === 'text' ? 500 : undefined}
        style={{ width: width ?? `${Math.min(48, Math.max(6, (value || placeholder || '').length + 1))}ch` }} onChange={(e) => onChange(e.target.value)} />
    </span>
  );
}

function Builder({ rule, initial, canEdit, onCount, onSaved, onRemoved }: {
  rule?: AutomationRule; initial: Flow; canEdit: boolean; onCount: number; onSaved: (r: AutomationRule) => void; onRemoved: () => void;
}) {
  const [f, setF] = useState<Flow>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editedAt, setEditedAt] = useState<number | null>(null);
  const set = <K extends keyof Flow>(k: K, v: Flow[K]) => { setF((x) => ({ ...x, [k]: v })); setEditedAt(Date.now()); };
  const subject = subjectOf(f.trigger);
  const ro = !canEdit;
  const members = useWsQuery(['members'], workspaceApi.members, { enabled: canEdit });
  const labels = useWsQuery(['labels'], labelApi.list, { enabled: canEdit && subject === 'task' });
  const convs = useWsQuery(['chat', 'conversations'], chatApi.conversations, { enabled: canEdit, staleTime: 60_000 });
  const channels = (convs.data ?? []).filter((c) => c.type !== 'Direct');

  const setSubject = (s: Subject) => {
    if (s === subject) return;
    setF((x) => ({
      ...x, trigger: s === 'ticket' ? 'TicketCreated' : 'TaskCreated',
      conditions: x.conditions.filter((c) => c.field !== 'noReply' && c.field !== 'status'),
      steps: x.steps.map((st) => (s === 'task' && st.action === 'TellCustomer') || (s === 'ticket' && st.action === 'AddLabel') ? step({}) : st),
    }));
    setEditedAt(Date.now());
  };
  const setTrigger = (t: AutomationTrigger) => setF((x) => ({ ...x, trigger: t, triggerDays: t === 'Stale' ? Math.max(1, x.triggerDays) : x.triggerDays }));
  const setCond = (i: number, c: AutomationCondition) => set('conditions', f.conditions.map((x, k) => (k === i ? c : x)));
  const setStep = (i: number, s: AutomationStep) => set('steps', f.steps.map((x, k) => (k === i ? s : x)));
  const free = CONDITIONS.filter((c) => (subject === 'ticket' || !c.ticketOnly) && !f.conditions.some((x) => x.field === c.field));

  const save = async (mode: 'draft' | 'on' | 'off' | 'save') => {
    const next: Flow = mode === 'draft' ? { ...f, isDraft: true, isEnabled: false } : mode === 'on' ? { ...f, isDraft: false, isEnabled: true }
      : mode === 'off' ? { ...f, isDraft: false, isEnabled: false } : f;
    if (!next.name.trim()) { setError('Give the automation a name.'); return; }
    setBusy(true); setError(null);
    try {
      const input = flowToInput(next);
      const saved = rule ? await workspaceAutomationApi.update(rule.id, input) : await workspaceAutomationApi.create(input);
      setF(next); setEditedAt(null);
      toast(mode === 'draft' ? 'Saved as a draft. It does not run until you turn it on.' : mode === 'on' ? 'Turned on.' : mode === 'off' ? 'Turned off.' : 'Saved.');
      onSaved(saved);
    } catch (e) { setError(errText(e, 'Could not save the automation.')); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!rule) { onRemoved(); return; }
    if (!(await confirmDialog({ title: 'Delete automation?', message: `“${rule.name}” will stop running. What it already changed stays as it is.`, confirmText: 'Delete' }))) return;
    try { await workspaceAutomationApi.remove(rule.id); toast('Automation deleted.', 'warning'); onRemoved(); }
    catch (e) { toast(errText(e, 'Could not delete the automation.'), 'error'); }
  };

  const live = !!rule && rule.isEnabled && !rule.isDraft;
  const state = !rule ? 'New · not saved' : f.isDraft ? `Draft · ${editedAt ? 'edited just now' : rule.lastRunAt ? `ran ${timeAgo(rule.lastRunAt)}` : 'not turned on'}`
    : live ? (editedAt ? 'On · unsaved changes' : 'On') : (editedAt ? 'Off · unsaved changes' : 'Off');

  return (
    <>
      <header className="au-head">
        <div className="au-head-t">
          <div className="eyebrow">{subject === 'ticket' ? 'Desk' : 'Work'} · {onCount} automation{onCount === 1 ? '' : 's'} on</div>
          <input className="au-title" aria-label="Automation name" value={f.name} maxLength={100} disabled={ro} onChange={(e) => set('name', e.target.value)} placeholder="Name this automation" />
        </div>
        <span className={`au-state ${live && !editedAt ? 'on' : ''}`}>{state}</span>
        {canEdit && (
          <div className="au-actions">
            {rule && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove()} disabled={busy}>Delete</button>}
            {!rule && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove()} disabled={busy}>Discard</button>}
            {live ? (
              <>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save('off')}>Turn off</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || !editedAt} onClick={() => void save('save')}>{busy ? 'Saving…' : 'Save'}</button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save('draft')}>Save as draft</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save('on')}>{busy ? 'Saving…' : 'Turn on'}</button>
              </>
            )}
          </div>
        )}
      </header>

      <section className="au-rule" aria-label="Rule">
        <div className="au-st">
          <div className="au-w">When</div>
          <div className="au-txt">
            <Tok label="What the rule acts on" value={subject} disabled={ro} onChange={(v) => setSubject(v as Subject)}>
              <option value="ticket">a ticket</option><option value="task">a task</option>
            </Tok>
            <span className="au-word">is</span>
            <Tok label="Event" value={f.trigger} disabled={ro} onChange={(v) => setTrigger(v as AutomationTrigger)}>
              {EVENTS[subject].map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </Tok>
            {f.trigger === 'StatusChanged' && (<><span className="au-word">to</span>
              <Tok label="Status" value={f.whenStatusCategory ?? ''} disabled={ro} onChange={(v) => set('whenStatusCategory', (v || null) as StatusCategory | null)}>
                <option value="">any status</option>{TASK_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </Tok></>)}
            {f.trigger === 'PriorityChanged' && (<><span className="au-word">of</span>
              <Tok label="Priority" value={f.whenPriority ?? ''} disabled={ro} onChange={(v) => set('whenPriority', v || null)}>
                <option value="">any priority</option><PriorityOptions />
              </Tok></>)}
            {isScheduled(f.trigger) && (<>
              <span className="au-word">{f.trigger === 'DueSoon' ? 'within' : f.trigger === 'Overdue' ? 'by' : 'for'}</span>
              <TokInput label="Days" type="number" width={48} min={f.trigger === 'Stale' ? 1 : 0} max={365} value={String(f.triggerDays)} disabled={ro} onChange={(v) => set('triggerDays', Number(v))} />
              <span className="au-word">days</span></>)}
            <span className="au-word">in</span><span className="au-tok v static">{subject === 'ticket' ? 'Desk · all queues' : 'any project'}</span>
          </div>
        </div>

        <div className="au-st">
          <div className="au-w if">If</div>
          <div className="au-txt">
            {f.conditions.length === 0 && <span className="au-word muted">always — no conditions</span>}
            {f.conditions.map((c, i) => (
              <span key={c.field} className="au-cond">
                {i > 0 && <span className="au-word">and</span>}
                <Condition c={c} subject={subject} ro={ro} onChange={(n) => setCond(i, n)} />
                {!ro && <button type="button" className="au-x" aria-label="Remove this condition" onClick={() => set('conditions', f.conditions.filter((_, k) => k !== i))}><Icon name="close" size={12} /></button>}
              </span>
            ))}
            {!ro && free.length > 0 && (
              <label className="au-add">
                <select aria-label="Add condition" value="" onChange={(e) => { if (e.target.value) set('conditions', [...f.conditions, newCondition(e.target.value as AutomationConditionField, subject)]); }}>
                  <option value="">＋ Add condition</option>{free.map((c) => <option key={c.field} value={c.field}>{c.label}</option>)}
                </select>
                <span aria-hidden="true">＋ Add condition</span>
              </label>
            )}
          </div>
        </div>

        <div className="au-st">
          <div className="au-w then">Then</div>
          <div className="au-txt">
            {f.steps.map((s, i) => (
              <div key={i} className="au-step">
                <StepTokens n={i} s={s} subject={subject} ro={ro} onChange={(n) => setStep(i, n)}
                  people={members.data?.map((m) => ({ id: m.userId, name: m.displayName })) ?? []}
                  labels={labels.data?.map((l) => ({ id: l.id, name: l.name })) ?? []}
                  channels={channels.map((c) => ({ id: c.id, name: c.name }))} />
                {!ro && f.steps.length > 1 && <button type="button" className="au-x" aria-label={`Remove step ${i + 1}`} onClick={() => set('steps', f.steps.filter((_, k) => k !== i))}><Icon name="close" size={12} /></button>}
              </div>
            ))}
            {!ro && f.steps.length < MAX_STEPS && (
              <button type="button" className="au-add" onClick={() => set('steps', [...f.steps, step({ action: subject === 'ticket' ? 'PostToChannel' : 'Notify' })])}>＋ Add step</button>
            )}
          </div>
        </div>
      </section>

      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="au-guard">
        <span><Icon name="shield" size={13} /> Cannot trigger itself: steps never start other automations.</span>
        <span><Icon name="clock" size={13} /> At most {MAX_RUNS_PER_HOUR} runs an hour.</span>
      </div>

      {canEdit && <Backtest flow={f} />}
      {canEdit && <TestRun flow={f} />}
      {rule && <Runs id={rule.id} />}
    </>
  );
}

function Condition({ c, subject, ro, onChange }: { c: AutomationCondition; subject: Subject; ro: boolean; onChange: (c: AutomationCondition) => void }) {
  switch (c.field) {
    case 'priority':
      return <><span className="au-word">priority is</span><Tok label="Priority" value={c.value ?? 'Critical'} disabled={ro} onChange={(v) => onChange({ ...c, value: v })}><PriorityOptions /></Tok></>;
    case 'status':
      return (<><span className="au-word">status is</span>
        <Tok label="Status" value={c.value ?? ''} disabled={ro} onChange={(v) => onChange({ ...c, value: v })}>
          {(subject === 'ticket' ? TICKET_STATUSES : TASK_CATEGORIES).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </Tok></>);
    case 'unassigned':
      return <span className="au-tok v static">nobody is assigned</span>;
    case 'businessHours':
      return <><span className="au-word">it is</span><span className="au-tok v static">within business hours</span></>;
    default:
      return (<><span className="au-tok v static">no agent has replied</span><span className="au-word">for</span>
        <TokInput label="Minutes without a reply" type="number" width={52} min={1} max={10080} value={String(c.minutes ?? 30)} disabled={ro} onChange={(v) => onChange({ ...c, minutes: Number(v) })} />
        <span className="au-word">minutes</span></>);
  }
}

const ACTION_LABEL: Record<AutomationAction, string> = {
  SetAssignee: 'Assign to', Notify: 'Notify', PostToChannel: 'Post in', TellCustomer: 'Tell the customer', SetPriority: 'Set priority to',
  MoveToStatus: 'Move to', AddComment: 'Add a note', AddLabel: 'Add label',
};
const ACTIONS: Record<Subject, AutomationAction[]> = {
  ticket: ['SetAssignee', 'PostToChannel', 'TellCustomer', 'Notify', 'SetPriority', 'MoveToStatus', 'AddComment'],
  task: ['SetAssignee', 'PostToChannel', 'Notify', 'SetPriority', 'MoveToStatus', 'AddLabel', 'AddComment'],
};

type Opt = { id: string; name: string };
function StepTokens({ n, s, subject, ro, onChange, people, labels, channels }: {
  n: number; s: AutomationStep; subject: Subject; ro: boolean; onChange: (s: AutomationStep) => void; people: Opt[]; labels: Opt[]; channels: Opt[];
}) {
  const up = (p: Partial<AutomationStep>) => onChange({ ...s, ...p });
  const changeAction = (a: AutomationAction) => onChange(step({
    action: a, actionTarget: a === 'SetAssignee' ? 'User' : 'Assignee', actionPriority: a === 'SetPriority' ? 'High' : null, actionStatusCategory: a === 'MoveToStatus' ? 'Active' : null,
  }));
  const person = (target: AutomationTarget, assignee: boolean) => (<>
    <Tok label="Who" value={target} disabled={ro} onChange={(v) => up({ actionTarget: v as AutomationTarget })}>
      <option value="User">a person…</option><option value="Reporter">the {subject === 'ticket' ? 'requester' : 'reporter'}</option>
      {assignee && <option value="Assignee">the assignee</option>}
    </Tok>
    {target === 'User' && (
      <Tok label="Person" value={s.actionUserId ?? ''} disabled={ro} onChange={(v) => up({ actionUserId: v || null })}>
        <option value="">choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Tok>
    )}
  </>);
  return (
    <>
      <Tok plain label={`Step ${n + 1}`} value={s.action} disabled={ro} onChange={(v) => changeAction(v as AutomationAction)}>
        {ACTIONS[subject].map((a) => <option key={a} value={a}>{NUMBERS[n]} {ACTION_LABEL[a]}</option>)}
      </Tok>
      {s.action === 'SetAssignee' && person(s.actionTarget === 'Assignee' ? 'User' : s.actionTarget, false)}
      {s.action === 'Notify' && (<>{person(s.actionTarget, true)}
        <TokInput label="Message" quoted value={s.actionText ?? ''} disabled={ro} placeholder="message (optional)" onChange={(v) => up({ actionText: v })} /></>)}
      {s.action === 'PostToChannel' && (<>
        <Tok label="Messages channel" value={s.actionConversationId ?? ''} disabled={ro} onChange={(v) => up({ actionConversationId: v || null })}>
          <option value="">Messages · choose a channel…</option>{channels.map((c) => <option key={c.id} value={c.id}>Messages · #{c.name}</option>)}
        </Tok>
        <TokInput label="Channel message" quoted value={s.actionText ?? ''} disabled={ro} placeholder="what to say (optional)" onChange={(v) => up({ actionText: v })} /></>)}
      {s.action === 'TellCustomer' && <TokInput label="What to tell the customer" quoted value={s.actionText ?? ''} disabled={ro} placeholder="We’re on it — update within 1 hour" onChange={(v) => up({ actionText: v })} />}
      {s.action === 'AddComment' && <TokInput label="Note" quoted value={s.actionText ?? ''} disabled={ro} placeholder="the note to add" onChange={(v) => up({ actionText: v })} />}
      {s.action === 'SetPriority' && <Tok label="Priority" value={s.actionPriority ?? 'High'} disabled={ro} onChange={(v) => up({ actionPriority: v })}><PriorityOptions /></Tok>}
      {s.action === 'MoveToStatus' && (
        <Tok label="Status" value={s.actionStatusCategory ?? 'Active'} disabled={ro} onChange={(v) => up({ actionStatusCategory: v as StatusCategory })}>
          {TASK_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </Tok>
      )}
      {s.action === 'AddLabel' && (
        <Tok label="Label" value={s.actionLabelId ?? ''} disabled={ro} onChange={(v) => up({ actionLabelId: v || null })}>
          <option value="">choose…</option>{labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Tok>
      )}
    </>
  );
}

/** "Would have fired N times last week": the flow as it stands replayed over the last 7 days on the server. Nothing is changed or sent. */
function Backtest({ flow }: { flow: Flow }) {
  const input = useMemo(() => flowToInput({ ...flow, name: flow.name.trim() || 'Untitled' }), [flow]);
  const key = useDebounced(JSON.stringify(input), 500);
  const q = useWsQuery(['automations', 'backtest', key], () => workspaceAutomationApi.backtest(JSON.parse(key)), { retry: false, staleTime: 60_000 });
  const [open, setOpen] = useState(false);
  const r: AutomationBacktest | undefined = q.data;
  const max = Math.max(1, ...(r?.days.map((d) => d.count) ?? [0]));
  const noun = subjectOf(flow.trigger) === 'ticket' ? 'ticket' : 'task';
  const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
  return (
    <section className="au-dry" aria-label="Dry run" aria-busy={q.isFetching}>
      <div className="au-dry-h">
        <span className={`au-dry-i ${r && r.total === 0 ? 'zero' : ''}`} aria-hidden="true">{q.isError ? '!' : '✓'}</span>
        <div className="au-dry-t">
          <b>{q.isError ? 'Dry run · could not replay this rule' : !r ? 'Dry run · replaying the last 7 days…'
            : r.total === 0 ? 'Dry run · would not have fired last week' : `Dry run · would have fired ${r.total} time${r.total === 1 ? '' : 's'} last week`}</b>
          <span>{q.isError ? errText(q.error, 'Finish the rule to see how often it would have fired.') : r?.note ?? 'Nothing is changed or sent.'}</span>
        </div>
        {r && r.total > 0 && <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : `See the ${r.total} ${noun}${r.total === 1 ? '' : 's'}`}</button>}
      </div>
      <div className="au-bars" role="img" aria-label={r ? r.days.map((d) => `${fmt(d.date)} ${d.count}`).join(', ') : 'Loading'}>
        {(r?.days ?? Array.from({ length: 7 }, (_, i) => ({ date: `x${i}`, count: 0 }))).map((d) => (
          <i key={d.date} style={{ height: `${d.count ? Math.max(12, (d.count / max) * 100) : 6}%` }} className={d.count ? '' : 'none'} />
        ))}
      </div>
      {r && <div className="au-bar-l">{r.days.map((d) => <span key={d.date}>{fmt(d.date)} {d.count}</span>)}</div>}
      {open && r && (
        <ul className="au-dry-items">
          {r.items.map((it) => (
            <li key={`${it.id}-${it.at}`}><Link className="link" to={`/work?item=${it.id}`}><b>{it.key}</b> {it.title}</Link>
              <time dateTime={it.at}>{new Date(it.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</time></li>
          ))}
          {r.total > r.items.length && <li className="au-note">and {r.total - r.items.length} more</li>}
        </ul>
      )}
    </section>
  );
}

/** Tries the flow as it stands against one task or ticket: per step, whether it would pass or stop. Nothing is changed or sent. */
function TestRun({ flow }: { flow: Flow }) {
  const ticket = subjectOf(flow.trigger) === 'ticket';
  const [text, setText] = useState('');
  const term = useDebounced(text.trim(), 300);
  const hits = useWsQuery(['work-items', 'au-test', ticket, term], () => workItemsApi.list({ kind: [ticket ? 'ticket' : 'task'], status: 'all', q: term, limit: 8 }), { enabled: term.length >= 2, staleTime: 30_000 });
  const [result, setResult] = useState<AutomationTest | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (taskId: string) => {
    setBusy(true); setResult(null);
    try { setResult(await workspaceAutomationApi.test(flowToInput({ ...flow, name: flow.name.trim() || 'Untitled' }), taskId)); }
    catch (e) { toast(errText(e, 'Could not run the test.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <details className="au-test">
      <summary className="au-h">Try it on one {ticket ? 'ticket' : 'task'}</summary>
      <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Find a ${ticket ? 'ticket' : 'task'} by key or title`} aria-label="Find an item to test with" />
      {term.length >= 2 && (hits.data?.items.length ?? 0) > 0 && !result && (
        <div className="au-hits">
          {hits.data!.items.map((h) => <button key={h.id} type="button" className="au-hit" disabled={busy} onClick={() => void run(h.id)}>{h.key} · {h.title}</button>)}
        </div>
      )}
      {busy && <p className="au-note">Running…</p>}
      {result && (
        <>
          <p className="au-note"><b>{result.taskKey}</b> {result.taskTitle} — {result.wouldRun ? 'the automation would act on it.' : 'the automation would not change it.'}
            {' '}<button type="button" className="wkp-link" onClick={() => setResult(null)}>Try another</button></p>
          <ol>
            {result.steps.map((s, i) => (
              <li key={i}><b className={s.pass ? 'pass' : 'stop'}>{s.pass ? '✓' : '✕'}</b><span><b>{s.step}</b> {s.note}</span></li>
            ))}
          </ol>
        </>
      )}
    </details>
  );
}

function Runs({ id }: { id: string }) {
  const q = useWsQuery(['automations', 'runs', id], () => workspaceAutomationApi.runs(id), { staleTime: 30_000 });
  return (
    <section aria-label="Run history" className="au-history">
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
