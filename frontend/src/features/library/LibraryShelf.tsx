import { useQueries } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import { documentApi } from '../../api/endpoints';
import type { DocumentItem } from '../../api/types';
import { timeAgo } from '../../lib/format';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { readingProgress } from '../documents/readingProgress';
import { coverLabel, shelfOf, type Shelf } from './libraryKinds';

/** A document's text, without markup: one line per paragraph, list item or heading. */
function plainText(html: string): string {
  return html
    .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr|\/pre)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

interface Preview { method?: string; path?: string; code?: string[]; steps?: string[]; passed?: number; total?: number }

/** What a cover can honestly show from the document itself: a request and its cURL, a runbook's first steps, a test report's pass count. */
export function previewOf(shelf: Shelf, sections: { content: string }[]): Preview {
  const text = plainText(sections.map((s) => s.content).join('\n'));
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (shelf === 'api') {
    const m = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w\-./{}:]*)/.exec(text);
    const at = lines.findIndex((l) => /^curl\s/i.test(l));
    const code = at >= 0 ? lines.slice(at, at + 4).map((l) => l.slice(0, 48)) : undefined;
    return { method: m?.[1], path: m?.[2], code };
  }
  if (shelf === 'runbook') {
    const steps = lines.filter((l) => l.length > 3 && l.length < 80 && !/^#/.test(l)).map((l) => l.replace(/^(\d+[.)]|[-*•]|\[[ x]\])\s*/i, '')).slice(0, 4);
    return { steps };
  }
  if (shelf === 'test') {
    const m = /(\d+)\s*(?:\/|of)\s*(\d+)\s*(?:tests?\s*)?passed/i.exec(text);
    if (m) return { passed: Number(m[1]), total: Number(m[2]) };
    const pass = (text.match(/\b(pass(ed)?|✓|✅)\b/gi) ?? []).length, fail = (text.match(/\b(fail(ed)?|✗|❌)\b/gi) ?? []).length;
    return pass + fail > 0 ? { passed: pass, total: pass + fail } : {};
  }
  return {};
}

const Lines = ({ w }: { w: number[] }) => <>{w.map((x, i) => <i key={i} className="lb-ln" style={{ width: `${x}%` }} />)}</>;

function CoverBody({ shelf, p }: { shelf: Shelf; p: Preview | null }) {
  if (shelf === 'api' && p?.method) return (
    <>
      <div className="lb-req"><span className="lb-verb">{p.method}</span><span className="lb-path">{p.path}</span></div>
      {p.code && <pre className="lb-code" aria-hidden="true">{p.code.map((l, i) => <span key={i}>{i === 0 ? <><u>curl</u>{l.slice(4)}</> : l.replace(/("[^"]*")/g, '\u0000$1\u0000').split('\u0000').map((x, j) => (j % 2 ? <i key={j}>{x}</i> : x))}{'\n'}</span>)}</pre>}
      <Lines w={[80, 60]} />
    </>
  );
  if (shelf === 'runbook' && p?.steps?.length) return (
    <><ol className="lb-steps">{p.steps.map((s, i) => <li key={i}><span>{i + 1}</span>{s}</li>)}</ol><Lines w={[70]} /></>
  );
  if (shelf === 'test' && p?.total) {
    const c = 2 * Math.PI * 16, ok = (p.passed! / p.total) * c;
    return (
      <>
        <div className="lb-ring">
          <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
            <circle cx="20" cy="20" r="16" className="lb-ring-track" />
            <circle cx="20" cy="20" r="16" className="lb-ring-ok" strokeDasharray={`${ok} ${c}`} transform="rotate(-90 20 20)" />
            {p.passed! < p.total && <circle cx="20" cy="20" r="16" className="lb-ring-bad" strokeDasharray={`${c - ok - 2} ${c}`} strokeDashoffset={-ok - 1} transform="rotate(-90 20 20)" />}
          </svg>
          <div><b>{p.passed}/{p.total}</b><small>passed</small></div>
        </div>
        <Lines w={[88, 66]} />
      </>
    );
  }
  return (
    <>
      <Lines w={[94, 88, 70]} />
      <div className="lb-blocks" aria-hidden="true"><i /><i /><i /></div>
      <Lines w={[90, 55]} />
    </>
  );
}

/** Continue: the four documents this person opened last, as covers with a live preview and how far they have read. */
export function ContinueShelf({ docs, onOpen }: { docs: DocumentItem[]; onOpen: (id: string) => void }) {
  const wid = useWorkspaceId();
  const meId = useAuth((s) => s.ctx?.user.id);
  const details = useQueries({ queries: docs.map((d) => ({ queryKey: [wid, 'documents', 'cover', d.id, d.updatedAt], queryFn: () => documentApi.get(d.id), staleTime: 60_000, retry: false })) });
  if (docs.length === 0) return null;
  return (
    <section className="lb-continue" aria-label="Continue">
      <div className="lb-shelfh"><h2>Recently viewed</h2><span>Picked up where you left off</span></div>
      <div className="lb-shelf">
        {docs.map((d, i) => {
          const shelf = shelfOf(d.typeCode);
          const det = details[i]?.data;
          const p = det ? previewOf(shelf, det.sections) : null;
          const read = readingProgress(d.id);
          const who = d.owner?.id === meId ? 'Edited by you' : d.owner?.name ?? d.projectName ?? '';
          return (
            <button key={d.id} type="button" className={`lb-book s-${shelf}`} onClick={() => onOpen(d.id)} data-cover={d.title} style={{ '--i': i } as CSSProperties}>
              <span className="lb-cov">
                <span className="lb-cov-k">{coverLabel(d.typeCode, d.typeName)}</span>
                <span className="lb-cov-t">{d.title}</span>
                <CoverBody shelf={shelf} p={p} />
              </span>
              <span className="lb-meta">
                <b>{d.title}</b>
                <span>{[who, timeAgo(d.updatedAt)].filter(Boolean).join(' · ')}</span>
                <span className="lb-prog" role="progressbar" aria-label={`Read ${Math.round((read ?? 0) * 100)}%`} aria-valuenow={Math.round((read ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <i style={{ width: `${Math.round((read ?? 0) * 100)}%` }} />
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
