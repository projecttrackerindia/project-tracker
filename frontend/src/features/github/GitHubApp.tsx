import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { integrationsApi } from '../../api/endpoints';
import type { DeliveryMetrics, DevLink, GitHubAppStatus, GitHubStatusRules, PullReviewItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Badge, EmptyState, ErrorState, Field, Modal, PageLoader } from '../../components/ui';
import { formatDate, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { hours, safeHref, useGitHubApp } from './github';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const LAST_REPO = 'pt-github-last-repo';
const readLastRepo = () => { try { return localStorage.getItem(LAST_REPO); } catch { return null; } };
const saveLastRepo = (r: string) => { try { localStorage.setItem(LAST_REPO, r); } catch { /* private window */ } };



// ------------------------------------------------------------------ Settings card

/**
 * Settings → GitHub & Azure DevOps: install the ProjectTracker GitHub App with one click (no webhook or secret to paste). GitHub sends the
 * admin back here with the installation and a one-time code; the server checks the code's GitHub user can reach that installation.
 */
// One completion per return from GitHub, even if the card mounts twice (the workspace context arriving remounts Settings):
// the one-time code is spent on the first call, and a second call would report a failure over a connection that worked.
const completed = new Set<string>();

export function GitHubAppCard() {
  const wid = useWorkspaceId();
  const role = useAuth((s) => s.ctx?.current?.role);
  const admin = role === 'Owner' || role === 'Admin';
  const q = useGitHubApp();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const completing = useRef(false);
  const qc = useQueryClient();
  const refresh = () => void invalidateWorkspace(wid, 'github-app');

  // Back from GitHub: ?installation_id=…&setup_action=install&code=…&state=…
  useEffect(() => {
    const installation = params.get('installation_id'), action = params.get('setup_action'), state = params.get('state');
    if (!installation && action !== 'request') return;
    const clear = () => { const n = new URLSearchParams(params); ['installation_id', 'setup_action', 'code', 'state'].forEach((k) => n.delete(k)); setParams(n, { replace: true }); };
    if (action === 'request') { setRequested(true); clear(); return; }
    const once = `${installation}|${state}`;
    if (completing.current || !installation || !state || completed.has(once)) { clear(); return; }
    completing.current = true; completed.add(once);
    setBusy(true);
    integrationsApi.gitHubComplete({ installationId: Number(installation), setupAction: action, code: params.get('code'), state })
      .then((s) => { toast(`GitHub connected: ${s.account ?? 'your account'}, ${s.repositories.length} repositor${s.repositories.length === 1 ? 'y' : 'ies'}.`);
        // Refresh every GitHub status copy, not only the one keyed by the workspace this first render saw (it may not have loaded yet).
        // The answer is the new status: show it now (no refetch race with a status read that started before the install finished).
        qc.setQueriesData({ predicate: (x) => x.queryKey.length === 2 && x.queryKey[1] === 'github-app' }, s);
        if (wid) qc.setQueryData([wid, 'github-app'], s);
        void qc.invalidateQueries({ predicate: (x) => x.queryKey.includes('github-app') }); })
      .catch((e) => toast(errText(e, 'GitHub could not be connected.'), 'error'))
      .finally(() => { setBusy(false); clear(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = async () => {
    setBusy(true);
    try { window.location.assign((await integrationsApi.gitHubInstall()).url); }
    catch (e) { toast(errText(e, 'Could not start the install.'), 'error'); setBusy(false); }
  };
  const disconnect = async (s: GitHubAppStatus) => {
    if (!(await confirmDialog({ title: `Disconnect ${s.account ?? 'GitHub'}?`, message: 'Links already made stay on their tasks. New events are ignored here; remove the app on GitHub to stop them being sent.', confirmText: 'Disconnect', danger: true }))) return;
    try { await integrationsApi.gitHubDisconnect(); toast('GitHub disconnected.'); refresh(); } catch (e) { toast(errText(e, 'Could not disconnect.'), 'error'); }
  };

  if (q.isLoading) return <div className="card mb-22"><div className="card-body"><PageLoader /></div></div>;
  if (q.isError || !q.data) return <div className="card mb-22"><div className="card-body"><ErrorState error={q.error} retry={() => void q.refetch()} /></div></div>;
  const s = q.data;

  return (
    <div className="card mb-22 gh-app" data-testid="github-app">
      <div className="card-head">
        <div>
          <h3><Icon name="git" size={15} /> GitHub App {s.installed && <Badge tone={s.suspended ? 'warning' : 'success'}>{s.suspended ? 'Suspended' : 'Connected'}</Badge>}</h3>
          <p>Install once: branches start from a task, status follows the code, and each pull request shows its checks, reviews and risk on the task.</p>
        </div>
        {s.installed && admin && (
          <div className="row" style={{ gap: 8 }}>
            {s.manageUrl && <a className="btn btn-ghost btn-sm" href={safeHref(s.manageUrl)} target="_blank" rel="noreferrer noopener"><Icon name="settings" size={14} /> Repositories on GitHub</a>}
            <button type="button" className="btn btn-ghost btn-sm danger" onClick={() => void disconnect(s)}>Disconnect</button>
          </div>
        )}
      </div>
      <div className="card-body">
        {requested && <p className="sso-note" role="status">Your request went to the GitHub organization’s owners. Once one of them approves it, come back here and press Install again.</p>}
        {!s.configured ? (
          <p className="sso-note">The ProjectTracker GitHub App is not set up on this server yet. Until it is, connect repositories with a webhook below.</p>
        ) : !s.installed ? (
          admin ? (
            <div className="gh-install">
              <ul className="gh-points">
                <li><Icon name="git" size={14} /> <span><b>Create branch</b> from any task, named with its key</span></li>
                <li><Icon name="kanban" size={14} /> <span><b>Status follows the code</b>: review when a pull request opens, done when it merges</span></li>
                <li><Icon name="shield" size={14} /> <span><b>Checks, reviews and a risk score</b> on the task</span></li>
                <li><Icon name="chart" size={14} /> <span><b>Release notes and delivery metrics</b> per project</span></li>
              </ul>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void install()}><Icon name="git" size={14} /> Install the GitHub App</button>
              <p className="muted" style={{ fontSize: 12 }}>You choose the repositories on GitHub. Nothing to paste: no webhook, no secret.</p>
            </div>
          ) : <p className="muted">An owner or admin can install the GitHub App for this workspace.</p>
        ) : (
          <>
            <div className="mailbox-stats">
              <span><b>{s.account}</b> {s.accountType === 'User' ? '(personal account)' : '(organization)'}</span>
              <span>{s.selection === 'all' ? 'All repositories' : `${s.repositories.length} selected repositor${s.repositories.length === 1 ? 'y' : 'ies'}`}</span>
              <span><b>{s.received}</b> event{s.received === 1 ? '' : 's'}{s.lastEventAt ? ` · last ${timeAgo(s.lastEventAt)}` : ''}</span>
            </div>
            {s.suspended && <div className="form-error" style={{ marginTop: 8 }}>The app is suspended on GitHub, so nothing new arrives. Unsuspend it in the installation settings on GitHub.</div>}
            {s.lastError && <div className="form-error" style={{ marginTop: 8 }}>{s.lastError}</div>}
            {s.repositories.length > 0 && (
              <div className="gh-repos" aria-label="Repositories">
                {s.repositories.slice(0, 12).map((r) => <code key={r}>{r}</code>)}
                {s.repositories.length > 12 && <span className="muted">and {s.repositories.length - 12} more</span>}
              </div>
            )}
            {admin && <GitHubRules s={s} onSaved={refresh} />}
          </>
        )}
      </div>
    </div>
  );
}

function GitHubRules({ s, onSaved }: { s: GitHubAppStatus; onSaved: () => void }) {
  const [rules, setRules] = useState<GitHubStatusRules>(s.rules);
  const [paths, setPaths] = useState(s.riskyPaths.join('\n'));
  const [close, setClose] = useState(s.closeOnKeyword);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await integrationsApi.gitHubSave({ rules, riskyPaths: paths.split('\n').map((p) => p.trim()).filter(Boolean), closeOnKeyword: close });
      toast('GitHub rules saved.'); onSaved();
    } catch (e) { toast(errText(e, 'Could not save the rules.'), 'error'); } finally { setBusy(false); }
  };
  const set = (k: 'opened' | 'approved' | 'merged', v: string) => setRules((r) => ({ ...r, [k]: v.trim() ? v : null }));
  return (
    <div className="gh-rules">
      <h4>Status follows the code</h4>
      <p className="muted">Write the status name as your projects call it; a project without that status keeps the task where it is. Leave empty to do nothing.</p>
      <div className="gh-rule-grid">
        <Field label="Pull request opened"><input className="input" maxLength={60} value={rules.opened ?? ''} placeholder="In Review" onChange={(e) => set('opened', e.target.value)} /></Field>
        <Field label="Approved"><input className="input" maxLength={60} value={rules.approved ?? ''} placeholder="Ready" onChange={(e) => set('approved', e.target.value)} /></Field>
        <Field label="Merged"><input className="input" maxLength={60} value={rules.merged ?? ''} placeholder="Done" onChange={(e) => set('merged', e.target.value)} /></Field>
      </div>
      <div className="sso-switches">
        <div className="setting-row">
          <div className="setting-info"><h4>Complete on “Fixes KEY”</h4><p>A merged pull request (or a push to the default branch) that says “fixes WEB-12” completes WEB-12.</p></div>
          <button type="button" className={`switch ${close ? 'on' : ''}`} role="switch" aria-checked={close} aria-label="Complete on fixes" onClick={() => setClose(!close)} />
        </div>
        <div className="setting-row">
          <div className="setting-info"><h4>Reopen on revert</h4><p>When a revert of a merged pull request is merged, its tasks go back to in progress.</p></div>
          <button type="button" className={`switch ${rules.reopenOnRevert ? 'on' : ''}`} role="switch" aria-checked={rules.reopenOnRevert} aria-label="Reopen on revert"
            onClick={() => setRules((r) => ({ ...r, reopenOnRevert: !r.reopenOnRevert }))} />
        </div>
      </div>
      <Field label="Risky folders" hint="One per line, e.g. db/migrations or src/payments. A first change there by someone adds to the pull request’s risk.">
        <textarea className="input" rows={3} value={paths} onChange={(e) => setPaths(e.target.value)} aria-label="Risky folders" />
      </Field>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>Save rules</button>
    </div>
  );
}

// ------------------------------------------------------------------ the task's Development panel

/** "Create branch" on a task: a branch named after the task in one of the app's repositories, linked straight away. */
export function CreateBranchButton({ taskId }: { taskId: string }) {
  const wid = useWorkspaceId();
  const gh = useGitHubApp();
  const canEdit = useCan('tasks.edit');
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ name: string; url: string } | null>(null);
  const repos = gh.data?.installed ? gh.data.repositories : [];
  if (!canEdit || repos.length === 0) return null;

  const create = async (repository: string) => {
    setBusy(true);
    try {
      const b = await integrationsApi.createBranch(taskId, { repository });
      saveLastRepo(repository); setMade({ name: b.name, url: b.url }); setOpen(true);
      void invalidateWorkspace(wid, 'dev-links', taskId);
    } catch (e) { toast(errText(e, 'Could not create the branch.'), 'error'); } finally { setBusy(false); }
  };
  const start = () => {
    if (repos.length === 1) return void create(repos[0]);
    const last = readLastRepo();
    setRepo(last && repos.includes(last) ? last : repos[0]); setMade(null); setOpen(true);
  };
  const command = made ? `git fetch origin && git switch ${made.name}` : '';
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={start} data-testid="create-branch"><Icon name="git" size={13} /> Create branch</button>
      {open && (
        <Modal title={made ? 'Branch created' : 'Create a branch'} onClose={() => setOpen(false)} onSubmit={made ? undefined : (e) => { e.preventDefault(); e.stopPropagation(); void create(repo); }}
          footer={made ? <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>Done</button>
            : <><button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || !repo}>Create branch</button></>}>
          {made ? (
            <>
              <p>Commits and pull requests on <a href={safeHref(made.url)} target="_blank" rel="noreferrer noopener"><code>{made.name}</code></a> link to this task.</p>
              <div className="gh-command"><code>{command}</code>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard?.writeText(command).then(() => toast('Copied.'), () => toast('Copy did not work here.', 'error')); }}><Icon name="copy" size={13} /> Copy</button>
              </div>
            </>
          ) : (
            <Field label="Repository" hint="From its default branch. The name carries the task key, so everything on it links here.">
              <Select className="select" value={repo} aria-label="Repository" onChange={(e) => setRepo(e.target.value)}>
                {repos.map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Field>
          )}
        </Modal>
      )}
    </>
  );
}

const riskTone = (score: number) => score >= 60 ? 'danger' : score >= 30 ? 'warning' : 'success';
const riskLabel = (score: number) => score >= 60 ? 'High risk' : score >= 30 ? 'Some risk' : 'Low risk';

/** What a pull request carries, as small pills: checks, review, size and risk (with its reasons when there is any). */
export function PullRequestFacts({ l }: { l: DevLink }) {
  if (l.kind !== 'pull_request') return null;
  const open = l.state === 'open';
  const facts: { text: string; tone: string; title?: string }[] = [];
  if (l.draft) facts.push({ text: 'Draft', tone: 'neutral' });
  if (l.checksState === 'success') facts.push({ text: '✓ Checks pass', tone: 'success' });
  else if (l.checksState === 'failure') facts.push({ text: '✗ Checks fail', tone: 'danger' });
  else if (l.checksState === 'pending') facts.push({ text: 'Checks running', tone: 'neutral' });
  if (l.reviewState === 'approved') facts.push({ text: 'Approved', tone: 'success' });
  else if (l.reviewState === 'changes_requested') facts.push({ text: 'Changes requested', tone: 'warning' });
  else if (open && l.awaitingReview) facts.push({ text: 'Waiting for review', tone: 'neutral' });
  if (l.additions != null) facts.push({ text: `+${l.additions} −${l.deletions ?? 0}${l.changedFiles ? ` · ${l.changedFiles} file${l.changedFiles === 1 ? '' : 's'}` : ''}`, tone: 'neutral' });
  if (l.riskScore != null) facts.push({ text: `${riskLabel(l.riskScore)} ${l.riskScore}`, tone: riskTone(l.riskScore), title: (l.riskReasons ?? []).join('\n') || 'Nothing stood out' });
  if (facts.length === 0) return null;
  return (
    <div className="pr-facts">
      <div className="pr-pills">{facts.map((f) => <span key={f.text} className={`pr-pill ${f.tone}`} title={f.title}>{f.text}</span>)}</div>
      {l.riskScore != null && l.riskScore >= 30 && (l.riskReasons ?? []).length > 0 && (
        <ul className="pr-reasons" aria-label="Why this is risky">{(l.riskReasons ?? []).map((r) => <li key={r}>{r}</li>)}</ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Home: the review queue

/** Pull requests waiting on my review (oldest first), and mine waiting on others. Shown only to people who connected GitHub and have something waiting. */
export function ReviewQueueCard({ compact }: { compact?: boolean }) {
  const q = useWsQuery(['review-queue'], integrationsApi.reviewQueue, { staleTime: 60_000, retry: false });
  const d = q.data;
  if (!d?.gitHubLinked || d.items.length === 0) return null;
  const mine = d.items.filter((i) => i.role === 'reviewer'), authored = d.items.filter((i) => i.role === 'author');
  const row = (i: PullReviewItem) => (
    <li key={i.linkId}>
      <a href={safeHref(i.url)} target="_blank" rel="noreferrer noopener" className="rq-main">
        <b>{i.repository}#{i.number}</b><span>{i.title}</span>
      </a>
      <span className="rq-meta">
        {i.taskKey && <span className="rq-key">{i.taskKey}</span>}
        {i.checksState === 'failure' && <span className="pr-pill danger">✗ checks</span>}
        {i.riskScore != null && i.riskScore >= 60 && <span className="pr-pill danger">High risk</span>}
        <span className={`cmd-pill ${i.days >= 2 ? 'warn' : ''}`}>{i.days === 0 ? 'today' : `${i.days}d`}</span>
      </span>
    </li>
  );
  return (
    <div className={`card review-queue ${compact ? '' : 'mb-22'}`} data-testid="review-queue">
      <div className="card-head">
        <div><h3><Icon name="git" size={15} /> Code reviews</h3>
          <p>{d.waitingOnMe > 0 ? `${d.waitingOnMe} waiting on you${d.oldestDays ? `, the oldest ${d.oldestDays} day${d.oldestDays === 1 ? '' : 's'}` : ''}` : 'Nothing waits on your review'}</p></div>
      </div>
      {mine.length > 0 && <ul className="rq-list">{mine.slice(0, compact ? 4 : 8).map(row)}</ul>}
      {authored.length > 0 && (
        <>
          <div className="rq-sub">Yours, waiting on others</div>
          <ul className="rq-list">{authored.slice(0, compact ? 3 : 6).map(row)}</ul>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the project's Code tab

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** A project's delivery metrics (lead time, deploys, change failure, restore) and release notes from its merged pull requests. */
export function ProjectCodeTab({ projectId, canWriteDocs }: { projectId: string; canWriteDocs: boolean }) {
  const nav = useNavigate();
  const gh = useGitHubApp();
  const [days, setDays] = useState(90);
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 14 * 86_400_000)));
  const installed = !!gh.data?.installed;
  const metrics = useWsQuery(['github-delivery', projectId, days], () => integrationsApi.delivery(projectId, days), { enabled: installed, placeholderData: (p) => p });
  const notes = useWsQuery(['release-notes', projectId, from, to], () => integrationsApi.releaseNotes(projectId, from, to), { enabled: installed, placeholderData: (p) => p });
  const [saving, setSaving] = useState(false);

  if (gh.isLoading) return <PageLoader />;
  if (!installed) {
    return <EmptyState icon="git" title="Connect GitHub to see delivery here" text="Once an owner or admin installs the GitHub App (Settings › GitHub & Azure DevOps), merged pull requests become release notes and deployments become delivery metrics."
      action={<Link className="btn btn-primary" to="/settings/git">Open GitHub settings</Link>} />;
  }
  const savePage = async () => {
    setSaving(true);
    try { const r = await integrationsApi.releaseNotesPage(projectId, from, to); toast('Release notes saved as a draft page.'); nav(`/documents/${r.documentId}`); }
    catch (e) { toast(errText(e, 'Could not save the page.'), 'error'); } finally { setSaving(false); }
  };
  const copyNotes = () => { if (notes.data) void navigator.clipboard?.writeText(notes.data.markdown).then(() => toast('Release notes copied.'), () => toast('Copy did not work here.', 'error')); };

  return (
    <div className="code-tab" data-testid="code-tab">
      <div className="card mb-22">
        <div className="card-head">
          <div><h3>Delivery</h3><p>From this project’s pull requests and the deployments GitHub reports. The same four measures teams use to see how fast and how safely they ship.</p></div>
          <div className="gh-period">
            <Select className="select" value={String(days)} aria-label="Period" onChange={(e) => setDays(Number(e.target.value))}>
              <option value="28">Last 4 weeks</option><option value="90">Last 90 days</option><option value="180">Last 6 months</option>
            </Select>
          </div>
        </div>
        <div className="card-body">
          {metrics.isLoading ? <PageLoader /> : metrics.isError || !metrics.data ? <ErrorState error={metrics.error} retry={() => void metrics.refetch()} /> : <DeliveryView m={metrics.data} />}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div><h3>Release notes</h3><p>What shipped, task by task, from merged pull requests. Check it, then copy it or save it as a page to publish.</p></div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <label className="rn-date">From <input className="input" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
            <label className="rn-date">To <input className="input" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
          </div>
        </div>
        <div className="card-body">
          {notes.isLoading ? <PageLoader /> : notes.isError || !notes.data ? <ErrorState error={notes.error} retry={() => void notes.refetch()} /> : notes.data.tasks.length === 0 ? (
            <EmptyState icon="note" title="Nothing merged in this period" text="Pull requests that mention a task key and get merged show up here." />
          ) : (
            <>
              <ul className="rn-list">
                {notes.data.tasks.map((t) => (
                  <li key={t.key}>
                    <div><b>{t.key}</b> {t.title}</div>
                    <ul>{t.pullRequests.map((p) => <li key={`${p.repository}#${p.number}`}><a href={safeHref(p.url)} target="_blank" rel="noreferrer noopener">{p.repository}#{p.number}</a> {p.title}{p.author ? ` · ${p.author}` : ''} · {formatDate(p.mergedAt)}</li>)}</ul>
                  </li>
                ))}
              </ul>
              <div className="row" style={{ gap: 8, marginTop: 12 }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={copyNotes}><Icon name="copy" size={13} /> Copy as Markdown</button>
                {canWriteDocs && <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={() => void savePage()}><Icon name="note" size={13} /> Save as a page</button>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DeliveryView({ m }: { m: DeliveryMetrics }) {
  const maxDeploys = Math.max(1, ...m.weeks.map((w) => w.deploys + w.failed), ...m.weeks.map((w) => w.merged));
  return (
    <>
      <div className="dora" aria-label="Delivery measures">
        <div className="dora-tile"><span>Lead time</span><b>{hours(m.leadTimeHours)}</b><small>{m.leadTimeBasis}, median</small></div>
        <div className="dora-tile"><span>Deploys a week</span><b>{m.deploysPerWeek}</b><small>to production</small></div>
        <div className="dora-tile"><span>Change failure</span><b>{m.changeFailureRate == null ? '—' : `${Math.round(m.changeFailureRate * 1000) / 10}%`}</b><small>of production deploys</small></div>
        <div className="dora-tile"><span>Time to restore</span><b>{hours(m.restoreHours)}</b><small>after a failed deploy, median</small></div>
      </div>
      {m.weeks.length > 0 && (
        <div className="dora-weeks" role="img" aria-label="Merged pull requests and deploys by week">
          {m.weeks.map((w) => (
            <div key={w.weekStart} className="dora-week" title={`Week of ${formatDate(w.weekStart)}: ${w.merged} merged, ${w.deploys} deployed${w.failed ? `, ${w.failed} failed` : ''}${w.leadTimeHours != null ? `, lead time ${hours(w.leadTimeHours)}` : ''}`}>
              <i className="m" style={{ height: `${(w.merged / maxDeploys) * 100}%` }} />
              <i className="d" style={{ height: `${(w.deploys / maxDeploys) * 100}%` }} />
              {w.failed > 0 && <i className="f" style={{ height: `${(w.failed / maxDeploys) * 100}%` }} />}
            </div>
          ))}
        </div>
      )}
      <div className="dora-legend"><span><i className="m" /> merged</span><span><i className="d" /> deployed</span><span><i className="f" /> failed deploy</span></div>
      {m.notes.map((n) => <p key={n} className="sso-note">{n}</p>)}
      {m.repositories.length > 0 && <p className="muted" style={{ fontSize: 12 }}>Repositories: {m.repositories.join(', ')}</p>}
    </>
  );
}
