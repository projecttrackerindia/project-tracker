/**
 * An animated SVG for a page, rebuilt from an allow-list. The markup is read tag by tag and written out again with only known shapes,
 * gradients, filters and animation elements and their plain attributes: no <script>, no <foreignObject>, no event handlers (on…), no
 * links that leave the picture (href only to #ids inside it), no styles that load anything. Anything else is dropped with what it holds.
 *
 * It is also only ever shown as an <img> (a picture: the browser never runs code or fetches anything for it), so this is the second wall,
 * not the only one. The server rebuilds it the same way on save (MotionSvg in DocumentMotion.cs).
 */
export const MAX_SVG = 150_000;

const ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop',
  'clippath', 'mask', 'pattern', 'symbol', 'use', 'title', 'desc', 'animate', 'animatetransform', 'animatemotion', 'mpath', 'style', 'filter', 'fegaussianblur', 'feoffset',
  'feblend', 'fecolormatrix', 'femerge', 'femergenode', 'feflood', 'fecomposite', 'fedropshadow', 'marker']);
/** Elements whose whole subtree goes when they are not allowed (script, foreignObject, iframe… everything outside the list). */
const NAME = /^[a-zA-Z][a-zA-Z0-9:_-]{0,40}$/;
const ATTR = /^[a-zA-Z][a-zA-Z0-9:_.-]{0,40}$/;
const BAD_VALUE = /(javascript|vbscript|data)\s*:|expression\s*\(|@import|-moz-binding|behavior/i;

const esc = (s: string) => s.replace(/&(?!(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline CSS of the picture: no url() except to #ids, nothing that loads or runs. */
function cleanCss(css: string): string | null {
  if (/[\\<]/.test(css) || BAD_VALUE.test(css)) return null;
  for (const m of css.matchAll(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) if (!m[2].trim().startsWith('#')) return null;
  if ((css.match(/url\s*\(/gi)?.length ?? 0) !== [...css.matchAll(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi)].length) return null;
  return css;
}

function cleanAttr(el: string, name: string, value: string): string | null {
  const n = name.toLowerCase();
  if (!ATTR.test(name) || n.startsWith('on') || n === 'srcdoc' || n === 'formaction' || n === 'src') return null;
  const v = value.trim();
  // eslint-disable-next-line no-control-regex
  const flat = v.replace(/[\u0000- ]/g, '');
  if (n === 'href' || n === 'xlink:href') return flat.startsWith('#') && /^#[\w.-]{1,80}$/.test(flat) ? v : null;
  if (n === 'style') return cleanCss(v);
  if (BAD_VALUE.test(flat)) return null;
  if (/url\s*\(/i.test(v) && !/^url\(\s*['"]?#[\w.-]+['"]?\s*\)$/i.test(v)) return null;
  // An animation may not change where something points.
  if ((el === 'animate' || el === 'set' || el === 'animatetransform' || el === 'animatemotion') && n === 'attributename' && /href|^on|style/i.test(v)) return null;
  if (n.startsWith('xmlns') && !/^(xmlns|xmlns:xlink)$/.test(n)) return null;
  return v;
}

export interface SvgResult { ok: boolean; svg: string; error?: string; removed: number }

/** Cleans SVG markup. `removed` counts what was taken out (shown to the editor so a dropped part is not a surprise). */
export function cleanSvg(input: string): SvgResult {
  if (input.length > MAX_SVG) return { ok: false, svg: '', error: 'The SVG is too large (keep it under 150 KB).', removed: 0 };
  const s = input.replace(/^\uFEFF/, '');
  let out = ''; let i = 0; let removed = 0;
  /** Open elements; a dropped element's subtree is skipped until its end tag. */
  const stack: { name: string; keep: boolean }[] = [];
  let skip = 0;
  let sawRoot = false;
  while (i < s.length) {
    if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); i = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith('<?', i)) { const e = s.indexOf('?>', i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i); const text = s.slice(i + 9, e < 0 ? s.length : e); i = e < 0 ? s.length : e + 3;
      if (!skip && stack.at(-1)?.name === 'style') { const c = cleanCss(text); if (c === null) removed++; else out += esc(c); }
      continue;
    }
    if (s.startsWith('<!', i)) { removed++; const e = s.indexOf('>', i); i = e < 0 ? s.length : e + 1; continue; }   // DOCTYPE / ENTITY: never
    if (s[i] === '<') {
      const close = s[i + 1] === '/';
      let j = i + (close ? 2 : 1);
      const nm = /^[^\s/>]+/.exec(s.slice(j))?.[0] ?? '';
      j += nm.length;
      // Attributes up to the end of the tag (quotes respected).
      const attrs: [string, string][] = [];
      let selfClose = false;
      while (j < s.length && s[j] !== '>') {
        if (/\s/.test(s[j])) { j++; continue; }
        if (s[j] === '/' && s[j + 1] === '>') { selfClose = true; j++; continue; }
        const an = /^[^\s=/>]+/.exec(s.slice(j))?.[0];
        if (!an) { j++; continue; }
        j += an.length;
        while (/\s/.test(s[j] ?? '')) j++;
        let av = '';
        if (s[j] === '=') {
          j++; while (/\s/.test(s[j] ?? '')) j++;
          const q = s[j];
          if (q === '"' || q === "'") { const e = s.indexOf(q, j + 1); av = s.slice(j + 1, e < 0 ? s.length : e); j = e < 0 ? s.length : e + 1; }
          else { const v = /^[^\s>]+/.exec(s.slice(j))?.[0] ?? ''; av = v; j += v.length; }
        }
        attrs.push([an, av]);
      }
      i = j + 1;
      const name = nm.toLowerCase();
      if (!NAME.test(nm)) { removed++; continue; }
      if (close) {
        // Close up to the matching open element.
        const at = stack.map((x) => x.name).lastIndexOf(name);
        if (at < 0) continue;
        while (stack.length > at) {
          const top = stack.pop()!;
          if (!top.keep) skip--; else if (!skip) out += `</${canon(top.name)}>`;
        }
        continue;
      }
      if (!sawRoot && name !== 'svg') return { ok: false, svg: '', error: 'This is not an SVG picture (it must start with <svg>).', removed };
      sawRoot = true;
      const keep = !skip && ELEMENTS.has(name);
      if (!keep) { if (!skip) removed++; }
      if (keep) {
        let tagOut = `<${canon(name)}`;
        for (const [an, av] of attrs) {
          const v = cleanAttr(name, an, av);
          if (v === null) { removed++; continue; }
          tagOut += ` ${an}="${esc(v)}"`;
        }
        if (name === 'svg' && !attrs.some(([a]) => a.toLowerCase() === 'xmlns')) tagOut += ' xmlns="http://www.w3.org/2000/svg"';
        out += tagOut + (selfClose ? '/>' : '>');
      }
      if (!selfClose) { stack.push({ name, keep }); if (!keep) skip++; }
      continue;
    }
    const e = s.indexOf('<', i);
    const text = s.slice(i, e < 0 ? s.length : e);
    i = e < 0 ? s.length : e;
    if (skip) continue;
    if (stack.at(-1)?.name === 'style') { const c = cleanCss(text); if (c === null) removed++; else out += esc(c); }
    else if (stack.length) out += esc(text);
  }
  while (stack.length) { const top = stack.pop()!; if (top.keep && !skip) out += `</${canon(top.name)}>`; else if (!top.keep) skip--; }
  if (!sawRoot) return { ok: false, svg: '', error: 'This is not an SVG picture.', removed };
  return { ok: true, svg: out, removed };
}

/** SVG element names are case-sensitive: write them as SVG spells them. */
function canon(name: string) {
  const map: Record<string, string> = { lineargradient: 'linearGradient', radialgradient: 'radialGradient', clippath: 'clipPath', animatetransform: 'animateTransform',
    animatemotion: 'animateMotion', fegaussianblur: 'feGaussianBlur', feoffset: 'feOffset', feblend: 'feBlend', fecolormatrix: 'feColorMatrix', femerge: 'feMerge',
    femergenode: 'feMergeNode', feflood: 'feFlood', fecomposite: 'feComposite', fedropshadow: 'feDropShadow' };
  return map[name] ?? name;
}

/** The cleaned picture as an image address (shown with <img>: inert by design). */
export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
