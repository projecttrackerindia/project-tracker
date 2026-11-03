import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { safeHref, sanitizeSvg } from './sanitize';

describe('safeHref', () => {
  it.each(['https://www.figma.com/file/x', 'http://example.in', 'mailto:a@example.com', 'tel:+919876543210', '/projects/1', '#top'])('keeps %s', (href) => {
    expect(safeHref(href)).toBe(href);
  });
  it.each(['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.example', ''])('drops %j', (href) => {
    expect(safeHref(href)).toBeUndefined();
  });
});

describe('sanitizeSvg', () => {
  it('fails closed where no DOM parser exists (never returns the raw markup)', () => {
    expect(sanitizeSvg('<svg><script>alert(1)</script></svg>')).toBe('');
  });
});

describe('transport and isolation headers', () => {
  const nginx = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');
  const caddy = readFileSync(new URL('../../../deploy/Caddyfile', import.meta.url), 'utf8');
  it('sends preload-eligible HSTS from both proxies', () => {
    expect(nginx).toMatch(/set \$sec_hsts "max-age=63072000; includeSubDomains; preload";/);
    expect(caddy).toMatch(/Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"/);
  });
  it('keeps the app policy free of inline script and plugins', () => {
    const app = nginx.match(/set \$app_csp "([^"]+)";/)![1];
    const scripts = app.split(';').find((d) => d.trim().startsWith('script-src'))!;
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    for (const d of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "require-trusted-types-for 'script'"]) expect(app).toContain(d);
  });
  it('isolates every HTML page from cross-origin openers', () => {
    expect((nginx.match(/Cross-Origin-Opener-Policy/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(caddy).toMatch(/protocols tls1\.2 tls1\.3/);
  });
});
