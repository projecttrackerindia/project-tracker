import { useContext, useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { documentApi } from '../../../api/endpoints';
import type { DocFile } from '../../../api/types';
import { Modal } from '../../../components/ui';
import { toast } from '../../../stores/ui';
import { DocumentIdContext } from '../DocImage';
import { cleanSvg } from './svgClean';

/** What the page lends the editor for motion blocks: uploading a file of the document, and whether interactive embeds are allowed. */
export interface MotionHost { pickFile: (accept: string) => Promise<{ fileId: string; name: string } | null>; sandbox: boolean }

export type MotionKind = 'lottie' | 'svg' | 'video' | 'gif' | 'sandbox';

const readText = (accept: string) => new Promise<string | null>((resolve) => {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = accept;
  input.onchange = () => { const f = input.files?.[0]; if (!f) return resolve(null); if (f.size > 150_000) { toast('That SVG is too large (keep it under 150 KB).', 'error'); return resolve(null); } void f.text().then(resolve, () => resolve(null)); };
  input.oncancel = () => resolve(null);
  input.click();
});

/** Adds a motion block where the cursor is. Lottie opens a picker (upload, or one of the page's attachments). */
export async function insertMotion(editor: Editor, kind: MotionKind, host: MotionHost, openLottie: () => void) {
  const c = () => editor.chain().focus();
  if (kind === 'sandbox') { if (!host.sandbox) { toast('Interactive embeds are turned off in this workspace.', 'info'); return; } c().insertContent({ type: 'sandboxEmbed', attrs: { height: 320 } }).run(); return; }
  if (kind === 'lottie') { openLottie(); return; }
  if (kind === 'svg') {
    const text = await readText('image/svg+xml,.svg');
    if (text === null) return;
    const r = cleanSvg(text);
    if (!r.ok) { toast(r.error ?? 'That SVG could not be read.', 'error'); return; }
    c().insertContent({ type: 'motionSvg', attrs: { svg: r.svg } }).run();
    if (r.removed) toast(`${r.removed} unsafe part${r.removed === 1 ? ' was' : 's were'} removed from the SVG (scripts, links, event handlers).`, 'info');
    return;
  }
  if (kind === 'video') { const f = await host.pickFile('video/mp4,video/webm'); if (f) c().insertContent({ type: 'motionVideo', attrs: { fileId: f.fileId, caption: f.name } }).run(); return; }
  if (kind === 'gif') { const f = await host.pickFile('image/gif,image/png,image/apng,image/webp'); if (f) c().insertContent({ type: 'docImage', attrs: { fileId: f.fileId, alt: f.name } }).run(); }
}

/** Choose a Lottie animation: one of the page's JSON attachments, or upload one. */
export function LottiePicker({ editor, host, onClose }: { editor: Editor; host: MotionHost; onClose: () => void }) {
  const documentId = useContext(DocumentIdContext);
  const [files, setFiles] = useState<DocFile[] | null>(null);
  useEffect(() => { if (documentId) void documentApi.files(documentId).then(setFiles, () => setFiles([])); }, [documentId]);
  const use = (fileId: string, name: string) => { editor.chain().focus().insertContent({ type: 'motionLottie', attrs: { fileId, caption: name.replace(/\.json$/i, '') } }).run(); onClose(); };
  const json = (files ?? []).filter((f) => f.contentType === 'application/json' || f.fileName.toLowerCase().endsWith('.json'));
  return (
    <Modal title="Add a Lottie animation" subtitle="A Lottie JSON file: upload one, or use one already attached to this page." onClose={onClose} className="doc-scope">
      <div className="mo-pick">
        <button type="button" className="btn btn-primary" onClick={async () => { const f = await host.pickFile('application/json,.json'); if (f) use(f.fileId, f.name); }}>Upload a JSON file…</button>
        {files === null ? <p className="muted">Looking for attachments…</p> : json.length === 0 ? <p className="muted">No Lottie files attached to this page yet.</p> : (
          <ul className="mo-pick-list">{json.map((f) => <li key={f.id}><button type="button" onClick={() => use(f.id, f.fileName)}>{f.fileName}<small>{Math.max(1, Math.round(f.sizeBytes / 1024))} KB</small></button></li>)}</ul>
        )}
      </div>
    </Modal>
  );
}
