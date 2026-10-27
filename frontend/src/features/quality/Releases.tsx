import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi } from '../../api/endpoints';
import { workspaceApi } from '../../api/endpoints.auth';
import { qualityApi, releaseApi, type Release, type ReleaseSignOff, type ReleaseState } from '../../api/qualityApi';
import { workItemsApi } from '../../api/workItemsApi';
import { Field, Modal } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';

const err = (e: unknown, f: string) => (e instanceof ApiError ? e.message : f);
const day = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'No date');

/**
 * Releases: a list on the left (planned first, by target date), the chosen release on the right — the go/no-go up top (three checks, each
 * green or what is missing), the work going out with its state, the test runs tied to it, and Approve (with a reason when the checks
 * say no) then Ship.
 */
export function Releases({ initial }: { initial?: string | null } = {}) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const list = useWsQuery(['quality', 'releases'], () => releaseApi.list(), { staleTime: 20_000 });
  const [sel, setSel] = useState<string | null>(initial ?? null);
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

const DAY_MS = 86_400_000;
const daysTo = (d: string) => Math.round((new Date(`${d}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime()) / DAY_MS);
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('');
const HUES = ['#28cd41', '#5856d6', '#ff9500', '#30b0c7', '#af52de', '#ff2d55', '#007aff'];
const hue = (id: string) => HUES[parseInt(id.replace(/[^0-9a-f]/gi, '').slice(-4) || '0', 16) % HUES.length];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const weekday = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

function Detail({ s, onChange }: { s: ReleaseState; onChange: (s: ReleaseState) => void }) {
  const r = s.release;
  const meId = useAuth((a) => a.ctx?.user.id ?? null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [people, setPeople] = useState(false);
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const runs = useWsQuery(['quality', 'runs', r.projectId ?? 'all'], () => qualityApi.runs(r.projectId ?? undefined), { staleTime: 30_000 });
  const free = (runs.data ?? []).filter((x) => !s.runs.some((y) => y.id === x.id));
  const act = async (fn: () => Promise<ReleaseState>, ok: string) => {
    setBusy(true);
    try { onChange(await fn()); toast(ok, 'success'); return true; } catch (e) { toast(err(e, 'That did not work.'), 'error'); return false; } finally { setBusy(false); }
  };
  const planned = r.status === 'Planned';
  const signOffs = s.signOffs ?? [];
  const pending = signOffs.filter((x) => x.status !== 'Signed');
  const mine = signOffs.find((x) => x.user.id === meId);
  const closed = (c: string) => c === 'Done' || c === 'Cancelled';
  const blockers = s.items.filter((i) => i.bug && !closed(i.category));
  const openWork = s.items.filter((i) => !i.bug && !closed(i.category)).length;
  const t = s.tests;
  const toGo = r.targetDate ? daysTo(r.targetDate) : null;
  const ready = [blockers.length ? `${plural(blockers.length, 'blocker')} close` : null, openWork ? `${plural(openWork, 'item')} ${openWork === 1 ? 'is' : 'are'} done` : null,
    pending.length ? `${plural(pending.length, 'person')} sign${pending.length === 1 ? 's' : ''} off`.replace('persons', 'people') : null, !t ? 'tests run' : !t.ready ? 'tests pass' : null].filter(Boolean) as string[];
  const verdict = r.status === 'Shipped' ? `Shipped ${r.shippedAt ? new Date(r.shippedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}`.trim()
    : r.status === 'Approved' ? `Approved by ${r.approvedBy?.name ?? 'someone'}` : s.go ? 'Every check passes — ready to go' : ready.length ? `Ready once ${ready.length > 1 ? `${ready.slice(0, -1).join(', ')} and ${ready[ready.length - 1]}` : ready[0]}` : 'Not ready yet';
  const f = s.forecast;
  const forecast = !f ? null : f.openBlockers === 0 ? 'No open bugs block this release.' : f.blockersClearBy
    ? `At the recent fix rate (${f.closedPerDay} a day) ${f.openBlockers === 1 ? 'the blocker closes' : `the ${f.openBlockers} blockers close`} by ${weekday(f.blockersClearBy)}${r.targetDate ? (f.blockersClearBy <= r.targetDate ? ' — on track for the target.' : ` — after the target of ${day(r.targetDate)}.`) : '.'}`
    : 'No bugs closed in the last two weeks, so there is no fix rate to forecast from yet.';
  const grid = s.grid;
  return (
    <>
      <header className="rl-top">
        <div><small className="rl-eyebrow">{r.projectName ?? 'All projects'} · release</small><h1>{r.name}{r.targetDate ? ` · ${day(r.targetDate)}` : ''}</h1></div>
        <div className="rl-pills">
          {s.previous && <span className="rl-pill">{s.previous.name} shipped {s.previous.shippedAt ? new Date(s.previous.shippedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}</span>}
          {r.status !== 'Shipped' && toGo != null && <span className={`rl-pill ${toGo < 0 ? 'late' : 'warn'}`}>{toGo > 0 ? `${plural(toGo, 'day')} to go` : toGo === 0 ? 'Due today' : `${plural(-toGo, 'day')} late`}</span>}
          <span className={`rl-st s-${r.status.toLowerCase()}`}>{r.status}</span>
          {r.notesDocumentId && <Link className="dq-btn sm rl-notes" to={`/documents/${r.notesDocumentId}`}>Release notes{r.notesDocumentKey ? ` · ${r.notesDocumentKey}` : ''}</Link>}
          {planned && s.go && <button type="button" className="dq-btn pri" disabled={busy} onClick={() => void act(() => releaseApi.approve(r.id), `${r.name} approved.`)}>Approve release</button>}
          {r.status === 'Approved' && <button type="button" className="dq-btn pri" disabled={busy} onClick={() => void act(() => releaseApi.ship(r.id), `${r.name} marked shipped.`)}>Mark shipped</button>}
        </div>
      </header>

      <div className="rl-grid">
        <section className={`dq-card rl-go ${s.go || r.status !== 'Planned' ? 'go' : 'nogo'}`} aria-label="Go or no-go">
          <div className="rl-verdict" aria-live="polite"><span className="rl-orb" aria-hidden="true">{s.go || r.status !== 'Planned' ? '✓' : '⏸'}</span>
            <div><small className="rl-kicker">GO / NO-GO · {r.status !== 'Planned' ? r.status.toUpperCase() : s.go ? 'GO' : 'NOT YET'}</small><h2>{verdict}</h2></div></div>
          <div className="rl-stats">
            <div><b>{t ? t.passed : '—'}{t && <span>/{t.ran + t.notRun}</span>}</b><small>Tests passed{t ? ` · ${t.passPercent}%` : ''}</small><i className="rl-bar" aria-hidden="true"><i style={{ width: `${t?.passPercent ?? 0}%` }} /></i></div>
            <div><b className={blockers.length ? 'red' : ''}>{blockers.length}</b><small>Blocking bug{blockers.length === 1 ? '' : 's'} open</small></div>
            <div><b className={pending.length ? 'amber' : ''}>{pending.length}</b><small>Sign-off{pending.length === 1 ? '' : 's'} pending</small></div>
          </div>
          {forecast && <p className="rl-forecast"><span className="rl-ai" aria-hidden="true" />{forecast}</p>}
          <ul className="rl-checks">{s.checks.map((c) => <li key={c.key} className={c.ok ? 'ok' : 'no'}><span aria-hidden="true">{c.ok ? '✓' : '•'}</span><b>{c.label}</b><small>{c.detail}</small></li>)}</ul>
          {planned && !s.go && (asking
            ? <form className="rl-why" onSubmit={(e) => { e.preventDefault(); void act(() => releaseApi.approve(r.id, reason), `${r.name} approved against the checks.`).then((ok) => ok && setAsking(false)); }}>
                <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Why go anyway?" aria-label="Reason to approve against the checks" />
                <button type="submit" className="dq-btn pri" disabled={busy || !reason.trim()}>Approve anyway</button>
                <button type="button" className="dq-btn" onClick={() => setAsking(false)}>Cancel</button>
              </form>
            : <div className="rl-why"><button type="button" className="dq-btn sm" onClick={() => setAsking(true)}>Approve anyway…</button></div>)}
        </section>

        <section className="dq-card rl-so" aria-label="Sign-offs">
          <div className="rl-sec-hd"><h2 className="dq-h3">Sign-offs</h2>{planned && <button type="button" className="dq-btn sm" onClick={() => setPeople(true)}>{signOffs.length ? 'Edit' : 'Ask people'}</button>}</div>
          {signOffs.length === 0 ? <p className="dq-empty">Ask the people who sign off — QA, Product, Engineering — and see who is still pending.</p> : (
            <ul>{signOffs.map((x) => (
              <li key={x.id} className="rl-so-row">
                <span className="rl-av" style={{ background: hue(x.user.id) }} aria-hidden="true">{initials(x.user.name)}</span>
                <span className="rl-so-who"><b>{x.user.name}</b> · {x.role}{x.note && <small>{x.note}</small>}</span>
                <span className={`rl-tag ${x.status === 'Signed' ? 'ok' : x.status === 'Declined' ? 'bad' : 'warn'}`}>{x.status}{x.signedAt ? ` · ${new Date(x.signedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}</span>
              </li>))}</ul>
          )}
          <div className="rl-so-acts">
            {planned && pending.some((x) => x.status === 'Pending') && <button type="button" className="dq-btn sm" disabled={busy} onClick={() => void act(() => releaseApi.remind(r.id), `Reminded ${plural(pending.filter((x) => x.status === 'Pending').length, 'person').replace('persons', 'people')}.`)}>Remind pending</button>}
            {planned && mine && mine.status !== 'Signed' && !declining && <>
              <button type="button" className="dq-btn sm pri" disabled={busy} onClick={() => void act(() => releaseApi.sign(r.id, true), 'Signed off.')}>Sign off as {mine.role}</button>
              <button type="button" className="dq-btn sm" onClick={() => setDeclining(true)}>Decline…</button>
            </>}
          </div>
          {declining && (
            <form className="rl-why" onSubmit={(e) => { e.preventDefault(); void act(() => releaseApi.sign(r.id, false, note), 'Sign-off declined.').then((ok) => ok && setDeclining(false)); }}>
              <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Why not yet?" aria-label="Reason for declining" />
              <button type="submit" className="dq-btn" disabled={busy || !note.trim()}>Decline</button>
              <button type="button" className="dq-btn" onClick={() => setDeclining(false)}>Cancel</button>
            </form>
          )}
        </section>

        <section className="dq-card rl-env" aria-label="Test runs by environment">
          <div className="rl-sec-hd"><h2 className="dq-h3">Test runs by environment</h2></div>
          {!grid || grid.rows.length === 0 ? <p className="dq-empty">Tie the test runs that check this release; results show here by suite and environment.</p> : (
            <div className="rl-table-wrap"><div className="rl-table" role="table" aria-label="Suites by environment" style={{ gridTemplateColumns: `minmax(96px, 1.6fr) repeat(${grid.environments.length}, minmax(56px, 1fr))` }}>
              <div role="row" className="rl-tr hd"><span role="columnheader">Suite</span>{grid.environments.map((e) => <span key={e} role="columnheader">{e}</span>)}</div>
              {grid.rows.map((row) => (
                <div role="row" className="rl-tr" key={row.suite}><span role="rowheader">{row.suite}</span>{row.cells.map((c) => (
                  <span role="cell" key={c.environment}><span className={`rl-c ${c.total === 0 ? (c.running ? 'run' : 'na') : c.passed === c.total ? 'ok' : 'bad'}`}>{c.total === 0 ? (c.running ? 'running' : '—') : `${c.passed}/${c.total}`}</span></span>))}</div>))}
            </div></div>
          )}
          {s.runs.length > 0 && <ul className="rl-runs">{s.runs.map((x) => <li key={x.id}><b>{x.name}</b><small>{[x.environment, x.build ? `build ${x.build}` : null, x.status].filter(Boolean).join(' · ')}</small>
            {planned && <button type="button" className="rl-x" aria-label={`Untie ${x.name}`} onClick={() => void act(() => releaseApi.detachRun(r.id, x.id), 'Run untied.')}>×</button>}</li>)}</ul>}
          {planned && free.length > 0 && (
            <label className="rl-tie">Tie a run<select value="" onChange={(e) => { if (e.target.value) void act(() => releaseApi.attachRun(r.id, e.target.value), 'Run tied to the release.'); }}>
              <option value="">Choose…</option>{free.map((x) => <option key={x.id} value={x.id}>{x.name}{x.environment ? ` · ${x.environment}` : ''}</option>)}
            </select></label>
          )}
        </section>

        <section className="dq-card rl-items" aria-label="Linked work items">
          <div className="rl-sec-hd"><h2 className="dq-h3">Linked work items</h2><span className="rl-sec-r"><span className="dq-faint">{s.items.length} in release</span>{planned && <button type="button" className="dq-btn sm" onClick={() => setAdding(true)}>Add work</button>}</span></div>
          {s.items.length === 0 ? <p className="dq-empty">Add the tasks, tickets and bugs going out in {r.name}.</p> : (
            <ul>{[...s.items].sort((a, b) => Number(closed(a.category)) - Number(closed(b.category)) || Number(b.bug) - Number(a.bug)).map((i) => {
              const done = closed(i.category), blocker = i.bug && !done;
              return (
                <li key={i.id} className="rl-wi">
                  <code>{i.key}</code>
                  <Link to={`/work?item=${i.id}`}>{i.title}</Link>
                  <span className={`rl-tag ${blocker ? 'bad' : done ? 'ok' : ''}`}>{blocker ? 'Blocker' : done ? 'Done' : i.status}</span>
                  {planned && !i.bug && <button type="button" className="rl-x" aria-label={`Take ${i.key} out of the release`} onClick={() => void act(() => releaseApi.items(r.id, { remove: [i.id] }), `${i.key} taken out.`)}>×</button>}
                </li>);
            })}</ul>
          )}
        </section>
      </div>
      {r.notes && <section className="dq-card rl-notes"><h2 className="dq-h3">Notes</h2><p>{r.notes}</p></section>}
      {adding && <AddWork projectId={r.projectId} exclude={s.items.map((i) => i.id)} onClose={() => setAdding(false)} onAdd={(ids) => void act(() => releaseApi.items(r.id, { add: ids }), `${ids.length} added.`).then((ok) => ok && setAdding(false))} />}
      {people && <SignOffPeople current={signOffs} onClose={() => setPeople(false)} onSave={(list) => void act(() => releaseApi.setSignOffs(r.id, list), 'Sign-offs updated.').then((ok) => ok && setPeople(false))} />}
    </>
  );
}

function SignOffPeople({ current, onClose, onSave }: { current: ReleaseSignOff[]; onClose: () => void; onSave: (list: { userId: string; role: string }[]) => void }) {
  const members = useWsQuery(['workspace', 'members'], () => workspaceApi.members(), { staleTime: 60_000 });
  const [rows, setRows] = useState(() => current.map((x) => ({ userId: x.user.id, role: x.role })));
  const [who, setWho] = useState('');
  const list = (members.data ?? []).filter((m) => m.role !== 'Guest');
  const name = (id: string) => list.find((m) => m.userId === id)?.displayName ?? current.find((x) => x.user.id === id)?.user.name ?? 'Someone';
  return (
    <Modal title="Who signs off" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={rows.some((x) => !x.role.trim())} onClick={() => onSave(rows.map((x) => ({ userId: x.userId, role: x.role.trim() })))}>Save</button></>}>
      <ul className="rl-pick">{rows.map((x, i) => (
        <li key={x.userId} className="rl-person"><b>{name(x.userId)}</b>
          <input className="input" value={x.role} maxLength={60} placeholder="Role, e.g. QA" aria-label={`Role for ${name(x.userId)}`} onChange={(e) => setRows((r) => r.map((y, j) => (j === i ? { ...y, role: e.target.value } : y)))} />
          <button type="button" className="rl-x" aria-label={`Remove ${name(x.userId)}`} onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>×</button></li>
      ))}</ul>
      <label className="rl-tie">Add a person<select value={who} onChange={(e) => { const v = e.target.value; setWho(''); if (v) setRows((r) => [...r, { userId: v, role: '' }]); }}>
        <option value="">Choose…</option>{list.filter((m) => !rows.some((x) => x.userId === m.userId)).map((m) => <option key={m.userId} value={m.userId}>{m.displayName}{m.jobRole ? ` · ${m.jobRole}` : ''}</option>)}
      </select></label>
    </Modal>
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
