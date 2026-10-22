import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { documentApi } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';
import type { DtCatalog, DtDocument, DtEndpoint, DtProject } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { Method } from '../documents/ApiView';
import { avatarColor } from '../documents/docUi';
import { NeedsAttention } from '../documents/NeedsAttention';
import { pid, scoreTone, useDtNav } from './DocTrackerPage';

export const avg = (eps: DtEndpoint[]) => (eps.length ? Math.round(eps.reduce((a, e) => a + e.score, 0) / eps.length) : 0);

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

/**
 * DocTracker's front page, built around what people come here to do: find a document, start one from a template, see what needs them and
 * pick up recent work. How well the APIs are documented is one compact card further down (the full scores live on each project).
 */
export function DtHome({ catalog, onRequired, onNew }: { catalog: DtCatalog; onRequired: () => void; onNew: (typeId?: string) => void }) {
  const nav = useDtNav();
  const [q, setQ] = useState('');
  const types = useWsQuery(['document-types'], documentApi.types, { staleTime: 300_000 });
  const projects = catalog.projects;
  const eps = projects.flatMap((p) => p.endpoints.map((e) => ({ p, e })));
  const apis = projects.reduce((a, p) => a + p.definitions.length, 0);
  const score = avg(eps.map((x) => x.e));
  const weak = eps.filter((x) => x.e.score < 70).sort((a, b) => a.e.score - b.e.score);
  const gaps = new Map<string, number>();
  for (const { e } of eps) for (const g of e.gaps) gaps.set(g, (gaps.get(g) ?? 0) + 1);
  const topGaps = [...gaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const docs = projects.flatMap((p) => p.documents.map((d) => ({ p, d })));
  const recent = [...docs].sort((a, b) => b.d.updatedAt.localeCompare(a.d.updatedAt)).slice(0, 8);
  const dq = q.trim().toLowerCase();
  const hits = dq.length < 2 ? null : {
    docs: docs.filter(({ d }) => `${d.key} ${d.title} ${d.typeName}`.toLowerCase().includes(dq)).slice(0, 8),
    eps: eps.filter(({ e }) => `${e.method} ${e.path} ${e.summary} ${e.tag ?? ''}`.toLowerCase().includes(dq)).slice(0, 8),
    projects: projects.filter((p) => `${p.name} ${p.key ?? ''}`.toLowerCase().includes(dq)).slice(0, 4),
  };
  // What needs attention, from the same numbers the list uses; when there is nothing, one line instead of an empty card.
  const dash = useWsQuery(['documents', 'dashboard'], documentApi.dashboard);
  const attention = dash.data ? (dash.data.projectsMissingRequired ?? 0) + dash.data.notUpdatedIn90Days + dash.data.unpublished : 0;
  const starters = (types.data ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder).slice(0, 6);

  return (
    <div className="dt-home dl">
      <label className="dl-search">
        <Icon name="search" size={18} />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search documents, APIs and endpoints" aria-label="Search DocTracker" />
      </label>

      {hits ? (
        <section className="dl-section" aria-label="Search results">
          {hits.docs.length + hits.eps.length + hits.projects.length === 0 && <p className="dl-empty">Nothing matches “{q.trim()}”.</p>}
          {hits.docs.length > 0 && <><h3>Documents</h3><ul className="dl-rows">{hits.docs.map(({ p, d }) => <DocRow key={d.id} p={p} d={d} />)}</ul></>}
          {hits.eps.length > 0 && <><h3>Endpoints</h3><ul className="dl-rows">{hits.eps.map(({ p, e }) => (
            <li key={e.id}><button type="button" className="dl-row" onClick={() => nav.go({ p: pid(p), ep: e.id })}>
              <Method m={e.method} /><code className="dl-path">{e.path}</code><span className="dl-row-sub">{e.summary || p.name}</span><ScoreBar score={e.score} />
            </button></li>))}</ul></>}
          {hits.projects.length > 0 && <><h3>Projects</h3><ul className="dl-rows">{hits.projects.map((p) => (
            <li key={pid(p)}><button type="button" className="dl-row" onClick={() => nav.go({ p: pid(p) })}><ProjectMark p={p} /><b>{p.name}</b><span className="dl-row-sub">{p.key}</span></button></li>))}</ul></>}
        </section>
      ) : <>
        {catalog.canCreate && starters.length > 0 && (
          <section className="dl-section" aria-label="Start a document">
            <header><h3>Start a document</h3><button type="button" className="mb-link" onClick={() => onNew()}>All templates</button></header>
            <div className="dl-starters">
              {starters.map((t) => (
                <button key={t.id} type="button" className="dl-starter" style={{ '--dc': t.color } as CSSProperties} onClick={() => onNew(t.id)}>
                  <span className="dl-starter-code">{t.code}</span><b>{t.name}</b>{t.description && <small>{t.description}</small>}
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="dl-split">
          <section className="dl-section" aria-label="Recent documents">
            <header><h3>Recent documents</h3></header>
            {recent.length === 0 ? <EmptyState icon="note" title="No documents yet" text={catalog.canCreate ? 'Start one from a template above.' : undefined} /> : (
              <ul className="dl-rows">{recent.map(({ p, d }) => <DocRow key={d.id} p={p} d={d} />)}</ul>
            )}
          </section>
          <section className="dl-section" aria-label="Projects">
            <header><h3>Projects</h3></header>
            <ul className="dl-projects">
              {projects.map((p) => {
                const n = p.documents.filter((d) => !d.isApi).length;
                return (
                  <li key={pid(p)}><button type="button" className="dl-project" onClick={() => nav.go({ p: pid(p) })}>
                    <ProjectMark p={p} />
                    <span className="dl-project-main"><b>{p.name}</b>
                      <small>{[n ? `${n} document${n === 1 ? '' : 's'}` : '', p.endpoints.length ? `${p.endpoints.length} endpoint${p.endpoints.length === 1 ? '' : 's'}` : '', p.diagrams ? `${p.diagrams} diagram${p.diagrams === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || 'Nothing yet'}</small></span>
                    {p.endpoints.length > 0 && <ScoreBar score={avg(p.endpoints)} />}
                  </button></li>
                );
              })}
              {projects.length === 0 && <li className="dl-empty">No projects yet.</li>}
            </ul>
          </section>
        </div>

        {attention > 0 ? (
          <section className="dl-section dt-attn" aria-label="Needs attention">
            <header><h3>Needs attention</h3><span className="muted">Missing required documents, nothing updated in 90 days, never published</span></header>
            <NeedsAttention canCreate={catalog.canCreate} isAdmin={catalog.isAdmin} onRequired={onRequired} />
          </section>
        ) : dash.data && (
          <p className="dl-allclear"><Icon name="checkCircle" size={15} /> Nothing needs attention: no missing, stale or unpublished documents.
            {catalog.isAdmin && dash.data.requiredTypes === 0 && <button type="button" className="mb-link" onClick={onRequired}>Choose documents every project must have</button>}</p>
        )}

        {eps.length > 0 && (
          <section className="dl-section dt-quality" aria-label="API quality">
            <div className="dt-hero">
              <ScoreRing score={score} size={64} label="Average documentation score" />
              <div>
                <h3>API quality</h3>
                <p className="muted">{`${eps.length.toLocaleString()} endpoint${eps.length === 1 ? '' : 's'} across ${apis.toLocaleString()} API${apis === 1 ? '' : 's'} average ${score}/100. ${weak.length ? `${weak.length.toLocaleString()} need work.` : 'Everything is well documented.'}`}</p>
                {topGaps.length > 0 && <div className="dl-gaps">{topGaps.map(([g, n]) => <span key={g}>{g} <b>{n}</b></span>)}</div>}
              </div>
            </div>
            {catalog.truncated > 0 && <div className="doc-alert info"><Icon name="info" size={16} /><div>Showing the first endpoints only; {catalog.truncated.toLocaleString()} more are not scored here.</div></div>}
            {weak.length > 0 && (
              <ul className="dt-weak">{weak.slice(0, 5).map(({ p, e }) => (
                <li key={e.id}><button type="button" onClick={() => nav.go({ p: pid(p), ep: e.id })}>
                  <Method m={e.method} /><code>{e.path}</code><span className="muted dt-weak-proj">{p.name}</span><ScoreBar score={e.score} />
                  <small className="dt-weak-gaps">{e.gaps.slice(0, 3).join(' · ')}</small>
                </button></li>
              ))}</ul>
            )}
          </section>
        )}
      </>}
    </div>
  );
}

function ProjectMark({ p }: { p: DtProject }) {
  return <span className="ds-avatar" style={{ '--av': p.id ? avatarColor(p.id) : 'var(--text-3)' } as CSSProperties}>{(p.key ?? p.name).charAt(0).toUpperCase()}</span>;
}

function DocRow({ p, d }: { p: DtProject; d: DtDocument }) {
  return (
    <li>
      <Link to={`/documents/${d.id}`} className="dl-row">
        <span className="ds-type-code" style={{ '--dc': d.typeColor } as CSSProperties}>{d.typeCode}</span>
        <b className="dl-row-title">{d.title}</b>
        <span className="dl-row-sub">{p.name}</span>
        <time className="dl-row-time" dateTime={d.updatedAt}>{timeAgo(d.updatedAt)}</time>
      </Link>
    </li>
  );
}
