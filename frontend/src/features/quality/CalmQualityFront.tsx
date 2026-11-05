import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { qualityApi, releaseApi } from '../../api/qualityApi';
import { workItemsApi, type WorkRow } from '../../api/workItemsApi';
import { CalmAvatar, CalmChip, CalmGo, CalmHero, CalmLink, CalmMeter, CalmOrb, CalmPills, CalmRailCard, CalmRailRow, CalmSplit, CalmDot } from '../../components/calm';
import { openNew } from '../../components/v2/state';
import { useWsQuery } from '../../lib/hooks';
import { projectColor } from '../../lib/calm';
import { useAuth } from '../../stores/auth';
import './calm-quality.css';

type View = 'open' | 'mine' | 'release' | 'closed';
const P: Record<string, string> = { Critical: 'P1', High: 'P2', Medium: 'P3', Low: 'P4' };
const tone = (r: WorkRow): 'on' | 'dn' | undefined => (r.category === 'Done' ? 'dn' : r.category === 'Active' ? 'on' : undefined);

/**
 * Quality (shot 60): "N open P1 bugs." with the first one named, the Open / Mine / Release / Closed bug list, and on the right the
 * release readiness, the latest test runs and one Aura line. The test-case matrix, cases and releases stay one "›" away (?tab=runs …).
 */
export function CalmQualityFront({ onTab }: { onTab: (t: 'runs' | 'cases' | 'releases') => void }) {
  const nav = useNavigate();
  const me = useAuth((s) => s.ctx?.user.id ?? null);
  const [view, setView] = useState<View>('open');
  const open = useWsQuery(['quality', 'bugs', 'open'], () => workItemsApi.list({ kind: ['issue'], status: 'open', limit: 200 }), { refetchInterval: 300_000 });
  const closed = useWsQuery(['quality', 'bugs', 'closed'], () => workItemsApi.list({ kind: ['issue'], status: 'closed', limit: 50 }), { enabled: view === 'closed' });
  const releases = useWsQuery(['quality', 'releases'], () => releaseApi.list(), { staleTime: 60_000 });
  const release = (releases.data ?? []).filter((r) => r.status !== 'Shipped').sort((a, b) => (a.targetDate ?? '9').localeCompare(b.targetDate ?? '9'))[0] ?? null;
  const state = useWsQuery(['quality', 'release', release?.id ?? 'none'], () => releaseApi.get(release!.id), { enabled: !!release });
  const matrix = useWsQuery(['quality', 'matrix'], () => qualityApi.matrix(undefined, 4), { staleTime: 30_000 });
  const coverage = useWsQuery(['quality', 'coverage'], () => qualityApi.coverage(), { staleTime: 5 * 60_000, retry: false });

  const rank = (r: WorkRow) => ['Critical', 'High', 'Medium', 'Low'].indexOf(r.priority);
  const all = useMemo(() => [...(open.data?.items ?? [])].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt)), [open.data]);
  const mine = all.filter((r) => r.assignee?.id === me);
  const relKeys = new Set((state.data?.items ?? []).filter((i) => i.bug && i.category !== 'Done').map((i) => i.key));
  const inRelease = all.filter((r) => relKeys.has(r.key));
  const rows = view === 'open' ? all : view === 'mine' ? mine : view === 'release' ? inRelease : (closed.data?.items ?? []);
  const p1 = all.filter((r) => r.priority === 'Critical');
  const first = p1[0] ?? all[0] ?? null;

  const tests = state.data?.tests ?? null;
  const covPct = (() => { const ps = (coverage.data?.projects ?? []).filter((p) => p.percent != null); return ps.length ? Math.round(ps.reduce((a, p) => a + (p.percent ?? 0), 0) / ps.length) : null; })();
  const runs = [...(matrix.data?.runs ?? [])].reverse().slice(0, 3);
  const resOf = (id: string) => (matrix.data?.results ?? []).filter((r) => r.runId === id);
  const blocker = release && p1.find((r) => relKeys.has(r.key));

  const pills = [
    { value: 'open' as const, label: 'Open', count: all.length },
    { value: 'mine' as const, label: 'Mine', count: mine.length },
    ...(release ? [{ value: 'release' as const, label: `Release ${release.name.replace(/^release\s*/i, '')}`, count: inRelease.length }] : []),
    { value: 'closed' as const, label: 'Closed' },
  ];

  return (
    <div className="cq-page">
      <div className="cq-top"><span className="calm-page-crumb">Quality</span><span className="cq-acts"><CalmLink onClick={() => onTab('runs')}>Test runs ›</CalmLink><CalmGo onClick={() => openNew('bug')}>+ Report bug</CalmGo></span></div>
      <CalmSplit rail={<>
        {release && (
          <CalmRailCard title={`${release.name} readiness`}>
            <CalmMeter label="Tests passing" value={tests?.passPercent ?? 0} right={tests ? `${tests.passPercent}%` : '—'} color="var(--calm-p2)" />
            <CalmMeter label="P1 open" value={p1.filter((r) => relKeys.has(r.key)).length} max={Math.max(1, p1.length)} right={p1.filter((r) => relKeys.has(r.key)).length} color="var(--calm-p5)" />
            {covPct != null && <CalmMeter label="Coverage" value={covPct} right={`${covPct}%`} color="var(--calm-p1)" />}
          </CalmRailCard>
        )}
        {runs.length > 0 && (
          <CalmRailCard title="Test runs" aside={<CalmLink onClick={() => onTab('runs')}>All ›</CalmLink>}>
            {runs.map((r) => {
              const rs = resOf(r.id), pass = rs.filter((x) => x.status === 'Pass').length, fail = rs.filter((x) => x.status === 'Fail').length;
              return <CalmRailRow key={r.id} onClick={() => onTab('runs')} title={[r.name, r.environment].filter(Boolean).join(' · ')}
                sub={rs.length ? `${pass} passed${fail ? ` · ${fail} failed` : ''}` : r.status} right={fail ? `${fail} ✕` : rs.length ? '✓' : '—'} />;
            })}
          </CalmRailCard>
        )}
        {blocker && <CalmRailCard tone="tip"><CalmOrb /><div>{blocker.key} blocks {release!.name}. <button type="button" onClick={() => nav(`/work?item=${encodeURIComponent(blocker.id)}`)}>Open {blocker.key}</button></div></CalmRailCard>}
      </>}>
        <CalmHero title={p1.length ? `${p1.length} open P1 ${p1.length === 1 ? 'bug' : 'bugs'}.` : all.length ? `${all.length} open ${all.length === 1 ? 'bug' : 'bugs'}.` : 'No open bugs.'}
          second={first ? `${first.title} first.` : 'Everything filed is closed.'} />
        <div className="calm-bar-row">
          <CalmPills label="Bugs" value={view} onChange={setView} options={pills} />
          <span className="calm-sp" />
          <CalmLink onClick={() => onTab('cases')}>Cases ›</CalmLink>
          <CalmLink onClick={() => onTab('releases')}>Releases ›</CalmLink>
        </div>
        <div className="calm-card calm-list cq-list" role="list" aria-label="Bugs">
          {open.isLoading && <p className="cq-empty">Loading…</p>}
          {!open.isLoading && rows.length === 0 && <p className="cq-empty">{view === 'mine' ? 'Nothing assigned to you.' : view === 'closed' ? 'Nothing closed yet.' : 'No open bugs.'}</p>}
          {rows.map((r) => (
            <button key={r.id} type="button" role="listitem" className="calm-apr" onClick={() => nav(`/work?item=${encodeURIComponent(r.id)}`)}>
              <span className="k">{r.key}</span>
              <span className="t"><b>{r.title}</b>{r.projectName && <small><CalmDot color={projectColor(r.projectId)} />{r.projectName}</small>}</span>
              <span className={`rk${r.priority === 'Critical' ? ' hi' : ''}`}>{P[r.priority] ?? r.priority}</span>
              <span><CalmChip tone={tone(r)}>{r.status}</CalmChip></span>
              <span className="po">{r.assignee ? <><CalmAvatar userId={r.assignee.id} name={r.assignee.name} />{r.assignee.name.split(' ')[0]}</> : 'Unassigned'}</span>
              <span className="chev" aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      </CalmSplit>
    </div>
  );
}
