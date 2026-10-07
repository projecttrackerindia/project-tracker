import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';

interface Found { source: string }

/** The text of every diagram (a code block written in "mermaid") in a section's rich text. */
function diagramsIn(value: string): Found[] {
  const found: Found[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const o = n as { type?: string; attrs?: { language?: string }; content?: unknown[]; text?: string };
    if (o.type === 'codeBlock' && ['mermaid', 'flow', 'flowchart'].includes((o.attrs?.language ?? '').toLowerCase()))
      found.push({ source: (o.content ?? []).map((c) => (c as { text?: string }).text ?? '').join('') });
    else (o.content ?? []).forEach(walk);
  };
  try { walk(JSON.parse(value)); } catch { /* not JSON yet */ }
  return found.slice(0, 20);
}

/**
 * The drawings of the diagrams written in a section. The server draws them (the same drawing is printed in the PDF), and this shows the result under the text
 * while writing and while reading. A mistake is explained in words instead.
 */
export function DiagramPreviews({ value }: { value: string }) {
  const sources = useMemo(() => diagramsIn(value).map((d) => d.source), [value]);
  const key = sources.join('\u0000');
  const [shown, setShown] = useState<{ svg?: string; error?: string }[]>([]);
  useEffect(() => {
    if (sources.length === 0) { setShown([]); return; }
    let live = true;
    const t = window.setTimeout(async () => {
      const out = await Promise.all(sources.map(async (s) => {
        try { return { svg: (await documentApi.renderDiagram(s)).svg }; }
        catch (e) { return { error: e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not draw it.' }; }
      }));
      if (live) setShown(out);
    }, 500);
    return () => { live = false; window.clearTimeout(t); };
  }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (sources.length === 0) return null;
  return (
    <div className="doc-diagrams" aria-label="Diagrams">
      {shown.map((d, i) => d.svg
        ? <figure key={i} className="doc-diagram" data-diagram dangerouslySetInnerHTML={{ __html: d.svg }} />
        : d.error ? <p key={i} className="doc-diagram-error" role="alert">Diagram {i + 1}: {d.error}</p> : null)}
    </div>
  );
}
