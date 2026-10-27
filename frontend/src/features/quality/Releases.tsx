import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi } from '../../api/endpoints';
import { qualityApi, releaseApi, type Release, type ReleaseState } from '../../api/qualityApi';
import { workItemsApi } from '../../api/workItemsApi';
import { Field, Modal } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';

const err = (e: unknown, f: string) => (e instanceof ApiError ? e.message : f);
const day = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'No date');
const ICON: Record<string, string> = { work: '✓', bugs: '🐞', tests: '⚗' };

/**
 * Releases: a list on the left (planned first, by target date), the chosen release on the right — the go/no-go up top (three checks, each
 * green or what is missing), the work going out with its state, the test runs tied to it, and Approve (with a reason when the checks
 * say no) then Ship.
 */
export function Releases() {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const list = useWsQuery(['quality', 'releases'], () => releaseApi.list(), { staleTime: 20_000 });
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const releases = list.data ?? [];
  useEffect(() => { if (!sel && releases[0]) setSel(releases[0].id); }, [releases, sel]);
  const state = useWsQuery(['quality', 'release', sel ?? 'none'], () => releaseApi.get(sel!), { enabled: !!sel });
  const refresh = (s?: ReleaseState) => {
    if (s) qc.setQueryData([wid, 'quality', 'release', s.release.id], s);
    void qc.invalidateQueries({ queryKey: [wid, 'quality', 'releases'] });
  };
  return (
    <div className="rl">
      <aside className="dq-card rl-list" aria-label="Releases">
        <div className="rl-list-hd"><h2 className="dq-h3">Releases</h2><button type="button" className="dq-btn sm pri" onClick={() => setCreating(true)}>New release</button></div>
        {list.isLoading ? <p className="dq-empty">Loading…</p> : releases.length === 0 ? <p className="dq-empty">No releases yet. Group the work going out together and decide go or no-go in one place.</p> : (
          <ul>
            {releases.map((r) => (
              <li key={r.id}><button type="button" className={`rl-row${r.id === sel ? ' on' : ''}`} aria-current={r.id === sel ? 'true' : undefined} onClick={() => setSel(r.id)}>
                <b>{r.name}</b><span className={`rl-st s-${r.status.toLowerCase()}`}>{r.status}</span>
                <small>{[r.projectName, day(r.targetDate), `${r.items} item${r.items === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</small>
              </button></li>
            ))}
          </ul>
        )}
      </aside>
      <section className="rl-main" aria-label="Release">
        {!sel ? null : state.isLoading || !state.data ? <p className="dq-empty">Loading…</p> : <Detail s={state.data} onChange={refresh} />}
      </section>
      {creating && <NewRelease onClose={() => setCreating(false)} onDone={(r) => { setCreating(false); setSel(r.id); refresh(); }} />}
    </div>
  );
}

function Detail({ s, onChange }: { s: ReleaseState; onChange: (s: ReleaseState) => void }) {
  const r = s.release;
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const runs = useWsQuery(['quality', 'runs', r.projectId ?? 'all'], () => qualityApi.runs(r.projectId ?? undefined), { staleTime: 30_000 });
  const free = (runs.data ?? []).filter((x) => !s.runs.some((y) => y.id === x.id));
  const act = async (fn: () => Promise<ReleaseState>, ok: string) => {
    setBusy(true);
    try { onChange(await fn()); toast(ok, 'success'); return true; } catch (e) { toast(err(e, 'That did not work.'), 'error'); return false; } finally { setBusy(false); }
  };
  const planned = r.status === 'Planned';
  return (
    <>
      <header className={`dq-card rl-head ${s.go ? 'go' : 'nogo'}`}>
        <div className="rl-verdict" aria-live="polite"><span className="rl-orb" aria-hidden="true">{s.go ? '✓' : '!'}</span><div><small>{r.projectName ?? 'All projects'} · {day(r.targetDate)}</small><h1>{r.name}</h1><b>{r.status === 'Shipped' ? 'Shipped' : r.status === 'Approved' ? `Approved by ${r.approvedBy?.name ?? 'someone'}` : s.go ? 'Go — every check passes' : 'No go yet'}</b></div></div>
        <div className="rl-checks">
          {s.checks.map((c) => <div key={c.key} className={`rl-check ${c.ok ? 'ok' : 'no'}`}><span aria-hidden="true">{ICON[c.key]}</span><div><b>{c.label}</b><small>{c.detail}</small></div></div>)}
        </div>
        <div className="rl-acts">
          {planned && (s.go
            ? <button type="button" className="dq-btn pri" disabled={busy} onClick={() => void act(() => releaseApi.approve(r.id), `${r.name} approved.`)}>Approve release</button>
            : asking
              ? <form className="rl-why" onSubmit={(e) => { e.preventDefault(); void act(() => releaseApi.approve(r.id, reason), `${r.name} approved against the checks.`).then((ok) => ok && setAsking(false)); }}>
                  <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Why go anyway?" aria-label="Reason to approve against the checks" />
                  <button type="submit" className="dq-btn pri" disabled={busy || !reason.trim()}>Approve anyway</button>
                  <button type="button" className="dq-btn" onClick={() => setAsking(false)}>Cancel</button>
                </form>
              : <button type="button" className="dq-btn" onClick={() => setAsking(true)}>Approve anyway…</button>)}
          {r.status === 'Approved' && <button type="button" className="dq-btn pri" disabled={busy} onClick={() => void act(() => releaseApi.ship(r.id), `${r.name} marked shipped.`)}>Mark shipped</button>}
        </div>
      </header>

      <div className="rl-cols">
        <section className="dq-card rl-items" aria-label="Work in this release">
          <div className="rl-sec-hd"><h2 className="dq-h3">Work <span className="dq-faint">{s.done} done · {s.open} open{s.openBugs ? ` · ${s.openBugs} open bug${s.openBugs === 1 ? '' : 's'}` : ''}</span></h2>{planned && <button type="button" className="dq-btn sm" onClick={() => setAdding(true)}>Add work</button>}</div>
          {s.items.length === 0 ? <p className="dq-empty">Add the tasks, tickets and bugs going out in {r.name}.</p> : (
            <ul>{s.items.map((i) => (
              <li key={i.id} className={`rl-item${i.category === 'Done' || i.category === 'Cancelled' ? ' done' : ''}${i.bug ? ' bug' : ''}`}>
                <span className="rl-dot" aria-hidden="true" />
                <Link to={`/work?item=${i.id}`}><b>{i.key}</b> {i.title}</Link>
                <small>{[i.bug ? 'Bug' : null, i.status, i.assignee?.name].filter(Boolean).join(' · ')}</small>
                {planned && !i.bug && <button type="button" className="rl-x" aria-label={`Take ${i.key} out of the release`} onClick={() => void act(() => releaseApi.items(r.id, { remove: [i.id] }), `${i.key} taken out.`)}>×</button>}
              </li>))}</ul>
          )}
        </section>
        <section className="dq-card rl-runs" aria-label="Test runs">
          <div className="rl-sec-hd"><h2 className="dq-h3">Test runs</h2></div>
          {s.runs.length === 0 ? <p className="dq-empty">Tie the test run that checks this release.</p> : (
            <ul>{s.runs.map((x) => <li key={x.id}><b>{x.name}</b><small>{[x.environment, x.build ? `build ${x.build}` : null, x.status].filter(Boolean).join(' · ')}</small>
              {planned && <button type="button" className="rl-x" aria-label={`Untie ${x.name}`} onClick={() => void act(() => releaseApi.detachRun(r.id, x.id), 'Run untied.')}>×</button>}</li>)}</ul>
          )}
          {s.tests && <p className="rl-pass"><b>{s.tests.passPercent}%</b> passed in {s.tests.run?.name} · {s.tests.failed} failed · {s.tests.blocked} blocked · {s.tests.notRun} not run</p>}
          {planned && free.length > 0 && (
            <label className="rl-tie">Tie a run<select value="" onChange={(e) => { if (e.target.value) void act(() => releaseApi.attachRun(r.id, e.target.value), 'Run tied to the release.'); }}>
              <option value="">Choose…</option>{free.map((x) => <option key={x.id} value={x.id}>{x.name}{x.environment ? ` · ${x.environment}` : ''}</option>)}
            </select></label>
          )}
        </section>
      </div>
      {r.notes && <section className="dq-card rl-notes"><h2 className="dq-h3">Notes</h2><p>{r.notes}</p></section>}
      {adding && <AddWork projectId={r.projectId} exclude={s.items.map((i) => i.id)} onClose={() => setAdding(false)} onAdd={(ids) => void act(() => releaseApi.items(r.id, { add: ids }), `${ids.length} added.`).then((ok) => ok && setAdding(false))} />}
    </>
  );
}

function AddWork({ projectId, exclude, onClose, onAdd }: { projectId: string | null; exclude: string[]; onClose: () => void; onAdd: (ids: string[]) => void }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const list = useWsQuery(['quality', 'release-pick', projectId ?? 'all', q], () => workItemsApi.list({ q: q || undefined, projectId: projectId ?? undefined, status: 'all', limit: 60 }), { staleTime: 10_000 });
  const rows = (list.data?.items ?? []).filter((w) => !exclude.includes(w.id));
  return (
    <Modal title="Add work to the release" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!picked.length} onClick={() => onAdd(picked)}>Add {picked.length || ''}</button></>}>
      <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by key or title" aria-label="Search work" />
      <ul className="rl-pick">{rows.map((w) => (
        <li key={w.id}><label><input type="checkbox" checked={picked.includes(w.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, w.id] : p.filter((x) => x !== w.id)))} /><b>{w.key}</b> {w.title}<small>{w.status}</small></label></li>
      ))}{!list.isLoading && rows.length === 0 && <li className="dq-empty">Nothing matches.</li>}</ul>
    </Modal>
  );
}

function NewRelease({ onClose, onDone }: { onClose: () => void; onDone: (r: Release) => void }) {
  const projects = useWsQuery(['projects', 'health'], () => projectApi.list({ pageSize: 100 }), { staleTime: 60_000 });
  const [name, setName] = useState('');
  const [project, setProject] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useMemo(() => (projects.data?.items ?? []).filter((p) => p.status !== 'Completed' && p.status !== 'Cancelled' && p.status !== 'Archived'), [projects.data]);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { onDone(await releaseApi.create({ name: name.trim(), projectId: project || null, targetDate: date || null })); toast('Release created.', 'success'); }
    catch (x) { toast(err(x, 'Could not create the release.'), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title="New release" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="rl-new" disabled={busy || !name.trim()}>Create</button></>}>
      <form id="rl-new" className="form-grid" onSubmit={(e) => void submit(e)}>
        <Field label="Name" required><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="v2.4" /></Field>
        <Field label="Project"><select className="input" value={project} onChange={(e) => setProject(e.target.value)}><option value="">Across projects</option>{live.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Target date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}
