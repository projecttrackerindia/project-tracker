import { createElement, useMemo } from 'react';
import { typeOf } from './api';

/** The icon's shapes as elements (no innerHTML: the app runs under Trusted Types). */
function shapes(svg: string) {
  return [...svg.matchAll(/<(path|circle|rect)\s([^>]*?)\/>/g)].map((m, i) => {
    const props: Record<string, string> = { key: String(i) };
    for (const a of m[2].matchAll(/([a-z-]+)="([^"]*)"/g)) props[a[1]] = a[2];
    return createElement(m[1], props);
  });
}

/** The request type's own line icon (as in the design: rocket, sliders, arrows, warning, clock, umbrella, key, card). */
export function TypeIcon({ type, size = 16 }: { type: string; size?: number }) {
  const icon = typeOf(type).icon;
  const kids = useMemo(() => shapes(icon), [icon]);
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kids}</svg>;
}

/** The icon in its quiet tile (32px, or 46px for the hero). */
export function TypeTile({ type, lg }: { type: string; lg?: boolean }) {
  return <span className={`ap-tile${lg ? ' lg' : ''}`}><TypeIcon type={type} size={lg ? 21 : 16} /></span>;
}
