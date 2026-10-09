import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import type { DocVersion, DocumentDetail, SectionDiff, VersionDiff } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, EmptyState, ErrorState, Field, Modal, PageLoader, SubmitButton } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { SectionEditor } from './SectionEditor';

/** Publish the draft as the next version: a sentence on what changed is required, a reason is welcome. */
export function PublishModal({ detail, onClose }: { detail: DocumentDetail; onClose: () => void }) {
  const wid = useWorkspaceId();
  const id = detail.item.id;
  const versions = useWsQuery(['documents', id, 'versions'], () => documentApi.versions(id));
  const [summary, setSummary] = useState('');
  const [reason, setReason] = useState('');
  const [major, setMajor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = !detail.publishedLabel;
  const next = versions.data ? (first ? '1.0' : major ? versions.data.nextLabelMajor : versions.data.nextLabelMinor) : '…';
  const publish = useMutation({
    mutationFn: () => documentApi.publish(id, { changeSummary: summary.trim(), changeReason: reason.trim() || undefined, major, revision: detail.revision }),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); toast(`Version ${next} published.`); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not publish.'),
  });
  return (
    <Modal title={`Publish version ${next}`} subtitle="Publishing freezes this text as a version people can read, compare and go back to." size="sm" onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (!summary.trim()) { setError('Say in a sentence what changed.'); return; } setError(null); publish.mutate(); }}
      footer={<><button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button><SubmitButton busy={publish.isPending}>Publish {next}</SubmitButton></>}>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
      <Field label="What changed?" required hint="Shown in the history, next to this version."><textarea className="textarea" value={summary} maxLength={500} rows={2} autoFocus onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Scope now includes tax forms" /></Field>
      <Field label="Why?" hint="Optional: the reason behind the change."><textarea className="textarea" value={reason} maxLength={500} rows={2} onChange={(e) => setReason(e.target.value)} /></Field>
      {!first && (
        <label className="check-row"><input type="checkbox" checked={major} onChange={(e) => setMajor(e.target.checked)} /> <span><b>A major change</b> <small>({versions.data?.nextLabelMajor} instead of {versions.data?.nextLabelMinor}): the meaning changed, not just the details.</small></span></label>
      )}
    </Modal>
  );
}

const OP_CLASS: Record<string, string> = { add: 'df-add', del: 'df-del', eq: 'df-eq', chg: 'df-chg' };

function Words({ line }: { line: NonNullable<SectionDiff['lines']>[number] }) {
  if (!line.words) return <>{line.text}</>;
  return <>{line.words.map((w, i) => <span key={i} className={w.op === 'eq' ? undefined : `dw-${w.op}`}>{w.text}{' '}</span>)}</>;
}

function DiffSection({ s, showSame }: { s: SectionDiff; showSame: boolean }) {
  if (s.change === 'Unchanged' && !showSame) return null;
  const lines = s.lines ?? [];
  // Long runs of unchanged text are folded to a couple of lines of context around each change.
  const shown = lines.map((l, i) => l.op !== 'eq' || lines.slice(Math.max(0, i - 2), i + 3).some((x) => x.op !== 'eq'));
  return (
    <section className="df-section">
      <h4>{s.title} <span className={`df-chip ${s.change.toLowerCase()}`}>{s.change === 'Changed' && s.formattingOnly ? 'Formatting only' : s.change}</span></h4>
      {s.change === 'Unchanged' && <p className="muted">Same in both versions.</p>}
      {s.kind === 'RichText' && lines.length > 0 && (
        <div className="df-lines">
          {lines.map((l, i) => shown[i]
            ? <div key={i} className={`df-line ${OP_CLASS[l.op]} st-${l.style}`}><i aria-hidden="true">{l.op === 'add' ? '+' : l.op === 'del' ? '−' : ''}</i><span><Words line={l} /></span></div>
            : (i === 0 || shown[i - 1] ? <div key={i} className="df-fold">…</div> : null))}
        </div>
      )}
      {s.kind === 'Table' && s.rows && s.columns && (
        <div className="te-scroll"><table className="te-table df-table">
          <thead><tr><th aria-label="Change" />{s.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{s.rows.map((r, i) => (
            <tr key={i} className={OP_CLASS[r.op]}><td className="df-mark">{r.op === 'add' ? '+' : r.op === 'del' ? '−' : r.op === 'chg' ? '≠' : ''}</td>
              {r.cells.map((c, j) => <td key={j}><span className={r.changedCells?.includes(j) ? 'dw-add' : undefined}>{c}</span></td>)}</tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

export function CompareView({ documentId, from, to }: { documentId: string; from: string; to: string }) {
  const q = useWsQuery(['documents', documentId, 'compare', from, to], () => documentApi.compare(documentId, from, to));
  const [showSame, setShowSame] = useState(false);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d: VersionDiff = q.data;
  const nothing = d.changed + d.added + d.removed === 0;
  return (
    <div className="df">
      <div className="df-head">
        <b>{d.from.label}</b> <Icon name="arrowRight" size={14} /> <b>{d.to.label}</b>
        <span className="muted">{nothing ? 'No differences' : `${d.changed} changed · ${d.added} added · ${d.removed} removed · ${d.unchanged} unchanged`}</span>
        {d.unchanged > 0 && <label className="check-row small"><input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} /> Show unchanged sections</label>}
      </div>
      {nothing && <EmptyState icon="checkCircle" title="These two versions are the same" />}
      {d.sections.map((s) => <DiffSection key={s.key} s={s} showSame={showSame} />)}
    </div>
  );
}

function VersionRow({ v, canRestore, onView, onCompare, onRestore }: { v: DocVersion; canRestore: boolean; onView: () => void; onCompare: () => void; onRestore: () => void }) {
  return (
    <li className={`ver${v.isCurrent ? ' current' : ''}${v.isDraft ? ' draft' : ''}`}>
      <div className="ver-main">
        <div className="ver-label"><b>{v.label}</b>{v.isCurrent && <span className="badge badge-success">Current</span>}{v.isDraft && v.hasChanges && <span className="badge badge-warning">Unpublished changes</span>}{v.restoredFrom && <span className="badge badge-neutral">Restored from {v.restoredFrom}</span>}</div>
        {v.changeSummary && <p className="ver-sum">{v.changeSummary}</p>}
        {v.changeReason && <p className="ver-why">Why: {v.changeReason}</p>}
        {v.publishedBy && <div className="ver-by"><Avatar name={v.publishedBy.name} userId={v.publishedBy.id} /> {v.publishedBy.name} · <span title={formatDateTime(v.publishedAt)}>{timeAgo(v.publishedAt)}</span></div>}
      </div>
      <div className="ver-actions">
        <button className="btn btn-ghost btn-sm" onClick={onView}>View</button>
        <button className="btn btn-ghost btn-sm" onClick={onCompare}>Compare with current</button>
        {canRestore && !v.isDraft && !v.isCurrent && <button className="btn btn-ghost btn-sm" onClick={onRestore}>Restore</button>}
      </div>
    </li>
  );
}

type Mode = { kind: 'list' } | { kind: 'view'; id: string } | { kind: 'compare'; from: string; to: string };

/** The versions of a document: read one, compare two, restore an old one (which publishes it again as the newest). */
export function HistoryModal({ detail, onClose }: { detail: DocumentDetail; onClose: () => void }) {
  const wid = useWorkspaceId();
  const id = detail.item.id;
  const q = useWsQuery(['documents', id, 'versions'], () => documentApi.versions(id));
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [a, setA] = useState(''); const [b, setB] = useState('');
  const items = q.data?.items ?? [];
  const published = items.find((v) => v.isCurrent);
  const newest = items[0];   // the draft for people who may edit, otherwise the newest published version
  const against = (v: DocVersion): Mode => (v.id === newest?.id ? { kind: 'compare', from: published?.id ?? v.id, to: v.id } : { kind: 'compare', from: v.id, to: newest?.id ?? v.id });
  const view = useWsQuery(['documents', id, 'version', mode.kind === 'view' ? mode.id : ''], () => documentApi.version(id, (mode as { id: string }).id), { enabled: mode.kind === 'view' });

  const restore = useMutation({
    mutationFn: (v: { id: string; discard: boolean; reason?: string }) => documentApi.restoreVersion(id, v.id, { discardChanges: v.discard, reason: v.reason, revision: detail.revision }),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); queryClient.removeQueries({ queryKey: [wid, 'documents', id] }); toast('Restored as a new version.'); onClose(); },
  });
  const doRestore = async (v: DocVersion) => {
    const unpublished = !!q.data?.hasUnpublishedChanges;
    if (!(await confirmDialog({ title: `Restore version ${v.label}?`, message: `This publishes a new version with the text of ${v.label}; every version stays in the history.${unpublished ? ' The unpublished changes in the draft will be replaced.' : ''}`, confirmText: 'Restore', danger: false }))) return;
    try { await restore.mutateAsync({ id: v.id, discard: true }); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not restore.', 'error'); }
  };

  const title = mode.kind === 'list' ? 'Version history' : mode.kind === 'view' ? `Version ${view.data?.version.label ?? ''}` : 'Compare versions';
  return (
    <Modal title={title} subtitle={`${detail.item.key} · ${detail.item.title}`} size="xl" onClose={onClose}
      footer={mode.kind === 'list' ? <button className="btn btn-ghost" onClick={onClose}>Close</button> : <button className="btn btn-ghost" onClick={() => setMode({ kind: 'list' })}><Icon name="arrowLeft" size={15} /> Back to history</button>}>
      {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : mode.kind === 'list' ? (
        <>
          {items.length <= 1 && !q.data?.publishedLabel && <p className="muted">Nothing has been published yet. Publish a version to start the history.</p>}
          <ul className="ver-list">
            {items.map((v) => (
              <VersionRow key={v.id} v={v} canRestore={detail.can.edit} onView={() => setMode({ kind: 'view', id: v.id })} onRestore={() => doRestore(v)}
                onCompare={() => setMode(against(v))} />
            ))}
          </ul>
          {items.length >= 2 && (
            <div className="ver-pick">
              <b>Compare any two</b>
              <Select className="select" value={a} onChange={(e) => setA(e.target.value)} aria-label="Older"><option value="">Choose…</option>{items.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</Select>
              <Icon name="arrowRight" size={14} />
              <Select className="select" value={b} onChange={(e) => setB(e.target.value)} aria-label="Newer"><option value="">Choose…</option>{items.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</Select>
              <button className="btn btn-primary btn-sm" disabled={!a || !b || a === b} onClick={() => setMode({ kind: 'compare', from: a, to: b })}>Compare</button>
            </div>
          )}
        </>
      ) : mode.kind === 'compare' ? <CompareView documentId={id} from={mode.from} to={mode.to} /> : (
        view.isLoading ? <PageLoader /> : view.isError || !view.data ? <ErrorState error={view.error} /> : (
          <div className="ver-view">
            {view.data.version.changeSummary && <p className="ver-sum"><b>{view.data.version.changeSummary}</b>{view.data.version.changeReason ? ` — ${view.data.version.changeReason}` : ''}</p>}
            {view.data.sections.map((s) => <SectionEditor key={s.key} section={s} value={s.content} readOnly />)}
          </div>
        )
      )}
    </Modal>
  );
}
