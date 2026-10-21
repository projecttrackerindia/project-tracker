import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../api/client';
import { apiDocApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { PageLoader } from '../../components/ui';

/**
 * The API in Swagger UI, inside the app: built from the same OpenAPI file the export gives (so masked values stay masked), loaded on
 * demand, read-only - "Try it out" is switched off, nothing is sent to the API's servers, and there is no public link.
 */
export function DtSwagger({ documentId, definitionId, title, onClose }: { documentId: string; definitionId: string; title: string; onClose: () => void }) {
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
    <div className="dt-swagger" role="dialog" aria-modal="true" aria-label={`${title} in Swagger`}>
      <header><Icon name="code" size={16} /><b>{title}</b><span className="muted">Swagger view · read only</span><button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="close" size={14} /> Close</button></header>
      <div className="dt-swagger-body">
        {state === 'loading' && <PageLoader />}
        {state !== 'loading' && state !== 'ready' && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{state}</div></div>}
        <div ref={host} className="dt-swagger-host" />
      </div>
    </div>,
    document.body,
  );
}
