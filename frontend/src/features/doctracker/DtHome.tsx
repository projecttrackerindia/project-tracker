import { type CSSProperties } from 'react';
import type { DtCatalog, DtEndpoint, DtProject } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { Method } from '../documents/ApiView';
import { avatarColor } from '../documents/docUi';
import { NeedsAttention } from '../documents/NeedsAttention';
import { pid, scoreTone, useDtNav } from './DocTrackerPage';

export const avg = (eps: DtEndpoint[]) => (eps.length ? Math.round(eps.reduce((a, e) => a + e.score, 0) / eps.length) : 0);
const lastUpdate = (p: DtProject) => [...p.endpoints.map((e) => e.updatedAt), ...p.documents.map((d) => d.updatedAt)].filter(Boolean).sort().pop() ?? null;

/** A ring showing a 0-100 score. */
export function ScoreRing({ score, size = 54, label }: { score: number; size?: number; label?: string }) {
  const r = (size - 8) / 2, c = 2 * Math.PI * r;
  return (
    <span className={`dt-ring ${scoreTone(score)}`} style={{ width: size, height: size } as CSSProperties} role="img" aria-label={`${label ?? 'Score'} ${score} of 100`}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} className="bg" />
        <circle cx={size / 2} cy={size / 2} r={r} className="fg" strokeDasharray={`${(c * score) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <b>{score}</b>
    </span>
  );
}

export function Kpi({ icon, label, value, hint, tone }: { icon: IconName; label: string; value: React.ReactNode; hint?: string; tone?: string }) {
  return (
    <div className={`dt-kpi${tone ? ` ${tone}` : ''}`}>
      <span className="dt-kpi-ic"><Icon name={icon} size={16} /></span>
      <div><span className="dt-kpi-label">{label}</span><b className="dt-kpi-value">{value}</b>{hint && <small>{hint}</small>}</div>
    </div>
  );
}

export const ScoreBar = ({ score }: { score: number }) => <span className={`dt-bar ${scoreTone(score)}`} title={`Documentation score ${score} / 100`}><span className="dt-bar-track"><i style={{ width: `${score}%` }} /></span><b>{score}</b></span>;

/** The DocTracker Control Center: how well every project's APIs are documented, and what to fix first. */
export function DtHome({ catalog, onRequired }: { catalog: DtCatalog; onRequired: () => void }) {
  const nav = useDtNav();
  const projects = catalog.projects;
  const eps = projects.flatMap((p) => p.endpoints.map((e) => ({ p, e })));
  const apis = projects.reduce((a, p) => a + p.definitions.length, 0);
  const docs = projects.reduce((a, p) => a + p.documents.filter((d) => !d.isApi).length, 0);
  const diagrams = projects.reduce((a, p) => a + p.diagrams, 0);
  const score = avg(eps.map((x) => x.e));
  const weak = eps.filter((x) => x.e.score < 70).sort((a, b) => a.e.score - b.e.score);
  const live = eps.filter((x) => x.e.stage === 'Production').length;
  const active = projects.filter((p) => p.endpoints.length || p.documents.length || p.diagrams);
  const gaps = new Map<string, number>();
  for (const { e } of eps) for (const g of e.gaps) gaps.set(g, (gaps.get(g) ?? 0) + 1);
  const topGaps = [...gaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  return (
    <div className="dt-home">
      <section className="dt-hero">
        <ScoreRing score={score} size={92} label="Average documentation score" />
        <div>
          <h2>Control Center</h2>
          <p className="muted">{eps.length ? `${eps.length.toLocaleString()} endpoints across ${apis.toLocaleString()} API${apis === 1 ? '' : 's'} average ${score}/100. ${weak.length ? `${weak.length.toLocaleString()} need work.` : 'Everything is well documented.'}` : 'Describe or import an API in a project to start scoring its documentation.'}</p>
        </div>
      </section>
      <div className="dt-kpis">
        <Kpi icon="folder" label="Projects documented" value={active.length} hint={`of ${projects.length}`} />
        <Kpi icon="layers" label="APIs" value={apis} />
        <Kpi icon="code" label="Endpoints" value={eps.length.toLocaleString()} hint={live ? `${live} in production` : undefined} />
        <Kpi icon="alert" label="Need work" value={weak.length} hint="score under 70" tone={weak.length ? 'warn' : 'good'} />
        <Kpi icon="workflow" label="Diagrams" value={diagrams} />
        <Kpi icon="note" label="Documents" value={docs} />
      </div>
      {catalog.truncated > 0 && <div className="doc-alert info"><Icon name="info" size={16} /><div>Showing the first endpoints only; {catalog.truncated.toLocaleString()} more are not scored here.</div></div>}

      <section className="dt-card">
        <div className="dt-card-head"><h3>Projects</h3><span className="muted">Open one for its APIs, architecture and documents</span></div>
        {projects.length === 0 ? <EmptyState icon="folder" title="No projects yet" /> : (
          <div className="dt-table-wrap"><table className="dt-table">
            <thead><tr><th>Project</th><th>APIs</th><th>Endpoints</th><th className="w-score">Score</th><th>Diagrams</th><th>Documents</th><th>Updated</th></tr></thead>
            <tbody>{projects.map((p) => (
              <tr key={pid(p)} onClick={() => nav.go({ p: pid(p) })} className="clickable">
                <td><span className="dt-proj"><span className="ds-avatar" style={{ '--av': p.id ? avatarColor(p.id) : 'var(--text-3)' } as CSSProperties}>{(p.key ?? p.name).charAt(0).toUpperCase()}</span><b>{p.name}</b>{p.key && <small>{p.key}</small>}</span></td>
                <td>{p.definitions.length || '–'}</td><td>{p.endpoints.length || '–'}</td>
                <td>{p.endpoints.length ? <ScoreBar score={avg(p.endpoints)} /> : <span className="muted">–</span>}</td>
                <td>{p.diagrams || '–'}</td><td>{p.documents.filter((d) => !d.isApi).length || '–'}</td>
                <td className="muted">{lastUpdate(p) ? timeAgo(lastUpdate(p)) : '–'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <div className="dt-split">
        <section className="dt-card">
          <div className="dt-card-head"><h3>Fix these first</h3><span className="muted">Lowest documentation scores</span></div>
          {weak.length === 0 ? <p className="muted dt-pad">Nothing below 70. Nice.</p> : (
            <ul className="dt-weak">{weak.slice(0, 10).map(({ p, e }) => (
              <li key={e.id}><button type="button" onClick={() => nav.go({ p: pid(p), ep: e.id })}>
                <Method m={e.method} /><code>{e.path}</code><span className="muted dt-weak-proj">{p.name}</span><ScoreBar score={e.score} />
                <small className="dt-weak-gaps">{e.gaps.slice(0, 3).join(' · ')}</small>
              </button></li>
            ))}</ul>
          )}
        </section>
        <section className="dt-card">
          <div className="dt-card-head"><h3>Most common gaps</h3></div>
          {topGaps.length === 0 ? <p className="muted dt-pad">No gaps found.</p> : (
            <ul className="dt-gaps">{topGaps.map(([g, n]) => <li key={g}><span>{g}</span><b>{n}</b><i style={{ width: `${Math.round((n / eps.length) * 100)}%` }} /></li>)}</ul>
          )}
          <p className="muted dt-pad dt-score-help">Score: summary 15 · description 15 · authentication 15 · described parameters 15 · request example 15 · success example 15 · error cases 10.</p>
        </section>
      </div>
      <section className="dt-card dt-attn">
        <div className="dt-card-head"><h3>Documents that need attention</h3><span className="muted">Missing required documents, unpublished changes, nothing updated in 90 days</span></div>
        <div className="dt-pad"><NeedsAttention canCreate={catalog.canCreate} isAdmin={catalog.isAdmin} onRequired={onRequired} /></div>
      </section>
    </div>
  );
}
