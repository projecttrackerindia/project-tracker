import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { timeAgo } from '../../../lib/format';
import { useWsQuery } from '../../../lib/hooks';
import { docAiApi } from '../../documents/docAi';
import { docsPath } from './nav';

/** The words of a hit with the searched words marked. */
function Marked({ text, q }: { text: string; q: string }) {
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  return <>{text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}</>;
}

/** Words found inside the pages, best first, each with the line that matched; opens the page at that line. */
export function TextHits({ q }: { q: string }) {
  const [debounced, setDebounced] = useState(q.trim());
  useEffect(() => { const t = window.setTimeout(() => setDebounced(q.trim()), 250); return () => window.clearTimeout(t); }, [q]);
  const r = useWsQuery(['documents', 'search', debounced], () => docAiApi.search(debounced, null, 12), { enabled: debounced.length >= 2, staleTime: 30_000 });
  if (debounced.length < 2) return null;
  if (r.isLoading) return <p className="dx-note">Looking inside the pages…</p>;
  const hits = r.data?.hits ?? [];
  if (!hits.length) return null;
  return (
    <>
      <h3>Inside pages <small>{r.data!.total > hits.length ? `${hits.length} of ${r.data!.total}` : hits.length}</small></h3>
      <ul className="dx-list">
        {hits.map((h) => (
          <li key={h.id}>
            <Link to={`${docsPath.doc(h.id)}${h.block >= 0 ? `#b-${h.block}` : ''}`} className="dx-li dx-hit">
              <span className="dx-hit-i" aria-hidden="true">{h.icon ?? '📄'}</span>
              <span className="dx-hit-main"><b><Marked text={h.title} q={debounced} /></b>{h.line && <small><Marked text={h.line} q={debounced} /></small>}</span>
              <span className="dx-li-proj">{h.projectName ?? 'General'}</span>
              <time dateTime={h.updatedAt}>{timeAgo(h.updatedAt)}</time>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
