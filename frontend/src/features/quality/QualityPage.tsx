import { ToolbarSeg } from '../../components/v2/ToolbarSeg';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi, workspaceApi } from '../../api/endpoints';
import { qualityApi, releaseApi, type CasePriority, type ResultStatus, type TestCase, type TestMatrix, type TestResult, type TestRun } from '../../api/qualityApi';
import { Field, Modal } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { commonCause, evidenceLines, releaseOf, runHeading, stepsOf } from './qualityLogic';
import '../desk/dq.css';
import './quality.css';
import { Releases } from './Releases';

type Tab = 'runs' | 'cases' | 'bugs' | 'releases';
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const STATUS_LABEL: Record<ResultStatus, string> = { Pass: 'Passed', Fail: 'Failed', Blocked: 'Blocked', NotRun: 'Not run' };
const DOT: Record<ResultStatus, string> = { Pass: 'p', Fail: 'x', Blocked: 'b', NotRun: 's' };

export function QualityPage() {
  const [params, setParams] = useSearchParams();
  const deepRelease = params.get('release');
  // The tab lives in the address, so it survives a reload, a remount (workspace context arriving) and the Back button.
  const TABS: Tab[] = ['runs', 'cases', 'bugs', 'releases'];
  const q = params.get('tab') as Tab | null;
  const tab: Tab = q && TABS.includes(q) ? q : deepRelease ? 'releases' : 'runs';
  const setTab = (t: Tab) => setParams((p) => { const n = new URLSearchParams(p); if (t === 'runs') n.delete('tab'); else n.set('tab', t); return n; }, { replace: true });
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [dialog, setDialog] = useState<'case' | 'run' | null>(null);
  const [cell, setCell] = useState<{ runId: string; caseId: string; x: number; y: number } | null>(null);
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const matrix = useWsQuery(['quality', 'matrix'], () => qualityApi.matrix(undefined, 4), { refetchInterval: 30_000 });
  const m: TestMatrix = matrix.data ?? { runs: [], cases: [], results: [] };
  const current: TestRun | null = useMemo(() => [...m.runs].reverse().find((r) => r.status === 'Running') ?? m.runs[m.runs.length - 1] ?? null, [m.runs]);
  const ready = useWsQuery(['quality', 'readiness', current?.id ?? 'none'], () => qualityApi.readiness(current ? { runId: current.id } : {}), { enabled: !!current });
  const reload = () => { void qc.invalidateQueries({ queryKey: [wid, 'quality'] }); };

  const resultOf = (runId: string, caseId: string) => m.results.find((r) => r.runId === runId && r.caseId === caseId) ?? null;
  const failedHere = (c: TestCase) => !!current && ['Fail', 'Blocked'].includes(resultOf(current.id, c.id)?.status ?? '');
  const rows = onlyFailed ? m.cases.filter(failedHere) : m.cases;
  const firstFailed = current ? m.cases.find((c) => resultOf(current.id, c.id)?.status === 'Fail') ?? m.cases.find(failedHere) : undefined;
  const sel = m.cases.find((c) => c.id === selected) ?? firstFailed ?? m.cases[0] ?? null;
  const project = sel?.projectName ?? m.cases.find((c) => c.projectName)?.projectName ?? null;

  useEffect(() => {
    if (!cell) return;
    const close = (e: Event) => { if (!(e.target as HTMLElement).closest?.('.qa-menu')) setCell(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setCell(null); };
    window.addEventListener('mousedown', close); window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [cell]);

  const setResult = async (runId: string, caseId: string, status: ResultStatus) => {
    setCell(null);
    try { await qualityApi.setResult(runId, caseId, { status }); setSelected(caseId); reload(); }
    catch (e) { toast(errText(e, 'Could not save the result.'), 'error'); }
  };
  const rerunFailed = async () => {
    if (!current) return;
    const failed = m.results.filter((r) => r.runId === current.id && r.status === 'Fail');
    if (failed.length === 0) { toast('Nothing failed in this run.'); return; }
    try { await Promise.all(failed.map((r) => qualityApi.setResult(current.id, r.caseId, { status: 'NotRun' }))); toast(`${failed.length} failed case${failed.length === 1 ? '' : 's'} queued to run again.`); reload(); }
    catch (e) { toast(errText(e, 'Could not queue the failed cases.'), 'error'); reload(); }
  };

  const empty = !matrix.isLoading && m.cases.length === 0;

  return (
    <div className="dq-page qa">
      <ToolbarSeg className="dq-tb">
        <div className="dq-seg" role="tablist" aria-label="Quality views">
          {(['runs', 'cases', 'bugs', 'releases'] as Tab[]).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
          ))}
        </div>
      </ToolbarSeg>
      <div className="dq-hd qa-hd">
        <div>
          <div className="dq-eyebrow">{[project, current ? releaseOf(current.name) : null].filter(Boolean).join(' · ') || 'Test cases and runs'}</div>
          <h1 className="dq-h1">Quality</h1>
        </div>
        <div className="dq-row" style={{ gap: 8 }}>
          {current && <button type="button" className="dq-btn sm" onClick={() => void rerunFailed()}>▶ Re‑run failed</button>}
        </div>
      </div>

      {tab === 'releases' ? <Releases initial={deepRelease} /> : matrix.isLoading ? <p className="dq-empty">Loading…</p> : empty ? (
        <div className="dq-card qa-empty">
          <span className="qa-empty-ic" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M9 3h6M10 3v6.5L5.2 18a2 2 0 0 0 1.7 3h10.2a2 2 0 0 0 1.7-3L14 9.5V3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
          <h2 className="dq-h3">No test cases yet</h2>
          <p className="dq-faint">Write down what a release must do, run it on each build and see readiness at a glance.</p>
          <button type="button" className="dq-btn pri" onClick={() => setDialog('case')}>Add your first test case</button>
        </div>
      ) : (
        <>
          <Readiness run={current} r={ready.data ?? null} results={m.results} onShow={() => { setOnlyFailed((v) => !v); setTab('runs'); }} showing={onlyFailed} onNewRun={() => setDialog('run')} />
          {tab === 'runs' && (
            <div className="qa-cols">
              <div className="dq-card qa-mx">
                {m.runs.length === 0 ? <div className="dq-empty">No runs yet. <button type="button" className="dq-btn sm pri" onClick={() => setDialog('run')}>Start a run</button></div> : (
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Test case</th>
                        {m.runs.map((r) => { const h = runHeading(r); return <th key={r.id} scope="col" className={r.id === current?.id && r.status === 'Running' ? 'run' : ''}>{h.top}<small>{h.sub}</small></th>; })}
                        <th scope="col" className="qa-add"><button type="button" aria-label="New run" title="New run" onClick={() => setDialog('run')}>＋</button></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((c) => (
                        <tr key={c.id} className={sel?.id === c.id ? 'sel' : ''} onClick={() => setSelected(c.id)}>
                          <td><span className="qa-ct">{c.title}</span><small>{[c.key, c.tags?.split(',')[0]?.trim() || c.projectName].filter(Boolean).join(' · ')}</small></td>
                          {m.runs.map((r) => {
                            const res = resultOf(r.id, c.id);
                            const st: ResultStatus = res?.status ?? 'NotRun';
                            return (
                              <td key={r.id} className={r.id === current?.id && r.status === 'Running' ? 'run' : ''}>
                                <button type="button" className={`qa-d ${DOT[st]}`} aria-label={`${c.key} in ${r.name}: ${STATUS_LABEL[st]}. Change`}
                                  onClick={(e) => { e.stopPropagation(); const b = (e.currentTarget as HTMLElement).getBoundingClientRect(); setSelected(c.id); setCell({ runId: r.id, caseId: c.id, x: b.left + b.width / 2, y: b.bottom + 6 }); }} />
                              </td>
                            );
                          })}
                          <td aria-hidden="true" />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              {sel && <Detail c={sel} run={current} result={current ? resultOf(current.id, sel.id) : null} onFiled={reload} />}
            </div>
          )}
          {tab === 'cases' && <CasesList cases={m.cases} onNew={() => setDialog('case')} onSaved={reload} />}
          {tab === 'bugs' && <BugsList m={m} />}
        </>
      )}

      {cell && (
        <div className="qa-menu" role="menu" style={{ left: cell.x, top: cell.y }}>
          {(['Pass', 'Fail', 'Blocked', 'NotRun'] as ResultStatus[]).map((s) => (
            <button key={s} type="button" role="menuitem" onClick={() => void setResult(cell.runId, cell.caseId, s)}><span className={`qa-d ${DOT[s]}`} aria-hidden="true" />{STATUS_LABEL[s]}</button>
          ))}
        </div>
      )}
      {dialog === 'case' && <CaseDialog onClose={() => setDialog(null)} onSaved={(c) => { setDialog(null); setSelected(c.id); reload(); }} />}
      {dialog === 'run' && <RunDialog onClose={() => setDialog(null)} onSaved={() => { setDialog(null); reload(); }} />}
    </div>
  );
}

/** The readiness card: the ring, "UAT 1.4 · 86% passing · 3 blockers", the counts and the one thing the failures share. */
function Readiness({ run, r, results, onShow, showing, onNewRun }: { run: TestRun | null; r: import('../../api/qualityApi').Readiness | null; results: TestResult[]; onShow: () => void; showing: boolean; onNewRun: () => void }) {
  const pct = r?.passPercent ?? 0;
  const C = 2 * Math.PI * 44;
  const failed = run ? results.filter((x) => x.runId === run.id && x.status === 'Fail') : [];
  const cause = commonCause(failed.map((x) => x.actual));
  const blockers = r?.blockers.length ?? 0;
  const nFailed = r?.failed ?? failed.length;
  return (
    <div className="dq-card qa-ready">
      <div className="qa-ring" role="img" aria-label={`${pct}% passing`}>
        <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">
          <circle cx="48" cy="48" r="44" fill="none" stroke="rgba(175,82,222,.14)" strokeWidth="8" />
          <circle cx="48" cy="48" r="44" fill="none" stroke="#af52de" strokeWidth="8" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} transform="rotate(-90 48 48)" />
        </svg>
        <span>{pct}%</span>
      </div>
      <div className="qa-ready-t">
        {run ? <div className="qa-big">{run.name} · {pct}% passing · {blockers} blocker{blockers === 1 ? '' : 's'}</div> : <div className="qa-big">No run yet</div>}
        <div className="dq-faint qa-ready-s">
          {!run ? 'Start a run to see how ready the release is.' : r?.ready ? 'Ready to ship: 95% or more passing and no blockers.' : `Not ready to ship. Ship needs 95% and zero blockers${run.status === 'Done' ? '.' : ' when the run ends.'}`}
          {!run && <> <button type="button" className="dq-btn sm pri" onClick={onNewRun}>Start a run</button></>}
        </div>
      </div>
      <div className="qa-st"><div className="n">{r?.ran ?? 0}</div><div className="l">Cases run</div></div>
      <div className="qa-st"><div className="n" style={{ color: '#ff3b30' }}>{r?.failed ?? 0}</div><div className="l">Failed</div></div>
      <div className="qa-st"><div className="n" style={{ color: '#ff9500' }}>{r?.blocked ?? 0}</div><div className="l">Blocked</div></div>
      {failed.length > 0 && (
        <div className="dq-ai qa-insight">
          <div className="dq-ai-line"><span className="dq-orb" aria-hidden="true" />
            <span>{cause ? `${nFailed === 1 ? 'The failure' : `All ${nFailed} failures`} share ${cause} — fix it once to clear them.` : `${nFailed} failures, ${blockers} of them blocking — start with the blockers.`}</span></div>
          <button type="button" className="dq-btn sm white" onClick={onShow}>{showing ? 'Show all' : 'Show failures'}</button>
        </div>
      )}
    </div>
  );
}

/** The selected case: steps, expected against actual, the evidence and File bug. */
function Detail({ c, run, result, onFiled }: { c: TestCase; run: TestRun | null; result: TestResult | null; onFiled: () => void }) {
  const nav = useNavigate();
  const releases = useWsQuery(['quality', 'releases'], () => releaseApi.list(), { staleTime: 20_000, enabled: !!run?.releaseId });
  const release = run?.releaseId ? releases.data?.find((x) => x.id === run.releaseId) ?? null : null;
  const open = release && release.status !== 'Shipped' ? release : null;
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 5 * 60_000, enabled: picking });
  const st: ResultStatus = result?.status ?? 'NotRun';
  const steps = stepsOf(c.steps);
  const file = async (assigneeId?: string) => {
    if (!result) return;
    if (result.linkedWorkItemId && !assigneeId) { nav(`/work?item=${encodeURIComponent(result.linkedWorkItemId)}`); return; }
    setBusy(true);
    try {
      const r = await qualityApi.fileBug(result.id, { assigneeId: assigneeId ?? null });
      toast(open ? `Filed ${r.workItem.key} into ${open.name}.` : `Filed ${r.workItem.key}.`);
      onFiled();
    } catch (e) { toast(errText(e, 'Could not file the bug.'), 'error'); }
    finally { setBusy(false); setPicking(false); }
  };
  const canFile = !!result && (st === 'Fail' || st === 'Blocked');
  return (
    <aside className="dq-card qa-det" aria-label="Selected test case">
      <div className="dq-row" style={{ gap: 8 }}>
        <span className={`dq-pill qa-st-${st}`}>{STATUS_LABEL[st]}{run ? ` · ${run.name}` : ''}</span>
        <span className="dq-faint dq-s12">{[c.key, result?.at ? new Date(result.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : null].filter(Boolean).join(' · ')}</span>
      </div>
      <h2 className="qa-dt">{c.title}</h2>
      {steps.length > 0 && <div><div className="dq-lbl">Steps</div><ol>{steps.map((s, i) => <li key={i}>{s}</li>)}</ol></div>}
      <div className="qa-ev">
        <div className="qa-exp"><b>Expected</b><br />{c.expected ?? '—'}</div>
        <div className={st === 'Pass' ? 'qa-exp' : 'qa-act'}><b>Actual</b><br />{result?.actual ?? (st === 'Pass' ? 'As expected' : st === 'NotRun' ? 'Not run yet' : '—')}</div>
      </div>
      {result?.evidence && <Evidence text={result.evidence} />}
      <div className="dq-row" style={{ gap: 8, marginTop: 2 }}>
        <button type="button" className="dq-btn pri qa-file" disabled={!canFile || busy} onClick={() => void file()}>{busy ? 'Filing…' : result?.linkedWorkItemId ? 'Open bug' : 'File bug'}</button>
        {picking ? (
          <select className="qa-assign" autoFocus aria-label="Assign the bug to" defaultValue="" onChange={(e) => { if (e.target.value) void file(e.target.value); }} onBlur={() => setPicking(false)}>
            <option value="" disabled>Assign to…</option>
            {(members.data ?? []).filter((x) => x.role !== 'Guest' && x.isActive !== false).map((x) => <option key={x.userId} value={x.userId}>{x.displayName}</option>)}
          </select>
        ) : <button type="button" className="dq-btn" disabled={!canFile || busy || !!result?.linkedWorkItemId} onClick={() => setPicking(true)}>Assign to…</button>}
      </div>
      <div className="dq-faint qa-note">{result?.linkedWorkItemId ? 'A bug is filed for this result.' : `Creates a work item${c.projectName ? ` in ${c.projectName}` : ''}, linked to this run${open ? ` and to release ${open.name}, where it blocks the go until fixed` : ''}.`}
        {open && <> <Link to={`/quality?release=${encodeURIComponent(open.id)}`} className="qa-rel">Open {open.name} ›</Link></>}</div>
    </aside>
  );
}

function Evidence({ text }: { text: string }) {
  return (
    <pre className="qa-pre">
      {evidenceLines(text).map((l, i) => (
        <span key={i}>{l.map((p, j) => <span key={j} className={p.k ?? undefined}>{p.t}</span>)}{'\n'}</span>
      ))}
    </pre>
  );
}

function CasesList({ cases, onNew, onSaved }: { cases: TestCase[]; onNew: () => void; onSaved: () => void }) {
  const [edit, setEdit] = useState<TestCase | null>(null);
  return (
    <div className="dq-card qa-list">
      <div className="qa-list-h"><h2 className="dq-h3">{cases.length} test case{cases.length === 1 ? '' : 's'}</h2><button type="button" className="dq-btn sm pri" onClick={onNew}>＋ New case</button></div>
      {cases.map((c) => (
        <button key={c.id} type="button" className="qa-li" onClick={() => setEdit(c)}>
          <span className="qa-key">{c.key}</span><span className="qa-ct">{c.title}</span><span className={`dq-pill qa-pr-${c.priority}`}>{c.priority}</span>
        </button>
      ))}
      {edit && <CaseDialog initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onSaved(); }} />}
    </div>
  );
}

function BugsList({ m }: { m: TestMatrix }) {
  const nav = useNavigate();
  const filed = m.results.filter((r) => r.linkedWorkItemId);
  return (
    <div className="dq-card qa-list">
      <div className="qa-list-h"><h2 className="dq-h3">Bugs filed from runs</h2></div>
      {filed.length === 0 ? <p className="dq-empty">No bugs filed yet. Pick a failed case and choose File bug.</p> : filed.map((r) => {
        const c = m.cases.find((x) => x.id === r.caseId), run = m.runs.find((x) => x.id === r.runId);
        return (
          <button key={r.id} type="button" className="qa-li" onClick={() => nav(`/work?item=${encodeURIComponent(r.linkedWorkItemId!)}`)}>
            <span className="qa-key">{c?.key}</span><span className="qa-ct">{c?.title}</span><span className="dq-faint dq-s12">{run?.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function useProjects() {
  return useWsQuery(['quality', 'projects'], () => projectApi.list({ pageSize: 100 }), { staleTime: 5 * 60_000 });
}

function Dialog({ title, onClose, onSubmit, busy, children, submit }: { title: string; onClose: () => void; onSubmit: (e: FormEvent<HTMLFormElement>) => void; busy: boolean; children: ReactNode; submit: string }) {
  return (
    <Modal title={title} onClose={onClose} onSubmit={onSubmit} footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : submit}</button></>}>
      {children}
    </Modal>
  );
}

function CaseDialog({ initial, onClose, onSaved }: { initial?: TestCase; onClose: () => void; onSaved: (c: TestCase) => void }) {
  const projects = useProjects();
  const [f, setF] = useState({ title: initial?.title ?? '', steps: initial?.steps ?? '', expected: initial?.expected ?? '', priority: (initial?.priority ?? 'Medium') as CasePriority, tags: initial?.tags ?? '', projectId: initial?.projectId ?? '' });
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!f.title.trim()) { toast('Give the test case a title.', 'error'); return; }
    setBusy(true);
    try {
      const body = { ...f, projectId: f.projectId || null };
      onSaved(initial ? await qualityApi.updateCase(initial.id, body) : await qualityApi.createCase(body));
      toast(initial ? 'Test case saved.' : 'Test case added.');
    } catch (err) { toast(errText(err, 'Could not save the test case.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Dialog title={initial ? `Edit ${initial.key}` : 'New test case'} onClose={onClose} onSubmit={(e) => void submit(e)} busy={busy} submit={initial ? 'Save' : 'Add test case'}>
      <Field label="Title" required><input className="input" autoFocus maxLength={300} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Loan dispatch API returns 200 for valid PAN" /></Field>
      <Field label="Steps" hint="One step per line."><textarea className="textarea" rows={4} maxLength={8000} value={f.steps} onChange={(e) => setF({ ...f, steps: e.target.value })} /></Field>
      <Field label="Expected"><input className="input" maxLength={2000} value={f.expected} onChange={(e) => setF({ ...f, expected: e.target.value })} placeholder="200 · dispatch_id present" /></Field>
      <Field label="Priority"><select className="select" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as CasePriority })}>{['Low', 'Medium', 'High', 'Critical'].map((p) => <option key={p}>{p}</option>)}</select></Field>
      <Field label="Area / tags"><input className="input" maxLength={300} value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="Loan dispatch" /></Field>
      <Field label="Project"><select className="select" value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">No project</option>{(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
    </Dialog>
  );
}

function RunDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (r: TestRun) => void }) {
  const projects = useProjects();
  const [f, setF] = useState({ name: '', environment: 'UAT', build: '', projectId: '' });
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!f.name.trim()) { toast('Give the run a name.', 'error'); return; }
    setBusy(true);
    try { onSaved(await qualityApi.createRun({ ...f, projectId: f.projectId || null })); toast('Run started.'); }
    catch (err) { toast(errText(err, 'Could not start the run.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Dialog title="New test run" onClose={onClose} onSubmit={(e) => void submit(e)} busy={busy} submit="Create run">
      <Field label="Name" required><input className="input" autoFocus maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="UAT 1.4" /></Field>
      <Field label="Environment"><input className="input" maxLength={40} value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })} placeholder="DEV, UAT, PROD-like" /></Field>
      <Field label="Build"><input className="input" maxLength={40} value={f.build} onChange={(e) => setF({ ...f, build: e.target.value })} placeholder="214" /></Field>
      <Field label="Project"><select className="select" value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">No project</option>{(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
    </Dialog>
  );
}
