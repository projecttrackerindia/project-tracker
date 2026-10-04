import { Fragment, memo, type ReactNode } from 'react';

/**
 * Renders the assistant's Markdown as React elements - never as HTML - so nothing the model writes can inject markup or script. Handles what
 * answers use: headings, paragraphs, bold/italic/code, links (http, https, mailto only), bullet and numbered lists, tables, quotes, rules
 * and fenced code. Half-written Markdown (an unclosed fence, a table still arriving) renders sensibly while an answer streams in.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="ai-md">{blocks(text)}</div>;
});

const KEY = /\b[A-Z][A-Z0-9]{1,5}-\d+\b/;   // work item keys like PRJ-12

// ------------------------------------------------------------------ inline

const INLINE = /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))|(\*[^*\n]+\*)|(_[^_\n]+_)/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(...plain(text.slice(last, i), `${keyBase}p${n}`));
    const tok = m[0];
    const k = `${keyBase}i${n++}`;
    if (m[1]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[2]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[3]) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      out.push(<a key={k} href={mm[2]} target="_blank" rel="noopener noreferrer">{mm[1]}</a>);
    } else out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    last = i + tok.length;
  }
  if (last < text.length) out.push(...plain(text.slice(last), `${keyBase}e`));
  return out;
}

/** Plain text, with work item keys picked out as small chips. */
function plain(text: string, keyBase: string): ReactNode[] {
  const parts = text.split(new RegExp(`(${KEY.source})`, 'g'));
  return parts.map((p, i) => (i % 2 === 1 ? <span key={`${keyBase}k${i}`} className="ai-key">{p}</span> : <Fragment key={`${keyBase}t${i}`}>{p}</Fragment>));
}

// ------------------------------------------------------------------ blocks

const isTableRow = (l: string) => /^\s*\|.*\|?\s*$/.test(l) && l.includes('|');
const isSeparator = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => `b${out.length}`;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // fenced code (also while the closing fence has not arrived yet)
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(<pre key={key()} className="ai-code"><code>{body.join('\n')}</code></pre>);
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const Tag = (`h${Math.min(h[1].length + 1, 5)}`) as 'h2' | 'h3' | 'h4' | 'h5';
      out.push(<Tag key={key()}>{inline(h[2], key())}</Tag>);
      i++; continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(<hr key={key()} />); i++; continue; }

    if (/^\s*>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={key()}>{blocks(q.join('\n'))}</blockquote>);
      continue;
    }

    // a table: a header row, a separator row, then body rows
    if (isTableRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1]) && lines[i + 1].includes('|')) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        <div key={key()} className="ai-table-wrap">
          <table>
            <thead><tr>{head.map((c, n) => <th key={n}>{inline(c, `${key()}h${n}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, n) => <tr key={n}>{head.map((_, c) => <td key={c}>{inline(r[c] ?? '', `${key()}r${n}c${c}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    const bullet = /^(\s*)([-*•])\s+/;
    const numbered = /^(\s*)(\d+)[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? numbered : bullet).test(lines[i])) {
        let item = lines[i].replace(ordered ? numbered : bullet, '');
        i++;
        // indented continuation lines belong to the same item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(item);
      }
      const Tag = ordered ? 'ol' : 'ul';
      out.push(<Tag key={key()}>{items.map((it, n) => <li key={n}>{inline(it, `${key()}l${n}`)}</li>)}</Tag>);
      continue;
    }

    // a paragraph runs until a blank line or the start of another block
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|>|[-*•]\s|\d+[.)]\s)/.test(lines[i]) && !(isTableRow(lines[i]) && isSeparator(lines[i + 1] ?? ''))) para.push(lines[i++]);
    if (para.length === 0) { para.push(lines[i++]); }
    out.push(<p key={key()}>{inline(para.join(' '), key())}</p>);
  }
  return out;
}
