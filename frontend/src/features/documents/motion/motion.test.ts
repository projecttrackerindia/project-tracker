import { describe, expect, it } from 'vitest';
import { checkCss, scopeCss, scopeSelector } from './cssScope';
import { cleanSvg } from './svgClean';
import { checkSandbox, EMBED_CSP, FORBIDDEN_TOKENS, frameAttrs, SANDBOX_TOKENS } from './sandbox';
import { cleanStyle, styleOf, suggestVisual, withStyle } from './pageStyle';

const ID = '00000000-0000-0000-0000-00000000d101';
const ok = (css: string) => { const r = scopeCss(css, ID); expect(r.errors).toEqual([]); return r.css; };
const bad = (css: string, msg?: RegExp) => { const r = scopeCss(css, ID); expect(r.ok).toBe(false); expect(r.css).toBe(''); if (msg) expect(r.errors.map((e) => e.message).join(' | ')).toMatch(msg); return r.errors; };

describe('page CSS scoper', () => {
  it('fences every rule into the page and keeps embeds out', () => {
    const css = ok('h2 { color: red } .note, p > em { font-weight: 600 }');
    expect(css).toContain(`@scope (${scopeSelector(ID)}) to ([data-embed-guard])`);
    expect(css).toContain(':scope h2 { color: red }');
    expect(css).toContain(':scope .note, :scope p > em { font-weight: 600 }');
  });
  it('turns :root, html and body into the page itself (for variables)', () => {
    expect(ok(':root { --accent: #4f46e5 }')).toContain(':scope { --accent: #4f46e5 }');
    expect(ok('body p { margin: 0 }')).toContain(':scope p { margin: 0 }');
    bad('.x :root { color: red }', /can only start a selector/);
    bad('p body { color: red }', /can only start a selector/);
  });
  it('follows the app theme for prefers-color-scheme', () => {
    const css = ok('@media (prefers-color-scheme: dark) { :root { --accent: #a5b4fc } h2 { color: var(--accent) } }');
    expect(css).toContain(':root[data-theme="dark"] :scope { --accent: #a5b4fc }');
    expect(css).toContain(':root[data-theme="dark"] :scope h2');
    expect(ok('@media (prefers-color-scheme: light) { h2 { color: navy } }')).toContain(':root:not([data-theme="dark"]) :scope h2');
    expect(ok('@media (max-width: 600px) { h2 { font-size: 20px } }')).toContain('@media (max-width: 600px)');
  });
  it('renames keyframes so they cannot replace the app’s own', () => {
    const css = ok('@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } } .a { animation: spin 2s linear infinite }');
    const name = /@keyframes (pg[a-z0-9]+-spin)/.exec(css)?.[1];
    expect(name).toBeTruthy();
    expect(css).toContain(`animation: ${name} 2s linear infinite`);
    expect(css).not.toMatch(/@keyframes spin\b/);
  });
  it('refuses anything that loads or runs', () => {
    bad('@import url(https://evil.example/x.css);', /not allowed/);
    bad('@import "x.css";');
    bad('p { background: url(https://evil.example/track.png) }', /data:image/);
    bad('p { background: url("//evil.example/a.png") }');
    bad('p { background-image: image-set("x.png" 1x) }', /image-set/);
    bad('p { width: expression(alert(1)) }', /expression/);
    bad('p { behavior: url(x.htc) }');
    bad('p { -moz-binding: url(x.xml#a) }');
    bad('a { background: url(javascript:alert(1)) }');
    bad('@font-face { font-family: x; src: url(https://evil.example/f.woff) }', /@font-face/);
    bad('p::before { content: url(data:image/png;base64,AAAA) }', /content/);
    bad('p { color: re\\64 }', /Backslash/);
    bad('p { background: u\\72l(https://evil.example) }', /Backslash/);
    bad('</style><script>alert(1)</script>', /</);
  });
  it('allows a small data: image', () => {
    expect(ok('p { background: url("data:image/png;base64,iVBORw0KGgo=") no-repeat }')).toContain('data:image/png;base64');
    bad(`p { background: url(data:image/png;base64,${'A'.repeat(13_000)}) }`, /too large/);
    bad('p { background: url(data:image/svg+xml;utf8,<svg/>) }');
  });
  it('cannot float over the app', () => {
    bad('.x { position: fixed; top: 0 }', /fixed/);
    bad('.x { position: sticky }', /sticky/);
    bad('.x { position:-webkit-sticky }', /sticky/);
    bad('.x { z-index: 9999 }', /at most 10/);
    bad('.x { z-index: calc(1000) }');
    expect(ok('.x { position: relative; z-index: 10 }')).toContain('z-index: 10');
  });
  it('cannot reach outside the page with selectors', () => {
    bad('+ .sidebar { display: none }', /combinator/);
    bad('~ * { display: none }', /combinator/);
    bad(':host { color: red }');
    bad('p { color: red }}', /extra/);
    bad('p { color: red', /not closed/);
    bad('p { color: red; .x { color: blue } }');
    bad('@media (prefers-color-scheme: dark) and (min-width: 1px) { p { color: red } }');
  });
  it('limits size and reports lines', () => {
    expect(checkCss('x'.repeat(20_001))[0].message).toMatch(/20 KB/);
    const e = bad('h1 { color: red }\n\np { position: fixed }');
    expect(e[0].line).toBe(3);
    expect(scopeCss('', ID)).toEqual({ ok: true, css: '', errors: [] });
    expect(scopeCss('/* only a comment */', ID).ok).toBe(true);
    bad('/* never closed', /comment/);
  });
});

describe('SVG cleaner', () => {
  it('keeps shapes and animation, drops scripts and handlers', () => {
    const r = cleanSvg('<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><circle cx="5" cy="5" r="4" fill="red" onclick="x()"><animate attributeName="r" values="2;4;2" dur="1s" repeatCount="indefinite"/></circle></svg>');
    expect(r.ok).toBe(true);
    expect(r.svg).toContain('<circle cx="5" cy="5" r="4" fill="red">');
    expect(r.svg).toContain('<animate attributeName="r"');
    expect(r.svg).not.toMatch(/script|onload|onclick|alert/i);
    expect(r.removed).toBeGreaterThanOrEqual(3);
  });
  it('drops foreignObject with all it holds, and external links', () => {
    const r = cleanSvg('<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.example"></iframe></div></foreignObject><use href="https://evil.example/x.svg#a"/><use xlink:href="#ok"/><a href="javascript:alert(1)"><rect/></a><image href="https://evil.example/t.png"/></svg>');
    expect(r.svg).not.toMatch(/foreignObject|iframe|evil|javascript|<a|<image/i);
    expect(r.svg).toContain('<use xlink:href="#ok"/>');
  });
  it('refuses animations that rewrite links, data: and styles that load', () => {
    const r = cleanSvg('<svg><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="xlink:href" values="javascript:alert(1)"/><rect style="fill:url(https://evil.example/p.png)" width="1"/><style>@import url(https://evil.example/x.css); rect{fill:red}</style><rect fill="url(#g)"/></svg>');
    expect(r.svg).not.toMatch(/javascript|evil|@import/i);
    expect(r.svg).toContain('fill="url(#g)"');
  });
  it('rejects what is not an SVG, DOCTYPE entities and oversize input', () => {
    expect(cleanSvg('<html><script>alert(1)</script></html>').ok).toBe(false);
    expect(cleanSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg><text>&x;</text></svg>').svg).not.toContain('ENTITY');
    expect(cleanSvg(`<svg>${'<g></g>'.repeat(30_000)}</svg>`).ok).toBe(false);
  });
});

describe('interactive embed frame', () => {
  it('is sandboxed with scripts only: no same origin, top navigation, popups or forms', () => {
    const a = frameAttrs('Demo');
    expect(a.sandbox).toBe('allow-scripts');
    expect(SANDBOX_TOKENS.split(/\s+/)).toEqual(['allow-scripts']);
    for (const t of FORBIDDEN_TOKENS) expect(a.sandbox).not.toContain(t);
    expect(a.src).toBe('/embed/sandbox.html');
    expect(a.referrerPolicy).toBe('no-referrer');
    expect(a.allow).toMatch(/camera 'none'/);
  });
  it('runs under a policy that loads nothing from anywhere', () => {
    expect(EMBED_CSP).toContain("default-src 'none'");
    expect(EMBED_CSP).toContain("script-src 'unsafe-inline'");
    expect(EMBED_CSP).toContain('img-src data:');
    expect(EMBED_CSP).not.toMatch(/https?:|'self'/);
  });
  it('has size limits', () => {
    expect(checkSandbox({ html: 'x', css: '', js: '' })).toEqual([]);
    expect(checkSandbox({ html: 'x'.repeat(40_001), css: '', js: '' }).join()).toMatch(/HTML/);
    expect(checkSandbox({ html: 'x'.repeat(39_000), css: 'x'.repeat(19_000), js: 'x'.repeat(39_000) }).join()).toMatch(/80 KB/);
  });
});

describe('page style', () => {
  it('is kept on the body and read back, and cleans what it does not know', () => {
    const body = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });
    const s = cleanStyle({ preset: 'editorial', css: 'h2{color:red}', animateSections: true, sectionTransition: 'line', extra: 1 });
    expect(styleOf(withStyle(body, s))).toEqual(s);
    expect(cleanStyle({ preset: 'evil', sectionTransition: 'x' })).toEqual({ preset: 'default', css: '', animateSections: false, sectionTransition: 'none' });
    expect(JSON.parse(withStyle(withStyle(body, s), cleanStyle({}))).attrs).toBeUndefined();
  });
  it('suggests a look from what the page holds', () => {
    const doc = { type: 'doc', content: [{ type: 'heading' }, { type: 'paragraph' }, { type: 'heading' }, { type: 'table' }, { type: 'codeBlock' }, { type: 'heading' }] };
    const r = suggestVisual(JSON.stringify(doc));
    expect(r.style.preset).toBe('product');
    expect(r.style.animateSections).toBe(true);
    expect(r.style.sectionTransition).toBe('line');
  });
});
