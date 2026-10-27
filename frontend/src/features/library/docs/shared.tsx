import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../../api/client';
import { apiDocApi, docTrackerApi } from '../../../api/endpoints';
import type { ApiOverview, DtEndpoint, DtProject } from '../../../api/types';
import { Field, Modal, PageLoader } from '../../../components/ui';
import { Icon, type IconName } from '../../../components/Icon';
import { invalidateWorkspace } from '../../../lib/hooks';
import { useWorkspaceId } from '../../../stores/auth';
import { toast } from '../../../stores/ui';
import { EndpointEditor } from '../../documents/ApiEndpointEditor';
import { ImportModal } from '../../documents/ApiTools';
import { useExportPdf } from '../../documents/ExportPdf';
import { avatarColor } from '../../documents/docUi';
import { GENERAL } from './nav';

export const pidOf = (p: Pick<DtProject, 'id'>) => p.id ?? GENERAL;
export const avgScore = (eps: Pick<DtEndpoint, 'score'>[]) => (eps.length ? Math.round(eps.reduce((a, e) => a + e.score, 0) / eps.length) : 0);
export const tone = (s: number) => (s >= 85 ? 'good' : s >= 60 ? 'ok' : 'low');
export const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

/** The method as a small coloured capsule. */
export const MethodPill = ({ m, size }: { m: string; size?: 'lg' }) => <span className={`dx-m m-${m.toLowerCase()}${size ? ` ${size}` : ''}`}>{m}</span>;

/** A project's mark: its key's first letter on its colour. */
export function ProjectMark({ p, size = 36 }: { p: Pick<DtProject, 'id' | 'key' | 'name'>; size?: number }) {
  return <span className="dx-mark" style={{ '--av': p.id ? avatarColor(p.id) : 'var(--ds-text-3)', width: size, height: size, fontSize: size * 0.42 } as CSSProperties} aria-hidden="true">{(p.key ?? p.name).charAt(0).toUpperCase()}</span>;
}

/** Documentation health as an Activity-style ring that draws itself in. */
export function HealthRing({ score, size = 44, label = 'Documentation health' }: { score: number; size?: number; label?: string }) {
  const r = (size - 6) / 2, c = 2 * Math.PI * r;
  return (
    <span className={`dx-ring t-${tone(score)}`} style={{ width: size, height: size, '--c': c, '--v': (c * score) / 100 } as CSSProperties} role="img" aria-label={`${label} ${score} of 100`}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="bg" />
        <circle cx={size / 2} cy={size / 2} r={r} className="fg" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <b>{score}</b>
    </span>
  );
}

/** Why someone needs the masked values; the reason goes into the audit trail with the reveal. */
export function RevealSheet({ onClose, onReveal, example = 'Partner integration call' }: { onClose: () => void; onReveal: (reason: string) => Promise<void>; example?: string }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setError(null);
    try { await onReveal(reason.trim()); } catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not reveal.'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Reveal masked values" subtitle="They show for a few seconds, then are masked again." size="sm" onClose={onClose} onSubmit={(e) => { e.preventDefault(); void go(); }}
      footer={<><button type="button" className="dx-btn" onClick={onClose}>Cancel</button><button type="submit" className="dx-btn pri" disabled={busy || reason.trim().length < 4}>{busy && <span className="spinner" />}Reveal</button></>}>
      {error && <p className="dx-err" role="alert">{error}</p>}
      <Field label="Why do you need to see them?" hint="Recorded in the audit trail with your name and the time.">
        <input className="input" autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder={example} />
      </Field>
    </Modal>
  );
}

/**
 * The API in Swagger UI, read-only: built from the same OpenAPI file the export gives (masked values stay masked), "Try it out" off,
 * nothing sent to the API's servers, no public link.
 */
export function SwaggerSheet({ documentId, definitionId, title, onClose }: { documentId: string; definitionId: string; title: string; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | string>('loading');
  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const [text, ui] = await Promise.all([apiDocApi.openApiText(documentId, definitionId), import('swagger-ui-dist/swagger-ui-es-bundle.js'), import('swagger-ui-dist/swagger-ui.css')]);
        if (gone || !host.current) return;
        const SwaggerUI = (ui as { default: (o: Record<string, unknown>) => unknown }).default;
        SwaggerUI({ domNode: host.current, spec: JSON.parse(text), supportedSubmitMethods: [], tryItOutEnabled: false, deepLinking: false, docExpansion: 'list', defaultModelsExpandDepth: 0, displayRequestDuration: false });
        setState('ready');
      } catch (e) { if (!gone) setState(e instanceof ApiError ? e.message : 'Could not open Swagger.'); }
    })();
    return () => { gone = true; };
  }, [documentId, definitionId]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return createPortal(
    <div className="dx-sheet-scrim" onClick={onClose}>
      <div className="dx-sheet" role="dialog" aria-modal="true" aria-label={`${title} in Swagger`} onClick={(e) => e.stopPropagation()}>
        <header><b>{title}</b><span>Swagger · read only</span><button type="button" className="dx-btn sm" onClick={onClose}>Done</button></header>
        <div className="dx-sheet-body">
          {state === 'loading' && <PageLoader />}
          {state !== 'loading' && state !== 'ready' && <p className="dx-err" role="alert">{state}</p>}
          <div ref={host} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

type Mode = null | { kind: 'endpoint' | 'import'; documentId: string; overview: ApiOverview; definitionId: string } | { kind: 'swagger'; documentId: string; definitionId: string; title: string };

/**
 * New endpoint / import / exports / Swagger for a project. New endpoint and Import go to the project's API document, made (with a first
 * API) the first time, so nobody has to create a document before describing an API.
 */
export function useApiActions(project: DtProject, onEndpoint?: (id: string) => void) {
  const wid = useWorkspaceId();
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const pdf = useExportPdf(project.definitions[0]?.documentId ?? '');
  const open = async (kind: 'endpoint' | 'import') => {
    setBusy(true);
    try {
      const home = await docTrackerApi.apiHome(project.id);
      const overview = await apiDocApi.overview(home.documentId);
      invalidateWorkspace(wid, 'documents');
      setMode({ kind, documentId: home.documentId, overview, definitionId: home.definitionId });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not open the API.', 'error'); }
    finally { setBusy(false); }
  };
  const exportFile = (format: 'openapi' | 'postman') => {
    for (const def of project.definitions)
      void apiDocApi.export(def.documentId, format, def.id, null, `${def.name.replace(/[^\w.-]+/g, '-')}.${format === 'openapi' ? 'openapi' : 'postman_collection'}.json`).catch((e) => toast(e instanceof ApiError ? e.message : 'Could not export.', 'error'));
  };
  const close = () => setMode(null);
  const done = () => invalidateWorkspace(wid, 'documents');
  const modal = mode === null ? null : mode.kind === 'endpoint' ? (
    <EndpointEditor documentId={mode.documentId} definitions={mode.overview.definitions} existing={null} startDefinition={mode.definitionId} onClose={close} onSaved={(r) => { close(); done(); onEndpoint?.(r.item.id); }} />
  ) : mode.kind === 'import' ? (
    <ImportModal documentId={mode.documentId} definitions={mode.overview.definitions} onClose={() => { close(); done(); }} onDone={() => done()} />
  ) : mode.kind === 'swagger' ? <SwaggerSheet documentId={mode.documentId} definitionId={mode.definitionId} title={mode.title} onClose={close} /> : null;
  return {
    busy, modal, hasApi: project.definitions.length > 0, pdfBusy: pdf.busy,
    newEndpoint: () => void open('endpoint'), importFile: () => void open('import'), exportFile, exportPdf: () => void pdf.run(),
    swagger: (definitionId?: string) => { const d = project.definitions.find((x) => x.id === definitionId) ?? project.definitions[0]; if (d) setMode({ kind: 'swagger', documentId: d.documentId, definitionId: d.id, title: d.name }); },
  };
}

export interface PopItem { label: string; hint?: string; icon?: IconName; onSelect: () => void; hidden?: boolean; danger?: boolean }
/** A pill button that opens a short menu (New, Export…). Closes on choosing, a click outside and Escape. */
export function PopMenu({ label, icon, items, tone, align = 'right' }: { label: string; icon?: IconName; items: PopItem[]; tone?: 'pri' | 'tint'; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const shown = items.filter((i) => !i.hidden);
  if (!shown.length) return null;
  return (
    <div className="dx-pop" ref={ref}>
      <button type="button" className={`dx-btn${tone ? ` ${tone}` : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{icon && <Icon name={icon} size={14} />}{label}</button>
      {open && (
        <ul className={`dx-pop-list ${align}`} role="menu" aria-label={label}>
          {shown.map((i) => (
            <li key={i.label} role="none"><button type="button" role="menuitem" className={i.danger ? 'danger' : ''} onClick={() => { setOpen(false); i.onSelect(); }}>
              {i.icon && <Icon name={i.icon} size={15} />}<span><b>{i.label}</b>{i.hint && <small>{i.hint}</small>}</span></button></li>
          ))}
        </ul>
      )}
    </div>
  );
}
