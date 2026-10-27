import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { DtProject } from '../../../api/types';
import { ReaderRail, useOutline } from '../../documents/DocReader';
import { docsPath } from './nav';

/** Library › Project › Topic. */
export function Crumb({ p, here }: { p: Pick<DtProject, 'id' | 'name'>; here?: ReactNode }) {
  return (
    <nav className="dx-crumb" aria-label="Breadcrumb" data-testid="docs-crumb">
      <Link to={docsPath.hub()}>Library</Link><span aria-hidden="true">›</span>
      {here ? <><Link to={docsPath.project(p.id)}>{p.name}</Link><span aria-hidden="true">›</span><span aria-current="page">{here}</span></> : <span aria-current="page">{p.name}</span>}
    </nav>
  );
}

/** The reading column with its outline on the right; `fresh` is the page's freshness (Verified N days ago / May be stale), shown by the breadcrumb. */
export function Reading({ p, title, children, tools, wide, fresh }: { p: DtProject; title?: string; children: ReactNode; tools?: ReactNode; wide?: boolean; fresh?: ReactNode }) {
  const col = useRef<HTMLDivElement>(null);
  const outline = useOutline(col, []);
  return (
    <div className={`dx-read${wide ? ' wide' : ''}`}>
      <div className="dx-bar"><Crumb p={p} here={title} />{fresh && <div className="dx-freshes">{fresh}</div>}{tools && <div className="dx-tools">{tools}</div>}</div>
      <div className="dx-col" ref={col}>{children}</div>
      {!wide && <ReaderRail outline={outline} />}
    </div>
  );
}

