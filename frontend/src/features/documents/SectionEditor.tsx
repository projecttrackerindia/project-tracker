import type { DocumentSection, SectionTemplate } from '../../api/types';
import { RichEditor } from './RichEditor';
import { TableEditor } from './TableEditor';
import { DiagramPreviews } from './DiagramPreviews';

/** One section of a document: its title, a hint on what belongs there, and the editor for its kind. */
export function SectionEditor({ section, template, value, onChange, readOnly, id, onPickImage, minimal }: {
  section: Pick<DocumentSection, 'key' | 'title' | 'kind'>; template?: SectionTemplate | null; value: string; onChange?: (v: string) => void; readOnly?: boolean; id?: string;
  onPickImage?: () => Promise<{ fileId: string; alt: string } | null>;
  /** Write in place: no fixed toolbar; formatting comes up on the selected text and "/" adds blocks. */ minimal?: boolean;
}) {
  return (
    <section className="doc-section" id={id}>
      <h3>{section.title}</h3>
      {template?.hint && !readOnly && <p className="doc-hint">{template.hint}</p>}
      {section.kind === 'Table'
        ? <TableEditor value={value} onChange={onChange} readOnly={readOnly} template={template} label={section.title} />
        : <><RichEditor value={value} onChange={onChange} readOnly={readOnly} label={section.title} placeholder={readOnly ? '' : minimal ? 'Write, or type / for blocks…' : 'Start writing…'} onPickImage={onPickImage} minimal={minimal} /><DiagramPreviews value={value} /></>}
    </section>
  );
}
