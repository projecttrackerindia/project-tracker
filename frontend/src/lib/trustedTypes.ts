/**
 * Trusted Types. The app's pages are served with `require-trusted-types-for 'script'`: the browser refuses to put a plain string into a
 * place that can run code (innerHTML, a script's source, a worker's address) unless it went through a policy. This file is that policy:
 *
 * - HTML is cleaned before it reaches the page: no <script>, frames, objects or <base>, no on… event attributes, no javascript: or
 *   data: addresses (images excepted), no SVG animation that rewrites a link. Icons, diagrams and formatted text keep working.
 * - Script addresses must be this site's own (or a blob made here); the payment window's script is allowed by name.
 * - Code from a string (eval and friends) is refused outright.
 *
 * So a bug that lets someone's text reach innerHTML can no longer run their code — in the password vault above all.
 */
type Policy = { createHTML: (s: string) => unknown };
type TT = { createPolicy: (name: string, rules: Record<string, (s: string, ...a: unknown[]) => unknown>) => Policy; defaultPolicy?: unknown };

const DROP = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'meta', 'link', 'set', 'portal']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'data', 'poster', 'background', 'srcset', 'ping']);
const SAFE_DATA = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);/i;
const SCRIPT_HOSTS = ['https://checkout.razorpay.com/', 'https://connect.facebook.net/'];

// Shapes that only live inside an <svg>. Markup that starts with one of them is an icon or a diagram's inside, written for an <svg>.
const SVG_PARTS = /^\s*<(path|rect|circle|ellipse|line|polyline|polygon|g|defs|use|text|tspan|lineargradient|radialgradient|stop|clippath|mask|pattern|symbol|marker|image|foreignobject)[\s/>]/i;

/** Cleans markup in an inert template (nothing in it loads or runs), then hands back the cleaned text. */
export function cleanHtml(html: string, parse: (s: string) => string | unknown): string {
  const tpl = document.createElement('template');
  // An SVG fragment is read inside an <svg>: read as HTML, `<rect/>` does not close itself and every later shape would end up inside it,
  // so an icon drawn from several shapes would show only its first one.
  const svg = SVG_PARTS.test(html);
  (tpl as unknown as { innerHTML: unknown }).innerHTML = parse(svg ? `<svg>${html}</svg>` : html);
  const walk = (root: ParentNode) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const tag = el.localName.toLowerCase();
      if (DROP.has(tag)) { el.remove(); continue; }
      if ((tag === 'animate' || tag === 'animatetransform' || tag === 'animatemotion') && /href/i.test(el.getAttribute('attributeName') ?? '')) { el.remove(); continue; }
      for (const a of Array.from(el.attributes)) {
        const name = a.name.toLowerCase();
        const value = [...a.value].filter((c) => c.charCodeAt(0) > 32).join('').toLowerCase();   // browsers ignore control characters and spaces in a scheme
        if (name.startsWith('on') || name === 'srcdoc') el.removeAttribute(a.name);
        else if (URL_ATTRS.has(name) && (value.startsWith('javascript:') || value.startsWith('vbscript:') || (value.startsWith('data:') && !SAFE_DATA.test(a.value.trim())))) el.removeAttribute(a.name);
      }
      if (tag === 'template') walk((el as HTMLTemplateElement).content);
    }
  };
  walk(tpl.content);
  const root = svg && tpl.content.childElementCount === 1 ? tpl.content.firstElementChild : null;
  return root?.localName === 'svg' ? root.innerHTML : tpl.innerHTML;
}

const cache = new Map<string, string>();
let installed = false;

export function installTrustedTypes() {
  const tt = (window as unknown as { trustedTypes?: TT }).trustedTypes;
  if (installed || !tt?.createPolicy) return;
  installed = true;
  try {
    // A private policy only the cleaner uses, to parse markup into an inert template.
    const raw = tt.createPolicy('pt-sanitize', { createHTML: (s: string) => s });
    tt.createPolicy('default', {
      createHTML: (s: string) => {
        const hit = cache.get(s);
        if (hit !== undefined) return hit;
        const out = cleanHtml(s, (x) => raw.createHTML(x));
        if (s.length < 4000) { if (cache.size > 800) cache.clear(); cache.set(s, out); }
        return out;
      },
      createScriptURL: (s: string) => {
        const u = new URL(s, location.href);
        if (u.origin === location.origin || u.protocol === 'blob:' || SCRIPT_HOSTS.some((h) => u.href.startsWith(h))) return u.href;
        throw new TypeError(`Blocked a script from ${u.origin}`);
      },
      createScript: () => { throw new TypeError('Running code from text is not allowed here.'); },
    });
  } catch { /* a policy of that name exists already (a second copy of the app): the first one stands */ }
}
