import { useState } from 'react';
import { ApiError } from '../../api/client';
import { apiDocApi, docTrackerApi } from '../../api/endpoints';
import type { ApiOverview, DtProject } from '../../api/types';
import { invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { EndpointEditor } from '../documents/ApiEndpointEditor';
import { ImportModal } from '../documents/ApiTools';
import { useExportPdf } from '../documents/ExportPdf';
import { DtSwagger } from './DtSwagger';

type Mode = null | { kind: 'endpoint' | 'import'; documentId: string; overview: ApiOverview; definitionId: string } | { kind: 'swagger'; documentId: string; definitionId: string; title: string };

/**
 * New endpoint / import / exports / Swagger for a project. "New endpoint" and "Import" go to the project's API document, which is made
 * (with a first API) the first time - so nobody has to create a document before documenting an API.
 */
export function useApiActions(project: DtProject, onEndpoint?: (id: string) => void) {
  const wid = useWorkspaceId();
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const firstDoc = project.definitions[0]?.documentId ?? '';
  const pdf = useExportPdf(firstDoc);
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
  ) : mode.kind === 'swagger' ? <DtSwagger documentId={mode.documentId} definitionId={mode.definitionId} title={mode.title} onClose={close} /> : null;
  return {
    busy, modal, hasApi: project.definitions.length > 0, pdfBusy: pdf.busy,
    newEndpoint: () => void open('endpoint'), importFile: () => void open('import'), exportFile, exportPdf: () => void pdf.run(),
    swagger: (definitionId?: string) => { const d = project.definitions.find((x) => x.id === definitionId) ?? project.definitions[0]; if (d) setMode({ kind: 'swagger', documentId: d.documentId, definitionId: d.id, title: d.name }); },
  };
}
