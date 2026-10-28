// The app's Content-Security-Policy: no inline script runs unless its exact text is listed by hash, and Trusted Types are required.
// The policy in nginx.conf ($app_csp) carries a placeholder that the image build fills with the hashes of index.html's inline scripts
// (scripts/csp-nginx.mjs); the synthetic UI checks fill it the same way, so they run the app under exactly the policy it ships with.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PLACEHOLDER = '__INLINE_SCRIPT_HASHES__';

/** 'sha256-…' for every inline script that runs (JSON-LD data blocks are not scripts to the browser and need none). */
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase();
    if (type && type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') continue;
    out.push(`'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  return [...new Set(out)];
}

export function fillAppCsp(nginxText, indexHtml) {
  const tpl = nginxText.match(/set \$app_csp "([^"]+)";/)?.[1];
  if (!tpl || !tpl.includes(PLACEHOLDER)) throw new Error('nginx.conf has no $app_csp with the inline-script placeholder');
  return tpl.replace(PLACEHOLDER, inlineScriptHashes(indexHtml).join(' '));
}

/** For the UI checks: the policy for a served file — the app's own for the app, the public site's for its static pages. */
export async function cspFor(dist = path.resolve('dist')) {
  const conf = await fs.readFile('nginx.conf', 'utf8');
  const site = conf.match(/set \$sec_csp "([^"]+)";/)[1];
  const embed = conf.match(/set \$embed_csp "([^"]+)";/)[1];
  // nginx fills ${CALLS_ORIGIN} (the media server) at container start; the checks have none.
  const app = fillAppCsp(conf, await fs.readFile(path.join(dist, 'index.html'), 'utf8')).replace('${CALLS_ORIGIN} ', process.env.CALLS_ORIGIN ? `${process.env.CALLS_ORIGIN} ` : '');
  const index = path.join(dist, 'index.html');
  const embedDir = path.join(dist, 'embed') + path.sep;
  return (file = 'index.html') => { const f = path.resolve(dist, String(file)); return f === index ? app : f.startsWith(embedDir) ? embed : f.endsWith('.html') ? site : app; };
}

/** The app's policy (most checks serve only the app's index.html). */
export async function appCsp() { return (await cspFor())('index.html'); }
