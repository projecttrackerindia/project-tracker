import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import type { ArtifactCompare, ArtifactVersion, DocumentDetail } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, EmptyState, ErrorState, Modal, PageLoader } from '../../components/ui';
import { formatBytes, formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';

const CHANGE_CLASS: Record<string, string> = { Added: 'df-add', Removed: 'df-del', Changed: 'df-chg' };
const CHANGE_MARK: Record<string, string> = { Added: '+', Removed: '−', Changed: '≠' };

/** The entry-level diff of two zip-based builds: added, removed and changed inner files, by path and size. */
function ArtifactEntryTable({ entries }: { entries: ArtifactCompare['entries'] }) {
  return (
    <div className="te-scroll">
      <table className="te-table df-table">
        <thead><tr><th aria-label="Change" /><th>Entry</th><th>From</th><th>To</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.path} className={CHANGE_CLASS[e.change]}>
              <td className="df-mark">{CHANGE_MARK[e.change]}</td>
              <td>{e.path}</td>
              <td className="muted">{e.fromSize != null ? formatBytes(e.fromSize) : '—'}</td>
              <td className="muted">{e.toSize != null ? formatBytes(e.toSize) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Compares two builds: a real entry list for zip-based files (.zip/.jar/.war/.ear...), or a size/hash delta for anything else. */
export function ArtifactCompareView({ documentId, from, to }: { documentId: string; from: string; to: string }) {
  const q = useWsQuery(['documents', documentId, 'artifact-compare', from, to], () => documentApi.compareArtifacts(documentId, from, to));
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const nothing = d.comparableAsZip && d.added + d.removed + d.changed === 0;
  return (
    <div className="df">
      <div className="df-head">
        <b>{d.from.label}</b> <Icon name="arrowRight" size={14} /> <b>{d.to.label}</b>
        {d.comparableAsZip
          ? <span className="muted">{nothing ? 'No differences' : `${d.changed} changed · ${d.added} added · ${d.removed} removed · ${d.unchanged} unchanged`}</span>
          : <span className="muted">Not a zip-based build — comparing size and content hash only</span>}
      </div>
      {d.comparableAsZip ? (
        nothing
          ? <EmptyState icon="checkCircle" title="These two builds contain the same files" />
          : <section className="df-section"><h4>Entries <span className="df-chip changed">{d.entries.length} different</span></h4><ArtifactEntryTable entries={d.entries} /></section>
      ) : (
        <section className="df-section">
          <h4>File <span className={`df-chip ${d.sizeChanged || d.hashChanged ? 'changed' : 'unchanged'}`}>{d.sizeChanged || d.hashChanged ? 'Different' : 'Identical'}</span></h4>
          <dl className="doc-facts">
            <div><dt>Size</dt><dd>{formatBytes(d.fromSizeBytes)} <Icon name="arrowRight" size={12} /> {formatBytes(d.toSizeBytes)}</dd></div>
            <div><dt>Content (SHA-256)</dt><dd>{d.hashChanged ? 'Different content' : 'Identical content'}</dd></div>
          </dl>
        </section>
      )}
    </div>
  );
}

function ArtifactVersionRow({ v, onCompare, onDownload }: { v: ArtifactVersion; onCompare: () => void; onDownload: () => void }) {
  return (
    <li className={`ver${v.isCurrent ? ' current' : ''}${v.isDraft ? ' draft' : ''}`}>
      <div className="ver-main">
        <div className="ver-label">
          <b>{v.label}</b>
          {v.isCurrent && <span className="badge badge-success">Current</span>}
          {v.isDraft && <span className="badge badge-warning">Draft</span>}
        </div>
        {v.file ? <p className="ver-sum">{v.file.fileName} · {formatBytes(v.file.sizeBytes)}{v.file.isZip ? '' : ' · not a zip-based build'}</p> : <p className="muted ver-sum">No build attached.</p>}
        {v.publishedBy && <div className="ver-by"><Avatar name={v.publishedBy.name} userId={v.publishedBy.id} /> {v.publishedBy.name} · <span title={formatDateTime(v.publishedAt)}>{timeAgo(v.publishedAt)}</span></div>}
      </div>
      <div className="ver-actions">
        {v.file && <button className="btn btn-ghost btn-sm" onClick={onDownload}>Download</button>}
        {v.file && !v.isDraft && <button className="btn btn-ghost btn-sm" onClick={onCompare}>Compare with current</button>}
      </div>
    </li>
  );
}

type Mode = { kind: 'list' } | { kind: 'compare'; from: string; to: string };

/** Every build of this document: who uploaded what, when, and a way to compare any two of them. */
export function ArtifactHistoryModal({ detail, onClose }: { detail: DocumentDetail; onClose: () => void }) {
  const id = detail.item.id;
  const q = useWsQuery(['documents', id, 'artifact', 'versions'], () => documentApi.artifactVersions(id));
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const items = q.data?.items ?? [];
  const current = items.find((v) => v.isCurrent);
  const withFile = items.filter((v) => v.file);
  const download = (v: ArtifactVersion) => { if (v.file) void documentApi.downloadArtifact(id, v.id, v.file.fileName).catch(() => toast('Could not download the file.', 'error')); };
  const against = (v: ArtifactVersion): Mode => ({ kind: 'compare', from: current?.id ?? v.id, to: v.id });

  return (
    <Modal title={mode.kind === 'list' ? 'Build history' : 'Compare builds'} subtitle={`${detail.item.key} · ${detail.item.title}`} size="xl" onClose={onClose} className="doc-scope"
      footer={mode.kind === 'list' ? <button className="btn btn-ghost" onClick={onClose}>Close</button> : <button className="btn btn-ghost" onClick={() => setMode({ kind: 'list' })}><Icon name="arrowLeft" size={15} /> Back to history</button>}>
      {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : mode.kind === 'list' ? (
        items.length === 0 ? (
          <EmptyState icon="clock" title="No builds yet" text="Upload a file and publish it to start the history." />
        ) : (
          <>
            <ul className="ver-list">
              {items.map((v) => <ArtifactVersionRow key={v.id} v={v} onCompare={() => setMode(against(v))} onDownload={() => download(v)} />)}
            </ul>
            {withFile.length >= 2 && (
              <div className="ver-pick">
                <b>Compare any two builds</b>
                <div className="ver-pick-row">
                  <div className="ver-pick-field"><label>From</label><Select className="select" value={a} onChange={(e) => setA(e.target.value)} aria-label="From version"><option value="">Choose a build…</option>{withFile.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</Select></div>
                  <Icon name="arrowRight" size={14} className="ver-pick-arrow" />
                  <div className="ver-pick-field"><label>To</label><Select className="select" value={b} onChange={(e) => setB(e.target.value)} aria-label="To version"><option value="">Choose a build…</option>{withFile.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</Select></div>
                  <button className="btn btn-primary btn-sm ver-pick-go" disabled={!a || !b || a === b} onClick={() => setMode({ kind: 'compare', from: a, to: b })}>Compare</button>
                </div>
                {a && b && a === b && <p className="muted ver-pick-hint">Choose two different builds to compare.</p>}
              </div>
            )}
          </>
        )
      ) : <ArtifactCompareView documentId={id} from={mode.from} to={mode.to} />}
    </Modal>
  );
}

/** The side card for a Build Artifact document: the current build, uploading a new one, publishing the draft, and a link to the full history. */
export function ArtifactCard({ detail, canEdit }: { detail: DocumentDetail; canEdit: boolean }) {
  const wid = useWorkspaceId();
  const id = detail.item.id;
  const q = useWsQuery(['documents', id, 'artifact', 'versions'], () => documentApi.artifactVersions(id));
  const [history, setHistory] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const refresh = () => invalidateWorkspace(wid, 'documents');
  const upload = useMutation({
    mutationFn: (file: File) => documentApi.uploadArtifactDraft(id, file),
    onSuccess: () => { refresh(); toast('Build attached to the draft.'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not attach the build.', 'error'),
  });
  const publish = useMutation({
    mutationFn: () => documentApi.publishArtifact(id, detail.revision),
    onSuccess: (r) => { refresh(); toast(`Version ${r.publishedLabel ?? ''} published.`); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not publish.', 'error'),
  });
  const draft = q.data?.items.find((v) => v.isDraft);
  const current = q.data?.items.find((v) => v.isCurrent);
  const shown = draft?.file ? draft : current;

  return (
    <div className="card doc-side-card doc-accent-card doc-accent-info">
      <div className="card-head">
        <div><h3>Build</h3><p>The current build file. Every upload becomes a new, automatically numbered version once published.</p></div>
        {canEdit && (
          <>
            <input ref={input} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload.mutate(f); }} />
            <button className="btn btn-ghost btn-sm" onClick={() => input.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? <span className="spinner" /> : <Icon name="upload" size={15} />} Upload new version
            </button>
          </>
        )}
      </div>
      <div className="card-body">
        {q.isLoading ? <p className="muted">Loading…</p> : !shown?.file ? (
          <p className="muted">{canEdit ? 'No build uploaded yet — choose Upload new version.' : 'No build uploaded yet.'}</p>
        ) : (
          <>
            <ul className="doc-files">
              <li>
                <Icon name="paperclip" size={16} />
                <button className="link-btn" onClick={() => documentApi.downloadArtifact(id, shown.id, shown.file!.fileName).catch(() => toast('Could not download the file.', 'error'))}>{shown.file.fileName}</button>
                <span className="muted">{formatBytes(shown.file.sizeBytes)} · {shown.isDraft ? 'Not published yet' : timeAgo(shown.publishedAt)}</span>
              </li>
            </ul>
          </>
        )}
        <div className="art-actions">
          {canEdit && draft?.file && (
            <button className="btn btn-primary btn-sm" onClick={() => publish.mutate()} disabled={publish.isPending}>
              {publish.isPending && <span className="spinner" />}Publish {q.data?.nextLabel}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => setHistory(true)}><Icon name="clock" size={14} /> Build history</button>
        </div>
      </div>
      {history && <ArtifactHistoryModal detail={detail} onClose={() => setHistory(false)} />}
    </div>
  );
}
