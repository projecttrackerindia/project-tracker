import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { qualityApi, type CaseDraft, type CasePriority, type EndpointTests as Tests } from '../../api/qualityApi';
import { Icon } from '../../components/Icon';
import { Term } from '../../components/Term';
import { Modal } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useModule, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import './endpointTests.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const PRIORITIES: CasePriority[] = ['Low', 'Medium', 'High', 'Critical'];
const KIND_LABEL: Record<CaseDraft['kind'], string> = { happy: 'Happy path', required: 'Required field', auth: 'Authentication', forbidden: 'Authorisation', timeout: 'Downstream timeout', idempotency: 'Idempotency', masking: 'Masked logs' };

/** The endpoint's Tests (GET /quality/endpoints/{id}/tests); only for people with the Work module (Quality lives there). */
export function useEndpointTests(endpointId: string) {
  const work = useModule('work');
  return useWsQuery(['quality', 'endpoint', endpointId], () => qualityApi.endpointTests(endpointId), { enabled: work > 0, retry: false, staleTime: 30_000 });
}

/**
 * "Tests" on an API endpoint's page: the cases that verify it (with their latest result per environment), the latest run per environment with
 * pass/fail and when, whether it is covered (a linked case passed within 30 days), "Add test case" prefilled from the endpoint, and
 * "✦ Generate test cases": Aura's proposals as cards to confirm one by one. Every confirmed case is linked to the endpoint.
 */
export function EndpointTests({ endpointId, projectId }: { endpointId: string; projectId: string | null }) {
  const wid = useWorkspaceId();
  const q = useEndpointTests(endpointId);
  const [adding, setAdding] = useState<CaseDraft | null>(null);
  const [asked, setAsked] = useState(false);
  const proposals = useWsQuery(['quality', 'endpoint', endpointId, 'suggestions'], () => qualityApi.suggestions(endpointId), { enabled: asked, retry: false });
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const t = q.data;
  if (!t?.draft) return null;   // no Work module, not readable, or an older server: the page simply has no Tests section

  const create = async (d: CaseDraft) => {
    setBusy(d.kind);
    try {
      await qualityApi.createCase({ title: d.title, steps: d.steps, expected: d.expected, priority: d.priority, tags: d.tags, projectId: t.projectId ?? projectId,
        links: [{ kind: 'endpoint', id: endpointId, documentId: t.documentId }] });
      toast('Test case added and linked to this endpoint.');
      setDismissed((s) => new Set(s).add(d.kind));
      void invalidateWorkspace(wid, 'quality');
      return true;
    } catch (e) { toast(errText(e, 'Could not add the test case.'), 'error'); return false; }
    finally { setBusy(null); }
  };
  const cards = (proposals.data ?? []).filter((p) => !dismissed.has(p.kind));

  return (
    <section className="dx-reveal et" data-outline="Tests" data-testid="endpoint-tests">
      <div className="dx-sect-h">
        <h2 className="dx-h2">Tests</h2>
        <span className={`et-cov ${t.covered ? 'ok' : 'no'}`} data-testid="endpoint-coverage">
          <Icon name={t.covered ? 'checkCircle' : 'alert'} size={13} />
          {t.covered ? <>Covered · passed {t.lastPassAt ? timeAgo(t.lastPassAt) : ''}</> : t.cases.length ? <>Not <Term k="coverage">covered</Term> · no pass in {t.days} days</> : <>Not <Term k="coverage">covered</Term> · no test cases</>}
        </span>
      </div>

      {t.environments.length > 0 && (
        <ul className="et-envs" aria-label="Latest run per environment">
          {t.environments.map((e) => (
            <li key={e.environment} className={`et-env s-${e.status.toLowerCase()}`} title={`${e.runName}${e.at ? ` · ${new Date(e.at).toLocaleString()}` : ''}`}>
              <b>{e.environment}</b><span>{e.status === 'Pass' ? 'Pass' : e.status === 'Fail' ? 'Fail' : 'Blocked'} · {e.passed}/{e.passed + e.failed + e.blocked}</span><small>{e.at ? timeAgo(e.at) : e.runName}</small>
            </li>
          ))}
        </ul>
      )}

      {t.cases.length > 0 ? (
        <ul className="et-cases">
          {t.cases.map(({ case: c, latest }) => (
            <li key={c.id} className="et-case">
              <Link to={`/quality?case=${c.id}`} className="et-key">{c.key}</Link>
              <span className="et-title" title={c.title}>{c.title}</span>
              <span className="et-latest">{latest.length === 0 ? <em className="et-pill none">Not run</em> : latest.map((r) => <em key={r.environment} className={`et-pill s-${r.status.toLowerCase()}`} title={`${r.runName}${r.at ? ` · ${timeAgo(r.at)}` : ''}`}>{r.environment} {r.status === 'Pass' ? '✓' : r.status === 'Fail' ? '✕' : '–'}</em>)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="dx-note">No test case verifies this endpoint yet.</p>}

      {t.canEdit && (
        <div className="dx-row et-actions">
          <button type="button" className="dx-btn" onClick={() => setAdding(t.draft)} data-testid="add-test-case"><Icon name="plus" size={13} /> Add test case</button>
          <button type="button" className="dx-btn et-ai" onClick={() => { setAsked(true); void proposals.refetch(); }} disabled={proposals.isFetching} data-testid="generate-test-cases">
            <span aria-hidden="true">✦</span> {proposals.isFetching ? 'Thinking…' : 'Generate test cases'}
          </button>
        </div>
      )}

      {asked && proposals.data && (
        <div className="et-proposals" aria-label="Proposed test cases">
          <p className="et-groot"><span className="et-orb" aria-hidden="true" /> Aura proposes {cards.length} case{cards.length === 1 ? '' : 's'} from this endpoint&apos;s description. Nothing is added until you confirm.</p>
          <ul>
            {cards.map((d) => (
              <li key={d.kind} className="et-card" data-testid="proposal">
                <span className="et-kind">{KIND_LABEL[d.kind]}</span>
                <b>{d.title}</b>
                <small>Expect: {d.expected}</small>
                <small className="et-why">{d.why}</small>
                <div className="et-card-acts">
                  <button type="button" className="dx-btn sm" onClick={() => setDismissed((s) => new Set(s).add(d.kind))}>Dismiss</button>
                  <button type="button" className="dx-btn sm" onClick={() => setAdding(d)}>Edit…</button>
                  <button type="button" className="dx-btn sm pri" disabled={busy === d.kind} onClick={() => void create(d)}>Add</button>
                </div>
              </li>
            ))}
            {cards.length === 0 && <li className="dx-note">All proposals handled.</li>}
          </ul>
        </div>
      )}

      {adding && <CaseSheet draft={adding} tests={t} onClose={() => setAdding(null)} onSave={async (d) => { if (await create(d)) setAdding(null); }} busy={!!busy} />}
    </section>
  );
}

function CaseSheet({ draft, tests, onClose, onSave, busy }: { draft: CaseDraft; tests: Tests; onClose: () => void; onSave: (d: CaseDraft) => Promise<void>; busy: boolean }) {
  const [d, setD] = useState(draft);
  return (
    <Modal title="Add test case" subtitle={`Linked to ${tests.method} ${tests.path}`} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void onSave(d); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || !d.title.trim()}>Add test case</button></>}>
      <div className="et-form">
        <label className="field-label" htmlFor="et-title">Title</label>
        <input id="et-title" className="input" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
        <label className="field-label" htmlFor="et-steps">Steps · one per line</label>
        <textarea id="et-steps" className="input" rows={4} value={d.steps} onChange={(e) => setD({ ...d, steps: e.target.value })} />
        <label className="field-label" htmlFor="et-exp">Expected</label>
        <input id="et-exp" className="input" value={d.expected} onChange={(e) => setD({ ...d, expected: e.target.value })} />
        <label className="field-label" htmlFor="et-pri">Priority</label>
        <select id="et-pri" className="select" value={d.priority} onChange={(e) => setD({ ...d, priority: e.target.value as CasePriority })}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
      </div>
    </Modal>
  );
}
