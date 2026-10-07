import { createContext, useContext, useEffect, useState } from 'react';
import { mergeAttributes, Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { fetchBlobUrl } from '../../api/client';

/** Which document the text belongs to, so its pictures can be fetched (they are protected files, not public addresses). */
export const DocumentIdContext = createContext<string | null>(null);

function ImageView({ node, selected, deleteNode, editor }: NodeViewProps) {
  const documentId = useContext(DocumentIdContext);
  const fileId = node.attrs.fileId as string;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!documentId) return;
    const ac = new AbortController();
    let made: string | null = null;
    fetchBlobUrl(`/documents/${documentId}/files/${fileId}/download?inline=true`, ac.signal).then((u) => { made = u; setUrl(u); }).catch(() => setFailed(true));
    return () => { ac.abort(); if (made) URL.revokeObjectURL(made); };
  }, [documentId, fileId]);
  return (
    <NodeViewWrapper className={`doc-img${selected ? ' selected' : ''}`} contentEditable={false}>
      {url ? <img src={url} alt={node.attrs.alt || ''} draggable={false} /> : <div className="doc-img-ph">{failed ? 'Picture not available' : 'Loading picture…'}</div>}
      {editor.isEditable && <button type="button" className="doc-img-x" aria-label="Remove picture from the text" onClick={() => deleteNode()}>×</button>}
    </NodeViewWrapper>
  );
}

/** A picture in the text: stored as the id of one of the document's own files, never as an address. */
export const DocImage = Node.create({
  name: 'docImage', group: 'block', atom: true, draggable: true,
  addAttributes() { return { fileId: { default: '' }, alt: { default: '' } }; },
  parseHTML() { return [{ tag: 'div[data-doc-image]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes({ 'data-doc-image': '' }, { 'data-file-id': HTMLAttributes.fileId })]; },
  addNodeView() { return ReactNodeViewRenderer(ImageView); },
});
