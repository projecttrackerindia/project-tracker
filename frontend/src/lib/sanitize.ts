/**
 * Allowlist sanitising for markup the app puts into the page itself (dangerouslySetInnerHTML). Trusted Types (trustedTypes.ts) already
 * cleans every HTML string in browsers that support it; this is the same guarantee in every browser, and stricter: only the listed
 * elements and attributes survive, everything else is dropped (not escaped), and no attribute may carry a script URL.
 *
 * Used for SVG drawn by the server from user-written diagram text. Text content is kept as text.
 */
const SVG_TAGS = new Set(['svg', 'g', 'defs', 'marker', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc']);
const SVG_ATTRS = new Set([
  'class', 'id', 'role', 'aria-label', 'aria-hidden', 'xmlns', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'transform',
  'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'marker-end', 'marker-start', 'orient', 'refx', 'refy',
  'markerwidth', 'markerheight', 'markerunits', 'preserveaspectratio',
]);
// A paint or marker reference may only point inside the same drawing: url(#id).
const URL_VALUE = /url\s*\(/i;
const LOCAL_REF = /^url\(\s*#[A-Za-z0-9_-]+\s*\)$/;

/** Keeps only safe SVG elements and attributes. Anything that is not an <svg> drawing comes back empty. */
export function sanitizeSvg(markup: string): string {
  if (typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) return '';
  const clean = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (!SVG_TAGS.has(child.localName.toLowerCase())) { child.remove(); continue; }
      clean(child);
    }
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      if (!SVG_ATTRS.has(name)) { el.removeAttribute(a.name); continue; }
      const v = a.value.trim();
      if (URL_VALUE.test(v) && !LOCAL_REF.test(v)) el.removeAttribute(a.name);
      else if (/^\s*(javascript|vbscript|data):/i.test(v)) el.removeAttribute(a.name);
    }
  };
  clean(root);
  return new XMLSerializer().serializeToString(root);
}

/** A link's address is safe to put in href: http(s), mailto, tel, or a path on this site. Anything else (javascript:, data:, …) is not. */
export function safeHref(href: string | null | undefined): string | undefined {
  const value = (href ?? '').trim();
  if (!value) return undefined;
  const scheme = [...value].filter((c) => c.charCodeAt(0) > 32).join('').toLowerCase();
  if (/^(https?:|mailto:|tel:)/.test(scheme)) return value;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  if (value.startsWith('#')) return value;
  return undefined;
}
