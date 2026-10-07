import { useState } from 'react';
import { ApiError, download } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { toast } from '../../stores/ui';

/**
 * Asks for a PDF of the document. The server builds it in the background; this waits for it (a few seconds for a normal document), downloads it, and
 * stops waiting after two minutes (the person is notified when it is ready, and the file is kept for seven days under Reports).
 */
/** Starts a PDF of the document and downloads it when it is ready. */
export function useExportPdf(documentId: string, versionId?: string | null) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const job = await documentApi.exportPdf(documentId, versionId);
      const until = Date.now() + 120_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const s = await documentApi.exportStatus(documentId, job.id);
        if (s.status === 'Ready') { await download(`/documents/${documentId}/exports/${job.id}/file`, s.fileName ?? 'document.pdf'); toast('PDF ready.'); return; }
        if (s.status === 'Failed') { toast(s.error ?? 'The PDF could not be made.', 'error'); return; }
        if (Date.now() > until) { toast('The PDF is still being prepared. You will be notified when it is ready.', 'warning'); return; }
      }
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not make the PDF.', 'error'); }
    finally { setBusy(false); }
  };
  return { busy, run };
}

export function ExportPdfButton({ documentId, versionId }: { documentId: string; versionId?: string | null }) {
  const { busy, run } = useExportPdf(documentId, versionId);
  return <button className="btn btn-ghost" disabled={busy} onClick={run} title="Download as PDF (secret values are never included)">{busy ? <span className="spinner" /> : <Icon name="download" size={15} />} PDF</button>;
}
