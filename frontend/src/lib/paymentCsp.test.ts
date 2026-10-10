import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');
const policy = config.match(/set \$sec_csp "([^"]+)";/)![1];
const directives = Object.fromEntries(policy.split(';').map((entry) => {
  const [name, ...sources] = entry.trim().split(/\s+/);
  return [name, sources];
}));

describe('payment checkout content security policy', () => {
  it('allows the actual checkout script and payment frame', () => {
    const checkout = readFileSync(new URL('./razorpay.ts', import.meta.url), 'utf8');
    const script = checkout.match(/s.src = '([^']+)'/)![1];
    expect(directives['script-src']).toContain(new URL(script).origin);
    expect(directives['frame-src']).toContain('https://api.razorpay.com');
    expect(directives['connect-src']).toContain('https://api.razorpay.com');
  });

  it('keeps scripts and frames restricted to explicit origins', () => {
    expect(directives['script-src']).not.toContain('*');
    expect(directives['script-src']).not.toContain('https:');
    expect(directives['frame-src']).not.toContain('*');
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
  });
});
