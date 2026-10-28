/**
 * A page's own CSS ("Advanced CSS" in the Style panel), checked and fenced in before it ever reaches the page.
 *
 * Library pages are read by the whole organisation, so the CSS one editor writes must never reach anything but that page's text:
 * - It is parsed (not pattern-matched): every rule, at-rule and declaration is rebuilt from what was understood; anything else is an error
 *   and the whole stylesheet is refused (nothing half-applied).
 * - Nothing can load from elsewhere: no @import / @font-face, no url() except small data: images (and none in `content`), no image-set(),
 *   no expression(), behavior, -moz-binding or javascript:. Backslash escapes are refused outright, so none of this can be spelled sideways.
 * - Nothing can float over the app: no position fixed/sticky and no z-index above 10.
 * - Every rule is wrapped in `@scope (<page>) to ([data-embed-guard])`: it can only match inside this page's text, never the app around it
 *   (sidebar, toolbar, dialogs) and never an embed's "Interactive embed" frame. A browser without @scope ignores the whole block (fail-safe).
 * - @keyframes are renamed per page so they cannot replace the app's own animations.
 * - Light and dark: `@media (prefers-color-scheme: dark|light)` follows the app's theme switch, not the operating system's.
 *
 * The server checks the same rules on save (PageCss.cs); this file also scopes the CSS for the browser.
 */

export const MAX_CSS = 20_000;
const MAX_DATA_URL = 12_000;
const MAX_RULES = 600;

export interface CssIssue { line: number; message: string }
export interface CssResult { ok: boolean; css: string; errors: CssIssue[] }

/** The element a page's CSS is fenced into. */
export const scopeSelector = (docId: string) => `.doc-scope[data-doc="${docId.replace(/[^a-zA-Z0-9-]/g, '')}"]`;

const BANNED_WORDS: [RegExp, string][] = [
  [/expression\s*\(/i, 'expression() is not allowed.'],
  [/javascript\s*:/i, 'javascript: is not allowed.'],
  [/vbscript\s*:/i, 'vbscript: is not allowed.'],
  [/-moz-binding/i, '-moz-binding is not allowed.'],
  [/(^|[^a-z-])behavior\s*:/i, 'behavior is not allowed.'],
  [/(-webkit-)?image-set\s*\(/i, 'image-set() is not allowed: use a small data: image in url().'],
  [/(^|[^a-z-])(src|image|element|-moz-element)\s*\(/i, 'Functions that load files are not allowed.'],
];
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const PROP = /^(--[a-zA-Z0-9_-]{1,60}|-?[a-z][a-z0-9-]{0,60})$/;
const KEYFRAME_NAME = /^[a-zA-Z_][\w-]{0,40}$/;
const KEYFRAME_STEP = /^(from|to|\d{1,3}(\.\d+)?%)(\s*,\s*(from|to|\d{1,3}(\.\d+)?%))*$/i;
const MEDIA_PRELUDE = /^[a-z0-9\s:().,\-/]+$/i;
const THEME = /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i;
const ROOTS = /^(:root|html|body|:scope)(?![\w-])/i;

/** A short, stable tag for one page (keyframe names), from its id. */
function tag(docId: string) {
  let h = 2166136261;
  for (let i = 0; i < docId.length; i++) { h ^= docId.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

class Reader {
  i = 0;
  errors: CssIssue[] = [];
  constructor(readonly s: string) {}
  line(at = this.i) { let n = 1; for (let k = 0; k < at && k < this.s.length; k++) if (this.s[k] === '\n') n++; return n; }
  err(message: string, at = this.i) { if (this.errors.length < 20) this.errors.push({ line: this.line(at), message }); }
  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  /** Reads up to (not including) one of `stops` at depth 0 outside strings. Returns null at the end of the text. */
  until(stops: string): string | null {
    const start = this.i; let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '"' || c === "'") {
        const q = c; this.i++;
        while (this.i < this.s.length && this.s[this.i] !== q) { if (this.s[this.i] === '\n') { this.err('A quoted text is not closed.'); break; } this.i++; }
        this.i++; continue;
      }
      if (c === '(' || c === '[') depth++;
      else if ((c === ')' || c === ']') && depth > 0) depth--;
      else if (depth === 0 && stops.includes(c)) return this.s.slice(start, this.i);
      this.i++;
    }
    return null;
  }
}

/** Splits at top-level commas (not inside brackets or quotes). */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []; let depth = 0, q = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

interface Ctx { r: Reader; keyframes: Map<string, string>; rules: number }

function checkValue(prop: string, value: string, ctx: Ctx, at: number): string | null {
  const v = value.trim();
  if (!v) { ctx.r.err(`"${prop}" has no value.`, at); return null; }
  for (const [re, msg] of BANNED_WORDS) if (re.test(v)) { ctx.r.err(msg, at); return null; }
  // url(): only a small inline picture, never an address.
  const urls = [...v.matchAll(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi)];
  if ((v.match(/url\s*\(/gi)?.length ?? 0) !== urls.length) { ctx.r.err('url() could not be read.', at); return null; }
  for (const u of urls) {
    if (prop === 'content') { ctx.r.err('url() is not allowed in content.', at); return null; }
    if (!DATA_IMAGE.test(u[2].trim())) { ctx.r.err('url() may only hold a data:image (png, jpeg, gif or webp) - no addresses.', at); return null; }
    if (u[2].length > MAX_DATA_URL) { ctx.r.err('That data: image is too large (keep it under 12 KB).', at); return null; }
  }
  if (prop === 'position' && /(fixed|sticky)/i.test(v)) { ctx.r.err('position: fixed and sticky are not allowed (the page cannot cover the app).', at); return null; }
  if (prop === 'z-index') {
    const z = v.replace(/\s*!important$/i, '');
    if (/^-?\d+$/.test(z)) { if (Number(z) > 10) { ctx.r.err('z-index can be at most 10.', at); return null; } }
    else if (!/^(auto|inherit|initial|unset|revert)$/i.test(z)) { ctx.r.err('z-index must be a whole number up to 10.', at); return null; }
  }
  if (prop === 'animation' || prop === 'animation-name') {
    return v.replace(/[A-Za-z_][\w-]*/g, (w) => ctx.keyframes.get(w) ?? w);
  }
  return v;
}

function declarations(body: string, ctx: Ctx, offset: number): string | null {
  const out: string[] = [];
  let ok = true;
  for (const part of splitTop(body, ';')) {
    if (!part.trim()) continue;
    const colon = part.indexOf(':');
    const at = offset + body.indexOf(part);
    if (colon < 0) { ctx.r.err(`"${part.trim().slice(0, 30)}" is not a property: value.`, at); ok = false; continue; }
    const prop = part.slice(0, colon).trim().toLowerCase().startsWith('--') ? part.slice(0, colon).trim() : part.slice(0, colon).trim().toLowerCase();
    if (!PROP.test(prop)) { ctx.r.err(`"${prop.slice(0, 40)}" is not a property name.`, at); ok = false; continue; }
    if (prop === 'behavior' || prop === '-ms-behavior' || prop === '-moz-binding') { ctx.r.err(`${prop} is not allowed.`, at); ok = false; continue; }
    const v = checkValue(prop, part.slice(colon + 1), ctx, at);
    if (v === null) { ok = false; continue; }
    out.push(`${prop}: ${v}`);
  }
  return ok ? out.join('; ') : null;
}

/** One selector list, made relative to the page (`:scope`). Null (with an error) when it could reach outside. */
function selectors(prelude: string, ctx: Ctx, at: number, theme: string): string | null {
  const s = prelude.trim();
  if (!s) { ctx.r.err('A rule has no selector.', at); return null; }
  if (/[{};@<]/.test(s)) { ctx.r.err('That selector could not be read.', at); return null; }
  const out: string[] = [];
  for (const raw of splitTop(s, ',')) {
    let sel = raw.trim().replace(/\s+/g, ' ');
    if (!sel) { ctx.r.err('An empty selector in a list.', at); return null; }
    if (/^[>+~]/.test(sel)) { ctx.r.err(`"${sel}" starts with a combinator: it would reach outside the page.`, at); return null; }
    if (/:host|::slotted|::part|:global/i.test(sel)) { ctx.r.err(`"${sel}" is not allowed.`, at); return null; }
    const root = ROOTS.exec(sel);
    if (root) sel = `:scope${sel.slice(root[0].length)}`;
    if (/(^|[\s>+~(,])(:root|html|body)(?![\w-])/i.test(sel)) { ctx.r.err(`"${raw.trim()}": :root, html and body can only start a selector (they mean the page).`, at); return null; }
    if (/:scope/i.test(sel.slice(root ? 6 : 0))) { ctx.r.err(`"${raw.trim()}": :scope can only start a selector.`, at); return null; }
    if (!root) sel = `:scope ${sel}`;
    out.push(theme ? `${theme} ${sel}` : sel);
  }
  return out.join(', ');
}

/** Rules until the closing brace (or the end at the top level). */
function block(ctx: Ctx, top: boolean, theme: string, depth: number, kf: string[]): string[] {
  const { r } = ctx; const out: string[] = [];
  for (;;) {
    r.ws();
    if (r.i >= r.s.length) { if (!top) r.err('A { is not closed.'); return out; }
    if (r.s[r.i] === '}') { if (top) { r.err('An extra } with no {.'); r.i++; continue; } r.i++; return out; }
    if (++ctx.rules > MAX_RULES) { r.err('Too many rules.'); r.i = r.s.length; return out; }
    const at = r.i;
    if (r.s[r.i] === '@') {
      const name = /^@([a-z-]+)/i.exec(r.s.slice(r.i))?.[1]?.toLowerCase() ?? '';
      r.i += name.length + 1;
      const prelude = r.until('{;}');
      if (prelude === null || r.s[r.i] !== '{') { r.err(`@${name || '?'} is not allowed.`, at); if (r.s[r.i] === ';') r.i++; continue; }
      r.i++;
      if (name === 'media') {
        const p = prelude.trim();
        const t = THEME.exec(p);
        if (depth > 0) { r.err('@media cannot be inside another @media.', at); skipBlock(r); continue; }
        if (!t && (!MEDIA_PRELUDE.test(p) || /url|prefers-color-scheme/i.test(p))) { r.err('That @media condition is not allowed (use prefers-color-scheme on its own for light and dark).', at); skipBlock(r); continue; }
        const inner = block(ctx, false, t ? (t[1].toLowerCase() === 'dark' ? ':root[data-theme="dark"]' : ':root:not([data-theme="dark"])') : theme, depth + 1, kf);
        if (t) out.push(...inner); else out.push(`@media ${p} {\n${inner.join('\n')}\n}`);
      } else if (name === 'keyframes' || name === '-webkit-keyframes') {
        const kname = prelude.trim();
        if (!KEYFRAME_NAME.test(kname)) { r.err('A @keyframes name may only hold letters, digits, - and _.', at); skipBlock(r); continue; }
        if (depth > 0 || !top) { r.err('@keyframes must be at the top level.', at); skipBlock(r); continue; }
        const steps: string[] = [];
        for (;;) {
          r.ws();
          if (r.i >= r.s.length) { r.err('@keyframes is not closed.', at); break; }
          if (r.s[r.i] === '}') { r.i++; break; }
          const sAt = r.i;
          const step = r.until('{}');
          if (step === null || r.s[r.i] !== '{') { r.err('A keyframe step could not be read.', sAt); skipBlock(r); break; }
          r.i++;
          if (!KEYFRAME_STEP.test(step.trim())) { r.err(`"${step.trim().slice(0, 20)}" is not a keyframe step (from, to or a %).`, sAt); }
          const dAt = r.i; const body = r.until('{}');
          if (body === null || r.s[r.i] !== '}') { r.err('A keyframe step is not closed.', sAt); skipBlock(r); break; }
          r.i++;
          const d = declarations(body, ctx, dAt);
          if (d !== null) steps.push(`  ${step.trim()} { ${d} }`);
        }
        kf.push(`@keyframes ${ctx.keyframes.get(kname) ?? kname} {\n${steps.join('\n')}\n}`);
      } else { r.err(`@${name} is not allowed.`, at); skipBlock(r); }
      continue;
    }
    const prelude = r.until('{};');
    if (prelude === null || r.s[r.i] !== '{') { r.err('Expected { after the selector.', at); if (r.i < r.s.length) r.i++; continue; }
    r.i++;
    const bodyAt = r.i;
    const body = r.until('{}');
    if (body === null || r.s[r.i] !== '}') { r.err('A rule is not closed (or holds a { inside).', bodyAt); skipBlock(r); continue; }
    r.i++;
    const sel = selectors(prelude, ctx, at, theme);
    const d = declarations(body, ctx, bodyAt);
    if (sel !== null && d !== null) out.push(`${sel} { ${d} }`);
  }
}

function skipBlock(r: Reader) {
  let depth = 1;
  while (r.i < r.s.length && depth > 0) { const c = r.s[r.i++]; if (c === '{') depth++; else if (c === '}') depth--; }
}

/**
 * Checks a page's CSS and returns it fenced into the page. `ok` false means nothing of it may be used (errors say why, by line).
 */
export function scopeCss(source: string, docId: string): CssResult {
  const fail = (errors: CssIssue[]): CssResult => ({ ok: false, css: '', errors });
  if (!source.trim()) return { ok: true, css: '', errors: [] };
  if (source.length > MAX_CSS) return fail([{ line: 1, message: `The CSS is too long (${Math.round(source.length / 1000)} KB): keep it under 20 KB.` }]);
  // Comments out (newlines kept, so lines still count right).
  let text = '';
  for (let i = 0; i < source.length;) {
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return fail([{ line: source.slice(0, i).split('\n').length, message: 'A /* comment is not closed.' }]);
      text += source.slice(i, end + 2).replace(/[^\n]/g, ' '); i = end + 2;
    } else text += source[i++];
  }
  const pre: CssIssue[] = [];
  const lineOf = (at: number) => text.slice(0, at).split('\n').length;
  const bs = text.indexOf('\\'); if (bs >= 0) pre.push({ line: lineOf(bs), message: 'Backslash escapes are not allowed.' });
  const lt = text.indexOf('<'); if (lt >= 0) pre.push({ line: lineOf(lt), message: '< is not allowed in CSS.' });
  // eslint-disable-next-line no-control-regex
  const ctl = text.search(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/); if (ctl >= 0) pre.push({ line: lineOf(ctl), message: 'Control characters are not allowed.' });
  if (pre.length) return fail(pre);

  const t = tag(docId);
  const keyframes = new Map<string, string>();
  for (const m of text.matchAll(/@(?:-webkit-)?keyframes\s+([A-Za-z_][\w-]{0,40})/g)) keyframes.set(m[1], `pg${t}-${m[1]}`);
  const r = new Reader(text);
  const ctx: Ctx = { r, keyframes, rules: 0 };
  const kf: string[] = [];
  const rules = block(ctx, true, '', 0, kf);
  if (r.errors.length) return fail(r.errors);
  const scope = scopeSelector(docId);
  const css = `${kf.join('\n')}\n@scope (${scope}) to ([data-embed-guard]) {\n${rules.join('\n')}\n}\n`;
  return { ok: true, css, errors: [] };
}

/** Only the checks (the editor's inline errors). */
export const checkCss = (source: string) => scopeCss(source, 'check').errors;
