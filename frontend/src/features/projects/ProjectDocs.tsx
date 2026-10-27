import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { uploadFile } from '../../api/client';
import { attachmentApi, documentApi } from '../../api/endpoints';
import type { Attachment, DocumentStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { formatBytes } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { useQueryClient } from '@tanstack/react-query';
import { DocumentWizard } from '../documents/DocumentWizard';
import { LinkDocumentButton, TargetDocuments } from '../documents/LinkedWork';
import { ProjectCodeTab } from '../github/GitHubApp';
import { useGitHubApp } from '../github/github';
import { errText } from './projectParts';
import '../library/library.css';
import '../talk/dots.css';

type Kind = 'API' | 'Doc' | 'Design' | 'File';
const KINDS: Kind[] = ['API', 'Doc', 'Design', 'File'];
const DESIGN_CODES = new Set(['ARCH', 'TECH', 'INTEG']);
const kindOf = (typeCode: string): Kind => (typeCode === 'API' ? 'API' : DESIGN_CODES.has(typeCode) ? 'Design' : typeCode === 'ARTIFACT' ? 'File' : 'Doc');
const STATUS: Record<DocumentStatus, { label: string; tone: string }> = {
  Draft: { label: 'Draft', tone: '' }, InReview: { label: 'In review', tone: 'warning' }, ChangesRequested: { label: 'Changes asked', tone: 'danger' },
  Approved: { label: 'Approved', tone: 'success' }, Published: { label: 'Published', tone: 'success' }, Archived: { label: 'Archived', tone: '' },
};
const shortDay = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
/** Search and the type chips appear only past this many items. */
const FILTERS_FROM = 10;
type Filter = Kind | 'Code' | null;
const PARAM: Record<string, Filter> = { api: 'API', doc: 'Doc', design: 'Design', file: 'File', code: 'Code' };

interface Row { id: string; kind: Kind; title: string; sub: string; status: DocumentStatus | null; at: string; open: () => void; file?: Attachment }

/**
 * A project's Docs (v2 §3.5): its documents, API references, designs and files in one list, newest first, each with what it is, its status and
 * when it last changed. Search and the type chips appear past 10 items. One "+ New": write a document or upload a file. The project's code
 * (GitHub) is one more chip when the app is installed; documents elsewhere that point at the project follow the list.
 */
export function ProjectDocs({ projectId, canEdit, archived }: { projectId: string; canEdit: boolean; archived: boolean }) {
  const nav = useNavigate();
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const docsLevel = useModule('documents');
  const seeDocs = docsLevel > 0, writeDocs = docsLevel >= 2 && !archived;
  const canUpload = canEdit && !archived;
  const docs = useWsQuery(['documents', 'project', projectId], () => documentApi.list({ projectId, limit: 100 }), { enabled: seeDocs, staleTime: 20_000 });
  const files = useWsQuery(['attachments', projectId, 'project'], () => attachmentApi.list(projectId), { staleTime: 20_000 });
  const limits = useWsQuery(['attachments', 'limits'], attachmentApi.limits, { enabled: canUpload });
  const gitHub = useGitHubApp();
  const code = !!gitHub.data?.installed;
  const filter: Filter = PARAM[params.get('type') ?? ''] ?? null;
  const setFilter = (f: Filter) => setParams((p) => { const n = new URLSearchParams(p); if (f) n.set('type', f.toLowerCase()); else n.delete('type'); return n; }, { replace: true });
  const [q, setQ] = useState('');
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = (docs.data?.items ?? []).map((d) => ({
      id: d.id, kind: kindOf(d.typeCode), title: d.title, sub: [d.typeName, d.owner?.name].filter(Boolean).join(' · '), status: d.status, at: d.updatedAt,
      open: () => nav(`/library/docs/${d.id}`),
    }));
    for (const f of files.data ?? []) out.push({
      id: `file:${f.id}`, kind: 'File', title: f.fileName, sub: ['File', formatBytes(f.sizeBytes), f.taskKey, f.uploadedBy?.name].filter(Boolean).join(' · '), status: null, at: f.createdAt, file: f,
      open: () => void attachmentApi.download(f.id, f.fileName).catch(() => toast('Could not download the file.', 'error')),
    });
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [docs.data, files.data, nav]);

  const needle = q.trim().toLowerCase();
  const filtersOn = rows.length > FILTERS_FROM || !!needle || (!!filter && filter !== 'Code');
  const shown = rows.filter((r) => (!filter || filter === 'Code' || r.kind === filter) && (!needle || `${r.title} ${r.sub}`.toLowerCase().includes(needle)));
  const refreshFiles = () => { void qc.invalidateQueries({ queryKey: [wid, 'attachments', projectId] }); void qc.invalidateQueries({ queryKey: [wid, 'attachments', 'limits'] }); };

  const upload = async (list: FileList | null) => {
    if (!list?.length || !canUpload) return;
    for (const file of Array.from(list)) {
      if (limits.data && file.size > limits.data.maxFileBytes) { toast(`“${file.name}” is ${formatBytes(file.size)}. Your plan allows files up to ${formatBytes(limits.data.maxFileBytes)}.`, 'error'); continue; }
      setBusy(file.name);
      try { await uploadFile(attachmentApi.uploadPath(projectId), file); refreshFiles(); toast(`“${file.name}” added.`); }
      catch (e) { toast(errText(e, `Could not upload “${file.name}”.`), 'error'); }
      finally { setBusy(null); }
    }
    if (input.current) input.current.value = '';
  };
  const remove = async (f: Attachment) => {
    if (!(await confirmDialog({ title: 'Remove file?', message: `“${f.fileName}” will be deleted for everyone.`, confirmText: 'Remove' }))) return;
    try { await attachmentApi.remove(f.id); toast('File removed.', 'warning'); refreshFiles(); }
    catch (e) { toast(errText(e, 'Could not remove the file.'), 'error'); }
  };

  const loading = (seeDocs && docs.isLoading) || files.isLoading;
  const error = (seeDocs && docs.isError ? docs.error : null) ?? (files.isError ? files.error : null);
  const chips: Filter[] = [...KINDS, ...(code ? ['Code' as const] : [])];
  return (
    <div className="pp-docs">
      <section className="lib-card pp-docs-card" aria-label="Docs">
        <div className="pp-docs-head">
          <h3>Docs{rows.length > 0 && <span> · {rows.length}</span>}</h3>
          {seeDocs && <LinkDocumentButton targetType="Project" targetId={projectId} />}
          {(writeDocs || canUpload) && <NewMenu doc={writeDocs} file={canUpload} busy={busy} onDoc={() => setWriting(true)} onFile={() => input.current?.click()} />}
          <input ref={input} type="file" multiple hidden aria-label="Upload a file" onChange={(e) => void upload(e.target.files)} accept={limits.data?.allowedExtensions.map((x) => `.${x}`).join(',')} />
        </div>
        {(filtersOn || code) && (
          <div className="lib-filters pp-docs-filters">
            <div className="ds-chips" role="group" aria-label="Type">
              <button type="button" className={`ds-chip${filter === null ? ' on' : ''}`} aria-pressed={filter === null} onClick={() => setFilter(null)}>All</button>
              {(filtersOn ? chips : ['Code' as const]).map((k) => <button key={k} type="button" className={`ds-chip${filter === k ? ' on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(filter === k ? null : k)}>{k}</button>)}
            </div>
            {filtersOn && filter !== 'Code' && <div className="search-field pp-docs-search"><Icon name="search" /><input className="input" type="search" placeholder="Search docs and files" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search docs and files" /></div>}
          </div>
        )}
        {filter === 'Code' ? <ProjectCodeTab projectId={projectId} canWriteDocs={writeDocs} />
          : loading ? <PageLoader /> : error ? <ErrorState error={error} retry={() => { void docs.refetch(); void files.refetch(); }} />
          : shown.length === 0 ? (
            needle || filter ? <EmptyState icon="search" title="Nothing matches" text="Try another word or type." />
              : <EmptyState icon="note" title="No docs yet" text={writeDocs || canUpload ? 'Write the first document, or drop in a file: specs, designs, Postman collections.' : 'Documents and files for this project appear here.'} />
          ) : (
            <ul className="lib-rows pp-doc-rows">
              {shown.map((r) => (
                <li key={r.id} className="pp-doc-li">
                  <button type="button" className="lib-row" onClick={r.open} data-doc={r.title}>
                    <span className={`lib-kind k-${r.kind.toLowerCase()}`}>{r.kind}</span>
                    <span className="lib-row-main"><b>{r.title}</b><small>{r.sub}</small></span>
                    {r.status ? <span className={`ds-pill ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span> : <span className="lib-dash" aria-hidden="true">—</span>}
                    <time dateTime={r.at}>{shortDay(r.at)}</time>
                  </button>
                  {r.file?.canDelete && !archived && <button type="button" className="btn-icon pp-doc-remove" aria-label={`Remove ${r.file.fileName}`} title="Remove" onClick={() => void remove(r.file!)}><Icon name="trash" size={15} /></button>}
                </li>
              ))}
              {busy && <li className="pp-doc-li"><span className="lib-row"><span className="spinner" /><span className="lib-row-main"><b>{busy}</b><small>Uploading…</small></span></span></li>}
            </ul>
          )}
      </section>
      {seeDocs && filter !== 'Code' && <TargetDocuments targetType="Project" targetId={projectId} title="Documents elsewhere about this project" hideWhenEmpty />}
      {writing && <DocumentWizard projectId={projectId} onClose={() => setWriting(false)} onCreated={(id) => nav(`/library/docs/${id}`)} />}
    </div>
  );
}

/** "+ New": write a document, or upload a file. With only one of the two allowed, the button does that one. */
function NewMenu({ doc, file, busy, onDoc, onFile }: { doc: boolean; file: boolean; busy: string | null; onDoc: () => void; onFile: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const only = doc && !file ? onDoc : file && !doc ? onFile : null;
  return (
    <div className="v2-dots pp-new" ref={ref}>
      <button type="button" className="btn btn-primary btn-sm pp-new-btn" aria-label="New document or file" disabled={busy !== null} aria-haspopup={only ? undefined : 'menu'} aria-expanded={only ? undefined : open}
        onClick={() => (only ? only() : setOpen((o) => !o))}><Icon name="plus" size={15} /> New</button>
      {open && (
        <ul className="v2-dots-list right" role="menu" aria-label="New">
          <li role="none"><button type="button" role="menuitem" onClick={() => { setOpen(false); onDoc(); }}><Icon name="note" size={15} /><span><b>Document</b><small>A spec, BRD, API doc or notes, from a template or with AI</small></span></button></li>
          <li role="none"><button type="button" role="menuitem" onClick={() => { setOpen(false); onFile(); }}><Icon name="upload" size={15} /><span><b>Upload a file</b><small>Designs, collections, exports</small></span></button></li>
        </ul>
      )}
    </div>
  );
}
